/**
 * src/utils/postBlocks.js
 *
 * Validation for the structured content of an Insights post.
 *
 * The post body is a JSON array of typed blocks (rendered by the React
 * frontend), faqs is an array of { question, answer } objects, and
 * tags / relatedServices are arrays of short strings. These helpers
 * are pure functions – no database, no express – so the insights
 * controller and the seed script share exactly the same rules.
 *
 * Nothing is executed or rendered here: the data is only checked,
 * lightly normalised (h2 ids are generated when missing) and returned
 * for storage as JSONB.
 *
 * Allowed block types and their required fields:
 *   p       { text }
 *   h2      { id, text }     – id is generated from text when missing,
 *                              and must be unique within the post
 *   h3      { text }
 *   ul      { items: string[] }
 *   ol      { items: string[] }
 *   quote   { text, cite? }
 *   callout { title, text }
 *   table   { head: string[], rows: string[][] }
 *   image   { src, alt, width, height, caption? }
 */

const slugify = require("./slugify");

// Hard limit on the number of blocks in one post
const MAX_BLOCKS = 200;

// Reading time is estimated at 200 words per minute
const WORDS_PER_MINUTE = 200;

// ── Small shared helpers ─────────────────────────────────────────────

const ok      = (value) => ({ valid: true, value });
const invalid = (message) => ({ valid: false, message });

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

// "src, alt, width and height" / "src and alt" / "src"
const listFields = (fields) =>
  fields.length === 1
    ? fields[0]
    : `${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}`;

// ── Body validation ──────────────────────────────────────────────────
// Returns { valid: true, value } with the normalised block array, or
// { valid: false, message } with a message that names the block position,
// for example:  "body[3]: h2 needs id and text"
const validateBody = (body) => {
  if (!Array.isArray(body)) return invalid("Body must be an array of blocks");
  if (body.length > MAX_BLOCKS) return invalid(`body cannot have more than ${MAX_BLOCKS} blocks`);

  const h2Ids = new Set();     // h2 ids must be unique within the post
  const blocks = [];

  for (let i = 0; i < body.length; i++) {
    const raw = body[i];

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return invalid(`body[${i}] must be a block object`);
    }
    if (!raw.type) {
      return invalid(`body[${i}]: block type is missing`);
    }

    // Copy so the caller's data is never mutated
    const block = { ...raw };

    switch (block.type) {
      case "p":
      case "h3": {
        if (!isNonEmptyString(block.text)) return invalid(`body[${i}]: ${block.type} needs text`);
        break;
      }

      case "h2": {
        // Without text no id can be generated either, so both are reported
        if (!isNonEmptyString(block.text)) return invalid(`body[${i}]: h2 needs id and text`);
        // The id comes from the client, or is generated from the text
        if (!isNonEmptyString(block.id)) block.id = slugify(block.text) || `section-${i + 1}`;
        if (h2Ids.has(block.id)) return invalid(`body[${i}]: duplicate h2 id "${block.id}"`);
        h2Ids.add(block.id);
        break;
      }

      case "ul":
      case "ol": {
        if (!Array.isArray(block.items) || !block.items.every(isNonEmptyString)) {
          return invalid(`body[${i}]: ${block.type} items must be an array of strings`);
        }
        break;
      }

      case "quote": {
        if (!isNonEmptyString(block.text)) return invalid(`body[${i}]: quote needs text`);
        if (block.cite !== undefined && typeof block.cite !== "string") {
          return invalid(`body[${i}]: quote cite must be a string`);
        }
        break;
      }

      case "callout": {
        if (!isNonEmptyString(block.title) || !isNonEmptyString(block.text)) {
          return invalid(`body[${i}]: callout needs title and text`);
        }
        break;
      }

      case "table": {
        if (!Array.isArray(block.head) || !block.head.every(isNonEmptyString)) {
          return invalid(`body[${i}]: table head must be an array of strings`);
        }
        if (!Array.isArray(block.rows) ||
            !block.rows.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))) {
          return invalid(`body[${i}]: table rows must be an array of string arrays`);
        }
        break;
      }

      case "image": {
        const missing = [];
        if (!isNonEmptyString(block.src))   missing.push("src");
        if (!isNonEmptyString(block.alt))   missing.push("alt");
        if (!Number.isFinite(block.width))  missing.push("width");
        if (!Number.isFinite(block.height)) missing.push("height");
        if (missing.length > 0) return invalid(`body[${i}]: image needs ${listFields(missing)}`);
        if (block.caption !== undefined && typeof block.caption !== "string") {
          return invalid(`body[${i}]: image caption must be a string`);
        }
        break;
      }

      default:
        return invalid(`body[${i}]: unknown block type "${block.type}"`);
    }

    blocks.push(block);
  }

  return ok(blocks);
};

