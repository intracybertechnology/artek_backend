/**
 * scripts/test-products-api.js
 *
 * One-shot end-to-end test for the products API. Spawns the server,
 * waits for readiness, runs every check against http://localhost:5000,
 * prints PASS/FAIL lines and exits non-zero if anything failed.
 *
 * Run:  node scripts/test-products-api.js
 */

const { spawn, execSync } = require("child_process");
const fs   = require("fs");
const path = require("path");
const sharp = require("sharp");

const BASE = "http://localhost:5000";
let passCount = 0, failCount = 0;

const check = (name, cond, extra) => {
  if (cond) { passCount++; console.log(`  PASS  ${name}`); }
  else      { failCount++; console.log(`  FAIL  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`); }
};

// ── Tiny HTTP helper: returns { status, json, text, cookie } ──────────
const req = async (method, url, { body, cookie, form } = {}) => {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let payload;
  if (form) {
    payload = form;                                    // FormData sets its own content type
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, cookie: res.headers.get("set-cookie")?.split(";")[0] };
};

// ── Server lifecycle ─────────────────────────────────────────────────
const startServer = () => new Promise((resolve, reject) => {
  const child = spawn("node", ["server.js"], { cwd: path.resolve(__dirname, "..") });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });

  const started = Date.now();
  const poll = async () => {
    if (Date.now() - started > 20000) return reject(new Error("server not ready in 20s:\n" + out));
    try {
      const r = await fetch(BASE + "/api/health");
      if (r.ok) resolve(child);
      else setTimeout(poll, 300);
    } catch { setTimeout(poll, 300); }
  };
  setTimeout(poll, 500);
  child.on("exit", (code) => reject(new Error(`server exited early (${code}):\n` + out)));
});

const killServer = (child) => {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); }
  catch { try { child.kill(); } catch { /* already gone */ } }
};

// ── Cleanup: remove leftovers of previous runs so the suite is repeatable ──
// Deletes the temporary test admin, all TEST-* products (image rows
// cascade) and their uploaded files. The 'pg' connection reads the same
// .env as the server.
const cleanup = async () => {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // The slug is intentionally stable across PATCHes, so matching by slug
    // catches test rows even when a run renamed their model number
    const found = await pool.query(
      "SELECT id FROM products WHERE model_number LIKE 'TEST-%' OR slug LIKE '%test-mouse%'"
    );
    await pool.query(
      "DELETE FROM products WHERE model_number LIKE 'TEST-%' OR slug LIKE '%test-mouse%'"
    );
    await pool.query("DELETE FROM users WHERE email = 'apitest.admin@example.com'");
    const uploadDir = path.resolve(__dirname, "..", process.env.UPLOAD_DIR || "./uploads");
    for (const row of found.rows) {
      fs.rmSync(path.join(uploadDir, "products", String(row.id)), { recursive: true, force: true });
    }
  } finally {
    await pool.end();
  }
};

