/**
 * src/routes/subcategories.routes.js
 *
 * Mounted at /api/subcategories
 *
 * Only admin editing lives here (public reads go through
 * GET /api/categories). Every route requires authentication
 * and the super_admin role.
 */

const express  = require("express");
const { body } = require("express-validator");

const { updateSubcategory, deleteSubcategory } = require("../controllers/subcategories.controller");
const authenticate = require("../middleware/authenticate");
const authorize    = require("../middleware/authorize");

const router = express.Router();

// Every route in this file needs authentication and super_admin role
router.use(authenticate, authorize("super_admin"));

// ── Validation rules ───────────────────────────────────────────────
// Max lengths match the VARCHAR(150) columns in db/schema.sql.

const updateSubcategoryValidation = [
  body("name")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Name cannot be empty")
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

// ── Routes ─────────────────────────────────────────────────────────

// PATCH /api/subcategories/:id
router.patch("/:id", updateSubcategoryValidation, updateSubcategory);

// DELETE /api/subcategories/:id
router.delete("/:id", deleteSubcategory);

module.exports = router;
