/**
 * src/middleware/authorize.js
 *
 * Usage: router.get("/", authenticate, authorize("super_admin"), handler)
 *        router.get("/", authenticate, authorize("super_admin", "admin"), handler)
 *
 * Must be used AFTER authenticate (which sets req.user).
 * Returns 403 if the user's role is not in the allowed list.
 */

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to perform this action",
      });
    }
    next();
  };
};

module.exports = authorize;
