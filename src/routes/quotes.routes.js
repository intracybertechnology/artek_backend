/**
 * src/routes/quotes.routes.js
 *
 * Mounted at /api/quotes
 *
 * Public:   visitors submit a quote request (rate limited, honeypot).
 * Admin:    super_admin lists quotes, reads one, updates the status.
 */

const express       = require("express");
const { body, query } = require("express-validator");
const rateLimit     = require("express-rate-limit");

const { createQuote, listQuotes, getQuoteById, updateQuoteStatus } =
  require("../controllers/quotes.controller");
const authenticate = require("../middleware/authenticate");
const authorize    = require("../middleware/authorize");

const router = express.Router();

// ── Rate limiter for the public submit route ────────────────────────
// Max 5 submissions per IP per 15 minutes
const quoteLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             5,
  standardHeaders: true,   // Return rate-limit info in RateLimit-* headers
  legacyHeaders:   false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many quote requests. Please try again after 15 minutes.",
    });
  },
});

// ── Validation rules ─────────────────────────────────────────────────
// Max lengths match the columns in db/schema.sql. The trimming and
// HTML stripping for saving happen in the controller – the chain trims
// only so the length checks see the real content.
//
// Note: "botcheck" is intentionally NOT validated – the honeypot must
// accept any value without complaining.

const createQuoteValidation = [
  body("fullName")
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage("Full name must be between 2 and 100 characters"),
  body("email")
    .isEmail()
    .withMessage("A valid email is required"),
  body("phone")
    .trim()
    .isLength({ min: 6, max: 30 })
    .withMessage("Phone must be between 6 and 30 characters"),
  body("companyName")
    .optional({ values: "null" })
    .trim()
    .isLength({ max: 255 })
    .withMessage("Company name must be 255 characters or less"),
  body("service")
    .optional({ values: "null" })
    .trim()
    .isLength({ max: 100 })
    .withMessage("Service must be 100 characters or less"),
  body("emirate")
    .optional({ values: "null" })
    .trim()
    .isLength({ max: 100 })
    .withMessage("Emirate must be 100 characters or less"),
  body("message")
    .trim()
    .isLength({ min: 5, max: 2000 })
    .withMessage("Message must be between 5 and 2000 characters"),
  body("product_id")
    .optional({ values: "null" })
    .isInt({ min: 1 })
    .withMessage("product_id must be a positive integer"),
  body("product_name")
    .optional({ values: "null" })
    .trim()
    .isLength({ max: 255 })
    .withMessage("Product name must be 255 characters or less"),
  body("model_number")
    .optional({ values: "null" })
    .trim()
    .isLength({ max: 150 })
    .withMessage("Model number must be 150 characters or less"),
  body("brand_name")
    .optional({ values: "null" })
    .trim()
    .isLength({ max: 150 })
    .withMessage("Brand name must be 150 characters or less"),
  body("category")
    .optional({ values: "null" })
    .trim()
    .isLength({ max: 150 })
    .withMessage("Category must be 150 characters or less"),
];

const listValidation = [
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("page must be a positive integer"),
  query("limit")
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage("limit must be between 1 and 100"),
  query("status")
    .optional()
    .isIn(["new", "contacted", "closed"])
    .withMessage("Status must be 'new', 'contacted' or 'closed'"),
];

const updateStatusValidation = [
  body("status")
    .isIn(["new", "contacted", "closed"])
    .withMessage("Status must be 'new', 'contacted' or 'closed'"),
];

// ── Public (no login) ───────────────────────────────────────────────

// POST /api/quotes – submit a quote request (rate limited)
router.post("/", quoteLimiter, createQuoteValidation, createQuote);

// ── Super admin only ────────────────────────────────────────────────

// GET /api/quotes – paginated list, ?status=new|contacted|closed
router.get("/", authenticate, authorize("super_admin"), listValidation, listQuotes);

// GET /api/quotes/:id – one quote
router.get("/:id", authenticate, authorize("super_admin"), getQuoteById);

// PATCH /api/quotes/:id – update the status only
router.patch("/:id", authenticate, authorize("super_admin"), updateStatusValidation, updateQuoteStatus);

module.exports = router;
