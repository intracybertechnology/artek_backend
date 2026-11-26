/**
 * src/controllers/products.controller.js
 *
 * Product APIs with image upload.
 *
 * Public:   paginated product list (filters, search, sort) and product
 *           detail by slug – active, non-deleted products only.
 * Admin:    create / update / soft-delete / restore products, the admin
 *           list + detail (inactive and soft-deleted included) and all
 *           image management. Both 'admin' and 'super_admin' roles may
 *           use these – the guards live in the routes files.
 *
 * Images:   uploaded via POST /api/products/:id/images, resized with
 *           sharp (longest side max 1200 px, WebP quality 80) and stored
 *           under UPLOAD_DIR/products/<product-id>/. image_path holds
 *           the public web path (/uploads/products/...), which is served
 *           by express.static in app.js.
 *
 * Slugs:    generated from name + model number – see src/utils/slugify.js.
 *
 * Deletes:  products are only ever soft-deleted (deleted_at set);
 *           image rows are the only rows physically deleted.
 */

const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");
const sharp  = require("sharp");

const { validationResult } = require("express-validator");
const pool    = require("../config/db");
const slugify = require("../utils/slugify");

// ── Constants ────────────────────────────────────────────────────────

// Columns returned by create / update / delete / restore
const PRODUCT_COLUMNS =
  "id, name, slug, model_number, description, category_id, subcategory_id, " +
  "brand_id, availability, specifications, is_active, deleted_at, " +
  "created_by, created_at, updated_at";

// How many images one product may have in total
const MAX_IMAGES_PER_PRODUCT = 5;

// Prefix of the public web paths stored in product_images.image_path
const IMAGE_PATH_PREFIX = "/uploads/products/";

// ── Helpers ──────────────────────────────────────────────────────────

// Parse a numeric route parameter; null when the value is not a whole
// positive number, so handlers can answer with a clean 404 instead of
// a database error.
const parseId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// image_path is a public web path ("/uploads/products/<id>/<file>");
// convert it back to a path inside UPLOAD_DIR/products. Returns null
// for anything that does not look like one of our own stored images.
const imageFileOnDisk = (imagePath) => {
  if (typeof imagePath !== "string" || !imagePath.startsWith(IMAGE_PATH_PREFIX)) return null;

  const parts = imagePath.slice(IMAGE_PATH_PREFIX.length).split("/");   // ["<product-id>", "<file>"]
  if (
    parts.length !== 2 ||
    parts.some((p) => !p || p === "." || p === ".." || p.includes("\\"))
  ) {
    return null;
  }

  const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads");
  return path.join(uploadDir, "products", parts[0], parts[1]);
};

// All images of one product, ordered for display (sort_order, then id).
const getProductImages = async (productId) => {
  const result = await pool.query(
    `SELECT id, file_name, image_path, is_primary, sort_order
     FROM product_images
     WHERE product_id = $1
     ORDER BY sort_order ASC, id ASC`,
    [productId]
  );
  return result.rows;
};

// ── Shared SQL for the list endpoints (public + admin) ───────────────
// Only the fields the product cards need. is_active / deleted_at are
// for the admin list; the public mapper does not return them.
// short_description is the description capped at 200 characters – the
// full text is only returned by the detail endpoints.
const LIST_SELECT = `
  SELECT p.id, p.name, p.slug, p.model_number,
         LEFT(p.description, 200) AS short_description,
         p.availability, p.is_active, p.deleted_at,
         b.name AS brand_name,          b.slug AS brand_slug,
         c.name AS category_name,        c.slug AS category_slug,
         s.name AS subcategory_name,     s.slug AS subcategory_slug,
         (SELECT pi.image_path FROM product_images pi
           WHERE pi.product_id = p.id
           ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.id ASC
           LIMIT 1) AS primary_image`;

