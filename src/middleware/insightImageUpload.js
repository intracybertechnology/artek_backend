/**
 * src/middleware/insightImageUpload.js
 *
 * Multer middleware for Insights image uploads
 * (POST /api/insights/images).
 *
 *   - Field name "image", exactly one file
 *   - The file is kept in memory; the controller resizes it (sharp) and
 *     writes it to UPLOAD_DIR/insights
 *   - Only JPG, PNG and WebP are allowed, maximum size 5 MB
 *   - The allowed type is taken from the MIME type, never from the
 *     client file name
 *   - Errors come back as clean 400 JSON instead of an HTML error page
 */

const multer = require("multer");

// Allowed MIME types (the extension actually saved is always .webp,
// because the controller converts every image – see the controller)
const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
};

// Multer setup: memory storage, 5 MB limit, type whitelist
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
const uploadImage = (req, res, next) => {
  upload.single("image")(req, res, (err) => {
    if (err) {
      let message = err.message;

      if (err.code === "LIMIT_FILE_SIZE") {
        message = "Image file is too large. Maximum size is 5 MB";
      } else if (err.code === "LIMIT_UNEXPECTED_FILE") {
        message = "Send the image as a single form-data field named 'image'";
      }

      return res.status(400).json({ success: false, message });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Image file is required. Send it as a form-data field named 'image'",
      });
    }

    next();
  });
};

module.exports = { uploadImage, IMAGE_TYPES };
