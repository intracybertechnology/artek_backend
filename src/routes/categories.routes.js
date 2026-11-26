/**
 * src/routes/categories.routes.js
 *
 * Mounted at /api/categories
 *
 * Public reads (menu tree), super_admin writes for categories.
 * Subcategory create lives here too (POST /api/categories/:id/subcategories);
 * subcategory edit/delete lives in subcategories.routes.js.
 */

const express  = require("express");
const { body } = require("express-validator");

const {
  listCategories,
  getCategoryBySlug,
  createCategory,
  updateCategory,
  deleteCategory,
  createSubcategory,
} = require("../controllers/categories.controller");
const authenticate = require("../middleware/authenticate");
const authorize    = require("../middleware/authorize");

const router = express.Router();

// ── Validation rules ───────────────────────────────────────────────
// Max lengths match the VARCHAR(150) columns in db/schema.sql.

const createCategoryValidation = [
  body("name")
    .trim()
    .notEmpty()
    .withMessage("Name is required")
    .isLength({ max: 150 })
    .withMessage("Name must be 150 characters or less"),
  body("description")
    .optional()
    .trim(),
  body("slug")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Slug cannot be empty")
    .isLength({ max: 150 })
    .withMessage("Slug must be 150 characters or less"),
];

const updateCategoryValidation = [
  body("name")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Name cannot be empty")
    .isLength({ max: 150 })
    .withMessage("Name must be 150 characters or less"),
  body("description")
    .optional()
    .trim(),
  body("slug")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Slug cannot be empty")
    .isLength({ max: 150 })
    .withMessage("Slug must be 150 characters or less"),
];

const createSubcategoryValidation = [
  body("name")
    .trim()
    .notEmpty()
    .withMessage("Name is required")
    .isLength({ max: 150 })
    .withMessage("Name must be 150 characters or less"),
  body("slug")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Slug cannot be empty")
    .isLength({ max: 150 })
    .withMessage("Slug must be 150 characters or less"),
];

// ── Public (no login) ─────────────────────────────────────────────

// GET /api/categories – all categories with nested subcategories
router.get("/", listCategories);

// GET /api/categories/:slug – one category with its subcategories
router.get("/:slug", getCategoryBySlug);

// ── Super admin only ──────────────────────────────────────────────

// POST /api/categories
router.post("/", authenticate, authorize("super_admin"), createCategoryValidation, createCategory);

// PATCH /api/categories/:id
router.patch("/:id", authenticate, authorize("super_admin"), updateCategoryValidation, updateCategory);

// DELETE /api/categories/:id
router.delete("/:id", authenticate, authorize("super_admin"), deleteCategory);

// POST /api/categories/:id/subcategories – create a subcategory inside a category
router.post("/:id/subcategories", authenticate, authorize("super_admin"), createSubcategoryValidation, createSubcategory);

module.exports = router;
