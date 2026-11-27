/**
 * db/seed-catalog.js
 *
 * Seeds the product catalog with the categories, subcategories and
 * brands for the Artek Computers storefront, using the exact slugs
 * the React frontend expects.
 *
 * Run:  npm run seed:catalog
 *
 * Safe to run many times, and it also repairs an existing database:
 *   - every category has an explicit slug; subcategory slugs come from
 *     frontendSlugify() below
 *   - a category is matched by slug first, then by name; a row found by
 *     name with an old slug gets its slug updated ("slug fixed: old -> new")
 *   - a subcategory is matched by slug first, then by its category +
 *     name, with the same slug repair
 *   - rows are never deleted, and descriptions are never changed
 *   - everything runs in one transaction: when a new slug is already
 *     owned by a different row, the run stops, rolls back and prints
 *     the conflicting row
 */

require("dotenv").config();

const pool    = require("../src/config/db");
const slugify = require("../src/utils/slugify");   // still used for brand slugs

// ── The slug rule the frontend uses ──────────────────────────────────
// Used for every subcategory slug. Note the difference from
// src/utils/slugify.js: "&" is simply dropped (it is not a letter or
// number), so "MPO & MTP Patch Cords" becomes "mpo-mtp-patch-cords".
const frontendSlugify = (name) =>
  String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// ── Categories: explicit slugs + full subcategory lists ──────────────
