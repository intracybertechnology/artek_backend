/**
 * src/routes/users.routes.js
 *
 * Mounted at /api/users
 * All routes require: authenticated session + super_admin role
 */

const express      = require("express");
const { body }     = require("express-validator");

const { listUsers, createUser, updateUser, deactivateUser } = require("../controllers/users.controller");
const authenticate = require("../middleware/authenticate");
const authorize    = require("../middleware/authorize");

const router = express.Router();

// Every route in this file needs authentication and super_admin role
router.use(authenticate, authorize("super_admin"));

// ── Validation rules ─────────────────────────────────────────────

const createValidation = [
  body("name")
    .trim()
    .notEmpty()
    .withMessage("Name is required"),
  body("email")
    .isEmail()
    .withMessage("A valid email is required")
    .normalizeEmail(),
  body("password")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters"),
  body("role")
    .isIn(["admin", "super_admin"])
    .withMessage("Role must be 'admin' or 'super_admin'"),
];

const updateValidation = [
  body("name")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Name cannot be empty"),
  body("role")
    .optional()
    .isIn(["admin", "super_admin"])
    .withMessage("Role must be 'admin' or 'super_admin'"),
  body("is_active")
    .optional()
    .isBoolean()
    .withMessage("is_active must be a boolean"),
  body("password")
    .optional()
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters"),
];

// ── Routes ───────────────────────────────────────────────────────

// GET  /api/users
router.get("/", listUsers);

// POST /api/users
router.post("/", createValidation, createUser);

// PATCH /api/users/:id
router.patch("/:id", updateValidation, updateUser);

// DELETE /api/users/:id  (soft-delete)
router.delete("/:id", deactivateUser);

module.exports = router;