// ── FAQs validation ──────────────────────────────────────────────────
// faqs must be an array of { question, answer } objects; absent becomes [].
const validateFaqs = (faqs) => {
  if (faqs === undefined || faqs === null) return ok([]);
  if (!Array.isArray(faqs)) return invalid("faqs must be an array of { question, answer } objects");

  for (let i = 0; i < faqs.length; i++) {
    const faq = faqs[i];
    if (typeof faq !== "object" || faq === null || Array.isArray(faq)) {
      return invalid(`faqs[${i}] must be an object with question and answer`);
    }
    const missing = [];
    if (!isNonEmptyString(faq.question)) missing.push("question");
    if (!isNonEmptyString(faq.answer))   missing.push("answer");
    if (missing.length > 0) return invalid(`faqs[${i}] needs ${listFields(missing)}`);
  }

  return ok(faqs);
};

// ── tags / relatedServices validation ───────────────────────────────
// Arrays of short strings; absent becomes []. The value is returned
// trimmed, without empty entries.
const validateShortStrings = (value, field, { maxLength = 100, maxItems = 50 } = {}) => {
  if (value === undefined || value === null) return ok([]);
  if (!Array.isArray(value)) return invalid(`${field} must be an array of strings`);
  if (value.length > maxItems) return invalid(`${field} cannot have more than ${maxItems} items`);

  const cleaned = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== "string" || item.trim() === "" || item.trim().length > maxLength) {
      return invalid(`${field}[${i}] must be a string of ${maxLength} characters or less`);
    }
    cleaned.push(item.trim());
  }

  return ok(cleaned);
};

// ── Reading time ──────────────────────────────────────────────────────
// Counts the words in the text fields of every block and converts them
// to whole minutes at WORDS_PER_MINUTE, with a minimum of 1.
const wordsIn = (text) =>
  typeof text === "string" ? text.trim().split(/\s+/).filter(Boolean).length : 0;

const readingMinutes = (body) => {
  if (!Array.isArray(body)) return 1;

  let words = 0;
  for (const block of body) {
    switch (block?.type) {
      case "p":
      case "h2":
      case "h3":
        words += wordsIn(block.text);
        break;
      case "ul":
      case "ol":
        words += (block.items || []).reduce((sum, item) => sum + wordsIn(item), 0);
        break;
      case "quote":
        words += wordsIn(block.text) + wordsIn(block.cite);
        break;
      case "callout":
        words += wordsIn(block.title) + wordsIn(block.text);
        break;
      case "table":
        words += (block.head || []).reduce((sum, cell) => sum + wordsIn(cell), 0);
        words += (block.rows || []).flat().reduce((sum, cell) => sum + wordsIn(cell), 0);
        break;
      case "image":
        words += wordsIn(block.caption);
        break;
      default:
        break;   // unknown blocks are never stored anyway
    }
  }

  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
};

module.exports = { validateBody, validateFaqs, validateShortStrings, readingMinutes, MAX_BLOCKS };
