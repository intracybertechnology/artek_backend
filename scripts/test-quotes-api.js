/**
 * scripts/test-quotes-api.js
 *
 * One-shot end-to-end test for the quotes API. Spawns the server,
 * runs every check and cleans up after itself.
 *
 * Run:  node scripts/test-quotes-api.js
 *
 * Phases:
 *   1  SMTP explicitly empty – honeypot, saving, DB-truth product
 *                               context, rate limit, admin endpoints
 *   2  SMTP -> local sink      – real email content, email_sent = true
 *   2b SMTP unreachable        – quote still saved, success still returned
 *
 * The suite is careful with the server process because this machine
 * reaps/kills spawned processes unreliably: before every start it makes
 * sure the port is free, and after every kill it waits until the port
 * is really released.
 */

const { spawn, execSync } = require("child_process");
const net   = require("net");
const path  = require("path");
const { Client } = require("pg");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

// Dedicated test port – the developer's own `npm run dev` (nodemon) uses
// 5000 on this machine, so the suite must never touch that port.
const TEST_PORT          = 5099;
const BASE               = `http://localhost:${TEST_PORT}`;
const TEST_EMAIL_DOMAIN  = "@quote-test.example";

let passCount = 0, failCount = 0;
const check = (name, cond, extra) => {
  if (cond) { passCount++; console.log(`  PASS  ${name}`); }
  else      { failCount++; console.log(`  FAIL  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`); }
};

// ── Tiny HTTP helper ─────────────────────────────────────────────────
const req = async (method, url, { body, cookie } = {}) => {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, cookie: res.headers.get("set-cookie")?.split(";")[0] };
};

// ── Port hygiene ─────────────────────────────────────────────────────
// Nothing may answer on the port before we spawn, and the port must be
// released after we kill – otherwise a leftover server answers requests
// and poisons the next phase (wrong rate limiter, wrong log capture).

const killListener = () => {
  try {
    const out = execSync("netstat -ano").toString();
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      if (/:5099\s/.test(line) && /\sLISTENING\s/.test(line)) {
        const pid = line.split(/\s+/).pop();
        try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); }
        catch { /* already gone */ }
      }
    }
  } catch { /* netstat unavailable – nothing we can do */ }
};

const waitForFreePort = async (timeoutMs) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { await fetch(BASE + "/api/health"); await new Promise((r) => setTimeout(r, 300)); }
    catch { return; }                                  // connection refused = free
  }
  throw new Error(`test port ${TEST_PORT} is still occupied`);
};

// ── Server lifecycle with stdout capture ────────────────────────────
const startServer = async (extraEnv = {}) => {
  killListener();                    // remove leftovers of a crashed run
  await waitForFreePort(10000);

  const state = await new Promise((resolve, reject) => {
    const child = spawn("node", ["server.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, PORT: String(TEST_PORT), ...extraEnv },
    });
    const capture = { child, out: "" };
    child.stdout.on("data", (d) => (capture.out += d));
    child.stderr.on("data", (d) => (capture.out += d));

    const t0 = Date.now();
    const poll = async () => {
      if (Date.now() - t0 > 20000) return reject(new Error("server not ready:\n" + capture.out));
      try {
        const r = await fetch(BASE + "/api/health");
        if (r.ok) {
          // The port answered – make sure it was OUR child, not a leftover
          if (child.exitCode !== null) {
            return reject(new Error(`our child died (${child.exitCode}) but the port answered:\n` + capture.out));
          }
          resolve(capture);
        } else {
          setTimeout(poll, 300);
        }
      } catch { setTimeout(poll, 300); }
    };
    setTimeout(poll, 500);

    // (A reject after resolve is a harmless no-op)
    child.on("exit", (code) => {
      reject(new Error(`server exited early (${code}):\n` + capture.out));
    });
  });

  return state;
};

const killServer = async (child) => {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); }
  catch { try { child.kill(); } catch { /* already gone */ } }
  await waitForFreePort(10000);      // do not let the next phase race a dying process
};

