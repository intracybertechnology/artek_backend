/**
 * src/routes/brands.routes.js
 *
 * Mounted at /api/brands
 *
 * Public reads, super_admin writes, and brand logo upload
 * (multipart form-data field "logo", see src/middleware/logoUpload.js).
 */

const express  = require("express");
const { body } = require("express-validator");

const {
  listBrands,
  getBrandBySlug,
  createBrand,
  updateBrand,
  deleteBrand,
  uploadBrandLogo,
} = require("../controllers/brands.controller");
const authenticate = require("../middleware/authenticate");
const authorize    = require("../middleware/authorize");
const { uploadLogo } = require("../middleware/logoUpload");

const router = express.Router();

// ── Validation rules ───────────────────────────────────────────────
// Max lengths match the VARCHAR(150) columns in db/schema.sql.

const createBrandValidation = [
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

const updateBrandValidation = [
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

// ── Public (no login) ─────────────────────────────────────────────

// GET /api/brands – all brands, ordered by name
router.get("/", listBrands);

// GET /api/brands/:slug – one brand
router.get("/:slug", getBrandBySlug);

// ── Super admin only ──────────────────────────────────────────────

// POST /api/brands
router.post("/", authenticate, authorize("super_admin"), createBrandValidation, createBrand);

// PATCH /api/brands/:id
router.patch("/:id", authenticate, authorize("super_admin"), updateBrandValidation, updateBrand);

// DELETE /api/brands/:id
router.delete("/:id", authenticate, authorize("super_admin"), deleteBrand);

// POST /api/brands/:id/logo – multipart upload (field name: "logo")
router.post("/:id/logo", authenticate, authorize("super_admin"), uploadLogo, uploadBrandLogo);

module.exports = router;
