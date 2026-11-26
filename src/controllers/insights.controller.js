/**
 * src/controllers/insights.controller.js
 *
 * Insights (blog) APIs.
 *
 * Public:   the published post list (featured first, newest first, with
 *           the unique category list) and the full post by slug with
 *           its prev/next neighbours (prev = previously published /
 *           older, next = subsequently published / newer).
 * Admin:    ('admin' and 'super_admin') create, update and upload
 *           images; the admin list and detail include drafts and
 *           needs-review posts. Soft delete and restore are
 *           super_admin only.
 *
 * Body:     posts are stored as a JSON array of typed blocks. The
 *           blocks, faqs, tags and relatedServices are validated with
 *           src/utils/postBlocks.js before anything is saved – nothing
 *           is executed or rendered on the server.
 *
 * Images:   POST /api/insights/images resizes to a maximum of 1600 px
 *           on the longest side, converts to WebP and stores the file
 *           under UPLOAD_DIR/insights; the public web path is returned
 *           for use in image blocks.
 *
 * Deletes:  posts are only ever soft-deleted (deleted_at set).
 */

const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");
const sharp  = require("sharp");

const { validationResult } = require("express-validator");

const pool    = require("../config/db");
const slugify = require("../utils/slugify");
const {
  validateBody, validateFaqs, validateShortStrings, readingMinutes,
} = require("../utils/postBlocks");

// ── Columns for every post query ────────────────────────────────────
// published_at is returned as a plain YYYY-MM-DD string (TO_CHAR) so
// the frontend can use it directly.
const POST_COLUMNS = `
  id, slug, title, dek, category, tags, author_id,
  TO_CHAR(published_at, 'YYYY-MM-DD') AS published_at,
  featured, cover_word, body, faqs, related_services, seo, status,
  created_by, deleted_at, created_at, updated_at`;

// ── Helpers ──────────────────────────────────────────────────────────

// Today's date as YYYY-MM-DD in local time (matches the DATE column)
const today = () => {
  const d  = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
};

