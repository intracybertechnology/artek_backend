/**
 * db/seed-catalog.js
 *
 * Seeds the product catalog with the initial categories, subcategories
 * and brands for the Artek Computers storefront.
 *
 * Run:  npm run seed:catalog
 *
 * Safe to run many times:
 *   - a row is inserted only when its slug does not exist yet
 *   - existing rows are never deleted or overwritten
 *   - missing subcategories are still added even when their category already exists
 */

require("dotenv").config();

const pool    = require("../src/config/db");
const slugify = require("../src/utils/slugify");

// ── Categories (subcategories optional) ─────────────────────────────
// Descriptions follow the same one-line style as the supplied ones.
const categories = [
  {
    name: "Computers",
    description: "Desktops, laptops and gaming PCs for business and personal use.",
    subcategories: ["Desktops", "Laptops", "Gaming PC"],
  },
  {
    name: "Computer peripherals",
    description: "Keyboards, mice, printers, scanners and other add-ons for every workstation.",
  },
  {
    name: "Networking",
    description: "Switches, routers, access points and accessories for wired and wireless networks.",
  },
  {
    name: "CCTV cameras",
    description: "Surveillance cameras, recorders and accessories for homes and businesses.",
  },
  {
    name: "Cabinets and power",
    description: "Racks, cabinets, UPS units and power distribution for server rooms.",
  },
  {
    name: "Fiber optic",
    description: "Fiber cables, patch cords, transceivers and splicing accessories for high-speed links.",
  },
  {
    name: "Copper cabling",
    description: "Cat5e, Cat6 and Cat6a cables, patch panels, keystone jacks and face plates.",
  },
  {
    name: "Specialty and ELV cables",
    description: "Purpose-made cables for audio, video, fire alarm and other low-voltage systems.",
    subcategories: [
      "Audio Cable",
      "Control Cable",
      "EIB BUS Cable",
      "Fire Alarm Cable",
      "HDMI Cable",
      "Instrumentation Cable",
      "Lift Cable",
      "RG59 Cable",
      "RG6 Cable",
      "Speaker Cable",
      "CCTV Cable",
    ],
  },
  {
    name: "Telephony and displays",
    description: "IP phones, conference phones, monitors and displays for offices and meeting rooms.",
  },
  {
    name: "Servers & storage",
    description: "Rack, tower and storage hardware, supplied and configured.",
  },
  {
    name: "Firewalls & security",
    description: "Appliances and licences for edge and endpoint protection.",
  },
  {
    name: "Backup & data protection",
    description: "Software and media for backup and archive.",
  },
];

// ── Brands (no logos) ────────────────────────────────────────────────
const brands = [
  "Hikvision",
  "D-Link",
  "HP",
  "Logitech",
  "Seagate",
  "Dell",
  "Epson",
  "Lenovo",
  "Dahua",
  "TP-Link",
  "Dell EMC",
  "Synology",
  "QNAP",
  "Fortinet",
  "Sophos",
  "Cisco",
  "Acronis",
  "Veeam",
  "LTO tape",
];

// ── Seed the categories and their subcategories ─────────────────────
async function seedCategories() {
  for (const category of categories) {
    const slug = slugify(category.name);

    // Insert only when this slug does not exist yet
    const existing = await pool.query(
      "SELECT id FROM categories WHERE slug = $1",
      [slug]
    );

    let categoryId;
    if (existing.rows.length > 0) {
      categoryId = existing.rows[0].id;
      console.log(`ℹ️   Category "${category.name}" already exists – skipped`);
    } else {
      const inserted = await pool.query(
        `INSERT INTO categories (name, slug, description)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [category.name, slug, category.description]
      );
      categoryId = inserted.rows[0].id;
      console.log(`✅  Category "${category.name}" created`);
    }

    // Add any subcategories that are missing (subcategory slugs are
    // unique across all categories – see db/schema.sql)
    for (const name of category.subcategories || []) {
      const subSlug = slugify(name);
      const existingSub = await pool.query(
        "SELECT id FROM subcategories WHERE slug = $1",
        [subSlug]
      );
      if (existingSub.rows.length > 0) {
        console.log(`ℹ️   Subcategory "${name}" already exists – skipped`);
        continue;
      }
      await pool.query(
        `INSERT INTO subcategories (category_id, name, slug)
         VALUES ($1, $2, $3)`,
        [categoryId, name, subSlug]
      );
      console.log(`✅  Subcategory "${name}" created`);
    }
  }
}

// ── Seed the brands ─────────────────────────────────────────────────
async function seedBrands() {
  for (const name of brands) {
    const slug = slugify(name);

    // Insert only when this slug does not exist yet
    const existing = await pool.query(
      "SELECT id FROM brands WHERE slug = $1",
      [slug]
    );
    if (existing.rows.length > 0) {
      console.log(`ℹ️   Brand "${name}" already exists – skipped`);
      continue;
    }

    await pool.query(
      "INSERT INTO brands (name, slug) VALUES ($1, $2)",
      [name, slug]
    );
    console.log(`✅  Brand "${name}" created`);
  }
}

// ── Main ────────────────────────────────────────────────────────────
async function seedCatalog() {
  try {
    await seedCategories();
    await seedBrands();
    console.log("✅  Catalog seed completed");
  } catch (err) {
    console.error("❌  Seed failed:", err.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

seedCatalog();
