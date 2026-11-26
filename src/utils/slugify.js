/**
 * src/utils/slugify.js
 *
 * Turns a name into a URL-safe slug.
 *
 *   "Servers & storage"   ->  "servers-and-storage"
 *   "CCTV cameras"        ->  "cctv-cameras"
 *   "D-Link"              ->  "d-link"
 *
 * Rules:
 *   - lowercase
 *   - "&" becomes "and"
 *   - special characters are removed
 *   - spaces (and repeated hyphens) become a single hyphen
 *   - no leading/trailing hyphens
 *
 * Returns an empty string when the name has no usable characters,
 * so callers should treat "" as "no valid slug".
 */
const slugify = (name) =>
  String(name)
    .toLowerCase()
    .replace(/&/g, "and")             // "&" -> "and"
    .replace(/[^a-z0-9\s-]/g, "")     // drop anything that is not a letter, number, space or hyphen
    .trim()
    .replace(/[\s-]+/g, "-")         // spaces / repeated hyphens -> single hyphen
    .replace(/^-+|-+$/g, "");         // trim hyphens from the ends

module.exports = slugify;
