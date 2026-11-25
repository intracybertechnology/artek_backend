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
