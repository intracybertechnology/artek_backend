/**
 * src/controllers/brands.controller.js
 *
 * Catalog brand APIs.
 *
 * Public:   list all brands and fetch one brand by slug.
 * Admin:    create / update / delete brands and upload a brand logo.
 *           (Admin routes are guarded in the routes file with
 *            authenticate + authorize("super_admin").)
 *
 * Logos:    uploaded via POST /api/brands/:id/logo, stored under
 *           UPLOAD_DIR/brands/ and served from /uploads/brands/ (see app.js).
 *           logo_path holds that public web path.
 */

const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

const { validationResult } = require("express-validator");
const pool    = require("../config/db");
const slugify = require("../utils/slugify");
const { LOGO_TYPES } = require("../middleware/logoUpload");

// ── Columns returned by the admin CRUD endpoints ───────────────────
const BRAND_COLUMNS = "id, name, slug, logo_path, created_at";

// ── Helper: absolute disk path of a stored logo file ────────────────
// logo_path is a public web path ("/uploads/brands/<file>"); convert it
// back to a path inside UPLOAD_DIR/brands. Returns null for anything
// that does not look like one of our own stored logos.
const logoFileOnDisk = (logoPath) => {
  if (!logoPath || !logoPath.startsWith("/uploads/brands/")) return null;
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads");
  // path.basename() strips any directories, so a bad value cannot escape the folder
  return path.join(uploadDir, "brands", path.basename(logoPath));
};

// ── Helper: delete a logo file from disk, ignoring errors ──────────
// (the file may already be gone – never fail the request because of it)
const removeLogoFile = (logoPath) => {
  const filePath = logoFileOnDisk(logoPath);
  if (filePath) {
    fs.unlink(filePath, () => {});
  }
};

// ── GET /api/brands ────────────────────────────────────────────────
// All brands, ordered by name – only the fields the frontend needs.
const listBrands = async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT id, name, slug, logo_path FROM brands ORDER BY name ASC"
    );
    return res.status(200).json({ success: true, brands: result.rows });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/brands/:slug ──────────────────────────────────────────
const getBrandBySlug = async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT id, name, slug, logo_path, created_at FROM brands WHERE slug = $1",
      [req.params.slug]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Brand not found" });
    }
    return res.status(200).json({ success: true, brand: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/brands ────────────────────────────────────────────────
const createBrand = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const { name, slug: suppliedSlug } = req.body;

    // Generate the slug from the name when it was not supplied
    const slug = suppliedSlug || slugify(name);
    if (!slug) {
      return res.status(422).json({
        success: false,
        message: "Slug cannot be empty – the name must contain at least one letter or number",
      });
    }

    // Reject a duplicate name or slug
    const existing = await pool.query(
      "SELECT id FROM brands WHERE name = $1 OR slug = $2",
      [name, slug]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "A brand with this name or slug already exists",
      });
    }

    const result = await pool.query(
      `INSERT INTO brands (name, slug)
       VALUES ($1, $2)
       RETURNING ${BRAND_COLUMNS}`,
      [name, slug]
    );

    return res.status(201).json({ success: true, brand: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/brands/:id ──────────────────────────────────────────
const updateBrand = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const id   = parseInt(req.params.id, 10);
    const name = req.body.name;

    // Load the brand first
    const found = await pool.query("SELECT * FROM brands WHERE id = $1", [id]);
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Brand not found" });
    }
    const brand = found.rows[0];

    // Slug priority: supplied slug > slug generated from the new name > keep current
    let slug;
    if (req.body.slug !== undefined) {
      slug = req.body.slug;
    } else if (name !== undefined) {
      slug = slugify(name);
      if (!slug) {
        return res.status(422).json({
          success: false,
          message: "Slug cannot be empty – the name must contain at least one letter or number",
        });
      }
    }

    // Reject a duplicate name or slug (excluding this brand itself)
    if (name !== undefined || slug !== undefined) {
      const existing = await pool.query(
        "SELECT id FROM brands WHERE (name = $1 OR slug = $2) AND id <> $3",
        [name !== undefined ? name : brand.name,
         slug !== undefined ? slug : brand.slug,
         id]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: "A brand with this name or slug already exists",
        });
      }
    }

    // Build the update dynamically – only set fields that were sent
    const updates = [];
    const values  = [];
    let   idx     = 1;

    if (name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(name);
    }
    if (slug !== undefined) {
      updates.push(`slug = $${idx++}`);
      values.push(slug);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE brands SET ${updates.join(", ")} WHERE id = $${idx}
       RETURNING ${BRAND_COLUMNS}`,
      values
    );

    return res.status(200).json({ success: true, brand: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/brands/:id ──────────────────────────────────────────
const deleteBrand = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    const found = await pool.query("SELECT id, logo_path FROM brands WHERE id = $1", [id]);
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Brand not found" });
    }

    // Block the delete while any product still points at this brand.
    // Soft-deleted products (deleted_at set) no longer count.
    const linked = await pool.query(
      "SELECT COUNT(*)::int AS count FROM products WHERE deleted_at IS NULL AND brand_id = $1",
      [id]
    );
    if (linked.rows[0].count > 0) {
      return res.status(409).json({
        success: false,
        message: "Cannot delete this brand because it still has products",
      });
    }

    await pool.query("DELETE FROM brands WHERE id = $1", [id]);

    // Also remove the logo file so uploads/ does not fill up with orphans
    removeLogoFile(found.rows[0].logo_path);

    return res.status(200).json({ success: true, message: "Brand deleted successfully" });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/brands/:id/logo ───────────────────────────────────────
// The uploadLogo middleware (src/middleware/logoUpload.js) has already
// checked the file type, the 2 MB limit and attached it as req.file.
const uploadBrandLogo = async (req, res, next) => {
  try {
    const brandId = parseInt(req.params.id, 10);

    // The brand must exist before we touch the filesystem
    const found = await pool.query("SELECT id, slug, logo_path FROM brands WHERE id = $1", [brandId]);
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Brand not found" });
    }
    const brand = found.rows[0];

    // Build a safe unique file name – the extension comes from our
    // whitelist, never from the original file name
    const ext      = LOGO_TYPES[req.file.mimetype];
    const fileName = `${brand.slug}-${crypto.randomUUID()}.${ext}`;

    // Make sure UPLOAD_DIR/brands exists, then write the file
    const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads");
    const brandDir  = path.join(uploadDir, "brands");
    fs.mkdirSync(brandDir, { recursive: true });
    await fs.promises.writeFile(path.join(brandDir, fileName), req.file.buffer);

    // Store the public web path served by express.static (see app.js)
    const logoPath = `/uploads/brands/${fileName}`;

    const result = await pool.query(
      `UPDATE brands SET logo_path = $1 WHERE id = $2
       RETURNING id, name, slug, logo_path`,
      [logoPath, brandId]
    );

    // Replace succeeded – delete the previous logo file, if there was one
    removeLogoFile(brand.logo_path);

    return res.status(200).json({
      success: true,
      message: "Logo uploaded successfully",
      brand:   result.rows[0],
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listBrands,
  getBrandBySlug,
  createBrand,
  updateBrand,
  deleteBrand,
  uploadBrandLogo,
};