// Many-to-one joins, so the brand / category / subcategory names travel
// with each row without extra queries. LEFT JOIN: a product whose brand
// or category was deleted must not disappear from the list.
const LIST_FROM = `
  FROM products p
  LEFT JOIN brands        b ON b.id = p.brand_id
  LEFT JOIN categories    c ON c.id = p.category_id
  LEFT JOIN subcategories s ON s.id = p.subcategory_id`;

// ── Shared list query ────────────────────────────────────────────────
// Used by the public list and the admin list so filters, sorting and
// pagination behave identically. `options` decides visibility:
//   includeInactive – do not filter out is_active = false rows (admin)
//   includeDeleted  – do not filter out soft-deleted rows (admin + ?deleted=true)
const findProducts = async (req, options) => {
  const { category, subcategory, brand, search, availability, sort } = req.query;

  // Defaults: page 1, limit 24. express-validator v7 sanitizers do not
  // write back into req.query, so parse the strings here (validation
  // has already rejected anything that is not a valid number).
  const page  = parseInt(req.query.page, 10)  || 1;
  const limit = parseInt(req.query.limit, 10) || 24;

  // Build the WHERE clause with parameterised values only
  const conditions = [];
  const values     = [];

  if (category) {
    values.push(category);
    conditions.push(`c.slug = $${values.length}`);
  }
  if (subcategory) {
    values.push(subcategory);
    conditions.push(`s.slug = $${values.length}`);
  }
  if (brand) {
    values.push(brand);
    conditions.push(`b.slug = $${values.length}`);
  }
  if (availability) {
    values.push(availability);
    conditions.push(`p.availability = $${values.length}`);
  }
  if (search) {
    // Escape LIKE wildcards so user input matches literally
    // (backslash is the default escape character for ILIKE)
    values.push(`%${search.replace(/[%_\\]/g, "\\$&")}%`);
    const n = values.length;
    conditions.push(`(p.name ILIKE $${n} OR p.model_number ILIKE $${n} OR b.name ILIKE $${n})`);
  }

  if (!options.includeInactive) conditions.push("p.is_active = true");
  if (!options.includeDeleted)  conditions.push("p.deleted_at IS NULL");

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Count matching rows first (the LEFT JOINs are many-to-one, so no duplicates)
  const count = await pool.query(`SELECT COUNT(*)::int AS total ${LIST_FROM} ${where}`, values);
  const total = count.rows[0].total;

  // Sort: "name" alphabetically, anything else newest first.
  // The order string is picked from this fixed whitelist, never built from input.
  const orderBy = sort === "name" ? "p.name ASC, p.id ASC" : "p.created_at DESC, p.id DESC";

  values.push(limit);
  const limitPlaceholder = `$${values.length}`;
  values.push((page - 1) * limit);
  const offsetPlaceholder = `$${values.length}`;

  const result = await pool.query(
    `${LIST_SELECT} ${LIST_FROM} ${where} ORDER BY ${orderBy} LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
    values
  );

  return {
    rows: result.rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
};

// ── Shared SELECT for the detail endpoints (public + admin) ──────────
// Joins the brand / category / subcategory so the product comes back
// ready for the frontend.
const DETAIL_SELECT = `
  SELECT p.id, p.name, p.slug, p.model_number, p.description, p.availability,
         p.specifications, p.is_active, p.deleted_at, p.created_by,
         p.created_at, p.updated_at,
         p.brand_id, p.category_id, p.subcategory_id,
         b.name AS brand_name,            b.slug AS brand_slug,
         c.name AS category_name,          c.slug AS category_slug,
         s.name AS subcategory_name,       s.slug AS subcategory_slug
  FROM products p
  LEFT JOIN brands        b ON b.id = p.brand_id
  LEFT JOIN categories    c ON c.id = p.category_id
  LEFT JOIN subcategories s ON s.id = p.subcategory_id`;

// Shape a detail row for the response. `admin` adds the management
// fields (is_active, deleted_at, ...) that the edit form needs.
const buildDetail = (row, images, admin) => {
  const product = {
    id:            row.id,
    name:          row.name,
    slug:          row.slug,
    model_number:  row.model_number,
    description:   row.description,
    availability:  row.availability,
    specifications: row.specifications,
    created_at:    row.created_at,
    brand:          row.brand_id
      ? { id: row.brand_id, name: row.brand_name, slug: row.brand_slug }
      : null,
    category:      row.category_id
      ? { id: row.category_id, name: row.category_name, slug: row.category_slug }
      : null,
    subcategory:   row.subcategory_id
      ? { id: row.subcategory_id, name: row.subcategory_name, slug: row.subcategory_slug }
      : null,
    images,
  };
  if (admin) {
    product.is_active  = row.is_active;
    product.deleted_at = row.deleted_at;
    product.created_by = row.created_by;
    product.updated_at = row.updated_at;
  }
  return product;
};

// Shape one list row for the public list response. "type" is the
// subcategory name – the product type (e.g. "Dome Camera") – and is
// null when the product has no subcategory.
const mapListItem = (row) => ({
  id:               row.id,
  name:             row.name,
  slug:             row.slug,
  model_number:     row.model_number,
  type:             row.subcategory_name || null,
  short_description: row.short_description,
  availability:     row.availability,
  brand:            row.brand_slug
    ? { name: row.brand_name, slug: row.brand_slug }
    : null,
  category:         row.category_slug
    ? { name: row.category_name, slug: row.category_slug }
    : null,
  subcategory:      row.subcategory_slug
    ? { name: row.subcategory_name, slug: row.subcategory_slug }
    : null,
  primary_image:    row.primary_image,
});

// Same shape plus the status flags, for the admin management table
const mapAdminListItem = (row) => ({
  ...mapListItem(row),
  is_active:  row.is_active,
  deleted_at: row.deleted_at,
});

// ══════════════════════════════════════════════════════════════════════
//  Public endpoints
// ══════════════════════════════════════════════════════════════════════

// ── GET /api/products ────────────────────────────────────────────────
// Paginated list of active, non-deleted products with filters, search
// and sorting – the fields the product cards need.
const listProducts = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const { rows, pagination } = await findProducts(req, {
      includeInactive: false,
      includeDeleted:  false,
    });

    return res.status(200).json({
      success: true,
      products: rows.map(mapListItem),
      pagination,
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/products/:slug ──────────────────────────────────────────
// One full product (active and not deleted, or 404) with all its images.
const getProductBySlug = async (req, res, next) => {
  try {
    const found = await pool.query(
      `${DETAIL_SELECT}
       WHERE p.slug = $1 AND p.is_active = true AND p.deleted_at IS NULL`,
      [req.params.slug]
    );

    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const row    = found.rows[0];
    const images = await getProductImages(row.id);

    return res.status(200).json({
      success: true,
      product: buildDetail(row, images, false),
    });
  } catch (err) {
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════════════
//  Admin: product CRUD
// ══════════════════════════════════════════════════════════════════════

// ── POST /api/products ───────────────────────────────────────────────
const createProduct = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const {
      name, model_number, category_id, subcategory_id, brand_id,
      description, availability, specifications, is_active,
    } = req.body;

    // Same reason as parseId: the ids may arrive as strings, so make
    // them real numbers before comparing them with database values
    const categoryId    = parseInt(category_id, 10);
    const brandId       = parseInt(brand_id, 10);
    const subcategoryId = subcategory_id == null ? null : parseInt(subcategory_id, 10);

    // ── Database validations for the given ids ──────────────────────
    const category = await pool.query("SELECT id FROM categories WHERE id = $1", [categoryId]);
    if (category.rows.length === 0) {
      return res.status(422).json({ success: false, message: "Category not found" });
    }

    const brand = await pool.query("SELECT id FROM brands WHERE id = $1", [brandId]);
    if (brand.rows.length === 0) {
      return res.status(422).json({ success: false, message: "Brand not found" });
    }

    // The subcategory (optional) must exist and belong to the category
    if (subcategoryId !== null) {
      const sub = await pool.query(
        "SELECT id, category_id FROM subcategories WHERE id = $1",
        [subcategoryId]
      );
      if (sub.rows.length === 0) {
        return res.status(422).json({ success: false, message: "Subcategory not found" });
      }
      if (sub.rows[0].category_id !== categoryId) {
        return res.status(422).json({
          success: false,
          message: "Subcategory does not belong to the selected category",
        });
      }
    }

    // ── Duplicate checks (cover soft-deleted rows too – the unique
    //    constraints in db/schema.sql apply to all rows) ──────────────
    const dupeModel = await pool.query(
      "SELECT id FROM products WHERE model_number = $1",
      [model_number]
    );
    if (dupeModel.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "A product with this model number already exists",
      });
    }

    // Slug comes from name + model number, capped at the column length
    const slug = slugify(`${name} ${model_number}`).slice(0, 255).replace(/-+$/, "");
    if (!slug) {
      return res.status(422).json({
        success: false,
        message: "Name and model number must contain at least one letter or number",
      });
    }

    const dupeSlug = await pool.query("SELECT id FROM products WHERE slug = $1", [slug]);
    if (dupeSlug.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "A product with this slug already exists",
      });
    }

    const result = await pool.query(
      `INSERT INTO products
         (name, slug, model_number, description, category_id, subcategory_id,
          brand_id, availability, specifications, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
       RETURNING ${PRODUCT_COLUMNS}`,
      [
        name,
        slug,
        model_number,
        description !== undefined ? description : null,
        categoryId,
        subcategoryId,
        brandId,
        availability || "available",
        specifications ? JSON.stringify(specifications) : null,
        is_active !== undefined ? is_active : true,
        req.user.id,                    // who created this product
      ]
    );

    return res.status(201).json({ success: true, product: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/products/:id ──────────────────────────────────────────
// Updates any of the create fields and always sets updated_at.
// The slug is intentionally left unchanged so product URLs stay stable.
const updateProduct = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const found = await pool.query("SELECT * FROM products WHERE id = $1", [id]);
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    const product = found.rows[0];
    const b = req.body;

    // The ids may arrive as strings (see findProducts) – make them
    // real numbers once and use those everywhere below
    const categoryId = b.category_id === undefined
      ? undefined
      : parseInt(b.category_id, 10);
    const brandId = b.brand_id === undefined
      ? undefined
      : parseInt(b.brand_id, 10);
    const subcategoryId = b.subcategory_id === undefined
      ? undefined
      : (b.subcategory_id === null ? null : parseInt(b.subcategory_id, 10));

    // ── Database validations for the fields being changed ────────────
    if (b.model_number !== undefined) {
      const dupe = await pool.query(
        "SELECT id FROM products WHERE model_number = $1 AND id <> $2",
        [b.model_number, id]
      );
      if (dupe.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: "A product with this model number already exists",
        });
      }
    }

    if (categoryId !== undefined) {
      const category = await pool.query("SELECT id FROM categories WHERE id = $1", [categoryId]);
      if (category.rows.length === 0) {
        return res.status(422).json({ success: false, message: "Category not found" });
      }
    }

    if (brandId !== undefined) {
      const brand = await pool.query("SELECT id FROM brands WHERE id = $1", [brandId]);
      if (brand.rows.length === 0) {
        return res.status(422).json({ success: false, message: "Brand not found" });
      }
    }

    // The subcategory (optional, null clears it) must exist and belong
    // to the new category when one is sent, otherwise the current one.
    if (subcategoryId !== undefined && subcategoryId !== null) {
      const subCategoryId = categoryId !== undefined ? categoryId : product.category_id;
      const sub = await pool.query(
        "SELECT id, category_id FROM subcategories WHERE id = $1",
        [subcategoryId]
      );
      if (sub.rows.length === 0) {
        return res.status(422).json({ success: false, message: "Subcategory not found" });
      }
      if (subCategoryId === null || sub.rows[0].category_id !== subCategoryId) {
        return res.status(422).json({
          success: false,
          message: "Subcategory does not belong to the selected category",
        });
      }
    }

    // ── Build the update dynamically – only set fields that were sent ──
    const updates = [];
    const values  = [];
    let   idx     = 1;

    if (b.name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(b.name);
    }
    if (b.model_number !== undefined) {
      updates.push(`model_number = $${idx++}`);
      values.push(b.model_number);
    }
    if (b.description !== undefined) {
      updates.push(`description = $${idx++}`);
      values.push(b.description);
    }
    if (b.availability !== undefined) {
      updates.push(`availability = $${idx++}`);
      values.push(b.availability);
    }
    if (b.specifications !== undefined) {
      updates.push(`specifications = $${idx++}::jsonb`);
      values.push(b.specifications === null ? null : JSON.stringify(b.specifications));
    }
    if (b.is_active !== undefined) {
      updates.push(`is_active = $${idx++}`);
      values.push(b.is_active);
    }
    if (categoryId !== undefined) {
      updates.push(`category_id = $${idx++}`);
      values.push(categoryId);
    }
    if (subcategoryId !== undefined) {
      updates.push(`subcategory_id = $${idx++}`);
      values.push(subcategoryId);
    }
    if (brandId !== undefined) {
      updates.push(`brand_id = $${idx++}`);
      values.push(brandId);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    // Spec: a PATCH always sets updated_at
    updates.push("updated_at = NOW()");

    values.push(id);
    const result = await pool.query(
      `UPDATE products SET ${updates.join(", ")} WHERE id = $${idx}
       RETURNING ${PRODUCT_COLUMNS}`,
      values
    );

    return res.status(200).json({ success: true, product: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/products/:id ─────────────────────────────────────────
// Soft delete only – set deleted_at, never remove the row.
const deleteProduct = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const found = await pool.query(
      "SELECT id, deleted_at FROM products WHERE id = $1",
      [id]
    );
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    if (found.rows[0].deleted_at !== null) {
      return res.status(409).json({ success: false, message: "Product is already deleted" });
    }

    const result = await pool.query(
      `UPDATE products SET deleted_at = NOW() WHERE id = $1
       RETURNING ${PRODUCT_COLUMNS}`,
      [id]
    );

    return res.status(200).json({
      success: true,
      message: "Product deleted successfully",
      product: result.rows[0],
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/products/:id/restore ───────────────────────────────────
// Restore a soft-deleted product (clears deleted_at).
const restoreProduct = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const found = await pool.query(
      "SELECT id, deleted_at FROM products WHERE id = $1",
      [id]
    );
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    if (found.rows[0].deleted_at === null) {
      return res.status(409).json({ success: false, message: "Product is not deleted" });
    }

    const result = await pool.query(
      `UPDATE products SET deleted_at = NULL, updated_at = NOW() WHERE id = $1
       RETURNING ${PRODUCT_COLUMNS}`,
      [id]
    );

    return res.status(200).json({
      success: true,
      message: "Product restored successfully",
      product: result.rows[0],
    });
  } catch (err) {
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════════════
//  Admin: list + detail (includes inactive and soft-deleted products)
// ══════════════════════════════════════════════════════════════════════

// ── GET /api/admin/products ──────────────────────────────────────────
// Same list as the public one, but inactive products are included and
// soft-deleted ones appear with ?deleted=true.
const listAdminProducts = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const { rows, pagination } = await findProducts(req, {
      includeInactive: true,
      includeDeleted:  req.query.deleted === "true",
    });

    return res.status(200).json({
      success: true,
      products: rows.map(mapAdminListItem),
      pagination,
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/admin/products/:id ──────────────────────────────────────
// One product by id – inactive and soft-deleted included – for the edit form.
const getAdminProductById = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const found = await pool.query(`${DETAIL_SELECT} WHERE p.id = $1`, [id]);
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const images = await getProductImages(id);

    return res.status(200).json({
      success: true,
      product: buildDetail(found.rows[0], images, true),
    });
  } catch (err) {
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════════════
//  Admin: product images
// ══════════════════════════════════════════════════════════════════════

// ── POST /api/products/:id/images ────────────────────────────────────
// The uploadImages middleware (src/middleware/productImageUpload.js)
// has already checked the file types, the 5 MB limit per file, the
// 5-files-per-request limit and attached the files as req.files.
const uploadProductImages = async (req, res, next) => {
  try {
    const productId = parseId(req.params.id);
    if (productId === null) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const found = await pool.query("SELECT id FROM products WHERE id = $1", [productId]);
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    // Maximum of 5 images per product in total
    const countResult = await pool.query(
      "SELECT COUNT(*)::int AS count FROM product_images WHERE product_id = $1",
      [productId]
    );
    const existingCount = countResult.rows[0].count;

    if (existingCount + req.files.length > MAX_IMAGES_PER_PRODUCT) {
      return res.status(400).json({
        success: false,
        message: `This product already has ${existingCount} image(s); at most ` +
                 `${MAX_IMAGES_PER_PRODUCT} are allowed in total (you can upload ` +
                 `${MAX_IMAGES_PER_PRODUCT - existingCount} more)`,
      });
    }

    // Resize (longest side at most 1200 px, never enlarged) and convert
    // every image to WebP before anything is written to disk or inserted.
    const processed = [];
    for (const file of req.files) {
      try {
        processed.push(
          await sharp(file.buffer)
            .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer()
        );
      } catch (err) {
        // The MIME type was fine but the content is not a real image
        return res.status(400).json({
          success: false,
          message: `The file "${file.originalname}" could not be processed as an image`,
        });
      }
    }

    // Write the files to UPLOAD_DIR/products/<product-id>/
    const uploadDir  = path.resolve(process.env.UPLOAD_DIR || "./uploads");
    const productDir = path.join(uploadDir, "products", String(productId));
    fs.mkdirSync(productDir, { recursive: true });

    // Safe unique file name – the extension comes from our WebP
    // conversion, never from the client file name
    const newFiles = [];
    for (const buffer of processed) {
      const fileName = `img-${crypto.randomUUID()}.webp`;
      await fs.promises.writeFile(path.join(productDir, fileName), buffer);
      newFiles.push({
        fileName,
        imagePath: `/uploads/products/${productId}/${fileName}`,
        sortOrder: existingCount + newFiles.length,
        // The first image of a product becomes the primary one
        isPrimary: existingCount === 0 && newFiles.length === 0,
      });
    }

    // One database row per file
    for (const file of newFiles) {
      await pool.query(
        `INSERT INTO product_images (product_id, file_name, image_path, is_primary, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [productId, file.fileName, file.imagePath, file.isPrimary, file.sortOrder]
      );
    }

    const images = await getProductImages(productId);

    return res.status(201).json({
      success: true,
      message: `${newFiles.length} image(s) uploaded successfully`,
      images,
    });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/products/:id/images/:imageId/primary ──────────────────
// Make this image the primary one (the others stop being it).
const setImagePrimary = async (req, res, next) => {
  try {
    const productId = parseId(req.params.id);
    const imageId   = parseId(req.params.imageId);
    if (productId === null) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    if (imageId === null) {
      return res.status(404).json({ success: false, message: "Image not found" });
    }

    const found = await pool.query("SELECT id FROM products WHERE id = $1", [productId]);
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const image = await pool.query(
      "SELECT id FROM product_images WHERE id = $1 AND product_id = $2",
      [imageId, productId]
    );
    if (image.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Image not found" });
    }

    // One atomic statement: the chosen image becomes primary,
    // every other image of this product stops being it
    await pool.query(
      "UPDATE product_images SET is_primary = (id = $1) WHERE product_id = $2",
      [imageId, productId]
    );

    const images = await getProductImages(productId);

    return res.status(200).json({
      success: true,
      message: "Primary image updated successfully",
      images,
    });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/products/:id/images/reorder ───────────────────────────
// Accepts the ordered array of all image ids of this product and
// rewrites sort_order to match it (0, 1, 2, ...).
const reorderImages = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const productId = parseId(req.params.id);
    if (productId === null) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const found = await pool.query("SELECT id FROM products WHERE id = $1", [productId]);
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    // The array must contain exactly the ids of all images of this
    // product, in the new order – no extras, none missing, no duplicates
    const current = await pool.query(
      "SELECT id FROM product_images WHERE product_id = $1",
      [productId]
    );
    const currentIds = current.rows.map((r) => r.id).sort((a, b) => a - b);
    const orderedIds = req.body.imageIds.map((v) => parseInt(v, 10));
    const sentIds    = [...orderedIds].sort((a, b) => a - b);

    if (
      sentIds.length !== currentIds.length ||
      sentIds.some((v, i) => v !== currentIds[i])
    ) {
      return res.status(400).json({
        success: false,
        message: "imageIds must contain exactly the ids of all images of this product, in the new order",
      });
    }

    // Rewrite sort_order one by one inside a transaction, so the
    // images never end up in a half-reordered state
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          "UPDATE product_images SET sort_order = $1 WHERE id = $2 AND product_id = $3",
          [i, orderedIds[i], productId]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    const images = await getProductImages(productId);

    return res.status(200).json({
      success: true,
      message: "Images reordered successfully",
      images,
    });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/products/:id/images/:imageId ──────────────────────────
// Deletes the database row and the file from disk. If the primary image
// is deleted, the next image (by sort order) becomes primary.
const deleteImage = async (req, res, next) => {
  try {
    const productId = parseId(req.params.id);
    const imageId   = parseId(req.params.imageId);
    if (productId === null) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    if (imageId === null) {
      return res.status(404).json({ success: false, message: "Image not found" });
    }

    const found = await pool.query("SELECT id FROM products WHERE id = $1", [productId]);
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const image = await pool.query(
      "SELECT id, image_path, is_primary, sort_order FROM product_images WHERE id = $1 AND product_id = $2",
      [imageId, productId]
    );
    if (image.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Image not found" });
    }

    // Delete the row first
    await pool.query("DELETE FROM product_images WHERE id = $1", [imageId]);

    // If that was the primary image, promote the next one: the first
    // image that comes after it in sort order, or (when the deleted
    // image was the last one) simply the first image left.
    if (image.rows[0].is_primary) {
      await pool.query(
        `UPDATE product_images SET is_primary = true
         WHERE product_id = $1
           AND id = (SELECT id FROM product_images
                      WHERE product_id = $1 AND sort_order >= $2
                      ORDER BY sort_order ASC, id ASC
                      LIMIT 1)`,
        [productId, image.rows[0].sort_order]
      );
      await pool.query(
        `UPDATE product_images SET is_primary = true
         WHERE product_id = $1
           AND id = (SELECT id FROM product_images
                      WHERE product_id = $1
                      ORDER BY sort_order ASC, id ASC
                      LIMIT 1)
           AND NOT EXISTS (SELECT 1 FROM product_images WHERE product_id = $1 AND is_primary)`,
        [productId]
      );
    }

    // Remove the file from disk, ignoring errors (the row is already
    // gone – never fail the request because of the filesystem). Awaited
    // so the file is really gone once the response is sent.
    const filePath = imageFileOnDisk(image.rows[0].image_path);
    if (filePath) {
      await fs.promises.unlink(filePath).catch(() => {});
    }

    const images = await getProductImages(productId);

    return res.status(200).json({
      success: true,
      message: "Image deleted successfully",
      images,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listProducts,
  getProductBySlug,
  createProduct,
  updateProduct,
  deleteProduct,
  restoreProduct,
  listAdminProducts,
  getAdminProductById,
  uploadProductImages,
  setImagePrimary,
  reorderImages,
  deleteImage,
};
