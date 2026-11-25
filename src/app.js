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
// CORS – allow only the React frontend
// ------------------------------------------------------------------
const allowedOrigins = [
  process.env.CLIENT_URL,
  "http://localhost:5173",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. curl, Postman) in development
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin '${origin}' not allowed`));
      }
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
