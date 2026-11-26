/**
 * src/controllers/testimonials.controller.js
 *
 * Testimonials (client quotes) APIs.
 *
 * Public:   GET /api/testimonials – published, non-deleted testimonials
 *           in display order, with an optional ?limit= (default 20,
 *           maximum 50).
 * Admin:    ('admin' and 'super_admin') list + detail, create, update,
 *           reorder and image upload / removal. Soft delete and restore
 *           are super_admin only. The guards live in the routes files.
 *
 * Text:     every text field is HTML-stripped and trimmed before it is
 *           saved (the same approach as quotes.controller.js).
 *
 * Images:   POST /api/testimonials/:id/image resizes the portrait to
 *           fit within 400 x 400 px (never enlarged), converts it to
 *           WebP (quality 80) and stores it under UPLOAD_DIR/testimonials.
 *           image_path holds the public web path
 *           (/uploads/testimonials/<file>), served by express.static.
 *
 * Deletes:  testimonials are only ever soft-deleted (deleted_at set).
 */

const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");
const sharp  = require("sharp");

const { validationResult } = require("express-validator");

const pool = require("../config/db");

// ── Constants ────────────────────────────────────────────────────────

// Columns returned by every query (mapTestimonial shapes the response)
const TESTIMONIAL_COLUMNS =
  "id, name, role, company, quote, rating, image_path, is_published, " +
  "sort_order, created_by, deleted_at, created_at, updated_at";

// Public web path prefix stored in image_path
const IMAGE_PATH_PREFIX = "/uploads/testimonials/";

// Gap between two sort_order values (10, 20, 30, ...) used both for
// new testimonials and by PATCH /reorder
const SORT_STEP = 10;

// ── Helpers ──────────────────────────────────────────────────────────

// Parse a numeric route parameter; null when the value is not a whole
// positive number, so handlers answer with a clean 404 instead of a
// database error.
const parseId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// Strip HTML tags from a text field (same approach as quotes.controller.js)
const stripHtml = (value) =>
  typeof value === "string" ? value.replace(/<[^>]*>/g, "") : value;

// Clean a text field: strip HTML, trim, empty becomes null (the
// optional role / company columns are nullable)
const cleanText = (value) => {
  if (value === undefined || value === null) return null;
  const cleaned = stripHtml(value).trim();
  return cleaned === "" ? null : cleaned;
};

// Shape a row for the response in the camelCase form the React
// frontend expects. The public form (admin: false) omits the internal
// fields isPublished, sortOrder, createdAt and updatedAt.
const mapTestimonial = (row, { admin = false } = {}) => {
  const testimonial = {
    id:      row.id,
    quote:   row.quote,
    name:    row.name,
    role:    row.role,
    company: row.company,
    rating:  row.rating,
    image:   row.image_path,
  };
  if (admin) {
    testimonial.isPublished = row.is_published;
    testimonial.sortOrder   = row.sort_order;
    testimonial.createdAt   = row.created_at;
    testimonial.updatedAt   = row.updated_at;
  }
  return testimonial;
};

// image_path is a public web path ("/uploads/testimonials/<file>");
// convert it back to a path inside UPLOAD_DIR/testimonials. Returns
// null for anything that does not look like one of our own files.
const imageFileOnDisk = (imagePath) => {
  if (typeof imagePath !== "string" || !imagePath.startsWith(IMAGE_PATH_PREFIX)) return null;

  const fileName = imagePath.slice(IMAGE_PATH_PREFIX.length);
  // Never allow a path (or a parent directory) – only a plain file name
  if (!fileName || fileName === "." || fileName === ".." ||
      fileName.includes("/") || fileName.includes("\\")) {
    return null;
  }

  const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads");
  return path.join(uploadDir, "testimonials", fileName);
};

// Remove a stored image file, ignoring errors: the database row is the
// source of truth, a missing file must never fail the request.
const removeStoredImage = async (imagePath) => {
  const filePath = imageFileOnDisk(imagePath);
  if (filePath) {
    await fs.promises.unlink(filePath).catch(() => {});
  }
};

