const express      = require("express");
const helmet       = require("helmet");
const morgan       = require("morgan");
const cookieParser = require("cookie-parser");
const cors         = require("cors");
const path         = require("path");
const fs           = require("fs");

const apiRoutes                 = require("./routes/index");
const { notFound, errorHandler } = require("./middleware/errorHandler");

const app = express();

// ------------------------------------------------------------------
// Trust proxy (needed for rate limiting behind load balancers / nginx)
// ------------------------------------------------------------------
app.set("trust proxy", 1);

// ------------------------------------------------------------------
// Security & logging
// ------------------------------------------------------------------
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(morgan("dev"));

// ------------------------------------------------------------------
// CORS – allow only the configured frontend origin(s)
// ------------------------------------------------------------------
// CLIENT_URL may hold several origins separated by commas
// (e.g. "https://artek.ae,https://www.artek.ae").
const allowedOrigins = (process.env.CLIENT_URL || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// http://localhost:5173 is a development convenience only
if (process.env.NODE_ENV !== "production") {
  allowedOrigins.push("http://localhost:5173");
}

// Optional regex for extra origins (e.g. Vercel preview deployments):
//   CORS_ORIGIN_REGEX=^https://artek-frontend-.*-intracyber-s-projects\.vercel\.app$
let originRegex = null;
if (process.env.CORS_ORIGIN_REGEX) {
  try {
    originRegex = new RegExp(process.env.CORS_ORIGIN_REGEX);
  } catch (err) {
    console.error(`⚠️  CORS_ORIGIN_REGEX is not a valid regular expression: ${err.message}`);
  }
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Requests with no origin (curl, Postman, health checks) are allowed
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (originRegex && originRegex.test(origin)) return callback(null, true);
      // Not allowed: answer without CORS headers and never throw,
      // so a foreign origin can never cause a server error
      return callback(null, false);
    },
    credentials: true,
  })
);

// ------------------------------------------------------------------
// Body parsing
// ------------------------------------------------------------------
app.use(express.json());
app.use(cookieParser());

// ------------------------------------------------------------------
// Static uploads folder
// ------------------------------------------------------------------
const uploadDir = process.env.UPLOAD_DIR || "./uploads";
const absoluteUploadDir = path.resolve(uploadDir);

if (!fs.existsSync(absoluteUploadDir)) {
  fs.mkdirSync(absoluteUploadDir, { recursive: true });
  console.log(`📁  Created uploads directory: ${absoluteUploadDir}`);
}

app.use("/uploads", express.static(absoluteUploadDir));

// ------------------------------------------------------------------
// API routes
// ------------------------------------------------------------------
app.use("/api", apiRoutes);

// ------------------------------------------------------------------
// Error handling (must come last)
// ------------------------------------------------------------------
app.use(notFound);
app.use(errorHandler);

module.exports = app;
