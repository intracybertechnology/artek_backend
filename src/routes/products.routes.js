/**
 * src/routes/products.routes.js
 *
 * Mounted at /api/products
 *
 * Public reads (active, non-deleted products only); admin writes for
 * products and their images. Both 'admin' and 'super_admin' may manage
 * products. The admin list + detail live in admin-products.routes.js
 * (mounted at /api/admin/products).
 */

const express  = require("express");
const { body, query } = require("express-validator");

const {
  listProducts,
  getProductBySlug,
  createProduct,
  updateProduct,
  deleteProduct,
  restoreProduct,
  uploadProductImages,
  setImagePrimary,
  reorderImages,
  deleteImage,
} = require("../controllers/products.controller");
const authenticate        = require("../middleware/authenticate");
const authorize           = require("../middleware/authorize");
const { uploadImages }    = require("../middleware/productImageUpload");

const router = express.Router();

// Every write in this file needs authentication, and both
// 'admin' and 'super_admin' may use it.
const requireAdmin = [authenticate, authorize("admin", "super_admin")];

// ── Validation helpers ───────────────────────────────────────────────

// Specifications must be a plain object of key-value pairs where every
// value is a string, number or boolean (stored as JSONB).
const isSpecObject = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Specifications must be an object of key-value pairs");
  }
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (!["string", "number", "boolean"].includes(typeof v)) {
      throw new Error("Specification values must be a string, number or boolean");
    }
  }
  return true;
};

// ── Validation rules ──────────────────────────────────────────────────
// Max lengths match the VARCHAR columns in db/schema.sql
// (products.name 255, model_number 150).
//
// Note: express-validator v7 sanitizers (toInt, toBoolean) do not write
// back into req.query / req.body, so the controller parses the numeric
// fields itself – only the validation rules live here.

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
];

const createValidation = [
  body("name")
    .trim()
    .notEmpty()
    .withMessage("Name is required")
    .isLength({ max: 255 })
    .withMessage("Name must be 255 characters or less"),
  body("model_number")
    .trim()
    .notEmpty()
    .withMessage("Model number is required")
    .isLength({ max: 150 })
    .withMessage("Model number must be 150 characters or less"),
  body("category_id")
    .isInt({ min: 1 })
    .withMessage("A valid category_id is required"),
  body("subcategory_id")
    .optional({ values: "null" })
    .isInt({ min: 1 })
    .withMessage("subcategory_id must be a positive integer"),
  body("brand_id")
    .isInt({ min: 1 })
    .withMessage("A valid brand_id is required"),
  body("description")
    .optional({ values: "null" })
    .isString()
    .withMessage("Description must be a string")
    .trim(),
  body("availability")
    .optional()
    .isIn(["available", "out_of_stock", "on_request"])
    .withMessage("Availability must be 'available', 'out_of_stock' or 'on_request'"),
  body("specifications")
    .optional({ values: "null" })
    .custom(isSpecObject),
  body("is_active")
    .optional()
    .isBoolean()
    .withMessage("is_active must be a boolean"),
];

const updateValidation = [
  body("name")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Name cannot be empty")
    .isLength({ max: 255 })
    .withMessage("Name must be 255 characters or less"),
  body("model_number")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Model number cannot be empty")
    .isLength({ max: 150 })
    .withMessage("Model number must be 150 characters or less"),
  body("category_id")
    .optional()
    .isInt({ min: 1 })
    .withMessage("category_id must be a positive integer"),
  body("subcategory_id")
    .optional({ values: "null" })
    .isInt({ min: 1 })
    .withMessage("subcategory_id must be a positive integer"),
  body("brand_id")
    .optional()
    .isInt({ min: 1 })
    .withMessage("brand_id must be a positive integer"),
  body("description")
    .optional({ values: "null" })
    .isString()
    .withMessage("Description must be a string")
    .trim(),
  body("availability")
    .optional()
    .isIn(["available", "out_of_stock", "on_request"])
    .withMessage("Availability must be 'available', 'out_of_stock' or 'on_request'"),
  body("specifications")
    .optional({ values: "null" })
    .custom(isSpecObject),
  body("is_active")
    .optional()
    .isBoolean()
    .withMessage("is_active must be a boolean"),
];

const reorderValidation = [
  body("imageIds")
    .isArray()
    .withMessage("imageIds must be an array of image ids"),
  body("imageIds.*")
    .isInt({ min: 1 })
    .withMessage("imageIds must contain valid image ids"),
];

// ── Public (no login) ────────────────────────────────────────────────

// GET /api/products – paginated list with filters, search and sort
router.get("/", listValidation, listProducts);

// GET /api/products/:slug – full product with images
router.get("/:slug", getProductBySlug);

// ── Admin (admin or super_admin) ─────────────────────────────────────

// POST /api/products
router.post("/", requireAdmin, createValidation, createProduct);

// PATCH /api/products/:id
router.patch("/:id", requireAdmin, updateValidation, updateProduct);

// DELETE /api/products/:id  (soft delete)
router.delete("/:id", requireAdmin, deleteProduct);

// POST /api/products/:id/restore
router.post("/:id/restore", requireAdmin, restoreProduct);

// POST /api/products/:id/images – multipart upload (field name "images")
router.post("/:id/images", requireAdmin, uploadImages, uploadProductImages);

// PATCH /api/products/:id/images/reorder
// (registered before the :imageId route so "reorder" is never treated as an id)
router.patch("/:id/images/reorder", requireAdmin, reorderValidation, reorderImages);

// PATCH /api/products/:id/images/:imageId/primary
router.patch("/:id/images/:imageId/primary", requireAdmin, setImagePrimary);

// DELETE /api/products/:id/images/:imageId
router.delete("/:id/images/:imageId", requireAdmin, deleteImage);

module.exports = router;
