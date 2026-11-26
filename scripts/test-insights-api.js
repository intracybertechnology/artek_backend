/**
 * scripts/test-insights-api.js
 *
 * One-shot end-to-end test for the Insights (blog) API. Spawns the
 * server on its own port (5099 – the developer's `npm run dev` owns
 * 5000), runs every check and cleans up after itself.
 *
 * Run:  node scripts/test-insights-api.js
 *
 * Expects `npm run migrate` and `npm run seed:insights` to have run.
 */

const { spawn, execSync } = require("child_process");
const fs     = require("fs");
const path   = require("path");
const sharp  = require("sharp");
const { Client } = require("pg");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const TEST_PORT   = 5099;
const BASE        = `http://localhost:${TEST_PORT}`;
const SLUG_PREFIX = "api-test-insights";
const ADMIN_EMAIL = "insights.api.test@example.com";
const SEED_SLUG   = "five-signs-your-cctv-system-needs-attention";

let passCount = 0, failCount = 0;
const check = (name, cond, extra) => {
  if (cond) { passCount++; console.log(`  PASS  ${name}`); }
  else      { failCount++; console.log(`  FAIL  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`); }
};

// Today's date as YYYY-MM-DD (same local-time rule as the controller)
const today = () => {
  const d  = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
};

// ── Tiny HTTP helper ─────────────────────────────────────────────────
const req = async (method, url, { body, cookie, form } = {}) => {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let payload;
  if (form) {
    payload = form;                       // FormData sets its own content type
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res  = await fetch(BASE + url, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, cookie: res.headers.get("set-cookie")?.split(";")[0] };
};

// ── Port hygiene (for the test port only – never 5000) ───────────────
const killListener = () => {
  try {
    const out = execSync("netstat -ano").toString();
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      if (line.includes(`:${TEST_PORT}`) && line.includes("LISTENING")) {
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
  killListener();
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

// ── Uploads hygiene: remove only files this run created ──────────────
const uploadsDir = () =>
  path.resolve(__dirname, "..", process.env.UPLOAD_DIR || "./uploads", "insights");
const listUploadFiles = () => {
  try { return new Set(fs.readdirSync(uploadsDir())); } catch { return new Set(); }
};

// ── Database helpers ──────────────────────────────────────────────────
const db = new Client({ connectionString: process.env.DATABASE_URL });
const cleanupDb = async () => {
  await db.query("DELETE FROM posts WHERE slug LIKE $1", [SLUG_PREFIX + "%"]);
  await db.query("DELETE FROM users WHERE email = $1", [ADMIN_EMAIL]);
};
const myPostCount = async () =>
  (await db.query("SELECT COUNT(*)::int AS n FROM posts WHERE slug LIKE $1", [SLUG_PREFIX + "%"])).rows[0].n;

// ── Image fixtures ───────────────────────────────────────────────────
const pngSmall = async () =>
  sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
const pngBig = async () =>
  sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();

const imageForm = (buf, type = "image/png", field = "image", name = "img.png") => {
  const f = new FormData();
  f.append(field, new Blob([buf], { type }), name);
  return f;
};

// ══════════════════════════════════════════════════════════════════════
(async () => {
  await db.connect();
  let S = null;

  try {
    await cleanupDb();                       // leftovers of a crashed run
    const uploadsBefore = listUploadFiles();

    // Reusable body block sets
    const validBody = [
      { type: "p", text: "Intro paragraph for the draft post." },
      { type: "h2", text: "Section Heading" },          // id generated
      { type: "h3", text: "Sub heading" },
      { type: "ul", items: ["One", "Two"] },
      { type: "ol", items: ["First", "Second"] },
      { type: "quote", text: "Quoted line", cite: "Someone" },
      { type: "callout", title: "Note", text: "Callout text" },
      { type: "table", head: ["A", "B"], rows: [["1", "2"], ["3", ""]] },
      { type: "image", src: "/uploads/insights/x.webp", alt: "pic", width: 800, height: 600, caption: "A picture" },
    ];
    const pBlock = (text) => ({ type: "p", text });

    // ══ Phase 1: server up, auth guards, create ════════════════════
    console.log("Phase 1 – server, guards, create");
    S = await startServer();

    // Unauthenticated guards
    for (const [m, p] of [
      ["POST", "/api/insights"], ["PATCH", "/api/insights/1"],
      ["DELETE", "/api/insights/1"], ["POST", "/api/insights/1/restore"],
      ["GET", "/api/admin/insights"], ["GET", "/api/admin/insights/1"],
    ]) {
      const r = await req(m, p, m === "PATCH" || m === "POST" ? { body: {} } : {});
      check(`401 unauth ${m} ${p}`, r.status === 401, r.status);
    }
    const unauthImg = await req("POST", "/api/insights/images", { form: imageForm(await pngSmall()) });
    check("401 unauth POST /api/insights/images", unauthImg.status === 401, unauthImg.status);

    // Logins: super admin (SA) and temp plain admin (AD)
    const loginSA = await req("POST", "/api/auth/login", {
    body: { email: process.env.SUPERADMIN_EMAIL, password: process.env.SUPERADMIN_PASSWORD },
    });
    const SA = loginSA.cookie;
    check("super admin login", loginSA.status === 200 && !!SA);

    const mkAD = await req("POST", "/api/users", { cookie: SA, body: {
      name: "Insights API Test Admin", email: ADMIN_EMAIL, password: "InsightsTest@123", role: "admin",
    }});
    const loginAD = await req("POST", "/api/auth/login", {
      body: { email: ADMIN_EMAIL, password: "InsightsTest@123" },
    });
    const AD = loginAD.cookie;
    check("temp admin created + login", mkAD.status === 201 && loginAD.status === 200);

    // ── Create: full-field draft ──────────────────────────────────
    const d1 = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "  API Test Insights Draft One  ",      // trimmed by the controller
      dek: "Draft dek",
      category: "TestCat",
      tags: ["CCTV", "Maintenance"],
      authorId: "author-jane",
      coverWord: "security",
      faqs: [{ question: "Is this a test?", answer: "Yes." }],
      relatedServices: ["Maintenance", "Installation"],
      seo: { title: "SEO title", description: "SEO description" },
      featured: false,
      body: validBody,
    }});
    check("create draft -> 201", d1.status === 201, d1.json);
    const d1post = d1.json?.post;
    check("camelCase shape has every field",
      d1post && ["id","slug","title","dek","category","tags","authorId","publishedAt","updatedAt",
                 "featured","coverWord","body","faqs","relatedServices","seo","status","readingMinutes","deletedAt"]
        .every((k) => k in d1post), Object.keys(d1post || {}));
    check("title trimmed", d1post?.title === "API Test Insights Draft One", d1post?.title);
    check("slug generated from title", d1post?.slug === "api-test-insights-draft-one", d1post?.slug);
    check("status defaults to draft", d1post?.status === "draft", d1post?.status);
    check("draft has no publishedAt", d1post?.publishedAt === null, d1post?.publishedAt);
    check("authorId stored", d1post?.authorId === "author-jane", d1post?.authorId);
    check("tags round-trip", JSON.stringify(d1post?.tags) === JSON.stringify(["CCTV", "Maintenance"]), d1post?.tags);
    check("relatedServices round-trip",
      JSON.stringify(d1post?.relatedServices) === JSON.stringify(["Maintenance", "Installation"]), d1post?.relatedServices);
    check("faqs round-trip", d1post?.faqs?.length === 1 && d1post?.faqs[0]?.question === "Is this a test?", d1post?.faqs);
    check("seo round-trip", d1post?.seo?.title === "SEO title", d1post?.seo);
    check("body stored with all 9 blocks", d1post?.body?.length === 9, d1post?.body?.length);
    check("h2 id generated from text", d1post?.body?.[1]?.id === "section-heading", d1post?.body?.[1]);
    check("created_by = super admin", d1post?.deletedAt === null && (await db.query("SELECT created_by FROM posts WHERE slug = $1", [d1post?.slug])).rows[0]?.created_by === 1);
    check("readingMinutes minimum 1", d1post?.readingMinutes === 1, d1post?.readingMinutes);

    // h2 explicit id kept + duplicate detection
    const h2exp = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights H2 Explicit", category: "TestCat", body: [
        { type: "h2", id: "custom-id", text: "Custom" },
        { type: "h2", id: "custom-id", text: "Duplicate" },
      ],
    }});
    check("duplicate h2 id -> 422 with position",
      h2exp.status === 422 && h2exp.json?.message === 'body[1]: duplicate h2 id "custom-id"', h2exp.json);

    const h2ok = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights H2 Kept", category: "TestCat", body: [{ type: "h2", id: "kept-id", text: "Custom" }],
    }});
    check("explicit h2 id kept", h2ok.status === 201 && h2ok.json?.post?.body?.[0]?.id === "kept-id", h2ok.json?.post?.body);

    // Explicit slug honored
    const exSlug = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Explicit", slug: "api-test-insights-explicit-slug", category: "TestCat", body: [pBlock("x")],
    }});
    check("explicit slug honored", exSlug.status === 201 && exSlug.json?.post?.slug === "api-test-insights-explicit-slug", exSlug.json?.post?.slug);

    // Published with explicit date
    const f1 = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Future A", category: "ApiTestFuture", status: "published",
      publishedAt: "2031-03-03", body: [pBlock("Future A content")],
    }});
    check("published with explicit date -> 201", f1.status === 201, f1.status);
    check("explicit publishedAt honored", f1.json?.post?.publishedAt === "2031-03-03", f1.json?.post?.publishedAt);

    // Published without a date -> today
    const t1 = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Published Today", category: "ApiTestToday", status: "published", body: [pBlock("Today content")],
    }});
    check("published without date uses today", t1.status === 201 && t1.json?.post?.publishedAt === today(), t1.json?.post?.publishedAt);

    // Published with empty-string date -> today (falsy handling)
    const t2 = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Empty Date", category: "ApiTestToday", status: "published", publishedAt: "", body: [pBlock("x")],
    }});
    check("published with empty publishedAt uses today", t2.status === 201 && t2.json?.post?.publishedAt === today(), t2.json?.post?.publishedAt);

    // Duplicate slug -> 409
    const dupe = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Draft One", category: "TestCat", body: [pBlock("dupe")],
    }});
    check("duplicate slug -> 409", dupe.status === 409 && dupe.json?.message === "A post with this slug already exists", dupe.json);

    // Scalar validation failures (express-validator shape)
    const noTitle = await req("POST", "/api/insights", { cookie: SA, body: { category: "C", body: [] } });
    check("missing title -> 422", noTitle.status === 422, noTitle.status);
    const noCat = await req("POST", "/api/insights", { cookie: SA, body: { title: "X", body: [] } });
    check("missing category -> 422", noCat.status === 422, noCat.status);
    const noBody = await req("POST", "/api/insights", { cookie: SA, body: { title: "X", category: "C" } });
    check("missing body -> 422", noBody.status === 422, noBody.status);
    const badStatus = await req("POST", "/api/insights", { cookie: SA, body: { title: "X", category: "C", body: [], status: "live" } });
    check("invalid status -> 422", badStatus.status === 422, badStatus.status);
    const badDate = await req("POST", "/api/insights", { cookie: SA, body: { title: "X", category: "C", body: [], status: "published", publishedAt: "2031/03/03" } });
    check("invalid publishedAt format -> 422", badDate.status === 422, badDate.status);
    const bodyStr = await req("POST", "/api/insights", { cookie: SA, body: { title: "X", category: "C", body: "not an array" } });
    check("body not an array -> 422", bodyStr.status === 422, bodyStr.status);
    const seoArr = await req("POST", "/api/insights", { cookie: SA, body: { title: "X", category: "C", body: [], seo: ["a"] } });
    check("seo array -> 422", seoArr.status === 422, seoArr.status);

    // ── Block validation messages (flat 422, position named) ──────
    const blockCase = async (name, body, expected) => {
      const r = await req("POST", "/api/insights", { cookie: SA, body: {
        title: "API Test Insights Block Case", category: "TestCat", body,
      }});
      check(name, r.status === 422 && r.json?.message === expected, r.json);
    };
    await blockCase("unknown type -> 422",
      [pBlock("ok"), { type: "marquee", text: "x" }], 'body[1]: unknown block type "marquee"');
    await blockCase("missing type -> 422", [{ text: "no type" }], "body[0]: block type is missing");
    await blockCase("p without text -> 422", [{ type: "p" }], "body[0]: p needs text");
    await blockCase("h2 without text -> 422 (spec example wording)",
      [{ type: "h2" }], "body[0]: h2 needs id and text");
    await blockCase("callout missing title -> 422",
      [{ type: "callout", text: "x" }], "body[0]: callout needs title and text");
    await blockCase("quote bad cite -> 422",
      [{ type: "quote", text: "x", cite: 5 }], "body[0]: quote cite must be a string");
    await blockCase("ul items not strings -> 422",
      [{ type: "ul", items: ["ok", 5] }], "body[0]: ul items must be an array of strings");
    await blockCase("table bad head -> 422",
      [{ type: "table", head: "A", rows: [] }], "body[0]: table head must be an array of strings");
    await blockCase("table bad rows -> 422",
      [{ type: "table", head: ["A"], rows: ["oops"] }], "body[0]: table rows must be an array of string arrays");
    await blockCase("image missing everything -> 422",
      [{ type: "image" }], "body[0]: image needs src, alt, width and height");
    await blockCase("image missing alt -> 422",
      [{ type: "image", src: "/uploads/insights/a.webp", width: 10, height: 10 }],
      "body[0]: image needs alt");
    await blockCase("image non-numeric width -> 422",
      [{ type: "image", src: "/s", alt: "a", width: "800", height: 10 }],
      "body[0]: image needs width");

    const over = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Too Many", category: "TestCat",
      body: Array.from({ length: 201 }, () => pBlock("block")),
    }});
    check("201 blocks -> 422", over.status === 422 && over.json?.message === "body cannot have more than 200 blocks", over.json);

    const atLimit = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights At Limit", category: "TestCat",
      body: Array.from({ length: 200 }, () => pBlock("block")),
    }});
    check("exactly 200 blocks -> 201", atLimit.status === 201, atLimit.status);

    // faqs / tags / relatedServices validation
    const badFaq = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Bad Faq", category: "TestCat", body: [], faqs: [{ question: "Only question?" }],
    }});
    check("faqs missing answer -> 422", badFaq.status === 422 && badFaq.json?.message === "faqs[0] needs answer", badFaq.json);
    const badFaqsType = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Bad Faqs", category: "TestCat", body: [], faqs: "nope",
    }});
    check("faqs not an array -> 422", badFaqsType.status === 422 && /faqs must be an array/.test(badFaqsType.json?.message || ""), badFaqsType.json);
    const badTags = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Bad Tags", category: "TestCat", body: [], tags: "cctv",
    }});
    check("tags not an array -> 422", badTags.status === 422 && badTags.json?.message === "tags must be an array of strings", badTags.json);
    const badTagItem = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Bad Tag Item", category: "TestCat", body: [], tags: [123],
    }});
    check("tags non-string item -> 422", badTagItem.status === 422 && /tags\[0\]/.test(badTagItem.json?.message || ""), badTagItem.json);
    const longTag = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Long Tag", category: "TestCat", body: [], tags: ["x".repeat(101)],
    }});
    check("tags too long -> 422", longTag.status === 422 && /100 characters or less/.test(longTag.json?.message || ""), longTag.json);
    const badRel = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Bad Related", category: "TestCat", body: [], relatedServices: [true],
    }});
    check("relatedServices non-string -> 422", badRel.status === 422 && /relatedServices\[0\]/.test(badRel.json?.message || ""), badRel.json);

    // readingMinutes: 3 x 120 words = 360 words -> 2 minutes
    const long = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Long Read", category: "TestCat",
      body: Array.from({ length: 3 }, () => pBlock("word ".repeat(120).trim())),
    }});
    check("readingMinutes = 2 for 360 words", long.status === 201 && long.json?.post?.readingMinutes === 2, long.json?.post?.readingMinutes);

    // ══ Phase 2: admin role behaviour (plain 'admin') ══════════════
    console.log("\nPhase 2 – plain admin role");
    const adCreate = await req("POST", "/api/insights", { cookie: AD, body: {
      title: "API Test Insights Admin Made", category: "TestCat", body: [pBlock("admin made")],
    }});
    check("admin role can create -> 201", adCreate.status === 201, adCreate.status);

    const adPatch = await req("PATCH", `/api/insights/${adCreate.json?.post?.id}`, {
      cookie: AD, body: { dek: "Patched by admin" },
    });
    check("admin role can patch -> 200", adPatch.status === 200 && adPatch.json?.post?.dek === "Patched by admin", adPatch.status);

    const adDel = await req("DELETE", `/api/insights/${adCreate.json?.post?.id}`, { cookie: AD });
    check("admin role cannot delete -> 403", adDel.status === 403, adDel.status);
    const adRestore = await req("POST", `/api/insights/${adCreate.json?.post?.id}/restore`, { cookie: AD });
    check("admin role cannot restore -> 403", adRestore.status === 403, adRestore.status);

    const adUpload = await req("POST", "/api/insights/images", { cookie: AD, form: imageForm(await pngSmall()) });
    check("admin role can upload image -> 201", adUpload.status === 201, adUpload.status);

    const adList = await req("GET", "/api/admin/insights", { cookie: AD });
    check("admin role sees admin list with drafts",
      adList.status === 200 && adList.json?.posts?.some((p) => p.slug === "api-test-insights-admin-made"), adList.status);

    // ══ Phase 3: PATCH (super admin) ═══════════════════════════════
    console.log("\nPhase 3 – PATCH");
    const before = d1post.updatedAt;
    await new Promise((r) => setTimeout(r, 1100));       // let the timestamp tick

    const patch = await req("PATCH", `/api/insights/${d1post.id}`, { cookie: SA, body: { dek: "Updated dek" } });
    check("patch dek -> 200", patch.status === 200 && patch.json?.post?.dek === "Updated dek", patch.json?.post?.dek);
    check("patch sets updated_at", patch.json?.post?.updatedAt > before, { before, after: patch.json?.post?.updatedAt });

    const patchStatus = await req("PATCH", `/api/insights/${adCreate.json?.post?.id}`, { cookie: SA, body: { status: "needs-review" } });
    check("patch status needs-review", patchStatus.status === 200 && patchStatus.json?.post?.status === "needs-review", patchStatus.json?.post?.status);

    // Publish a draft without a date -> publishedAt becomes today
    const pubMe = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Publish Me", category: "ApiTestToday", body: [pBlock("publish me")],
    }});
    const pubPatch = await req("PATCH", `/api/insights/${pubMe.json?.post?.id}`, { cookie: SA, body: { status: "published" } });
    check("patch to published sets today",
      pubPatch.status === 200 && pubPatch.json?.post?.publishedAt === today(), pubPatch.json?.post?.publishedAt);

    // Publish with an explicit date on the same PATCH
    const dated = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Dated Patch", category: "ApiTestToday", body: [pBlock("x")],
    }});
    const datedPatch = await req("PATCH", `/api/insights/${dated.json?.post?.id}`, {
      cookie: SA, body: { status: "published", publishedAt: "2030-06-15" },
    });
    check("patch publish with explicit date",
      datedPatch.status === 200 && datedPatch.json?.post?.publishedAt === "2030-06-15", datedPatch.json?.post?.publishedAt);

    // Slug rename on a published post
    const ren = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Renamed", category: "ApiTestToday", status: "published", body: [pBlock("rename me")],
    }});
    const renPatch = await req("PATCH", `/api/insights/${ren.json?.post?.id}`, {
      cookie: SA, body: { slug: "api-test-insights-renamed-new" },
    });
    check("patch slug rename -> 200", renPatch.status === 200 && renPatch.json?.post?.slug === "api-test-insights-renamed-new", renPatch.json?.post?.slug);
    const oldSlug = await req("GET", "/api/insights/api-test-insights-renamed");
    check("old slug -> 404 after rename", oldSlug.status === 404, oldSlug.status);
    const newSlug = await req("GET", "/api/insights/api-test-insights-renamed-new");
    check("new slug serves the post", newSlug.status === 200, newSlug.status);

    // Duplicate slug on PATCH -> 409
    const patchDupe = await req("PATCH", `/api/insights/${d1post.id}`, { cookie: SA, body: { slug: "api-test-insights-future-a" } });
    check("patch duplicate slug -> 409", patchDupe.status === 409, patchDupe.status);

    // More PATCH edge cases
    const patchNoFields = await req("PATCH", `/api/insights/${d1post.id}`, { cookie: SA, body: {} });
    check("patch no fields -> 400", patchNoFields.status === 400, patchNoFields.status);
    const patchBadStatus = await req("PATCH", `/api/insights/${d1post.id}`, { cookie: SA, body: { status: "live" } });
    check("patch invalid status -> 422", patchBadStatus.status === 422, patchBadStatus.status);
    const patchBadBody = await req("PATCH", `/api/insights/${d1post.id}`, { cookie: SA, body: { body: [{ type: "p" }] } });
    check("patch invalid body block -> 422 with message",
      patchBadBody.status === 422 && patchBadBody.json?.message === "body[0]: p needs text", patchBadBody.json);
    const patch404 = await req("PATCH", "/api/insights/999999", { cookie: SA, body: { dek: "x" } });
    check("patch missing post -> 404", patch404.status === 404, patch404.status);
    const patchBadId = await req("PATCH", "/api/insights/abc", { cookie: SA, body: { dek: "x" } });
    check("patch non-numeric id -> 404", patchBadId.status === 404, patchBadId.status);

    // ══ Phase 4: admin list + detail ══════════════════════════════
    console.log("\nPhase 4 – admin list and detail");
    const adminList = await req("GET", "/api/admin/insights", { cookie: SA });
    check("admin list -> 200", adminList.status === 200);
    check("admin list includes drafts", adminList.json?.posts?.some((p) => p.slug === "api-test-insights-draft-one"));
    check("admin list includes needs-review", adminList.json?.posts?.some((p) => p.slug === "api-test-insights-admin-made" && p.status === "needs-review"));
    check("admin list item omits body and faqs, keeps flags",
      adminList.json.posts.every((p) => !("body" in p) && !("faqs" in p) && "deletedAt" in p && "readingMinutes" in p));

    const fDraft = await req("GET", "/api/admin/insights?status=draft", { cookie: SA });
    check("?status=draft -> only drafts",
      fDraft.status === 200 && fDraft.json.posts.length > 0 && fDraft.json.posts.every((p) => p.status === "draft"), fDraft.json?.posts?.map((p) => p.status));
    const fBad = await req("GET", "/api/admin/insights?status=live", { cookie: SA });
    check("?status=live -> 422", fBad.status === 422, fBad.status);

    const adminDetail = await req("GET", `/api/admin/insights/${d1post.id}`, { cookie: SA });
    check("admin detail by id -> 200 with full body",
      adminDetail.status === 200 && adminDetail.json?.post?.body?.length === 9 && adminDetail.json?.post?.status === "draft",
      { status: adminDetail.status, blocks: adminDetail.json?.post?.body?.length });
    const detail404 = await req("GET", "/api/admin/insights/999999", { cookie: SA });
    check("admin detail missing -> 404", detail404.status === 404, detail404.status);
    const detailBad = await req("GET", "/api/admin/insights/abc", { cookie: SA });
    check("admin detail non-numeric -> 404", detailBad.status === 404, detailBad.status);

    // ══ Phase 5: soft delete + restore (super admin only) ═════════
    console.log("\nPhase 5 – delete and restore");
    const x = await req("POST", "/api/insights", { cookie: SA, body: {
      title: "API Test Insights Delete Me", category: "ApiTestFuture", status: "published",
      publishedAt: "2031-01-15", body: [pBlock("delete me")],
    }});
    check("create delete-target -> 201", x.status === 201, x.status);
    const xid = x.json?.post?.id;
    const xslug = x.json?.post?.slug;

    const del = await req("DELETE", `/api/insights/${xid}`, { cookie: SA });
    check("soft delete -> 200", del.status === 200 && del.json?.post?.deletedAt !== null, del.json?.post?.deletedAt);

    const pubGone = await req("GET", `/api/insights/${xslug}`);
    check("deleted post hidden publicly -> 404", pubGone.status === 404, pubGone.status);

    const listNoDeleted = await req("GET", "/api/admin/insights", { cookie: SA });
    check("admin list excludes deleted by default", !listNoDeleted.json?.posts?.some((p) => p.id === xid));

    const listDeletedSA = await req("GET", "/api/admin/insights?deleted=true", { cookie: SA });
    check("super admin ?deleted=true includes deleted",
      listDeletedSA.json?.posts?.some((p) => p.id === xid && p.deletedAt !== null));

    const listDeletedAD = await req("GET", "/api/admin/insights?deleted=true", { cookie: AD });
    check("plain admin ?deleted=true still excludes deleted",
      !listDeletedAD.json?.posts?.some((p) => p.id === xid));

    const detailDeletedAD = await req("GET", `/api/admin/insights/${xid}`, { cookie: AD });
    check("plain admin detail of deleted -> 404", detailDeletedAD.status === 404, detailDeletedAD.status);
    const detailDeletedSA = await req("GET", `/api/admin/insights/${xid}`, { cookie: SA });
    check("super admin detail of deleted -> 200", detailDeletedSA.status === 200, detailDeletedSA.status);

    const delAgain = await req("DELETE", `/api/insights/${xid}`, { cookie: SA });
    check("delete twice -> 409", delAgain.status === 409 && delAgain.json?.message === "Post is already deleted", delAgain.json);

    const restore = await req("POST", `/api/insights/${xid}/restore`, { cookie: SA });
    check("restore -> 200, deletedAt null", restore.status === 200 && restore.json?.post?.deletedAt === null, restore.json?.post?.deletedAt);
    const pubBack = await req("GET", `/api/insights/${xslug}`);
    check("restored post visible publicly", pubBack.status === 200, pubBack.status);

    const restoreAgain = await req("POST", `/api/insights/${xid}/restore`, { cookie: SA });
    check("restore non-deleted -> 409", restoreAgain.status === 409, restoreAgain.status);
    const del404 = await req("DELETE", "/api/insights/999999", { cookie: SA });
    check("delete missing -> 404", del404.status === 404, del404.status);
    const restore404 = await req("POST", "/api/insights/999999/restore", { cookie: SA });
    check("restore missing -> 404", restore404.status === 404, restore404.status);

    // ══ Phase 6: public list ordering, categories, pagination ═════
    console.log("\nPhase 6 – public list");
    // Ordering set (all category ApiTestOrder, published)
    const orderPosts = [
      { title: "API Test Insights Order One",   publishedAt: "2031-01-10", featured: true  },
      { title: "API Test Insights Order Two",   publishedAt: "2031-01-12", featured: false },
      { title: "API Test Insights Order Three", publishedAt: "2031-01-11", featured: false },
      { title: "API Test Insights Order Four",  publishedAt: "2031-01-05", featured: true  },
    ];
    for (const o of orderPosts) {
      const r = await req("POST", "/api/insights", { cookie: SA, body: {
        title: o.title, category: "ApiTestOrder", status: "published",
        publishedAt: o.publishedAt, featured: o.featured, body: [pBlock("ordering")],
      }});
      check(`create ${o.title} -> 201`, r.status === 201, r.status);
    }
    // Future B and C (category ApiTestFuture)
    for (const [title, date] of [["API Test Insights Future B", "2031-02-02"], ["API Test Insights Future C", "2031-01-01"]]) {
      const r = await req("POST", "/api/insights", { cookie: SA, body: {
        title, category: "ApiTestFuture", status: "published", publishedAt: date, body: [pBlock("future")],
      }});
      check(`create ${title} -> 201`, r.status === 201, r.status);
    }

    // Featured first, then newest published first
    const ordered = await req("GET", "/api/insights?category=ApiTestOrder");
    check("featured first, then newest first",
      JSON.stringify(ordered.json?.posts?.map((p) => p.slug)) ===
        JSON.stringify(["api-test-insights-order-one", "api-test-insights-order-four",
                        "api-test-insights-order-two", "api-test-insights-order-three"]),
      ordered.json?.posts?.map((p) => `${p.featured ? "*" : ""}${p.slug}`));

    // List item shape: no body/faqs, but readingMinutes present
    const listItem = ordered.json?.posts?.[0];
    check("list item omits body and faqs", !("body" in listItem) && !("faqs" in listItem), Object.keys(listItem));
    check("list item has readingMinutes and status",
      typeof listItem?.readingMinutes === "number" && listItem?.status === "published");

    // Default pagination values
    const defList = await req("GET", "/api/insights");
    check("default pagination page=1 limit=50",
      defList.json?.pagination?.page === 1 && defList.json?.pagination?.limit === 50, defList.json?.pagination);
    check("default list includes seed post and a suite post",
      defList.json?.posts?.some((p) => p.slug === SEED_SLUG)
      && defList.json?.posts?.some((p) => p.slug === "api-test-insights-order-one"));

    // Pagination over ApiTestFuture (4 published: Future A, B, Delete Me, C)
    const pg1 = await req("GET", "/api/insights?category=ApiTestFuture&page=1&limit=2");
    check("pagination page=1 limit=2",
      pg1.json?.pagination?.total === 4 && pg1.json?.pagination?.totalPages === 2
      && JSON.stringify(pg1.json?.posts?.map((p) => p.slug)) ===
        JSON.stringify(["api-test-insights-future-a", "api-test-insights-future-b"]),
      pg1.json?.pagination);
    const pg2 = await req("GET", "/api/insights?category=ApiTestFuture&page=2&limit=2");
    check("pagination page=2",
      JSON.stringify(pg2.json?.posts?.map((p) => p.slug)) ===
        JSON.stringify(["api-test-insights-delete-me", "api-test-insights-future-c"]),
      pg2.json?.posts?.map((p) => p.slug));

    for (const [name, qs] of [
      ["limit=101 -> 422", "limit=101"], ["limit=0 -> 422", "limit=0"], ["page=0 -> 422", "page=0"],
    ]) {
      const r = await req("GET", `/api/insights?${qs}`);
      check(name, r.status === 422, r.status);
    }

    const noCategory = await req("GET", "/api/insights?category=NoSuchCategory");
    check("unknown category -> empty list", noCategory.json?.pagination?.total === 0 && noCategory.json?.posts?.length === 0, noCategory.json?.pagination);

    // Categories: unique, order of first appearance in the list order
    const cats = defList.json?.categories;
    check("categories first three in first-appearance order",
      JSON.stringify(cats?.slice(0, 3)) === JSON.stringify(["ApiTestOrder", "ApiTestFuture", "ApiTestToday"]), cats);
    check("categories includes seeded Security", cats?.includes("Security"), cats);
    check("categories has no duplicates", new Set(cats).size === cats.length, cats);

    // ══ Phase 7: public detail + prev/next ═════════════════════════
    console.log("\nPhase 7 – public detail");
    const f2detail = await req("GET", "/api/insights/api-test-insights-future-b");
    check("detail by slug -> 200 with full body",
      f2detail.status === 200 && f2detail.json?.post?.body?.length === 1 && Array.isArray(f2detail.json?.post?.faqs), f2detail.status);
    check("prev = closest older (Delete Me)",
      f2detail.json?.prev?.slug === "api-test-insights-delete-me", f2detail.json?.prev);
    check("next = closest newer (Future A)",
      f2detail.json?.next?.slug === "api-test-insights-future-a", f2detail.json?.next);

    const f1detail = await req("GET", "/api/insights/api-test-insights-future-a");
    check("newest post has no next, prev = Future B",
      f1detail.json?.next === null && f1detail.json?.prev?.slug === "api-test-insights-future-b",
      { prev: f1detail.json?.prev, next: f1detail.json?.next });

    const draft404 = await req("GET", "/api/insights/api-test-insights-draft-one");
    check("draft detail -> 404", draft404.status === 404, draft404.status);
    const unknown404 = await req("GET", "/api/insights/unknown-slug");
    check("unknown detail -> 404", unknown404.status === 404, unknown404.status);

    // The seeded post is publicly intact
    const seedDetail = await req("GET", `/api/insights/${SEED_SLUG}`);
    check("seed post publicly visible",
      seedDetail.status === 200 && seedDetail.json?.post?.status === "published"
      && seedDetail.json?.post?.body?.length === 4
      && seedDetail.json?.post?.body?.[1]?.id === "what-to-check-every-month"
      && JSON.stringify(seedDetail.json?.post?.tags) === JSON.stringify(["CCTV", "Maintenance", "Security"]),
      seedDetail.json?.post?.body?.[1]);
    const seedCatList = await req("GET", "/api/insights?category=Security");
    check("seed category filter -> 1 post", seedCatList.json?.pagination?.total === 1, seedCatList.json?.pagination);

    // ══ Phase 8: image upload ═════════════════════════════════════
    console.log("\nPhase 8 – image upload");
    const up1 = await req("POST", "/api/insights/images", { cookie: SA, form: imageForm(await pngSmall()) });
    check("upload small png -> 201 with path/width/height",
      up1.status === 201 && up1.json?.success === true && typeof up1.json?.path === "string"
      && up1.json?.width === 200 && up1.json?.height === 150, up1.json);
    check("path format /uploads/insights/insight-<uuid>.webp",
      /^\/uploads\/insights\/insight-[0-9a-f-]{36}\.webp$/.test(up1.json?.path || ""), up1.json?.path);

    const fileOnDisk = path.join(uploadsDir(), path.basename(up1.json?.path || "x"));
    check("file written to UPLOAD_DIR/insights/", fs.existsSync(fileOnDisk));
    const meta1 = await sharp(fs.readFileSync(fileOnDisk)).metadata();
    check("stored file is webp, small image not enlarged",
      meta1.format === "webp" && meta1.width === 200 && meta1.height === 150, { format: meta1.format, w: meta1.width, h: meta1.height });

    const served = await fetch(BASE + up1.json.path);
    check("image served by the static route",
      served.status === 200 && (served.headers.get("content-type") || "").includes("webp"), served.status);

    const up2 = await req("POST", "/api/insights/images", { cookie: SA, form: imageForm(await pngBig()) });
    check("big image resized to <= 1600 on the longest side",
      up2.status === 201 && up2.json?.width === 1600 && up2.json?.height <= 1600, up2.json);

    const upWebp = await req("POST", "/api/insights/images", {
      cookie: SA, form: imageForm(await sharp(await pngSmall()).webp().toBuffer(), "image/webp", "image", "img.webp"),
    });
    check("webp upload accepted", upWebp.status === 201, upWebp.status);

    const upFake = await req("POST", "/api/insights/images", {
      cookie: SA, form: imageForm(Buffer.from("this is not an image at all")),
    });
    check("fake image content -> 400", upFake.status === 400 && /could not be processed/.test(upFake.json?.message || ""), upFake.json);

    const upSvg = await req("POST", "/api/insights/images", {
      cookie: SA, form: imageForm(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml", "image", "x.svg"),
    });
    check("svg -> 400 wrong type", upSvg.status === 400 && /JPG, PNG, WebP/.test(upSvg.json?.message || ""), upSvg.json);

    const tooBigBuf = Buffer.concat([await pngSmall(), Buffer.alloc(6 * 1024 * 1024, 7)]);
    const upBig = await req("POST", "/api/insights/images", { cookie: SA, form: imageForm(tooBigBuf) });
    check("oversize -> 400 with 5 MB message", upBig.status === 400 && /5 MB/.test(upBig.json?.message || ""), upBig.json);

    const upNone = await req("POST", "/api/insights/images", { cookie: SA, form: new FormData() });
    check("no file -> 400", upNone.status === 400 && /required/.test(upNone.json?.message || ""), upNone.json);

    const upWrongField = await req("POST", "/api/insights/images", {
      cookie: SA, form: imageForm(await pngSmall(), "image/png", "photo"),
    });
    check("wrong field name -> 400", upWrongField.status === 400 && /single form-data field named 'image'/.test(upWrongField.json?.message || ""), upWrongField.json);

    // ── Cleanup and summary ───────────────────────────────────────
    await killServer(S.child);
    S = null;

    await cleanupDb();
    check("cleanup removed every test post", (await myPostCount()) === 0, await myPostCount());
    const seedStillThere = await db.query("SELECT id FROM posts WHERE slug = $1", [SEED_SLUG]);
    check("seed post untouched", seedStillThere.rows.length === 1);
    const usersLeft = await db.query("SELECT id FROM users WHERE email = $1", [ADMIN_EMAIL]);
    check("temp admin removed", usersLeft.rows.length === 0);

    // Remove only the files this run created
    for (const f of listUploadFiles()) {
      if (!uploadsBefore.has(f)) fs.rmSync(path.join(uploadsDir(), f), { force: true });
    }
    const filesNow = [...listUploadFiles()];
    check("uploads/insights back to its starting state",
      filesNow.every((f) => uploadsBefore.has(f)), filesNow);

    console.log(`\n${passCount} passed, ${failCount} failed`);
    process.exitCode = failCount > 0 ? 1 : 0;

  } catch (err) {
    console.error("TEST RUN ERROR:", err.message);
    process.exitCode = 1;
  } finally {
    if (S) await killServer(S.child);
    await db.end();
  }
})();