// ── Minimal SMTP sink: accepts one message, keeps the raw DATA ───────
const startSmtpSink = () => new Promise((resolve) => {
  let captured = null;
  const server = net.createServer((socket) => {
    let buffer = "", inData = false, data = "";
    socket.write("220 mini-smtp ready\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            captured = data;
            socket.write("250 OK: queued\r\n");
          } else {
            data += (line.startsWith("..") ? line.slice(1) : line) + "\r\n";   // undo dot-stuffing
          }
        } else if (/^(EHLO|HELO)/i.test(line)) {
          socket.write("250-mini\r\n250 8BITMIME\r\n");
        } else if (/^DATA/i.test(line)) {
          inData = true; data = "";
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (/^QUIT/i.test(line)) {
          socket.write("221 Bye\r\n"); socket.end();
        } else {
          socket.write("250 OK\r\n");   // MAIL FROM, RCPT TO, anything else
        }
      }
    });
  });
  server.listen(2525, "127.0.0.1", () => resolve({
    getCaptured: () => captured,
    close: () => new Promise((r) => server.close(r)),
  }));
});

// ── Database helper ──────────────────────────────────────────────────
const db = new Client({ connectionString: process.env.DATABASE_URL });
const cleanupDb = async () => {
  await db.query("DELETE FROM quote_requests WHERE email LIKE $1", [`%${TEST_EMAIL_DOMAIN}`]);
  await db.query("DELETE FROM users WHERE email = $1", ["quote.api.test@example.com"]);
};
const quoteCount = async () =>
  (await db.query("SELECT COUNT(*)::int AS n FROM quote_requests")).rows[0].n;
const quoteRow = async (email) =>
  (await db.query("SELECT * FROM quote_requests WHERE email = $1", [email])).rows[0];

