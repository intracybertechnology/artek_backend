const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Test the connection when this module is first loaded
pool.connect((err, client, release) => {
  if (err) {
    console.error("❌  Database connection failed:", err.message);
  } else {
    console.log("✅  Database connected successfully");
    release();
  }
});

module.exports = pool;
