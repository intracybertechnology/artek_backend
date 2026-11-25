/**
 * src/controllers/auth.controller.js
 *
 * Handles login, logout, and "who am I?" for admin users.
 */

const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");
const { validationResult } = require("express-validator");
const pool   = require("../config/db");

// ── Helper: build the httpOnly cookie options ─────────────────────
const cookieOptions = () => ({
  httpOnly: true,                                      // JS cannot read this cookie
  sameSite: "lax",
  secure:   process.env.NODE_ENV === "production",     // HTTPS only in production
  maxAge:   24 * 60 * 60 * 1000,                       // 1 day in ms
});

// ── POST /api/auth/login ──────────────────────────────────────────
const login = async (req, res, next) => {
  try {
    // 1. Run express-validator checks
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const { email, password } = req.body;

    // 2. Look up the user (always query so timing is consistent)
    const result = await pool.query(
      "SELECT id, name, email, password_hash, role, is_active FROM users WHERE email = $1",
      [email]
    );
    const user = result.rows[0];

    // 3. Compare password even if user not found (prevents timing attacks)
    //    Use a dummy hash when user is missing so bcrypt always runs.
    const dummyHash = "$2a$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const hashToCheck = user ? user.password_hash : dummyHash;
    const passwordMatch = await bcrypt.compare(password, hashToCheck);

    // 4. Reject with the same message regardless of which check failed
    if (!user || !passwordMatch || !user.is_active) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    // 5. Sign JWT
    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
    );

    // 6. Set httpOnly cookie
    res.cookie("token", token, cookieOptions());

    // 7. Return safe user object – never include password_hash
    return res.status(200).json({
      success: true,
      user: {
        id:    user.id,
        name:  user.name,
        email: user.email,
        role:  user.role,
      },
    });

  } catch (err) {
    next(err);
  }
};

// ── POST /api/auth/logout ─────────────────────────────────────────
const logout = (req, res) => {
  res.clearCookie("token", { httpOnly: true, sameSite: "lax" });
  return res.status(200).json({ success: true, message: "Logged out successfully" });
};

// ── GET /api/auth/me ──────────────────────────────────────────────
// authenticate middleware already loaded the user, just return it.
const me = (req, res) => {
  const { id, name, email, role } = req.user;
  return res.status(200).json({ success: true, user: { id, name, email, role } });
};

module.exports = { login, logout, me };