// Descriptions follow the same one-line style as the original ones.
const categories = [
  {
    slug:         "copper-cabling",
    name:         "Copper cabling",
    description:  "Cat5e, Cat6 and Cat6a cables, patch panels, keystone jacks and face plates.",
    subcategories: [
      "Cat6 Cable",
      "Cat6 Outdoor Cable",
      "Cat6A Cable",
      "Cat7 Cable",
      "Cat8 Cable",
      "Network Cable",
      "Copper Patch Cord",
      "Copper Patch Panel",
    ],
  },
  {
    slug:         "fiber-optic",
    name:         "Fiber optic",
    description:  "Fiber cables, patch cords, transceivers and splicing accessories for high-speed links.",
    subcategories: [
      "Fiber Adaptor",
      "Fiber Optic Cable",
      "Fiber Optic Patch Cord",
      "Fiber Optic Patch Panels",
      "Fiber Optic Pigtails",
      "Fiber Optic Splitter",
      "FO Distribution Box",
      "FTTH Drop Cable",
      "MPO & MTP Patch Cords",
      "Media Converter",
      "PLC Splitter",
      "Transceiver",
    ],
  },
  {
    slug:         "specialty-cables",
    name:         "Specialty and ELV cables",
    description:  "Purpose-made cables for audio, video, fire alarm and other low-voltage systems.",
    subcategories: [
      "Audio Cable",
      "CCTV Cable",
      "Control Cable",
      "EIB BUS Cable",
      "Fire Alarm Cable",
      "HDMI Cable",
      "Instrumentation Cable",
      "Lift Cable",
      "RG59 Cable",
      "RG6 Cable",
      "Speaker Cable",
    ],
  },
  {
    slug:         "cabinets-power",
    name:         "Cabinets and power",
    description:  "Racks, cabinets, UPS units and power distribution for server rooms.",
    subcategories: [
      "Network Cabinet",
      "Patch Free Cabinet",
      "PDU",
      "UPS",
    ],
  },
  {
    slug:         "networking",
    name:         "Networking",
    description:  "Switches, routers, access points and accessories for wired and wireless networks.",
    subcategories: [
      "Network Router",
      "Network Switches",
      "Industrial Switches",
    ],
  },
  {
    slug:         "computers",
    name:         "Computers",
    description:  "Desktops, laptops and gaming PCs for business and personal use.",
    subcategories: [
      "Desktops",
      "Gaming PC",
      "Laptops",
    ],
  },
  {
    slug:         "telephony-displays",
    name:         "Telephony and displays",
    description:  "IP phones, conference phones, monitors and displays for offices and meeting rooms.",
    subcategories: [
      "IP PBX",
      "IP Phone",
      "Interactive Screen",
    ],
  },
  {
    slug:         "cctv-cameras",
    name:         "CCTV cameras",
    description:  "Surveillance cameras, recorders and accessories for homes and businesses.",
    subcategories: [
      "IP Camera",
      "Dome Camera",
      "Bullet Camera",
      "PTZ Camera",
    ],
  },
  {
    slug:         "computer-peripherals",
    name:         "Computer peripherals",
    description:  "Keyboards, mice, printers, scanners and other add-ons for every workstation.",
    subcategories: [
      "Mouse",
      "Keyboard",
      "Webcam",
      "Conference Webcam",
      "Printer",
      "Hard Disk",
    ],
  },
  {
    slug:         "servers-storage",
    name:         "Servers & storage",
    description:  "Rack, tower and storage hardware, supplied and configured.",
  },
  {
    slug:         "firewalls-security",
    name:         "Firewalls & security",
    description:  "Appliances and licences for edge and endpoint protection.",
  },
  {
    slug:         "backup-data-protection",
    name:         "Backup & data protection",
    description:  "Software and media for backup and archive.",
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
  "Belden",
  "ExTell",
  "Opterna",
  "Norden",
  "Kuwes",
  "Techlogiks",
  "SonicWall",
  "Ubiquiti",
  "Aruba",
  "Ruckus",
  "Linksys",
  "MikroTik",
  "Grandstream",
  "EnGenius",
  "Ruijie",
  "DrayTek",
  "Tenda",
  "IP-COM",
  "Huawei",
  "Yeastar",
  "Jabra",
  "Axis",
  "Toten",
  "UNV",
  "ZKTeco",
  "EZVIZ",
  "Imou",
  "Tapo",
  "APC",
  "Eaton",
  "Schneider",
  "Apple",
  "Acer",
  "ASUS",
  "Samsung",
  "WD",
  "Brother",
  "Microsoft",
  "Kaspersky",
  "Symantec",
  "Ugreen",
  "Anker",
  "Rapoo",
  "NVIDIA",
  "Intel",
];

// ── Guard: a slug must not be owned by a different row ──────────────
// `excludeId` is the row that is about to take the slug (0 for inserts,
// where no row may be excluded). Table names are fixed strings from
// this file, never user input. Throwing here rolls back the whole run.
const assertSlugFree = async (client, table, slug, excludeId) => {
  const clash = await client.query(
    `SELECT id, name FROM ${table} WHERE slug = $1 AND id <> $2`,
    [slug, excludeId]
  );
  if (clash.rows.length > 0) {
    throw new Error(
      `slug "${slug}" is already used by another ${table} row: ` +
      `"${clash.rows[0].name}" (id ${clash.rows[0].id})`
    );
  }
};

// ── Seed the categories and their subcategories ─────────────────────
async function seedCategories(client) {
  for (const category of categories) {
    // 1. Find the category by its new slug first
    let row = (await client.query(
      "SELECT id, slug, name FROM categories WHERE slug = $1",
      [category.slug]
    )).rows[0];

    if (row) {
      // A slug hit only counts when it really is this category;
      // a different row owning the slug is a conflict
      if (row.name.toLowerCase() !== category.name.toLowerCase()) {
        throw new Error(
          `slug "${category.slug}" is already used by another categories row: ` +
          `"${row.name}" (id ${row.id})`
        );
      }
      console.log(`ℹ️   Category "${category.name}" already exists – skipped`);
    } else {
      // 2. Not found by slug – look for the same category by exact name
      row = (await client.query(
        "SELECT id, slug FROM categories WHERE LOWER(name) = LOWER($1)",
        [category.name]
      )).rows[0];

      if (row) {
        // Found under an old slug – repair the slug, nothing else
        await assertSlugFree(client, "categories", category.slug, row.id);
        await client.query(
          "UPDATE categories SET slug = $1 WHERE id = $2",
          [category.slug, row.id]
        );
        console.log(`🔧  slug fixed: ${row.slug} -> ${category.slug}`);
      } else {
        // 3. Brand-new category – insert it with its description
        await assertSlugFree(client, "categories", category.slug, 0);
        row = (await client.query(
          `INSERT INTO categories (name, slug, description)
           VALUES ($1, $2, $3)
           RETURNING id, slug`,
          [category.name, category.slug, category.description]
        )).rows[0];
        console.log(`✅  Category "${category.name}" created`);
      }
    }

    // Subcategories of this category
    for (const name of category.subcategories || []) {
      const subSlug = frontendSlugify(name);

      // 1. Find by slug (subcategory slugs are unique across all
      //    categories – see db/schema.sql)
      let sub = (await client.query(
        "SELECT id, slug, name, category_id FROM subcategories WHERE slug = $1",
        [subSlug]
      )).rows[0];

      if (sub) {
        // A slug hit only counts when it really is this subcategory
        // (same category, same name); anything else is a conflict
        if (sub.category_id !== row.id || sub.name.toLowerCase() !== name.toLowerCase()) {
          throw new Error(
            `slug "${subSlug}" is already used by another subcategories row: ` +
            `"${sub.name}" (id ${sub.id})`
          );
        }
        console.log(`ℹ️   Subcategory "${name}" already exists – skipped`);
        continue;
      }

      // 2. Not found by slug – look inside this category by name
      sub = (await client.query(
        `SELECT id, slug FROM subcategories
         WHERE category_id = $1 AND LOWER(name) = LOWER($2)`,
        [row.id, name]
      )).rows[0];

      if (sub) {
        // Found under an old slug – repair the slug, nothing else
        await assertSlugFree(client, "subcategories", subSlug, sub.id);
        await client.query(
          "UPDATE subcategories SET slug = $1 WHERE id = $2",
          [subSlug, sub.id]
        );
        console.log(`🔧  slug fixed: ${sub.slug} -> ${subSlug}`);
      } else {
        // 3. Brand-new subcategory
        await assertSlugFree(client, "subcategories", subSlug, 0);
        await client.query(
          `INSERT INTO subcategories (category_id, name, slug)
           VALUES ($1, $2, $3)`,
          [row.id, name, subSlug]
        );
        console.log(`✅  Subcategory "${name}" created`);
      }
    }
  }
}

// ── Seed the brands ─────────────────────────────────────────────────
async function seedBrands(client) {
  for (const name of brands) {
    const slug = slugify(name);

    // Insert only when this slug does not exist yet
    const existing = await client.query(
      "SELECT id FROM brands WHERE slug = $1",
      [slug]
    );
    if (existing.rows.length > 0) {
      console.log(`ℹ️   Brand "${name}" already exists – skipped`);
      continue;
    }

    await client.query(
      "INSERT INTO brands (name, slug) VALUES ($1, $2)",
      [name, slug]
    );
    console.log(`✅  Brand "${name}" created`);
  }
}

// ── Main ────────────────────────────────────────────────────────────
// Everything runs inside one transaction, so a mid-run failure (for
// example a slug owned by a different row) leaves the database
// exactly as it was.
async function seedCatalog() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await seedCategories(client);
    await seedBrands(client);

    // Final counts as they will be after the commit
    const counts = (await client.query(`
      SELECT (SELECT COUNT(*) FROM categories)    AS categories,
             (SELECT COUNT(*) FROM subcategories) AS subcategories,
             (SELECT COUNT(*) FROM brands)        AS brands
    `)).rows[0];

    await client.query("COMMIT");

    console.log("✅  Catalog seed completed");
    console.log(
      `📊  Final counts: ${counts.categories} categories, ` +
      `${counts.subcategories} subcategories, ${counts.brands} brands`
    );

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌  Seed failed – rolled back, nothing was changed:", err.message);
  } finally {
    client.release();
    await pool.end();
    process.exit(0);
  }
}

seedCatalog();
