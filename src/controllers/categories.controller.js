/**
 * src/controllers/categories.controller.js
 *
 * Catalog category APIs.
 *
 * Public:   list the menu tree (categories with nested subcategories)
 *           and fetch one category by slug.
 * Admin:    create / update / delete categories and create subcategories.
 *           (Admin routes are guarded in the routes file with
 *            authenticate + authorize("super_admin").)
 *
 * Slugs:    generated from the name when not supplied – see src/utils/slugify.js.
 */

const { validationResult } = require("express-validator");
const pool    = require("../config/db");
const slugify = require("../utils/slugify");

// ── Columns returned by the admin CRUD endpoints ───────────────────
const CATEGORY_COLUMNS = "id, name, slug, description, created_at";

// ── GET /api/categories ─────────────────────────────────────────────
// Full menu tree – only the fields the frontend menu needs.
const listCategories = async (req, res, next) => {
  try {
    const categories = await pool.query(
      "SELECT id, name, slug, description FROM categories ORDER BY name ASC"
    );
    const subcategories = await pool.query(
      "SELECT id, category_id, name, slug FROM subcategories ORDER BY name ASC"
    );

    // Group subcategories by their parent category id
    const subsByCategory = new Map();
    for (const sub of subcategories.rows) {
      const list = subsByCategory.get(sub.category_id) || [];
      list.push({ id: sub.id, name: sub.name, slug: sub.slug });
      subsByCategory.set(sub.category_id, list);
    }

    const result = categories.rows.map((cat) => ({
      id:           cat.id,
      name:         cat.name,
      slug:         cat.slug,
      description:  cat.description,
      subcategories: subsByCategory.get(cat.id) || [],
    }));

    return res.status(200).json({ success: true, categories: result });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/categories/:slug ──────────────────────────────────────
// One category with its subcategories.
const getCategoryBySlug = async (req, res, next) => {
  try {
    const found = await pool.query(
      "SELECT id, name, slug, description FROM categories WHERE slug = $1",
      [req.params.slug]
    );
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }
    const category = found.rows[0];

    const subcategories = await pool.query(
      "SELECT id, name, slug FROM subcategories WHERE category_id = $1 ORDER BY name ASC",
      [category.id]
    );

    return res.status(200).json({
      success: true,
      category: {
        id:           category.id,
        name:         category.name,
        slug:         category.slug,
        description:  category.description,
        subcategories: subcategories.rows,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/categories ───────────────────────────────────────────
const createCategory = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const { name, description, slug: suppliedSlug } = req.body;

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
      "SELECT id FROM categories WHERE name = $1 OR slug = $2",
      [name, slug]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "A category with this name or slug already exists",
      });
    }

    const result = await pool.query(
      `INSERT INTO categories (name, slug, description)
       VALUES ($1, $2, $3)
       RETURNING ${CATEGORY_COLUMNS}`,
      [name, slug, description || null]
    );

    return res.status(201).json({ success: true, category: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/categories/:id ──────────────────────────────────────
const updateCategory = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const id   = parseInt(req.params.id, 10);
    const name = req.body.name;

    // Load the category first
    const found = await pool.query("SELECT * FROM categories WHERE id = $1", [id]);
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }
    const category = found.rows[0];

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

    // Reject a duplicate name or slug (excluding this category itself)
    if (name !== undefined || slug !== undefined) {
      const existing = await pool.query(
        "SELECT id FROM categories WHERE (name = $1 OR slug = $2) AND id <> $3",
        [name !== undefined ? name : category.name,
         slug !== undefined ? slug : category.slug,
         id]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: "A category with this name or slug already exists",
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
    if (req.body.description !== undefined) {
      updates.push(`description = $${idx++}`);
      values.push(req.body.description || null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE categories SET ${updates.join(", ")} WHERE id = $${idx}
       RETURNING ${CATEGORY_COLUMNS}`,
      values
    );

    return res.status(200).json({ success: true, category: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/categories/:id ─────────────────────────────────────
// Deleting a category cascades to its subcategories (see db/schema.sql),
// so it is blocked while any product still points at it.
const deleteCategory = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    const found = await pool.query("SELECT id FROM categories WHERE id = $1", [id]);
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    // Products linked directly or through any subcategory of this category.
    // Soft-deleted products (deleted_at set) no longer count.
    const linked = await pool.query(
      `SELECT COUNT(*)::int AS count FROM products
       WHERE deleted_at IS NULL
         AND (category_id = $1
              OR subcategory_id IN (SELECT id FROM subcategories WHERE category_id = $1))`,
      [id]
    );
    if (linked.rows[0].count > 0) {
      return res.status(409).json({
        success: false,
        message: "Cannot delete this category because it still has products",
      });
    }

    // Subcategories are removed automatically by ON DELETE CASCADE
    await pool.query("DELETE FROM categories WHERE id = $1", [id]);

    return res.status(200).json({ success: true, message: "Category deleted successfully" });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/categories/:id/subcategories ──────────────────────────
// Create a subcategory inside the category given by :id.
const createSubcategory = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const categoryId = parseInt(req.params.id, 10);

    // The parent category must exist
    const parent = await pool.query("SELECT id FROM categories WHERE id = $1", [categoryId]);
    if (parent.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
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

    // Subcategory slugs are unique across all categories (see db/schema.sql)
    const existing = await pool.query(
      "SELECT id FROM subcategories WHERE name = $1 OR slug = $2",
      [name, slug]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "A subcategory with this name or slug already exists",
      });
    }

    const result = await pool.query(
      `INSERT INTO subcategories (category_id, name, slug)
       VALUES ($1, $2, $3)
       RETURNING id, category_id, name, slug`,
      [categoryId, name, slug]
    );

    return res.status(201).json({ success: true, subcategory: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listCategories,
  getCategoryBySlug,
  createCategory,
  updateCategory,
  deleteCategory,
  createSubcategory,
};
