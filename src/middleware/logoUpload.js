/**
 * src/middleware/logoUpload.js
 *
 * Multer middleware for brand logo uploads (POST /api/brands/:id/logo).
 *
 *   - Files are kept in memory; the controller writes them to UPLOAD_DIR/brands
 *   - Only JPG, PNG, WebP and SVG are allowed, maximum size 2 MB
 *   - Errors come back as clean 400 JSON instead of an HTML error page
 */

const multer = require("multer");

// Allowed MIME types mapped to the safe file extension we save
const LOGO_TYPES = {
  "image/jpeg":    "jpg",
  "image/png":     "png",
  "image/webp":    "webp",
  "image/svg+xml": "svg",
};

// Multer setup: memory storage, 2 MB limit, type whitelist
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 2 * 1024 * 1024 },   // 2 MB
  fileFilter: (req, file, cb) => {
    if (LOGO_TYPES[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error("Invalid logo file type. Allowed types: JPG, PNG, WebP, SVG"));
    }
  },
});

// Friendly messages for the multer error codes we care about
const ERROR_MESSAGES = {
  LIMIT_FILE_SIZE:        "Logo file is too large. Maximum size is 2 MB",
  LIMIT_UNEXPECTED_FILE:  "Send the logo as a single form-data field named 'logo'",
};

// Wrap multer so its errors return 400 JSON, matching the API style
const uploadLogo = (req, res, next) => {
  upload.single("logo")(req, res, (err) => {
    if (err) {
      const message = err.code && ERROR_MESSAGES[err.code] ? ERROR_MESSAGES[err.code] : err.message;
      return res.status(400).json({ success: false, message });
    }
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Logo file is required. Send it as a form-data field named 'logo'",
      });
    }
    next();
  });
};

module.exports = { uploadLogo, LOGO_TYPES };