// ── Main test flow ───────────────────────────────────────────────────
(async () => {
  let server;
  try {
    // Remove leftovers of a previous run so the suite is repeatable
    await cleanup();

    server = await startServer();
    console.log("server ready\n");

    // ── Login both roles ──────────────────────────────────────────────
    const login = await req("POST", "/api/auth/login", {
    body: { email: process.env.SUPERADMIN_EMAIL, password: process.env.SUPERADMIN_PASSWORD },
    });
    const SA = login.cookie;                             // super admin cookie
    check("super admin login", login.status === 200 && !!SA);

    // Temp admin (role 'admin') – must also be allowed to manage products
    const mkAdmin = await req("POST", "/api/users", {
      cookie: SA,
      body: { name: "API Test Admin", email: "apitest.admin@example.com", password: "apitest@1234", role: "admin" },
    });
    const loginAdmin = await req("POST", "/api/auth/login", {
      body: { email: "apitest.admin@example.com", password: "apitest@1234" },
    });
    const AD = loginAdmin.cookie;                        // admin cookie
    check("temp admin login", mkAdmin.status === 201 && loginAdmin.status === 200);

    // ── Unauthenticated guards (expect 401) ───────────────────────────
    for (const [m, p] of [
      ["POST", "/api/products"], ["PATCH", "/api/products/1"],
      ["DELETE", "/api/products/1"], ["POST", "/api/products/1/restore"],
      ["POST", "/api/products/1/images"], ["GET", "/api/admin/products"],
      ["GET", "/api/admin/products/1"],
      ["PATCH", "/api/products/1/images/reorder"],
      ["PATCH", "/api/products/1/images/1/primary"],
      ["DELETE", "/api/products/1/images/1"],
    ]) {
      const r = await req(m, p, m === "PATCH" || m === "POST" ? { body: {} } : {});
      check(`401 unauth ${m} ${p}`, r.status === 401, r.status);
    }

    // ── Create: valid, with STRING ids (parsing fix) ────────────────────
    const create = await req("POST", "/api/products", {
      cookie: SA,
      body: {
        name: "API Test Mouse & Pad", model_number: "TEST-MOUSE-01",
        category_id: "1", subcategory_id: "2", brand_id: "5",
        description: "Temp product created by the API test.",
        availability: "available",
        specifications: { dpi: 8000, wireless: true, buttons: 6 },
      },
    });
    check("create with string ids -> 201", create.status === 201, create.json);
    const pid = create.json?.product?.id;
    check("slug generated from name + model",
      create.json?.product?.slug === "api-test-mouse-and-pad-test-mouse-01",
      create.json?.product?.slug);
    check("created_by = super admin", create.json?.product?.created_by === 1, create.json?.product?.created_by);
    check("specifications stored as JSONB",
      Object.keys(create.json?.product?.specifications || {}).length === 3
      && create.json?.product?.specifications?.dpi === 8000
      && create.json?.product?.specifications?.wireless === true
      && create.json?.product?.specifications?.buttons === 6,
      create.json?.product?.specifications);

    // ── Create: validation failures ────────────────────────────────────
    const wrongSub = await req("POST", "/api/products", {
      cookie: SA, body: { name: "X", model_number: "T-1", category_id: "1", subcategory_id: "5", brand_id: "5" },
    });
    check("subcategory not in category -> 422", wrongSub.status === 422, wrongSub.json);

    const dupModel = await req("POST", "/api/products", {
      cookie: SA, body: { name: "X", model_number: "TEST-MOUSE-01", category_id: "1", brand_id: "5" },
    });
    check("duplicate model number -> 409", dupModel.status === 409, dupModel.json);

    const dupSlug = await req("POST", "/api/products", {
      cookie: SA, body: { name: "API Test Mouse & Pad", model_number: "test-mouse-01", category_id: "1", brand_id: "5" },
    });
    check("duplicate slug -> 409", dupSlug.status === 409, dupSlug.json);

    const badAvail = await req("POST", "/api/products", {
      cookie: SA, body: { name: "X", model_number: "T-2", category_id: "1", brand_id: "5", availability: "whenever" },
    });
    check("bad availability -> 422", badAvail.status === 422, badAvail.status);

    const badSpecs = await req("POST", "/api/products", {
      cookie: SA, body: { name: "X", model_number: "T-3", category_id: "1", brand_id: "5", specifications: ["a"] },
    });
    check("specifications array -> 422", badSpecs.status === 422, badSpecs.status);

    const missing = await req("POST", "/api/products", { cookie: SA, body: { category_id: 1 } });
    check("missing name/model -> 422", missing.status === 422, missing.status);

    // ── Create by plain 'admin' role (must also be allowed) ────────────
    const createByAdmin = await req("POST", "/api/products", {
      cookie: AD,
      body: { name: "Admin Role Product", model_number: "TEST-ADMIN-01", category_id: "4", brand_id: "1" },
    });
    check("admin role can create -> 201", createByAdmin.status === 201, createByAdmin.status);
    const pid2 = createByAdmin.json?.product?.id;

    // ── PATCH ──────────────────────────────────────────────────────────
    await new Promise((r) => setTimeout(r, 1100));       // let updated_at tick
    const patch = await req("PATCH", `/api/products/${pid}`, {
      cookie: SA,
      body: { name: "API Test Mouse Renamed", availability: "out_of_stock", specifications: { dpi: 16000 }, is_active: false },
    });
    check("patch fields -> 200", patch.status === 200, patch.json);
    check("patch applies name", patch.json?.product?.name === "API Test Mouse Renamed");
    check("patch applies availability", patch.json?.product?.availability === "out_of_stock");
    check("patch sets updated_at", patch.json?.product?.updated_at > create.json?.product?.created_at,
      { created: create.json?.product?.created_at, updated: patch.json?.product?.updated_at });

    const pubAfterInactive = await req("GET", "/api/products?search=TEST-MOUSE");
    check("inactive product hidden from public list",
      pubAfterInactive.json.pagination.total === 0, pubAfterInactive.json.pagination);

    const pubDetail = await req("GET", "/api/products/api-test-mouse-and-pad-test-mouse-01");
    check("inactive product hidden from public detail -> 404", pubDetail.status === 404, pubDetail.status);

    const adminList = await req("GET", "/api/admin/products?search=TEST-MOUSE", { cookie: SA });
    check("inactive product visible in admin list",
      adminList.json.pagination.total === 1 && adminList.json.products[0].is_active === false,
      adminList.json.pagination);
    check("admin list item has is_active/deleted_at flags",
      adminList.json.products[0].hasOwnProperty("deleted_at"));

    const patchDup = await req("PATCH", `/api/products/${pid}`, {
      cookie: SA, body: { model_number: "DS-2CD1043G0-I" },   // belongs to seeded product
    });
    check("patch duplicate model -> 409", patchDup.status === 409, patchDup.status);

    const patchNoFields = await req("PATCH", `/api/products/${pid}`, { cookie: SA, body: {} });
    check("patch no fields -> 400", patchNoFields.status === 400, patchNoFields.status);

    const patch404 = await req("PATCH", "/api/products/999999", { cookie: SA, body: { name: "x" } });
    check("patch missing product -> 404", patch404.status === 404, patch404.status);

    // Admin list pagination (uses the same fixed parser)
    const adminPage = await req("GET", "/api/admin/products?page=2&limit=2", { cookie: SA });
    check("admin list pagination page=2 limit=2",
      adminPage.json.pagination.page === 2 && adminPage.json.pagination.limit === 2,
      adminPage.json.pagination);

    // ── DELETE (soft) / restore ────────────────────────────────────────
    const del = await req("DELETE", `/api/products/${pid}`, { cookie: SA });
    check("soft delete -> 200 with deleted_at set", del.status === 200 && del.json?.product?.deleted_at !== null, del.json?.product?.deleted_at);

    const delAgain = await req("DELETE", `/api/products/${pid}`, { cookie: SA });
    check("second delete -> 409", delAgain.status === 409, delAgain.status);

    const pubDeleted = await req("GET", "/api/products?search=TEST-MOUSE");
    check("deleted product hidden from public", pubDeleted.json.pagination.total === 0);

    const adminNoDeleted = await req("GET", "/api/admin/products?search=TEST-MOUSE", { cookie: SA });
    check("deleted product hidden from admin list without ?deleted=true",
      adminNoDeleted.json.pagination.total === 0, adminNoDeleted.json.pagination);

    const adminDeleted = await req("GET", "/api/admin/products?search=TEST-MOUSE&deleted=true", { cookie: SA });
    check("deleted product in admin list with ?deleted=true",
      adminDeleted.json.pagination.total === 1, adminDeleted.json.pagination);

    const adminDetailDeleted = await req("GET", `/api/admin/products/${pid}`, { cookie: SA });
    check("admin detail works for deleted product", adminDetailDeleted.status === 200, adminDetailDeleted.status);

    const restore = await req("POST", `/api/products/${pid}/restore`, { cookie: SA });
    check("restore -> 200, deleted_at null", restore.status === 200 && restore.json?.product?.deleted_at === null);

    const restoreAgain = await req("POST", `/api/products/${pid}/restore`, { cookie: SA });
    check("restore non-deleted -> 409", restoreAgain.status === 409, restoreAgain.status);

    // ── Images ──────────────────────────────────────────────────────────
    // Fixtures: real PNG (small), big PNG (3000x2000 -> must resize to <=1200),
    // a JPEG, a fake "png" (not really an image), an oversized buffer, and an SVG.
    const pngSmall = await sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
    const pngBig   = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const jpg      = await sharp(pngSmall).jpeg().toBuffer();
    const svg      = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const fakePng  = Buffer.from("this is definitely not an image");
    const tooBig   = Buffer.concat([pngSmall, Buffer.alloc(6 * 1024 * 1024, 7)]); // > 5 MB

    const upload1 = await req("POST", `/api/products/${pid}/images`, {
      cookie: SA,
      form: (() => { const f = new FormData();
        f.append("images", new Blob([pngSmall], { type: "image/png" }), "a.png");
        f.append("images", new Blob([pngBig],   { type: "image/png" }), "b.png");
        f.append("images", new Blob([jpg],      { type: "image/jpeg" }), "c.jpg");
        return f; })(),
    });
    check("upload 3 images -> 201", upload1.status === 201, upload1.json);
    const imgs = upload1.json?.images || [];
    check("3 image rows created", imgs.length === 3, imgs.length);
    check("first image is primary", imgs[0]?.is_primary === true && imgs.filter((i) => i.is_primary).length === 1, imgs);
    check("sort_order 0,1,2", imgs.map((i) => i.sort_order).join(",") === "0,1,2", imgs.map((i) => i.sort_order));
    check("image_path format /uploads/products/<id>/img-<uuid>.webp",
      imgs.every((i) => new RegExp(`^/uploads/products/${pid}/img-[0-9a-f-]{36}\\.webp$`).test(i.image_path)),
      imgs.map((i) => i.image_path));
    check("file_name stored", imgs.every((i) => /^img-[0-9a-f-]{36}\.webp$/.test(i.file_name)), imgs.map((i) => i.file_name));

    // Files exist on disk and were resized to WebP (longest side <= 1200, never enlarged)
    const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads", "products", String(pid));
    let allOnDisk = true, maxSideOk = true, minSideOk = true;
    for (const i of imgs) {
      const p = path.join(uploadDir, i.file_name);
      if (!fs.existsSync(p)) { allOnDisk = false; continue; }
      // sharp(buffer) instead of sharp(path): libvips keeps path-opened files
      // memory-mapped on Windows, which would block the server's unlink
      const meta = await sharp(fs.readFileSync(p)).metadata();
      if (Math.max(meta.width, meta.height) > 1200) maxSideOk = false;
      if (meta.width < 200 || meta.height < 150) minSideOk = false;   // small one must NOT be enlarged
    }
    check("all image files written to UPLOAD_DIR/products/<id>/", allOnDisk);
    check("big image resized to longest side <= 1200", maxSideOk);
    check("small image not enlarged", minSideOk);

    // Primary image shown in the public list
    const pubList = await req("GET", "/api/products?search=TEST-ADMIN");
    check("admin-role product visible publicly", pubList.json.pagination.total === 1);
    // Slug is intentionally NOT changed on rename – re-activate and fetch
    // by the original slug to prove product URLs stay stable.
    await req("PATCH", `/api/products/${pid}`, { cookie: SA, body: { is_active: true } });
    const pubImg = await req("GET", "/api/products/api-test-mouse-and-pad-test-mouse-01");
    check("renamed product still served under original slug", pubImg.status === 200, pubImg.status);

    // Rejections
    const upWrongType = await req("POST", `/api/products/${pid}/images`, {
      cookie: SA, form: (() => { const f = new FormData(); f.append("images", new Blob([svg], { type: "image/svg+xml" }), "x.svg"); return f; })(),
    });
    check("svg upload -> 400", upWrongType.status === 400 && /JPG, PNG, WebP/.test(upWrongType.json?.message || ""), upWrongType.json);

    const upFake = await req("POST", `/api/products/${pid}/images`, {
      cookie: SA, form: (() => { const f = new FormData(); f.append("images", new Blob([fakePng], { type: "image/png" }), "fake.png"); return f; })(),
    });
    check("fake image content -> 400", upFake.status === 400 && /could not be processed/.test(upFake.json?.message || ""), upFake.json);

    const upBig = await req("POST", `/api/products/${pid}/images`, {
      cookie: SA, form: (() => { const f = new FormData(); f.append("images", new Blob([tooBig], { type: "image/png" }), "big.png"); return f; })(),
    });
    check("oversize file -> 400", upBig.status === 400 && /5 MB/.test(upBig.json?.message || ""), upBig.json);

    const upNone = await req("POST", `/api/products/${pid}/images`, { cookie: SA, form: new FormData() });
    check("no file -> 400", upNone.status === 400 && /No images/.test(upNone.json?.message || ""), upNone.json);

    const upSix = await req("POST", `/api/products/${pid}/images`, {
      cookie: SA, form: (() => { const f = new FormData();
        for (let i = 0; i < 6; i++) f.append("images", new Blob([pngSmall], { type: "image/png" }), `s${i}.png`);
        return f; })(),
    });
    check("6 files in one request -> 400", upSix.status === 400 && /at most 5 images at once/.test(upSix.json?.message || ""), upSix.json);

    const upMissingProduct = await req("POST", "/api/products/999999/images", {
      cookie: SA, form: (() => { const f = new FormData(); f.append("images", new Blob([pngSmall], { type: "image/png" }), "a.png"); return f; })(),
    });
    check("upload to missing product -> 404", upMissingProduct.status === 404, upMissingProduct.status);

    // Max 5 in total: 3 exist -> upload 2 more (ok), then 1 more (400)
    const up2more = await req("POST", `/api/products/${pid}/images`, {
      cookie: SA, form: (() => { const f = new FormData();
        f.append("images", new Blob([pngSmall], { type: "image/png" }), "d.png");
        f.append("images", new Blob([pngSmall], { type: "image/png" }), "e.png");
        return f; })(),
    });
    check("upload to 5 total -> 201", up2more.status === 201 && up2more.json?.images?.length === 5, up2more.status);

    const up1more = await req("POST", `/api/products/${pid}/images`, {
      cookie: SA, form: (() => { const f = new FormData(); f.append("images", new Blob([pngSmall], { type: "image/png" }), "f.png"); return f; })(),
    });
    check("6th image -> 400 with clear message",
      up1more.status === 400 && /at most 5 are allowed in total/.test(up1more.json?.message || ""), up1more.json);

    // Reorder (reverse), primary change, delete primary
    const idsInOrder = (await req("GET", `/api/admin/products/${pid}`, { cookie: SA })).json.product.images.map((i) => i.id);
    const reversed = [...idsInOrder].reverse();

    const upBadOrder = await req("PATCH", `/api/products/${pid}/images/reorder`, {
      cookie: SA, body: { imageIds: [reversed[0]] },       // missing ids -> 400
    });
    check("reorder with partial ids -> 400", upBadOrder.status === 400, upBadOrder.status);

    const reorder = await req("PATCH", `/api/products/${pid}/images/reorder`, {
      cookie: SA, body: { imageIds: reversed },
    });
    check("reorder -> 200", reorder.status === 200, reorder.status);
    check("reorder applied (ids reversed)",
      reorder.json?.images?.map((i) => i.id).join(",") === reversed.join(","),
      reorder.json?.images?.map((i) => i.id));

    const newPrimaryId = reorder.json.images[2].id;
    const setPrimary = await req("PATCH", `/api/products/${pid}/images/${newPrimaryId}/primary`, { cookie: SA });
    check("set primary -> 200, exactly one primary",
      setPrimary.status === 200 && setPrimary.json.images.filter((i) => i.is_primary).length === 1
      && setPrimary.json.images.find((i) => i.is_primary).id === newPrimaryId,
      setPrimary.json?.images?.filter((i) => i.is_primary));

    // Delete the primary -> next image (by sort order) becomes primary, file removed
    const fileToDelete = setPrimary.json.images.find((i) => i.is_primary);
    const delImg = await req("DELETE", `/api/products/${pid}/images/${newPrimaryId}`, { cookie: SA });
    check("delete image -> 200, next becomes primary",
      delImg.status === 200 && delImg.json.images.length === 4
      && delImg.json.images.filter((i) => i.is_primary).length === 1
      && delImg.json.images.find((i) => i.is_primary).id === reorder.json.images[3].id,
      delImg.json?.images);
    check("deleted image file removed from disk",
      !fs.existsSync(path.join(uploadDir, fileToDelete.file_name)));

    const delImg404 = await req("DELETE", `/api/products/${pid}/images/${newPrimaryId}`, { cookie: SA });
    check("delete same image again -> 404", delImg404.status === 404, delImg404.status);

    const delForeign = await req("DELETE", `/api/products/${pid2}/images/${delImg.json.images[0].id}`, { cookie: SA });
    check("image of another product -> 404", delForeign.status === 404, delForeign.status);

    // 'admin' role may manage images too
    const upByAdmin = await req("POST", `/api/products/${pid2}/images`, {
      cookie: AD, form: (() => { const f = new FormData(); f.append("images", new Blob([pngSmall], { type: "image/png" }), "a.png"); return f; })(),
    });
    check("admin role can upload images -> 201", upByAdmin.status === 201, upByAdmin.status);

    // ── Summary ───────────────────────────────────────────────────────
    console.log(`\n${passCount} passed, ${failCount} failed`);
    process.exitCode = failCount > 0 ? 1 : 0;

  } catch (err) {
    console.error("TEST RUN ERROR:", err.message);
    process.exitCode = 1;
  } finally {
    if (server) killServer(server);
    // Leave the database clean for the next run
    try { await cleanup(); } catch (e) { console.error("cleanup skipped:", e.message); }
  }
})();
