/**
 * db/import-posts.js
 *
 * Imports the posts from db/posts-export.json (the file produced by the
 * React frontend's scripts/export-posts.mjs) into the posts table.
 *
 * Run:  npm run import:posts
 *
 * Safe to run many times:
 *   - a post is inserted only when its slug does not exist yet
 *   - existing rows (including the sample post) are never deleted or
 *     overwritten
 *
 * Every post is validated with the same block rules as the API
 * (src/utils/postBlocks.js). A post whose body or faqs fail validation
 * is reported and skipped, and the remaining posts are still imported.
 *
 * Text is stored exactly as exported – nothing is trimmed or altered,
 * and the post's own slug is used (never re-slugified).
 */

require("dotenv").config();

const fs   = require("fs");
const path = require("path");

const pool = require("../src/config/db");
const { validateBody, validateFaqs } = require("../src/utils/postBlocks");

// The export file sits next to this script
const EXPORT_FILE = path.join(__dirname, "posts-export.json");

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  try {
    const posts = JSON.parse(fs.readFileSync(EXPORT_FILE, "utf8"));
    if (!Array.isArray(posts)) {
      console.error("❌  posts-export.json must contain an array of posts");
      return;
    }

    let inserted = 0;
    let skipped  = 0;

    for (const post of posts) {
      // Guard against a malformed entry before touching any field
      if (typeof post !== "object" || post === null || !post.slug) {
        console.error("❌  Skipping an entry without a slug");
        skipped++;
        continue;
      }

      // 1. Validate the structured content with the API's own rules;
      //    the message names the exact block, e.g. "body[3]: h2 ..."
      const body = validateBody(post.body);
      if (!body.valid) {
        console.error(`❌  ${post.slug}: ${body.message}`);
        skipped++;
        continue;
      }
      const faqs = validateFaqs(post.faqs);
      if (!faqs.valid) {
        console.error(`❌  ${post.slug}: ${faqs.message}`);
        skipped++;
        continue;
      }

      // 2. Insert only when this slug does not exist yet, so re-running
      //    is safe and the existing sample post is never touched
      //    (its slug is not in the export file)
      const existing = await pool.query("SELECT id FROM posts WHERE slug = $1", [post.slug]);
      if (existing.rows.length > 0) {
        console.log(`ℹ️   Post "${post.slug}" already exists – skipped`);
        skipped++;
        continue;
      }

      // 3. Insert with parameterised SQL only, using the post's own slug
      try {
        await pool.query(
          `INSERT INTO posts
             (slug, title, dek, category, tags, author_id, published_at,
              featured, cover_word, body, faqs, related_services, seo,
              status, created_by)
           VALUES ($1, $2, $3, $4, $5::text[], $6, $7::date, $8, $9,
                   $10::jsonb, $11::jsonb, $12::text[], $13::jsonb,
                   'published', NULL)`,
          [
            post.slug,
            post.title,
            post.dek ?? null,
            post.category,
            post.tags ?? [],
            post.authorId ?? null,
            post.publishedAt ?? null,
            post.featured ?? false,
            post.coverWord ?? null,
            JSON.stringify(body.value),
            JSON.stringify(faqs.value),
            post.relatedServices ?? [],
            post.seo === undefined || post.seo === null ? null : JSON.stringify(post.seo),
          ]
        );
        inserted++;
        console.log(`✅  Post "${post.slug}" created`);
      } catch (err) {
        // One bad post must not stop the rest of the import
        console.error(`❌  ${post.slug}: ${err.message}`);
        skipped++;
      }
    }

    console.log(`\n📊  Inserted ${inserted}, skipped ${skipped}, total ${posts.length}`);

  } catch (err) {
    console.error("❌  Import failed:", err.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

main();
