/**
 * src/controllers/subcategories.controller.js
 *
 * Admin editing of subcategories (super_admin only – guarded in the routes file).
 * Public reads go through GET /api/categories, so there is no public route here.
 *
 * Slugs: generated from the name when not supplied – see src/utils/slugify.js.
 */

const { validationResult } = require("express-validator");
const pool    = require("../config/db");
const slugify = require("../utils/slugify");

// ── PATCH /api/subcategories/:id ───────────────────────────────────
const updateSubcategory = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const id   = parseInt(req.params.id, 10);
    const name = req.body.name;

    // Load the subcategory first
    const found = await pool.query("SELECT * FROM subcategories WHERE id = $1", [id]);
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Subcategory not found" });
    }
    const subcategory = found.rows[0];

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

    // Reject a duplicate name or slug (excluding this subcategory itself)
    if (name !== undefined || slug !== undefined) {
      const existing = await pool.query(
        "SELECT id FROM subcategories WHERE (name = $1 OR slug = $2) AND id <> $3",
        [name !== undefined ? name : subcategory.name,
         slug !== undefined ? slug : subcategory.slug,
         id]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: "A subcategory with this name or slug already exists",
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
      `UPDATE subcategories SET ${updates.join(", ")} WHERE id = $${idx}
       RETURNING id, category_id, name, slug`,
      values
    );

    return res.status(200).json({ success: true, subcategory: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/subcategories/:id ──────────────────────────────────
const deleteSubcategory = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    const found = await pool.query("SELECT id FROM subcategories WHERE id = $1", [id]);
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Subcategory not found" });
    }

    // Block the delete while any product still points at this subcategory.
    // Soft-deleted products (deleted_at set) no longer count.
    const linked = await pool.query(
      "SELECT COUNT(*)::int AS count FROM products WHERE deleted_at IS NULL AND subcategory_id = $1",
      [id]
    );
    if (linked.rows[0].count > 0) {
      return res.status(409).json({
        success: false,
        message: "Cannot delete this subcategory because it still has products",
      });
    }

    await pool.query("DELETE FROM subcategories WHERE id = $1", [id]);

    return res.status(200).json({ success: true, message: "Subcategory deleted successfully" });
  } catch (err) {
    next(err);
  }
};

module.exports = { updateSubcategory, deleteSubcategory };