// ══════════════════════════════════════════════════════════════════════
(async () => {
  await db.connect();
  let S = null, sink = null;

  try {
    await cleanupDb();
    const baseline = await quoteCount();
    const hik = await db.query("SELECT id FROM products WHERE model_number = 'DS-2CD1043G0-I'");
    const hikProductId = hik.rows[0].id;

    // ══ Phase 1: SMTP explicitly empty – saving, honeypot, DB truth ══
    console.log("Phase 1 – SMTP not configured");
    S = await startServer({
      SMTP_HOST: "", SMTP_PORT: "", SMTP_USER: "", SMTP_PASS: "", QUOTE_TO_EMAIL: "",
    });

    const before = await quoteCount();

    // 1. Honeypot – returns success but saves nothing
    const bot = await req("POST", "/api/quotes", { body: {
      botcheck: "spam bot",
      fullName: "Bot", email: "bot" + TEST_EMAIL_DOMAIN, phone: "+971 50 000 0000",
      message: "buy cheap seo now please",
    }});
    check("honeypot returns the normal success response",
      bot.status === 201 && bot.json.success === true
      && bot.json.message === "Thank you, we will contact you shortly.", bot.json);
    check("honeypot saved nothing", (await quoteCount()) === before, { before, after: await quoteCount() });

    // 2. Valid quote with HTML in the fields + service/emirate/category
    const q1 = await req("POST", "/api/quotes", { body: {
      fullName: "Test <b>Person</b>",
      email: "q1" + TEST_EMAIL_DOMAIN,
      phone: "+971 4 123 4567",
      companyName: "ACME <b>Corp</b>",
      service: "CCTV <b>Installation</b>",
      emirate: "Dubai",
      message: "Please quote 4 dome cameras.<script>alert(1)</script> Need installation.",
      category: "CCTV cameras",
    }});
    check("valid quote -> 201 success message",
      q1.status === 201 && q1.json.success === true
      && q1.json.message === "Thank you, we will contact you shortly.", q1.json);
    check("saved row is not returned", q1.json.quote === undefined && q1.json.id === undefined, q1.json);

    const row1 = await quoteRow("q1" + TEST_EMAIL_DOMAIN);
    check("name column = fullName, HTML stripped", row1.name === "Test Person", row1.name);
    check("company column = companyName, HTML stripped", row1.company === "ACME Corp", row1.company);
    check("status is 'new'", row1.status === "new", row1.status);
    check("email_sent false (SMTP not configured)", row1.email_sent === false, row1.email_sent);
    check("no product context stored without product_id",
      row1.product_id === null && row1.product_name === null
      && row1.model_number === null && row1.brand_name === null, row1);
    check("message HTML stripped",
      row1.message.startsWith("Please quote 4 dome cameras.alert(1) Need installation."), row1.message);
    check("message ends with Service/Emirate/Category lines",
      row1.message.endsWith("Service: CCTV Installation\nEmirate: Dubai\nCategory: CCTV cameras"),
      row1.message);

    // 3. product_id given -> database truth overwrites the client's values
    const q2 = await req("POST", "/api/quotes", { body: {
      fullName: "Quote Two",
      email: "q2" + TEST_EMAIL_DOMAIN,
      phone: "+971 2 555 0111",
      message: "Need a quote for this model please.",
      product_id: String(hikProductId),     // string, like a form would send it
      product_name: "FAKE PRODUCT",
      model_number: "FAKE-1",
      brand_name: "FAKEBRAND",
    }});
    check("quote with product_id -> 201", q2.status === 201, q2.status);
    const row2 = await quoteRow("q2" + TEST_EMAIL_DOMAIN);
    check("product_id stored", row2.product_id === hikProductId, row2.product_id);
    check("product_name from database, not client",
      row2.product_name === "Hikvision 4MP Bullet Camera", row2.product_name);
    check("model_number from database", row2.model_number === "DS-2CD1043G0-I", row2.model_number);
    check("brand_name from database", row2.brand_name === "Hikvision", row2.brand_name);
    const q2id = row2.id;

    // 4. product_id that does not exist -> context kept, broken reference dropped
    const q3 = await req("POST", "/api/quotes", { body: {
      fullName: "Quote Three",
      email: "q3" + TEST_EMAIL_DOMAIN,
      phone: "+971 3 444 0022",
      message: "Quote for a legacy camera we have.",
      product_id: 999999,
      product_name: "Legacy Camera",
      model_number: "LEG-1",
      brand_name: "SomeBrand",
    }});
    check("quote with unknown product_id -> 201", q3.status === 201, q3.status);
    const row3 = await quoteRow("q3" + TEST_EMAIL_DOMAIN);
    check("unknown product_id not stored (FK safe)", row3.product_id === null, row3.product_id);
    check("client product context kept",
      row3.product_name === "Legacy Camera" && row3.model_number === "LEG-1"
      && row3.brand_name === "SomeBrand", row3);

    // 5. Validation error (missing fullName) – still counts for the limiter
    const inv = await req("POST", "/api/quotes", { body: {
      email: "x" + TEST_EMAIL_DOMAIN, phone: "+971 50 111 2222", message: "hello there",
    }});
    check("missing fullName -> 422", inv.status === 422 && inv.json.success === false, inv.status);

    // 6. Rate limit: this is the 6th POST within 15 minutes
    const limited = await req("POST", "/api/quotes", { body: {
      fullName: "Sixth Try", email: "q6" + TEST_EMAIL_DOMAIN, phone: "+971 50 999 8888",
      message: "This should be rate limited.",
    }});
    check("6th request -> 429 { success: false, message }",
      limited.status === 429 && limited.json.success === false && typeof limited.json.message === "string",
      limited.json);

    // Server log line (stdout may flush late on Windows pipes – give it a second)
    await new Promise((r) => setTimeout(r, 1000));
    check("server startup banner captured (our child answered)",
      S.out.includes("Server running"), { outLen: S.out.length });
    check('logs "Email not configured, quote saved only"',
      S.out.includes("Email not configured, quote saved only"), { outLen: S.out.length });

    // ── Phase 1b: admin endpoints (same server, GETs are not rate limited) ──
    const anon = await req("GET", "/api/quotes");
    check("unauthenticated GET /api/quotes -> 401", anon.status === 401, anon.status);

    const login = await req("POST", "/api/auth/login", {
      body: { email: process.env.SUPERADMIN_EMAIL, password: process.env.SUPERADMIN_PASSWORD },
    });
    const SA = login.cookie;
    check("super admin login", login.status === 200 && !!SA);

    const mk = await req("POST", "/api/users", { cookie: SA, body: {
      name: "Quote API Test Admin", email: "quote.api.test@example.com",
      password: "QuoteTest@123", role: "admin",
    }});
    const admLogin = await req("POST", "/api/auth/login", {
      body: { email: "quote.api.test@example.com", password: "QuoteTest@123" },
    });
    check("temp admin created + login", mk.status === 201 && admLogin.status === 200);
    const forbidden = await req("GET", "/api/quotes", { cookie: admLogin.cookie });
    check("plain 'admin' role -> 403 (super_admin only)", forbidden.status === 403, forbidden.status);

    const list = await req("GET", "/api/quotes", { cookie: SA });
    check("admin list -> 200", list.status === 200);
    check("admin list default pagination",
      list.json.pagination.page === 1 && list.json.pagination.limit === 20
      && list.json.pagination.total === 3 && list.json.pagination.totalPages === 1,
      list.json.pagination);
    check("admin list newest first",
      list.json.quotes[0].email === "q3" + TEST_EMAIL_DOMAIN
      && list.json.quotes[2].email === "q1" + TEST_EMAIL_DOMAIN,
      list.json.quotes.map((q) => q.email));
    check("list rows include message and status",
      typeof list.json.quotes[0].message === "string" && list.json.quotes[0].status === "new");

    const page2 = await req("GET", "/api/quotes?page=2&limit=2", { cookie: SA });
    check("pagination page=2 limit=2 -> 1 row",
      page2.json.pagination.page === 2 && page2.json.quotes.length === 1, page2.json.pagination);
    const badLimit = await req("GET", "/api/quotes?limit=0", { cookie: SA });
    check("limit=0 -> 422", badLimit.status === 422, badLimit.status);

    const detail = await req("GET", `/api/quotes/${row1.id}`, { cookie: SA });
    check("GET /api/quotes/:id returns the quote",
      detail.status === 200 && detail.json.quote.id === row1.id && detail.json.quote.name === "Test Person");
    const miss = await req("GET", "/api/quotes/999999", { cookie: SA });
    check("GET missing quote -> 404", miss.status === 404, miss.status);
    const badId = await req("GET", "/api/quotes/abc", { cookie: SA });
    check("GET non-numeric id -> clean 404", badId.status === 404, badId.status);

    const patch = await req("PATCH", `/api/quotes/${q2id}`, { cookie: SA, body: { status: "contacted" } });
    check("PATCH status -> 200, quote returned",
      patch.status === 200 && patch.json.quote.status === "contacted", patch.json);
    const fContacted = await req("GET", "/api/quotes?status=contacted", { cookie: SA });
    check("filter status=contacted -> 1",
      fContacted.json.pagination.total === 1 && fContacted.json.quotes[0].id === q2id,
      fContacted.json.pagination);
    const fNew = await req("GET", "/api/quotes?status=new", { cookie: SA });
    check("filter status=new -> 2", fNew.json.pagination.total === 2, fNew.json.pagination);
    const fClosed = await req("GET", "/api/quotes?status=closed", { cookie: SA });
    check("filter status=closed -> 0", fClosed.json.pagination.total === 0, fClosed.json.pagination);
    const fBad = await req("GET", "/api/quotes?status=whatever", { cookie: SA });
    check("filter status=whatever -> 422", fBad.status === 422, fBad.status);

    // PATCH ignores every field except status
    const patchIgnore = await req("PATCH", `/api/quotes/${q2id}`, { cookie: SA, body: {
      status: "new", name: "Hack Attempt", email_sent: true,
    }});
    check("PATCH with extra fields -> 200", patchIgnore.status === 200, patchIgnore.status);
    const rowAfter = (await db.query(
      "SELECT name, email_sent, status FROM quote_requests WHERE id = $1", [q2id]
    )).rows[0];
    check("extra fields ignored, status applied",
      rowAfter.name === "Quote Two" && rowAfter.email_sent === false && rowAfter.status === "new", rowAfter);

    const patchBad = await req("PATCH", `/api/quotes/${q2id}`, { cookie: SA, body: { status: "nonsense" } });
    check("PATCH invalid status -> 422", patchBad.status === 422, patchBad.status);
    const patchMissing = await req("PATCH", `/api/quotes/${q2id}`, { cookie: SA, body: {} });
    check("PATCH missing status -> 422", patchMissing.status === 422, patchMissing.status);
    const patchMiss = await req("PATCH", "/api/quotes/999999", { cookie: SA, body: { status: "new" } });
    check("PATCH missing quote -> 404", patchMiss.status === 404, patchMiss.status);
    const patchNoAuth = await req("PATCH", `/api/quotes/${q2id}`, { body: { status: "new" } });
    check("PATCH unauthenticated -> 401", patchNoAuth.status === 401, patchNoAuth.status);

    await killServer(S.child);
    S = null;

    // ══ Phase 2: SMTP configured -> real email content, email_sent = true ══
    console.log("\nPhase 2 – SMTP pointed at the local sink");
    sink = await startSmtpSink();
    S = await startServer({
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "2525",
      SMTP_USER: "",
      SMTP_PASS: "",
      QUOTE_TO_EMAIL: "sales@artekcomputer.com",
    });

    const q4 = await req("POST", "/api/quotes", { body: {
      fullName: "Quote Four",
      email: "q4" + TEST_EMAIL_DOMAIN,
      phone: "+971 50 123 4567",
      companyName: "Four Trading LLC",
      service: "CCTV Installation",
      emirate: "Sharjah",
      message: "Please send a quotation for the bullet camera.",
      product_id: String(hikProductId),
    }});
    check("quote with SMTP configured -> 201", q4.status === 201, q4.status);
    const row4 = await quoteRow("q4" + TEST_EMAIL_DOMAIN);
    check("email_sent = true after a successful send", row4 && row4.email_sent === true, row4 && row4.email_sent);

    await new Promise((r) => setTimeout(r, 300));
    const mail = sink.getCaptured();
    check("SMTP sink captured the email", typeof mail === "string" && mail.includes("Subject:"), typeof mail);
    if (mail) {
      check("To: QUOTE_TO_EMAIL", mail.includes("To: sales@artekcomputer.com"));
      check("Reply-To: the customer", mail.includes("Reply-To: q4" + TEST_EMAIL_DOMAIN));
      check("Subject: product name + fullName",
        mail.includes("Subject: New quote request: Hikvision 4MP Bullet Camera (Quote Four)"));
      check("body lists the date", /Date:/.test(mail));
      check("body lists name, email, phone",
        mail.includes("Name:    Quote Four")
        && mail.includes("Email:   q4" + TEST_EMAIL_DOMAIN)
        && mail.includes("Phone:   +971 50 123 4567"));
      check("body lists company, service, emirate",
        mail.includes("Company: Four Trading LLC")
        && mail.includes("Service: CCTV Installation")
        && mail.includes("Emirate: Sharjah"));
      check("body includes the message",
        mail.includes("Please send a quotation for the bullet camera."));
      check("body lists product name, model, brand",
        mail.includes("Name:  Hikvision 4MP Bullet Camera")
        && mail.includes("Model: DS-2CD1043G0-I")
        && mail.includes("Brand: Hikvision"));
    }

    // Remaining validation cases (fresh limiter, 5 POSTs used in total)
    const badEmail = await req("POST", "/api/quotes", { body: {
      fullName: "Bad Email", email: "not-an-email", phone: "+971 50 111 2222", message: "testing bad email case",
    }});
    check("invalid email -> 422", badEmail.status === 422, badEmail.status);
    const shortPhone = await req("POST", "/api/quotes", { body: {
      fullName: "Short Phone", email: "sp" + TEST_EMAIL_DOMAIN, phone: "123", message: "testing short phone case",
    }});
    check("short phone -> 422", shortPhone.status === 422, shortPhone.status);
    const shortMsg = await req("POST", "/api/quotes", { body: {
      fullName: "Short Message", email: "sm" + TEST_EMAIL_DOMAIN, phone: "+971 50 333 4444", message: "hi",
    }});
    check("short message -> 422", shortMsg.status === 422, shortMsg.status);
    const badPid = await req("POST", "/api/quotes", { body: {
      fullName: "Bad Product Id", email: "bp" + TEST_EMAIL_DOMAIN, phone: "+971 50 555 6666",
      message: "testing bad product id", product_id: "abc",
    }});
    check("non-numeric product_id -> 422", badPid.status === 422, badPid.status);

    await killServer(S.child);
    S = null;
    await sink.close();
    sink = null;

    // ══ Phase 2b: SMTP configured but unreachable -> quote still saved ══
    console.log("\nPhase 2b – SMTP unreachable");
    S = await startServer({
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "2599",       // nothing listens on this port
      QUOTE_TO_EMAIL: "sales@artekcomputer.com",
    });

    const q5 = await req("POST", "/api/quotes", { body: {
      fullName: "Quote Five",
      email: "q5" + TEST_EMAIL_DOMAIN,
      phone: "+971 6 777 8899",
      message: "Testing what happens when SMTP is down.",
    }});
    check("SMTP down -> still 201 and success",
      q5.status === 201 && q5.json.success === true
      && q5.json.message === "Thank you, we will contact you shortly.", q5.json);
    const row5 = await quoteRow("q5" + TEST_EMAIL_DOMAIN);
    check("SMTP down -> quote saved, email_sent stays false",
      !!row5 && row5.email_sent === false, row5 && row5.email_sent);
    await new Promise((r) => setTimeout(r, 1000));
    check('logs "Quote email failed:"', S.out.includes("Quote email failed:"), { outLen: S.out.length });

    await killServer(S.child);
    S = null;

    // ── Cleanup and summary ───────────────────────────────────────────
    await cleanupDb();
    const leftover = await quoteCount();
    check("cleanup removed every test quote", leftover === baseline, { baseline, leftover });

    console.log(`\n${passCount} passed, ${failCount} failed`);
    process.exitCode = failCount > 0 ? 1 : 0;

  } catch (err) {
    console.error("TEST RUN ERROR:", err.message);
    process.exitCode = 1;
  } finally {
    if (S) await killServer(S.child);
    if (sink) await sink.close();
    await db.end();
  }
})();
