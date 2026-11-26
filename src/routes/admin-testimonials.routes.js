/**
 * src/routes/admin-testimonials.routes.js
 *
 * Mounted at /api/admin/testimonials
 *
 * Management list + detail for the admin panel: unpublished
 * testimonials are included, and the soft-deleted ones are returned
 * with ?deleted=true (super_admin only). All other testimonial routes
 * live in testimonials.routes.js.
 */

const express  = require("express");
const { query } = require("express-validator");

const {
  listAdminTestimonials,
  getAdminTestimonialById,
} = require("../controllers/testimonials.controller");
const authenticate = require("../middleware/authenticate");
const authorize    = require("../middleware/authorize");

const router = express.Router();

// Every route in this file needs authentication; admins and super admins
router.use(authenticate, authorize("admin", "super_admin"));

// ── Validation rules ─────────────────────────────────────────────────
const listValidation = [
  query("deleted")
    .optional()
    .isIn(["true", "false"])
    .withMessage("deleted must be 'true' or 'false'"),
];

// ── Routes ────────────────────────────────────────────────────────────

// GET /api/admin/testimonials – all testimonials (?deleted=true for the trash)
router.get("/", listValidation, listAdminTestimonials);

// GET /api/admin/testimonials/:id – one testimonial for the edit form
router.get("/:id", getAdminTestimonialById);

module.exports = router;
