const pool = require("../config/db");

// GET /api/health
const healthCheck = async (req, res) => {
  try {
    await pool.query("SELECT 1");
    return res.status(200).json({ status: "ok", database: "connected" });
  } catch (err) {
    return res.status(500).json({ status: "error", database: "disconnected" });
  }
};

module.exports = { healthCheck };
