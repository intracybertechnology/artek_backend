/**
 * src/routes/admin-insights.routes.js
 *
 * Mounted at /api/admin/insights
 *
 * Management list + detail for the admin panel: drafts and
 * needs-review posts are included, and soft-deleted ones appear for a
 * super_admin with ?deleted=true. All other post routes live in
 * insights.routes.js.
 */

const express  = require("express");
const { query } = require("express-validator");

const { listAdminPosts, getAdminPostById } = require("../controllers/insights.controller");
const authenticate = require("../middleware/authenticate");
const authorize    = require("../middleware/authorize");

const router = express.Router();

// Every route in this file needs authentication; admins and super admins
router.use(authenticate, authorize("admin", "super_admin"));

// ── Validation rules ───────────────────────────────────────────────
const listValidation = [
  query("status")
    .optional()
    .isIn(["draft", "needs-review", "published"])
    .withMessage("Status must be 'draft', 'needs-review' or 'published'"),
  query("deleted")
    .optional()
    .isIn(["true", "false"])
    .withMessage("deleted must be 'true' or 'false'"),
];

// ── Routes ────────────────────────────────────────────────────────────

// GET /api/admin/insights – all posts (drafts included)
router.get("/", listValidation, listAdminPosts);

// GET /api/admin/insights/:id – one post for the edit form
router.get("/:id", getAdminPostById);

module.exports = router;
