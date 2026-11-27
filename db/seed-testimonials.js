/**
 * db/seed-testimonials.js
 *
 * Inserts the sample testimonials shown in the site's testimonial
 * section.
 *
 * Run:  npm run seed:testimonials
 *
 * Safe to run many times:
 *   - a testimonial is inserted only when no row with the same name and
 *     company exists yet
 *   - existing rows are never deleted or overwritten
 *
 * To add another testimonial, append it to the TESTIMONIALS array below
 * and run the script again.
 */

require("dotenv").config();

const pool = require("../src/config/db");

// ── The testimonials ─────────────────────────────────────────────────
const TESTIMONIALS = [
  {
    name:    "Ahmed Al Farsi",
    role:    "Facilities Manager",
    company: "Marina Gate Offices, Dubai",
    rating:  5,
    quote:   "ARTEK upgraded our office CCTV and access control across two floors without disrupting a single workday. The SIRA paperwork was handled entirely by their team.",
  },
  {
    name:    "Priya Nair",
    role:    "Operations Head",
    company: "Retail Chain, Deira",
    rating:  5,
    quote:   "Their support contract is worth every dirham. A network fault on a Thursday evening was fixed the same night — our operations never stopped.",
  },
  {
    name:    "Khalid Mansour",
    role:    "Villa Owner",
    company: "Palm Jumeirah Residence",
    rating:  4,
    quote:   "Transparent quotation, branded equipment, and a clean installation. The after-sales service visits have kept our cameras and NVR running flawlessly.",
  },
  {
    name:    "Daniel D'Souza",
    role:    "Warehouse Director",
    company: "Logistics Firm, JAFZA",
    rating:  5,
    quote:   "From structured cabling to Wi-Fi coverage in our warehouse, ARTEK delivered the full IT setup on schedule. One team, one point of contact — simple.",
  },
  {
    name:    "Sara Iqbal",
    role:    "IT Manager",
    company: "Corporate Office, Business Bay",
    rating:  5,
    quote:   "We moved our entire server room over a weekend with zero data loss. Their engineers planned every step and tested everything before Monday morning.",
  },
  {
    name:    "Omar Haddad",
    role:    "Procurement Officer",
    company: "Trading Company, Bur Dubai",
    rating:  4,
    quote:   "Good pricing on laptops and accessories for our staff, plus fast setup and imaging. Our go-to supplier for office IT in Bur Dubai.",
  },
];

// Gap between two sort_order values (matches the API default)
const SORT_STEP = 10;

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  try {
    // New testimonials are appended after the current last one
    const max = await pool.query(
      "SELECT COALESCE(MAX(sort_order), 0) AS max FROM testimonials"
    );
    let sortOrder = max.rows[0].max;
    let inserted  = 0;

    for (const testimonial of TESTIMONIALS) {
      // Insert only when this name + company pair does not exist yet
      const existing = await pool.query(
        "SELECT id FROM testimonials WHERE name = $1 AND company = $2",
        [testimonial.name, testimonial.company || null]
      );
      if (existing.rows.length > 0) {
        console.log(`ℹ️   Testimonial "${testimonial.name}" already exists – skipped`);
        continue;
      }

      sortOrder += SORT_STEP;

      await pool.query(
        `INSERT INTO testimonials
           (name, role, company, quote, rating, is_published, sort_order)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [
          testimonial.name,
          testimonial.role || null,
          testimonial.company || null,
          testimonial.quote,
          testimonial.rating ?? null,
          sortOrder,
        ]
      );
      inserted++;
      console.log(`✅  Testimonial "${testimonial.name}" created`);
    }

    if (inserted === 0) console.log("ℹ️   Nothing to insert");

  } catch (err) {
    console.error("❌  Seed failed:", err.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

main();