// Parse a numeric route parameter; null when not a positive whole number
const parseId = (value) => {
  const id = parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// "Was this optional field actually sent?" – null and "" count as absent
const sent = (value) => value !== undefined && value !== null && value !== "";

// Trim a text field (express-validator v7 sanitizers do not write back)
const text = (value) => (typeof value === "string" ? value.trim() : value);

// Shape a post row for the response, in the camelCase form the React
// frontend expects. `full` includes body and faqs (the list omits them);
// `admin` adds the internal deletedAt field.
const mapPost = (row, { full = true, admin = false } = {}) => {
  const post = {
    id:              row.id,
    slug:            row.slug,
    title:           row.title,
    dek:             row.dek,
    category:        row.category,
    tags:            row.tags || [],
    authorId:        row.author_id,
    publishedAt:     row.published_at,
    updatedAt:       row.updated_at,
    featured:        row.featured,
    coverWord:       row.cover_word,
    ...(full ? { body: row.body || [], faqs: row.faqs || [] } : {}),
    relatedServices: row.related_services || [],
    seo:             row.seo,
    status:          row.status,
    readingMinutes:  readingMinutes(row.body || []),
  };
  if (admin) post.deletedAt = row.deleted_at;
  return post;
};

// Deep validation of the structured fields. `requireBody` is true for
// create (body is mandatory) and false for update (only sent fields are
// checked). Returns { values } when valid, or { message } for a 422.
// values only contains the fields that were actually sent.
const validateStructuredFields = (fields, { requireBody = false } = {}) => {
  const values = {};

  if (requireBody || fields.body !== undefined) {
    const r = validateBody(fields.body);
    if (!r.valid) return { message: r.message };
    values.body = r.value;
  }
  if (fields.faqs !== undefined) {
    const r = validateFaqs(fields.faqs);
    if (!r.valid) return { message: r.message };
    values.faqs = r.value;
  }
  if (fields.tags !== undefined) {
    const r = validateShortStrings(fields.tags, "tags");
    if (!r.valid) return { message: r.message };
    values.tags = r.value;
  }
  if (fields.relatedServices !== undefined) {
    const r = validateShortStrings(fields.relatedServices, "relatedServices");
    if (!r.valid) return { message: r.message };
    values.relatedServices = r.value;
  }

  return { values };
};

// ══════════════════════════════════════════════════════════════════════
//  Public endpoints
// ══════════════════════════════════════════════════════════════════════

// ── GET /api/insights ────────────────────────────────────────────────
// Published, non-deleted posts: featured first, then newest published
// first. `categories` lists the unique categories of all published
// posts in order of first appearance in the same ordering.
const listPosts = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    // Defaults: page 1, limit 50 (validation has already capped limit at 100)
    const page  = parseInt(req.query.page, 10)  || 1;
    const limit = parseInt(req.query.limit, 10) || 50;

    // Build the WHERE clause with parameterised values only
    const conditions = ["status = 'published'", "deleted_at IS NULL"];
    const values     = [];
    if (req.query.category) {
      values.push(req.query.category);
      conditions.push(`category = $${values.length}`);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;

    // Featured posts first, then newest published first
    const orderBy = "featured DESC, published_at DESC NULLS LAST, id DESC";

    const count = await pool.query(
      `SELECT COUNT(*)::int AS total FROM posts ${where}`,
      values
    );
    const total = count.rows[0].total;

    values.push(limit);
    const limitPlaceholder = `$${values.length}`;
    values.push((page - 1) * limit);
    const offsetPlaceholder = `$${values.length}`;

    const result = await pool.query(
      `SELECT ${POST_COLUMNS} FROM posts ${where}
       ORDER BY ${orderBy}
       LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      values
    );

    // Unique categories of all published posts, in order of first
    // appearance in the same ordering
    const categoryRows = await pool.query(
      `SELECT category FROM posts
       WHERE status = 'published' AND deleted_at IS NULL
       ORDER BY ${orderBy}`
    );
    const categories = [...new Set(categoryRows.rows.map((r) => r.category))];

    return res.status(200).json({
      success: true,
      posts: result.rows.map((row) => mapPost(row, { full: false })),
      categories,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });

  } catch (err) {
    next(err);
  }
};

// ── GET /api/insights/:slug ──────────────────────────────────────────
// One full published post plus its neighbours by date:
//   prev = the previously published post (the closest older one)
//   next = the subsequently published post (the closest newer one)
// (date first, id as the tie-break – the usual chronological blog
// navigation)
const getPostBySlug = async (req, res, next) => {
  try {
    const found = await pool.query(
      `SELECT ${POST_COLUMNS} FROM posts
       WHERE slug = $1 AND status = 'published' AND deleted_at IS NULL`,
      [req.params.slug]
    );
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }
    const row = found.rows[0];

    const prev = await pool.query(
      `SELECT slug, title FROM posts
       WHERE status = 'published' AND deleted_at IS NULL
         AND (published_at < $1::date OR (published_at = $1::date AND id < $2))
       ORDER BY published_at DESC, id DESC
       LIMIT 1`,
      [row.published_at, row.id]
    );

    const next = await pool.query(
      `SELECT slug, title FROM posts
       WHERE status = 'published' AND deleted_at IS NULL
         AND (published_at > $1::date OR (published_at = $1::date AND id > $2))
       ORDER BY published_at ASC, id ASC
       LIMIT 1`,
      [row.published_at, row.id]
    );

    return res.status(200).json({
      success: true,
      post: mapPost(row, { full: true }),
      prev: prev.rows[0] || null,
      next: next.rows[0] || null,
    });

  } catch (err) {
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════════════
//  Admin: list + detail (include drafts and needs-review posts)
// ══════════════════════════════════════════════════════════════════════

// ── GET /api/admin/insights ─────────────────────────────────────────
// Every post that is not soft-deleted, drafts included. ?status=
// filters, and ?deleted=true also shows soft-deleted posts – but only
// for a super_admin (deleted posts are a super_admin concern).
const listAdminPosts = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const includeDeleted = req.query.deleted === "true" && req.user.role === "super_admin";

    const conditions = [];
    const values     = [];
    if (!includeDeleted) conditions.push("deleted_at IS NULL");
    if (req.query.status) {
      values.push(req.query.status);
      conditions.push(`status = $${values.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `SELECT ${POST_COLUMNS} FROM posts ${where}
       ORDER BY created_at DESC, id DESC`,
      values
    );

    return res.status(200).json({
      success: true,
      posts: result.rows.map((row) => mapPost(row, { full: false, admin: true })),
    });

  } catch (err) {
    next(err);
  }
};

// ── GET /api/admin/insights/:id ─────────────────────────────────────
// One post by id (any status) with the full body, for the edit form.
const getAdminPostById = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    const result = await pool.query(
      `SELECT ${POST_COLUMNS} FROM posts WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    // Deleted posts are a super_admin concern only (same rule as the list)
    if (result.rows[0].deleted_at !== null && req.user.role !== "super_admin") {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    return res.status(200).json({
      success: true,
      post: mapPost(result.rows[0], { full: true, admin: true }),
    });

  } catch (err) {
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════════════
//  Admin: create / update / delete / restore
// ══════════════════════════════════════════════════════════════════════

// ── POST /api/insights ───────────────────────────────────────────────
const createPost = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const b = req.body;

    // Deep validation of the structured fields (the messages name the
    // exact block position, e.g. "body[3]: h2 needs id and text")
    const structured = validateStructuredFields(b, { requireBody: true });
    if (structured.message) {
      return res.status(422).json({ success: false, message: structured.message });
    }

    // Slug: supplied, or generated from the title
    const slug = sent(b.slug) ? text(b.slug) : slugify(b.title);
    if (!slug) {
      return res.status(422).json({
        success: false,
        message: "Slug cannot be empty – the title must contain at least one letter or number",
      });
    }

    // Duplicate slug (the constraint covers drafts and deleted posts too)
    const dupe = await pool.query("SELECT id FROM posts WHERE slug = $1", [slug]);
    if (dupe.rows.length > 0) {
      return res.status(409).json({ success: false, message: "A post with this slug already exists" });
    }

    // Status defaults to draft; publishing without a date uses today
    const status      = sent(b.status) ? b.status : "draft";
    const publishedAt = sent(b.publishedAt)
      ? b.publishedAt
      : (status === "published" ? today() : null);

    const result = await pool.query(
      `INSERT INTO posts
         (slug, title, dek, category, tags, author_id, published_at, featured,
          cover_word, body, faqs, related_services, seo, status, created_by)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7::date, $8, $9,
               $10::jsonb, $11::jsonb, $12::text[], $13::jsonb, $14, $15)
       RETURNING ${POST_COLUMNS}`,
      [
        slug,
        text(b.title),
        sent(b.dek) ? text(b.dek) : null,
        text(b.category),
        structured.values.tags ?? [],
        sent(b.authorId) ? text(b.authorId) : "artek-team",
        publishedAt,
        b.featured !== undefined && b.featured !== null ? b.featured : false,
        sent(b.coverWord) ? text(b.coverWord) : null,
        JSON.stringify(structured.values.body),
        JSON.stringify(structured.values.faqs ?? []),
        structured.values.relatedServices ?? [],
        b.seo !== undefined && b.seo !== null ? JSON.stringify(b.seo) : null,
        status,
        req.user.id,                    // who created this post
      ]
    );

    return res.status(201).json({
      success: true,
      post: mapPost(result.rows[0], { full: true, admin: true }),
    });

  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/insights/:id ──────────────────────────────────────────
// Updates any of the create fields and always sets updated_at.
const updatePost = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    const found = await pool.query(
      `SELECT ${POST_COLUMNS} FROM posts WHERE id = $1`,
      [id]
    );
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }
    const post = found.rows[0];
    const b    = req.body;

    // Deep validation of the structured fields that were sent
    const structured = validateStructuredFields(b);
    if (structured.message) {
      return res.status(422).json({ success: false, message: structured.message });
    }

    // Slug changes are allowed but must stay unique
    if (sent(b.slug) && text(b.slug) !== post.slug) {
      const dupe = await pool.query(
        "SELECT id FROM posts WHERE slug = $1 AND id <> $2",
        [text(b.slug), id]
      );
      if (dupe.rows.length > 0) {
        return res.status(409).json({ success: false, message: "A post with this slug already exists" });
      }
    }

    // Publishing without a date (sent or already stored) uses today
    let publishedAt;
    if (b.status === "published") {
      publishedAt = sent(b.publishedAt) ? b.publishedAt : (post.published_at || today());
    } else if (b.publishedAt !== undefined) {
      publishedAt = sent(b.publishedAt) ? b.publishedAt : null;
    }

    // Build the update dynamically – only set fields that were sent
    const updates = [];
    const values  = [];
    let   idx     = 1;

    if (sent(b.title))            { updates.push(`title = $${idx++}`);    values.push(text(b.title)); }
    if (b.dek !== undefined)     { updates.push(`dek = $${idx++}`);      values.push(sent(b.dek) ? text(b.dek) : null); }
    if (sent(b.category))        { updates.push(`category = $${idx++}`); values.push(text(b.category)); }
    if (structured.values.tags !== undefined)
                                  { updates.push(`tags = $${idx++}::text[]`);  values.push(structured.values.tags); }
    if (sent(b.authorId))        { updates.push(`author_id = $${idx++}`); values.push(text(b.authorId)); }
    if (publishedAt !== undefined)
                                  { updates.push(`published_at = $${idx++}::date`); values.push(publishedAt); }
    if (b.featured !== undefined && b.featured !== null)
                                  { updates.push(`featured = $${idx++}`); values.push(b.featured); }
    if (b.coverWord !== undefined){ updates.push(`cover_word = $${idx++}`); values.push(sent(b.coverWord) ? text(b.coverWord) : null); }
    if (structured.values.body !== undefined)
                                  { updates.push(`body = $${idx++}::jsonb`);  values.push(JSON.stringify(structured.values.body)); }
    if (structured.values.faqs !== undefined)
                                  { updates.push(`faqs = $${idx++}::jsonb`);  values.push(JSON.stringify(structured.values.faqs)); }
    if (structured.values.relatedServices !== undefined)
                                  { updates.push(`related_services = $${idx++}::text[]`); values.push(structured.values.relatedServices); }
    if (b.seo !== undefined)      { updates.push(`seo = $${idx++}::jsonb`); values.push(b.seo === null ? null : JSON.stringify(b.seo)); }
    if (sent(b.status))          { updates.push(`status = $${idx++}`);     values.push(b.status); }
    if (sent(b.slug))            { updates.push(`slug = $${idx++}`);       values.push(text(b.slug)); }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    // Spec: a PATCH always sets updated_at
    updates.push("updated_at = NOW()");

    values.push(id);
    const result = await pool.query(
      `UPDATE posts SET ${updates.join(", ")} WHERE id = $${idx}
       RETURNING ${POST_COLUMNS}`,
      values
    );

    return res.status(200).json({
      success: true,
      post: mapPost(result.rows[0], { full: true, admin: true }),
    });

  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/insights/:id  (super_admin only, soft delete) ────────
const deletePost = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    const found = await pool.query("SELECT id, deleted_at FROM posts WHERE id = $1", [id]);
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }
    if (found.rows[0].deleted_at !== null) {
      return res.status(409).json({ success: false, message: "Post is already deleted" });
    }

    const result = await pool.query(
      `UPDATE posts SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1
       RETURNING ${POST_COLUMNS}`,
      [id]
    );

    return res.status(200).json({
      success: true,
      message: "Post deleted successfully",
      post: mapPost(result.rows[0], { full: false, admin: true }),
    });

  } catch (err) {
    next(err);
  }
};

// ── POST /api/insights/:id/restore  (super_admin only) ──────────────
const restorePost = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    const found = await pool.query("SELECT id, deleted_at FROM posts WHERE id = $1", [id]);
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }
    if (found.rows[0].deleted_at === null) {
      return res.status(409).json({ success: false, message: "Post is not deleted" });
    }

    const result = await pool.query(
      `UPDATE posts SET deleted_at = NULL, updated_at = NOW() WHERE id = $1
       RETURNING ${POST_COLUMNS}`,
      [id]
    );

    return res.status(200).json({
      success: true,
      message: "Post restored successfully",
      post: mapPost(result.rows[0], { full: true, admin: true }),
    });

  } catch (err) {
    next(err);
  }
};

// ── POST /api/insights/images ────────────────────────────────────────
// One image per request (field "image"); the uploadImage middleware
// has already checked the MIME type, the 5 MB limit and attached the
// file as req.file. The image is stored as WebP, resized so the
// longest side is at most 1600 px (never enlarged).
const uploadInsightImage = async (req, res, next) => {
  try {
    // Resize and convert to WebP before anything is written to disk
    let processed;
    try {
      processed = await sharp(req.file.buffer)
        .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true });     // { data, info }
    } catch (err) {
      // The MIME type was fine but the content is not a real image
      return res.status(400).json({
        success: false,
        message: `The file "${req.file.originalname}" could not be processed as an image`,
      });
    }

    // Safe unique file name – the extension is always our WebP output,
    // never taken from the client file name
    const fileName = `insight-${crypto.randomUUID()}.webp`;

    const uploadDir   = path.resolve(process.env.UPLOAD_DIR || "./uploads");
    const insightsDir = path.join(uploadDir, "insights");
    fs.mkdirSync(insightsDir, { recursive: true });
    await fs.promises.writeFile(path.join(insightsDir, fileName), processed.data);

    return res.status(201).json({
      success: true,
      path:   `/uploads/insights/${fileName}`,
      width:  processed.info.width,
      height: processed.info.height,
    });

  } catch (err) {
    next(err);
  }
};

module.exports = {
  listPosts,
  getPostBySlug,
  listAdminPosts,
  getAdminPostById,
  createPost,
  updatePost,
  deletePost,
  restorePost,
  uploadInsightImage,
};
