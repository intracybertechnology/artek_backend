/**
 * db/seed-superadmin.js
 *
 * Creates the first super_admin account.
 * Run once:  npm run seed:admin
 *
 * Required .env variables:
 *   SUPERADMIN_NAME      – display name
 *   SUPERADMIN_EMAIL     – login email
 *   SUPERADMIN_PASSWORD  – plain-text password (hashed here, never stored plain)
 */

require("dotenv").config();

const bcrypt = require("bcryptjs");
const pool   = require("../src/config/db");

async function seedSuperAdmin() {
  const name     = process.env.SUPERADMIN_NAME;
  const email    = process.env.SUPERADMIN_EMAIL;
  const password = process.env.SUPERADMIN_PASSWORD;

  // ── Validate env vars ────────────────────────────────────────────
  if (!name || !email || !password) {
    console.error(
      "❌  Please set SUPERADMIN_NAME, SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD in your .env file."
    );
    process.exit(1);
  }

  try {
    // ── Check if the email is already registered ─────────────────
    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );

    if (existing.rows.length > 0) {
      console.log(`ℹ️   A user with email "${email}" already exists. Nothing was changed.`);
      return;
    }

    // ── Hash the password (12 rounds) ────────────────────────────
    const passwordHash = await bcrypt.hash(password, 12);

    // ── Insert super_admin ────────────────────────────────────────
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'super_admin')
       RETURNING id, name, email, role`,
      [name, email, passwordHash]
    );

    const user = result.rows[0];
    console.log("✅  Super admin created successfully:");
    console.log(`    ID:    ${user.id}`);
    console.log(`    Name:  ${user.name}`);
    console.log(`    Email: ${user.email}`);
    console.log(`    Role:  ${user.role}`);
    // Password is intentionally never printed.

  } catch (err) {
    console.error("❌  Seed failed:", err.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

seedSuperAdmin();
