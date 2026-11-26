/**
 * db/seed-sample-products.js
 *
 * Inserts a few sample products (without images) so the catalog has
 * something to show in the storefront.
 *
 * Run:  npm run seed:products
 *
 * Safe to run many times:
 *   - a product is inserted only when its model number does not exist yet
 *   - a subcategory needed by a product is created when its slug is missing
 *   - existing rows are never deleted or overwritten
 *
 * Uses the categories and brands created by `npm run seed:catalog`.
 */

require("dotenv").config();

const pool    = require("../src/config/db");
const slugify = require("../src/utils/slugify");

// ── Sample products (no images) ────────────────────────────────────────
const sampleProducts = [
  {
    name:             "Hikvision 4MP Bullet Camera",
    model_number:     "DS-2CD1043G0-I",
    description:      "4 MP outdoor bullet camera with EXIR night vision for entrances and perimeters.",
    category_slug:    "cctv-cameras",
    subcategory_slug: "bullet-camera",
    subcategory_name: "Bullet Camera",
    brand_slug:       "hikvision",
    availability:     "available",
    specifications:   { resolution: "4 MP", "night vision": "up to 30 m", "form factor": "Bullet" },
  },
  {
    name:             "Hikvision 4MP Dome Camera",
    model_number:     "DS-2CD1043G2-LIU",
    description:      "4 MP dome camera with smart hybrid illumination for indoor and covered outdoor areas.",
    category_slug:    "cctv-cameras",
    subcategory_slug: "dome-camera",
    subcategory_name: "Dome Camera",
    brand_slug:       "hikvision",
    availability:     "available",
    specifications:   { resolution: "4 MP", "night vision": "up to 30 m", "form factor": "Dome" },
  },
  {
    name:             "Dell Latitude 5540 Laptop",
    model_number:     "LAT-5540-CTO",
    description:      "14-inch business laptop with Intel Core i5, 16 GB RAM and a 512 GB SSD.",
    category_slug:    "computers",
    subcategory_slug: "laptops",
    subcategory_name: "Laptops",
    brand_slug:       "dell",
    availability:     "available",
    specifications:   { processor: "Intel Core i5", RAM: "16 GB", storage: "512 GB SSD", screen: "14 inch" },
  },
  {
    name:             "TP-Link 24-Port Gigabit Switch",
    model_number:     "TL-SG1024D",
    description:      "24-port gigabit rack-mount switch for small and medium office networks.",
    category_slug:    "networking",
    subcategory_slug: null,
    brand_slug:       "tp-link",
    availability:     "available",
    specifications:   { ports: "24", speed: "1 Gbps", mounting: "19-inch rack" },
  },
  {
    name:             "Cisco Firepower 1120 Firewall",
    model_number:     "FPR1120-NGFW",
    description:      "Desktop firewall appliance with NGFW services for small and medium businesses.",
    category_slug:    "firewalls-and-security",
    subcategory_slug: null,
    brand_slug:       "cisco",
    availability:     "on_request",
    specifications:   { ports: "8", throughput: "1.5 Gbps" },
  },
];

// ── Look up an id by slug, or null when the row does not exist ────────
// The table name is always a fixed string from this file, never user input.
const findIdBySlug = async (table, slug) => {
  const result = await pool.query(`SELECT id FROM ${table} WHERE slug = $1`, [slug]);
  return result.rows[0] ? result.rows[0].id : null;
};

// ── Ensure a subcategory exists, insert it under its category when its
//    slug is missing. Returns the id, or null when the parent category
//    does not exist (run "npm run seed:catalog" first). ──────────────
const ensureSubcategory = async (categorySlug, slug, name) => {
  const existing = await pool.query(
    "SELECT id FROM subcategories WHERE slug = $1",
    [slug]
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  const category = await pool.query(
    "SELECT id FROM categories WHERE slug = $1",
    [categorySlug]
  );
  if (!category.rows[0]) {
    console.log(`⚠️   Cannot create subcategory "${name}": category "${categorySlug}" not found`);
    return null;
  }

  const inserted = await pool.query(
    `INSERT INTO subcategories (category_id, name, slug)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [category.rows[0].id, name, slug]
  );
  console.log(`✅  Subcategory "${name}" created`);
  return inserted.rows[0].id;
};

// ── Seed the products ─────────────────────────────────────────────────
async function seedSampleProducts() {
  for (const product of sampleProducts) {
    // Insert only when this model number does not exist yet
    const existing = await pool.query(
      "SELECT id FROM products WHERE model_number = $1",
      [product.model_number]
    );
    if (existing.rows.length > 0) {
      console.log(`ℹ️   Product "${product.name}" (${product.model_number}) already exists – skipped`);
      continue;
    }

    // Resolve category / subcategory / brand ids by slug
    const categoryId = await findIdBySlug("categories", product.category_slug);
    const brandId     = await findIdBySlug("brands", product.brand_slug);

    if (categoryId === null || brandId === null) {
      console.log(
        `⚠️   Skipped "${product.name}": category or brand not found – run "npm run seed:catalog" first`
      );
      continue;
    }

    let subcategoryId = null;
    if (product.subcategory_slug) {
      // Create the subcategory when its slug is missing
      subcategoryId = await ensureSubcategory(
        product.category_slug,
        product.subcategory_slug,
        product.subcategory_name
      );
      if (subcategoryId === null) {
        console.log(`⚠️   Skipped "${product.name}": subcategory could not be created`);
        continue;
      }
    }

    // Same slug rule as the API: name + model number
    const slug = slugify(`${product.name} ${product.model_number}`);

    await pool.query(
      `INSERT INTO products
         (name, slug, model_number, description, category_id, subcategory_id,
          brand_id, availability, specifications)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        product.name,
        slug,
        product.model_number,
        product.description,
        categoryId,
        subcategoryId,
        brandId,
        product.availability,
        JSON.stringify(product.specifications),
      ]
    );
    console.log(`✅  Product "${product.name}" created`);
  }
}

// ── One-time repair: link sample products to their subcategory ─────
// For the sample products whose subcategory_id is still NULL, set it by
// model number. Only rows with a NULL subcategory are touched, and only
// when the subcategory belongs to the product's own category – so this
// is safe to run many times and never touches other products.
const subcategoryLinks = [
  { model_number: "TL-SG1024D",     subcategory_slug: "network-switches" },
  { model_number: "DS-2CD1043G0-I", subcategory_slug: "bullet-camera"   },
];

async function linkSampleSubcategories() {
  for (const link of subcategoryLinks) {
    const result = await pool.query(
      `UPDATE products p
       SET subcategory_id = s.id, updated_at = NOW()
       FROM subcategories s
       WHERE p.model_number = $1
         AND p.subcategory_id IS NULL
         AND s.slug = $2
         AND s.category_id = p.category_id
       RETURNING p.id`,
      [link.model_number, link.subcategory_slug]
    );

    if (result.rows.length > 0) {
      console.log(`✅  Product ${link.model_number} linked to subcategory "${link.subcategory_slug}"`);
    } else {
      console.log(`ℹ️   Product ${link.model_number} needs no subcategory link`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  try {
    await seedSampleProducts();
    await linkSampleSubcategories();
    console.log("✅  Sample products seed completed");
  } catch (err) {
    console.error("❌  Seed failed:", err.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

main();