// One testimonial by id, or null when it does not exist
const findById = async (id) => {
  const result = await pool.query(
    `SELECT ${TESTIMONIAL_COLUMNS} FROM testimonials WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
};

// ══════════════════════════════════════════════════════════════════════
//  Public endpoint
// ══════════════════════════════════════════════════════════════════════

// ── GET /api/testimonials ────────────────────────────────────────────
// Published, non-deleted testimonials in display order. ?limit= defaults
// to 20 and is capped at 50 by the validation rules in the route file.
const listTestimonials = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const limit = parseInt(req.query.limit, 10) || 20;

    const result = await pool.query(
      `SELECT ${TESTIMONIAL_COLUMNS} FROM testimonials
       WHERE is_published = true AND deleted_at IS NULL
       ORDER BY sort_order ASC, id ASC
       LIMIT $1`,
      [limit]
    );

    return res.status(200).json({
      success: true,
      testimonials: result.rows.map((row) => mapTestimonial(row)),
    });

  } catch (err) {
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════════════
//  Admin: list + detail (unpublished included; deleted for super_admin)
// ══════════════════════════════════════════════════════════════════════

// ── GET /api/admin/testimonials ─────────────────────────────────────
// Every active testimonial, published or not, in display order.
// ?deleted=true returns the soft-deleted ones instead (the "trash"),
// and only a super_admin may ask for them.
const listAdminTestimonials = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const wantDeleted = req.query.deleted === "true";

    // Deleted testimonials are a super_admin concern only
    if (wantDeleted && req.user.role !== "super_admin") {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to perform this action",
      });
    }

    const result = await pool.query(
      `SELECT ${TESTIMONIAL_COLUMNS} FROM testimonials
       WHERE deleted_at IS ${wantDeleted ? "NOT NULL" : "NULL"}
       ORDER BY sort_order ASC, id ASC`
    );

    return res.status(200).json({
      success: true,
      testimonials: result.rows.map((row) => mapTestimonial(row, { admin: true })),
    });

  } catch (err) {
    next(err);
  }
};

// ── GET /api/admin/testimonials/:id ─────────────────────────────────
// One testimonial for the edit form (any publishing state).
const getAdminTestimonialById = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ success: false, message: "Testimonial not found" });
    }

    const row = await findById(id);
    if (!row) {
      return res.status(404).json({ success: false, message: "Testimonial not found" });
    }

    // Deleted testimonials are a super_admin concern only (same rule as
    // the list)
    if (row.deleted_at !== null && req.user.role !== "super_admin") {
      return res.status(404).json({ success: false, message: "Testimonial not found" });
    }

    return res.status(200).json({
      success: true,
      testimonial: mapTestimonial(row, { admin: true }),
    });

  } catch (err) {
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════════════
//  Admin: create / update / reorder
// ══════════════════════════════════════════════════════════════════════

// ── POST /api/testimonials ───────────────────────────────────────────
const createTestimonial = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    // req.body is guaranteed to be a JSON object by requireJsonBody in
    // the route file; read it defensively all the same.
    const body = req.body || {};

    // Clean the text fields: strip HTML tags, trim, empty -> null.
    // (express-validator does not write sanitised values back into
    // req.body, so the cleaning is done here.)
    const name    = cleanText(body.name);
    const quote   = cleanText(body.quote);
    const role    = cleanText(body.role);
    const company = cleanText(body.company);

    // Validation passed, but stripping tags may have emptied a field
    if (!name || !quote) {
      return res.status(422).json({
        success: false,
        message: "Name and quote are required",
      });
    }

    // Optional rating: an integer 1-5, or null
    const rating = body.rating === undefined || body.rating === null
      ? null
      : parseInt(body.rating, 10);

    // Optional flag – published by default
    const isPublished = body.isPublished === undefined || body.isPublished === null
      ? true
      : body.isPublished;

    // Optional sort order – when missing, append after the current last
    // one (current maximum + 10)
    let sortOrder;
    if (body.sortOrder === undefined || body.sortOrder === null) {
      // SORT_STEP is a fixed server-side constant, so it is safe to
      // interpolate it into the query (no user input involved)
      const max = await pool.query(
        `SELECT COALESCE(MAX(sort_order), 0) + ${SORT_STEP} AS next FROM testimonials`
      );
      sortOrder = max.rows[0].next;
    } else {
      sortOrder = parseInt(body.sortOrder, 10);
    }

    const result = await pool.query(
      `INSERT INTO testimonials
         (name, role, company, quote, rating, is_published, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${TESTIMONIAL_COLUMNS}`,
      [name, role, company, quote, rating, isPublished, sortOrder, req.user.id]
    );

    return res.status(201).json({
      success: true,
      testimonial: mapTestimonial(result.rows[0], { admin: true }),
    });

  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/testimonials/:id ──────────────────────────────────────
// Updates any of the create fields and always sets updated_at.
const updateTestimonial = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ success: false, message: "Testimonial not found" });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    if (!(await findById(id))) {
      return res.status(404).json({ success: false, message: "Testimonial not found" });
    }

    const body = req.body || {};

    // Build the update dynamically – only set fields that were sent
    // (undefined = not sent; null clears the optional fields)
    const updates = [];
    const values  = [];
    let   idx     = 1;

    if (body.name !== undefined)
      { updates.push(`name = $${idx++}`);    values.push(cleanText(body.name)); }
    if (body.quote !== undefined)
      { updates.push(`quote = $${idx++}`);   values.push(cleanText(body.quote)); }
    if (body.role !== undefined)
      { updates.push(`role = $${idx++}`);    values.push(cleanText(body.role)); }
    if (body.company !== undefined)
      { updates.push(`company = $${idx++}`); values.push(cleanText(body.company)); }
    if (body.rating !== undefined)
      { updates.push(`rating = $${idx++}`);  values.push(body.rating === null ? null : parseInt(body.rating, 10)); }
    if (body.isPublished !== undefined && body.isPublished !== null)
      { updates.push(`is_published = $${idx++}`); values.push(body.isPublished); }
    if (body.sortOrder !== undefined)
      { updates.push(`sort_order = $${idx++}`);   values.push(parseInt(body.sortOrder, 10)); }

    // An empty body has nothing to update – a clean 400, never a no-op
    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Request body must be JSON",
      });
    }

    // Spec: a PATCH always sets updated_at
    updates.push("updated_at = NOW()");

    values.push(id);
    const result = await pool.query(
      `UPDATE testimonials SET ${updates.join(", ")} WHERE id = $${idx}
       RETURNING ${TESTIMONIAL_COLUMNS}`,
      values
    );

    return res.status(200).json({
      success: true,
      testimonial: mapTestimonial(result.rows[0], { admin: true }),
    });

  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/testimonials/reorder ──────────────────────────────────
// Body { ids: [3, 1, 2] } – rewrites sort_order to 10, 20, 30, ... in
// exactly that order, in one transaction, so the list is never left
// half-reordered. Unknown or soft-deleted ids are rejected with 422.
const reorderTestimonials = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const body = req.body || {};
    const orderedIds = (body.ids || []).map((value) => parseInt(value, 10));

    // Every id must be an existing, non-deleted testimonial
    const found = await pool.query(
      "SELECT id FROM testimonials WHERE id = ANY($1::int[]) AND deleted_at IS NULL",
      [orderedIds]
    );
    const foundIds = new Set(found.rows.map((row) => row.id));
    const unknown  = orderedIds.filter((id) => !foundIds.has(id));

    if (unknown.length > 0) {
      return res.status(422).json({
        success: false,
        message: `Unknown or deleted testimonial id(s): ${unknown.join(", ")}`,
      });
    }

    // Rewrite sort_order one by one inside a transaction
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          "UPDATE testimonials SET sort_order = $1, updated_at = NOW() WHERE id = $2",
          [(i + 1) * SORT_STEP, orderedIds[i]]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    const result = await pool.query(
      `SELECT ${TESTIMONIAL_COLUMNS} FROM testimonials
       WHERE deleted_at IS NULL
       ORDER BY sort_order ASC, id ASC`
    );

    return res.status(200).json({
      success: true,
      message: "Testimonials reordered successfully",
      testimonials: result.rows.map((row) => mapTestimonial(row, { admin: true })),
    });

  } catch (err) {
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════════════
//  Admin: image upload / removal
// ══════════════════════════════════════════════════════════════════════

// ── POST /api/testimonials/:id/image ─────────────────────────────────
// One portrait per request (field "image"). The uploadImage middleware
// has already checked the file type, the 2 MB limit and attached the
// file as req.file. The image is stored as WebP, resized to fit within
// 400 x 400 px (never enlarged).
const uploadTestimonialImage = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ success: false, message: "Testimonial not found" });
    }

    const existing = await findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Testimonial not found" });
    }

    // Resize and convert to WebP before anything is written to disk
    let processed;
    try {
      processed = await sharp(req.file.buffer)
        .resize(400, 400, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
    } catch (err) {
      // The MIME type was fine but the content is not a real image
      return res.status(400).json({
        success: false,
        message: `The file "${req.file.originalname}" could not be processed as an image`,
      });
    }

    // Safe unique file name – the extension is always our WebP output,
    // never taken from the client file name
    const fileName = `testimonial-${crypto.randomUUID()}.webp`;
    const imagePath = `${IMAGE_PATH_PREFIX}${fileName}`;

    const uploadDir      = path.resolve(process.env.UPLOAD_DIR || "./uploads");
    const testimonialsDir = path.join(uploadDir, "testimonials");
    fs.mkdirSync(testimonialsDir, { recursive: true });
    await fs.promises.writeFile(path.join(testimonialsDir, fileName), processed);

    // Store the new path and delete the old file when replacing
    const result = await pool.query(
      `UPDATE testimonials SET image_path = $1, updated_at = NOW() WHERE id = $2
       RETURNING ${TESTIMONIAL_COLUMNS}`,
      [imagePath, id]
    );
    await removeStoredImage(existing.image_path);

    return res.status(201).json({
      success: true,
      message: "Image uploaded successfully",
      testimonial: mapTestimonial(result.rows[0], { admin: true }),
    });

  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/testimonials/:id/image ───────────────────────────────
// Removes the stored file and sets image_path back to NULL.
const deleteTestimonialImage = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ success: false, message: "Testimonial not found" });
    }

    const existing = await findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Testimonial not found" });
    }
    if (!existing.image_path) {
      return res.status(400).json({
        success: false,
        message: "This testimonial has no image",
      });
    }

    const result = await pool.query(
      `UPDATE testimonials SET image_path = NULL, updated_at = NOW() WHERE id = $1
       RETURNING ${TESTIMONIAL_COLUMNS}`,
      [id]
    );
    await removeStoredImage(existing.image_path);

    return res.status(200).json({
      success: true,
      message: "Image deleted successfully",
      testimonial: mapTestimonial(result.rows[0], { admin: true }),
    });

  } catch (err) {
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════════════
//  Super admin: soft delete / restore
// ══════════════════════════════════════════════════════════════════════

// ── DELETE /api/testimonials/:id  (soft delete) ──────────────────────
const deleteTestimonial = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ success: false, message: "Testimonial not found" });
    }

    const existing = await findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Testimonial not found" });
    }
    if (existing.deleted_at !== null) {
      return res.status(409).json({ success: false, message: "Testimonial is already deleted" });
    }

    const result = await pool.query(
      `UPDATE testimonials SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1
       RETURNING ${TESTIMONIAL_COLUMNS}`,
      [id]
    );

    return res.status(200).json({
      success: true,
      message: "Testimonial deleted successfully",
      testimonial: mapTestimonial(result.rows[0], { admin: true }),
    });

  } catch (err) {
    next(err);
  }
};

// ── POST /api/testimonials/:id/restore ───────────────────────────────
const restoreTestimonial = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ success: false, message: "Testimonial not found" });
    }

    const existing = await findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Testimonial not found" });
    }
    if (existing.deleted_at === null) {
      return res.status(409).json({ success: false, message: "Testimonial is not deleted" });
    }

    const result = await pool.query(
      `UPDATE testimonials SET deleted_at = NULL, updated_at = NOW() WHERE id = $1
       RETURNING ${TESTIMONIAL_COLUMNS}`,
      [id]
    );

    return res.status(200).json({
      success: true,
      message: "Testimonial restored successfully",
      testimonial: mapTestimonial(result.rows[0], { admin: true }),
    });

  } catch (err) {
    next(err);
  }
};

module.exports = {
  listTestimonials,
  listAdminTestimonials,
  getAdminTestimonialById,
  createTestimonial,
  updateTestimonial,
  reorderTestimonials,
  uploadTestimonialImage,
  deleteTestimonialImage,
  deleteTestimonial,
  restoreTestimonial,
};
