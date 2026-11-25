/**
 * src/middleware/authenticate.js
 *
 * Verifies the JWT from the "token" httpOnly cookie.
 * On success it attaches the full user row (minus password_hash) to req.user.
 * On failure it responds with 401.
 */

const jwt  = require("jsonwebtoken");
const pool = require("../config/db");

const authenticate = async (req, res, next) => {
  try {
    const token = req.cookies?.token;

    if (!token) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }

    // Verify signature and expiry
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }

    // Load the user from the database so we always have fresh data
    const result = await pool.query(
      "SELECT id, name, email, role, is_active FROM users WHERE id = $1",
      [payload.id]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ success: false, message: "User not found" });
    }

    if (!user.is_active) {
      return res.status(401).json({ success: false, message: "Account is deactivated" });
    }

    // Attach user to request so downstream handlers can read it
    req.user = user;
    next();

  } catch (err) {
    next(err);
  }
};

module.exports = authenticate;
