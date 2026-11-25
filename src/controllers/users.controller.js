/**
 * src/controllers/users.controller.js
 *
 * Admin account management – accessible to super_admin only.
 *
 * Rules enforced here:
 *  - Password is never returned in any response.
 *  - A super_admin cannot deactivate, demote or delete their own account.
 */

const bcrypt = require("bcryptjs");
const { validationResult } = require("express-validator");
const pool   = require("../config/db");

// ── Columns we return for every user (no password_hash) ──────────
const SAFE_COLUMNS = "id, name, email, role, is_active, created_at";

// ── GET /api/users ────────────────────────────────────────────────
const listUsers = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ${SAFE_COLUMNS} FROM users ORDER BY created_at ASC`
    );
    return res.status(200).json({ success: true, users: result.rows });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/users ───────────────────────────────────────────────
const createUser = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const { name, email, password, role } = req.body;

    // Check for duplicate email
    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: "Email is already in use" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING ${SAFE_COLUMNS}`,
      [name, email, passwordHash, role]
    );

    return res.status(201).json({ success: true, user: result.rows[0] });

  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/users/:id ──────────────────────────────────────────
const updateUser = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const targetId  = parseInt(req.params.id, 10);
    const requesterId = req.user.id;

    // Load target user
    const found = await pool.query("SELECT * FROM users WHERE id = $1", [targetId]);
    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    const target = found.rows[0];

    // Self-protection: a super_admin cannot demote or deactivate themselves
    if (targetId === requesterId) {
      const { role, is_active } = req.body;
      if (role !== undefined && role !== req.user.role) {
        return res.status(403).json({
          success: false,
          message: "You cannot change your own role",
        });
      }
      if (is_active !== undefined && is_active === false) {
        return res.status(403).json({
          success: false,
          message: "You cannot deactivate your own account",
        });
      }
    }

    // Build the update dynamically – only set fields that were sent
    const updates = [];
    const values  = [];
    let   idx     = 1;

    if (req.body.name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(req.body.name);
    }
    if (req.body.role !== undefined) {
      updates.push(`role = $${idx++}`);
      values.push(req.body.role);
    }
    if (req.body.is_active !== undefined) {
      updates.push(`is_active = $${idx++}`);
      values.push(req.body.is_active);
    }
    if (req.body.password !== undefined) {
      const hash = await bcrypt.hash(req.body.password, 12);
      updates.push(`password_hash = $${idx++}`);
      values.push(hash);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    values.push(targetId);

    const result = await pool.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = $${idx}
       RETURNING ${SAFE_COLUMNS}`,
      values
    );

    return res.status(200).json({ success: true, user: result.rows[0] });

  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/users/:id  (soft-delete: sets is_active = false) ──
const deactivateUser = async (req, res, next) => {
  try {
    const targetId    = parseInt(req.params.id, 10);
    const requesterId = req.user.id;

    // Self-protection
    if (targetId === requesterId) {
      return res.status(403).json({
        success: false,
        message: "You cannot deactivate your own account",
      });
    }

    const result = await pool.query(
      `UPDATE users SET is_active = false WHERE id = $1
       RETURNING ${SAFE_COLUMNS}`,
      [targetId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.status(200).json({
      success: true,
      message: "User deactivated successfully",
      user: result.rows[0],
    });

  } catch (err) {
    next(err);
  }
};

module.exports = { listUsers, createUser, updateUser, deactivateUser };
