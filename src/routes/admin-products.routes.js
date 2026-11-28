/**
 * src/routes/admin-products.routes.js
 *
 * Mounted at /api/admin/products
 *
 * Product management list + detail for the admin panel: inactive
 * products are included, and soft-deleted ones appear with ?deleted=true
 * (super_admin only). Every route needs authentication; both 'admin'
 * and 'super_admin' may use it. All other product routes live in
 * products.routes.js.
 */

const express  = require("express");
const { query } = require("express-validator");

const { listAdminProducts, getAdminProductById } = require("../controllers/products.controller");
const authenticate = require("../middleware/authenticate");
const authorize    = require("../middleware/authorize");

const router = express.Router();

// Every route in this file needs authentication; admins and super admins
router.use(authenticate, authorize("admin", "super_admin"));

// ── Validation rules ─────────────────────────────────────────────────
// Same pagination / filter rules as the public list (see products.routes.js),
// plus the ?deleted=true|false switch. Note: express-validator v7
// sanitizers do not write back into req.query, so the controller parses
// the numeric fields itself – only the validation rules live here.

const listValidation = [
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("page must be a positive integer"),
  query("limit")
    .optional()
    .isInt({ min: 1, max: 60 })
    .withMessage("limit must be between 1 and 60"),
  query("availability")
    .optional()
    .isIn(["available", "out_of_stock", "on_request"])
    .withMessage("Availability must be 'available', 'out_of_stock' or 'on_request'"),
  query("sort")
    .optional()
    .isIn(["newest", "name", "created_asc", "created_desc"])
    .withMessage("sort must be 'newest', 'name', 'created_asc' or 'created_desc'"),
  query("deleted")
    .optional()
    .isIn(["true", "false"])
    .withMessage("deleted must be 'true' or 'false'"),
];

// ── Routes ────────────────────────────────────────────────────────────

// GET /api/admin/products – management list (add ?deleted=true for soft-deleted)
router.get("/", listValidation, listAdminProducts);

// GET /api/admin/products/:id – one product for the edit form
router.get("/:id", getAdminProductById);

module.exports = router;
