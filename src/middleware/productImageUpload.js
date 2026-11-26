/**
 * src/middleware/productImageUpload.js
 *
 * Multer middleware for product image uploads (POST /api/products/:id/images).
 *
 *   - Field name "images", 1 to 5 files per request
 *   - Files are kept in memory; the controller resizes them (sharp) and
 *     writes them to UPLOAD_DIR/products/<product-id>/
 *   - Only JPG, PNG and WebP are allowed, maximum 5 MB each
 *   - The saved file extension comes from the MIME type whitelist,
 *     never from the client file name
 *   - Errors come back as clean 400 JSON instead of an HTML error page
 *
 * The "maximum 5 images per product in total" rule lives in the
 * controller (it needs the count from the database).
 */

const multer = require("multer");

// Allowed MIME types mapped to the safe file extension we save
const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
};

// Multer setup: memory storage, 5 MB per file, type whitelist
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },   // 5 MB
  fileFilter: (req, file, cb) => {
    if (IMAGE_TYPES[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error("Invalid image file type. Allowed types: JPG, PNG, WebP"));
    }
  },
});

// Wrap multer so its errors return 400 JSON, matching the API style
const uploadImages = (req, res, next) => {
  // Second argument = max 5 files per request (multer only caps the maximum)
  upload.array("images", 5)(req, res, (err) => {
    if (err) {
      let message = err.message;

      if (err.code === "LIMIT_FILE_SIZE") {
        message = "Image file is too large. Maximum size is 5 MB per image";
      } else if (err.code === "LIMIT_UNEXPECTED_FILE") {
        // Either a 6th file in "images", or a file under a different field name
        message = err.field === "images"
          ? "You can upload at most 5 images at once"
          : "Send the images as form-data fields named 'images'";
      }

      return res.status(400).json({ success: false, message });
    }

    // "1 to 5 images" – multer cannot enforce a minimum, so check it here
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No images were uploaded. Send them as form-data fields named 'images'",
      });
    }

    next();
  });
};

module.exports = { uploadImages, IMAGE_TYPES };
