// 404 – route not found
const notFound = (req, res, next) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
};

// Global error handler (must have 4 parameters so Express recognises it)
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  // A request body that could not be parsed as JSON (malformed or empty)
  // is a client error: answer with the same clean 400 the routes use for
  // a missing body instead of the raw parser message.
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "Request body must be JSON" });
  }

  const statusCode = err.statusCode || err.status || 500;

  if (process.env.NODE_ENV !== "production") {
    console.error("🔥  Error:", err.stack || err.message);
  }

  res.status(statusCode).json({
    success: false,
    message: err.message || "An unexpected error occurred",
  });
};

module.exports = { notFound, errorHandler };
