/**
 * src/routes/insights.routes.js
 *
 * Mounted at /api/insights
 *
 * Public reads (published, non-deleted posts); admin writes for posts
 * and image uploads (both 'admin' and 'super_admin'); soft delete and
 * restore are super_admin only. The admin list + detail live in
 * admin-insights.routes.js (mounted at /api/admin/insights).
 */

const express  = require("express");
const { body, query } = require("express-validator");

const {
  listPosts,
  getPostBySlug,
  createPost,
  updatePost,
  deletePost,
  restorePost,
  uploadInsightImage,
} = require("../controllers/insights.controller");
const authenticate = require("../middleware/authenticate");
const authorize    = require("../middleware/authorize");
const { uploadImage } = require("../middleware/insightImageUpload");

const router = express.Router();

// Guards
const requireAdmin      = [authenticate, authorize("admin", "super_admin")];
const requireSuperAdmin = [authenticate, authorize("super_admin")];

// ── Validation rules ─────────────────────────────────────────────────
// Max lengths match the columns in db/schema.sql.
// The structured fields (body blocks, faqs, tags, relatedServices) are
// validated in the controller with src/utils/postBlocks.js, so the
// messages can name the exact block position (e.g. "body[3]: ...").
//
// Note: express-validator v7 sanitizers do not write back into req.body,
// so the controller trims the text fields itself.

const listValidation = [
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("page must be a positive integer"),
  query("limit")
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage("limit must be between 1 and 100"),
  query("category")
    .optional()
    .isLength({ max: 100 })
    .withMessage("category must be 100 characters or less"),
];

const createValidation = [
  body("title")
    .trim()
    .notEmpty()
    .withMessage("Title is required")
    .isLength({ max: 255 })
    .withMessage("Title must be 255 characters or less"),
  body("slug")
    .optional({ values: "falsy" })     // "", null and undefined all count as "not supplied"
    .isLength({ max: 255 })
    .withMessage("Slug must be 255 characters or less"),
  body("category")
    .trim()
    .notEmpty()
    .withMessage("Category is required")
    .isLength({ max: 100 })
    .withMessage("Category must be 100 characters or less"),
  body("dek")
    .optional({ values: "null" })
    .isString()
    .withMessage("Dek must be a string"),
  body("authorId")
    .optional({ values: "falsy" })
    .isString()
    .withMessage("authorId must be a string")
    .isLength({ max: 100 })
    .withMessage("authorId must be 100 characters or less"),
  body("coverWord")
    .optional({ values: "falsy" })
    .isString()
    .withMessage("coverWord must be a string")
    .isLength({ max: 50 })
    .withMessage("coverWord must be 50 characters or less"),
  body("featured")
    .optional({ values: "null" })
    .isBoolean()
    .withMessage("featured must be a boolean"),
  body("status")
    .optional({ values: "falsy" })
    .isIn(["draft", "needs-review", "published"])
    .withMessage("Status must be 'draft', 'needs-review' or 'published'"),
  body("publishedAt")
    .optional({ values: "falsy" })
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage("publishedAt must be a date in YYYY-MM-DD format")
    .isDate()
    .withMessage("publishedAt must be a real date in YYYY-MM-DD format"),
  body("seo")
    .optional({ values: "null" })
    .custom((v) => typeof v === "object" && !Array.isArray(v))
    .withMessage("seo must be an object"),
  body("body")
    .exists()
    .withMessage("Body is required")
    .isArray()
    .withMessage("Body must be an array of blocks"),
];

const updateValidation = [
  // Same fields as create, but everything is optional for a PATCH
  body("title")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Title cannot be empty")
    .isLength({ max: 255 })
    .withMessage("Title must be 255 characters or less"),
  body("slug")
    .optional({ values: "falsy" })
    .isLength({ max: 255 })
    .withMessage("Slug must be 255 characters or less"),
  body("category")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Category cannot be empty")
    .isLength({ max: 100 })
    .withMessage("Category must be 100 characters or less"),
  body("dek")
    .optional({ values: "null" })
    .isString()
    .withMessage("Dek must be a string"),
  body("authorId")
    .optional({ values: "falsy" })
    .isString()
    .withMessage("authorId must be a string")
    .isLength({ max: 100 })
    .withMessage("authorId must be 100 characters or less"),
  body("coverWord")
    .optional({ values: "falsy" })
    .isString()
    .withMessage("coverWord must be a string")
    .isLength({ max: 50 })
    .withMessage("coverWord must be 50 characters or less"),
  body("featured")
    .optional({ values: "null" })
    .isBoolean()
    .withMessage("featured must be a boolean"),
  body("status")
    .optional({ values: "falsy" })
    .isIn(["draft", "needs-review", "published"])
    .withMessage("Status must be 'draft', 'needs-review' or 'published'"),
  body("publishedAt")
    .optional({ values: "falsy" })
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage("publishedAt must be a date in YYYY-MM-DD format")
    .isDate()
    .withMessage("publishedAt must be a real date in YYYY-MM-DD format"),
  body("seo")
    .optional({ values: "null" })
    .custom((v) => typeof v === "object" && !Array.isArray(v))
    .withMessage("seo must be an object"),
  body("body")
    .optional({ values: "null" })
    .isArray()
    .withMessage("Body must be an array of blocks"),
];

// ── Public (no login) ────────────────────────────────────────────────

// GET /api/insights – published posts, featured first, newest first
router.get("/", listValidation, listPosts);

// GET /api/insights/:slug – one full post with prev/next
router.get("/:slug", getPostBySlug);

// ── Admin (admin or super_admin) ─────────────────────────────────────

// POST /api/insights/images – one image for use in image blocks
// (registered before the :id routes so "images" is never treated as an id)
router.post("/images", requireAdmin, uploadImage, uploadInsightImage);

// POST /api/insights
router.post("/", requireAdmin, createValidation, createPost);

// PATCH /api/insights/:id
router.patch("/:id", requireAdmin, updateValidation, updatePost);

// ── Super admin only ────────────────────────────────────────────────

// DELETE /api/insights/:id  (soft delete)
router.delete("/:id", requireSuperAdmin, deletePost);

// POST /api/insights/:id/restore
router.post("/:id/restore", requireSuperAdmin, restorePost);

module.exports = router;
