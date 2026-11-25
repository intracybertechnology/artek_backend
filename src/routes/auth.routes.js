/**
 * src/routes/auth.routes.js
 *
 * Mounted at /api/auth
 */

const express      = require("express");
const { body }     = require("express-validator");
const rateLimit    = require("express-rate-limit");

const { login, logout, me } = require("../controllers/auth.controller");
const authenticate           = require("../middleware/authenticate");

const router = express.Router();

// ── Rate limiter for the login route only ────────────────────────
// Max 10 attempts per IP per 15 minutes
const loginLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             10,
  standardHeaders: true,   // Return rate-limit info in RateLimit-* headers
  legacyHeaders:   false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many login attempts. Please try again after 15 minutes.",
    });
  },
});

// ── Validation rules for login ───────────────────────────────────
const loginValidation = [
  body("email")
    .isEmail()
    .withMessage("A valid email is required")
    .normalizeEmail(),
  body("password")
    .notEmpty()
    .withMessage("Password is required"),
];

// ── Routes ───────────────────────────────────────────────────────

// POST /api/auth/login
router.post("/login", loginLimiter, loginValidation, login);

// POST /api/auth/logout
router.post("/logout", logout);

// GET /api/auth/me  (requires a valid cookie)
router.get("/me", authenticate, me);

module.exports = router;
