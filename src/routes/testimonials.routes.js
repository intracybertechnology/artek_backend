/**
 * src/routes/testimonials.routes.js
 *
 * Mounted at /api/testimonials
 *
 * Public:   the published testimonial list (no login).
 * Admin:    ('admin' and 'super_admin') create, update, reorder and
 *           image upload / removal. Soft delete and restore are
 *           super_admin only. The admin list + detail live in
 *           admin-testimonials.routes.js (mounted at
 *           /api/admin/testimonials).
 */

const express = require("express");
const { body, query } = require("express-validator");

const {
  listTestimonials,
  createTestimonial,
  updateTestimonial,
  reorderTestimonials,
  uploadTestimonialImage,
  deleteTestimonialImage,
  deleteTestimonial,
  restoreTestimonial,
} = require("../controllers/testimonials.controller");
const authenticate = require("../middleware/authenticate");
const authorize    = require("../middleware/authorize");
const { uploadImage } = require("../middleware/testimonialImageUpload");

const router = express.Router();

// Guards
const requireAdmin      = [authenticate, authorize("admin", "super_admin")];
const requireSuperAdmin = [authenticate, authorize("super_admin")];

// ── Body guard ───────────────────────────────────────────────────────
// A missing, empty or non-JSON-object body must come back as a clean
// 400 – never a server error (reading req.body.x when the body was not
// parsed used to throw). A body that is malformed JSON is already
// answered with 400 by the JSON parser (see middleware/errorHandler.js).
const requireJsonBody = (req, res, next) => {
  const body = req.body;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length === 0
  ) {
    return res.status(400).json({ success: false, message: "Request body must be JSON" });
  }
  next();
};

// ── Validation rules ─────────────────────────────────────────────────
// Max lengths match the columns in db/schema.sql
// (name 100, role 100, company 150, quote TEXT).
//
// Note: express-validator v7 sanitizers do not write back into req.body,
// so the controller strips the HTML tags and trims the text fields
// itself. "optional({ values: 'null' })" means null is accepted and
// clears the (nullable) field; a plain "optional()" only skips
// undefined, so null is rejected.

const listValidation = [
  query("limit")
    .optional()
    .isInt({ min: 1, max: 50 })
    .withMessage("limit must be between 1 and 50"),
];

const createValidation = [
  body("name")
    .trim()
    .notEmpty()
    .withMessage("Name is required")
    .isLength({ min: 2, max: 100 })
    .withMessage("Name must be between 2 and 100 characters"),
  body("quote")
    .trim()
    .notEmpty()
    .withMessage("Quote is required")
    .isLength({ min: 10, max: 1000 })
    .withMessage("Quote must be between 10 and 1000 characters"),
  body("role")
    .optional({ values: "null" })
    .trim()
    .isLength({ max: 100 })
    .withMessage("Role must be 100 characters or less"),
  body("company")
    .optional({ values: "null" })
    .trim()
    .isLength({ max: 150 })
    .withMessage("Company must be 150 characters or less"),
  body("rating")
    .optional({ values: "null" })
    .isInt({ min: 1, max: 5 })
    .withMessage("Rating must be an integer between 1 and 5, or null"),
  body("isPublished")
    .optional()
    .isBoolean()
    .withMessage("isPublished must be a boolean"),
  body("sortOrder")
    .optional()
    .isInt()
    .withMessage("sortOrder must be an integer"),
];

const updateValidation = [
  // Same fields as create, but everything is optional for a PATCH
  body("name")
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage("Name must be between 2 and 100 characters"),
  body("quote")
    .optional()
    .trim()
    .isLength({ min: 10, max: 1000 })
    .withMessage("Quote must be between 10 and 1000 characters"),
  body("role")
    .optional({ values: "null" })
    .trim()
    .isLength({ max: 100 })
    .withMessage("Role must be 100 characters or less"),
  body("company")
    .optional({ values: "null" })
    .trim()
    .isLength({ max: 150 })
    .withMessage("Company must be 150 characters or less"),
  body("rating")
    .optional({ values: "null" })
    .isInt({ min: 1, max: 5 })
    .withMessage("Rating must be an integer between 1 and 5, or null"),
  body("isPublished")
    .optional()
    .isBoolean()
    .withMessage("isPublished must be a boolean"),
  body("sortOrder")
    .optional()
    .isInt()
    .withMessage("sortOrder must be an integer"),
];

const reorderValidation = [
  body("ids")
    .isArray({ min: 1 })
    .withMessage("ids must be a non-empty array of testimonial ids"),
  body("ids.*")
    .isInt({ min: 1 })
    .withMessage("ids must contain valid testimonial ids"),
];

// ── Public (no login) ────────────────────────────────────────────────

// GET /api/testimonials – published testimonials, ?limit= (max 50)
router.get("/", listValidation, listTestimonials);

// ── Admin (admin or super_admin) ─────────────────────────────────────

// POST /api/testimonials
router.post("/", requireAdmin, requireJsonBody, createValidation, createTestimonial);

// PATCH /api/testimonials/reorder
// (registered before the /:id routes so "reorder" is never read as an id)
router.patch("/reorder", requireAdmin, requireJsonBody, reorderValidation, reorderTestimonials);

// PATCH /api/testimonials/:id
router.patch("/:id", requireAdmin, requireJsonBody, updateValidation, updateTestimonial);

// POST /api/testimonials/:id/image – multipart upload (field name "image")
router.post("/:id/image", requireAdmin, uploadImage, uploadTestimonialImage);

// DELETE /api/testimonials/:id/image – remove the portrait
router.delete("/:id/image", requireAdmin, deleteTestimonialImage);

// ── Super admin only ────────────────────────────────────────────────

// DELETE /api/testimonials/:id  (soft delete)
router.delete("/:id", requireSuperAdmin, deleteTestimonial);

// POST /api/testimonials/:id/restore
router.post("/:id/restore", requireSuperAdmin, restoreTestimonial);

module.exports = router;
