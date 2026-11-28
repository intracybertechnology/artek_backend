/**
 * src/controllers/quotes.controller.js
 *
 * Quote request APIs.
 *
 * Public:   visitors submit a "Get a quote" request. Submissions are
 *           rate limited, honeypot-protected and HTML-stripped (the
 *           guards live in the routes file).
 * Admin:    'admin' and 'super_admin' read quotes and update their status.
 *
 * Emails:   after saving, src/utils/mailer.js notifies QUOTE_TO_EMAIL
 *           (reply-to the customer). An unconfigured or failed email
 *           never fails the request – the quote is already stored.
 */

const { validationResult } = require("express-validator");

const pool               = require("../config/db");
const { sendQuoteEmail }  = require("../utils/mailer");

// ── Columns returned by the admin endpoints ─────────────────────────
const QUOTE_COLUMNS =
  "id, name, email, phone, company, message, product_id, product_name, " +
  "model_number, brand_name, email_sent, status, created_at";
// ── Helper: strip HTML tags from a text field ───────────────────────
const stripHtml = (value) =>
  typeof value === "string" ? value.replace(/<[^>]*>/g, "") : value;

// ── Helper: clean a text field – strip HTML, trim, empty becomes null ─
const cleanText = (value) => {
  if (value === undefined || value === null) return null;   // optional fields may be absent
  const cleaned = stripHtml(value).trim();
  return cleaned === "" ? null : cleaned;
};

// ── Helper: parse an id route parameter (null when not a number) ────
const parseId = (value) => {
  const id = parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// ── POST /api/quotes ─────────────────────────────────────────────────
// Public submission. Rate limited + validated in the routes file.
const createQuote = async (req, res, next) => {
  try {
    // 0. A missing or non-JSON body must be a clean 400, never a server
    //    error (req.body is undefined when no JSON body was sent, and
    //    reading req.body.x would then throw)
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({
        success: false,
        message: "Request body must be JSON",
      });
    }

    // 1. Honeypot – checked before anything else, so a bot always gets
    //    the normal success response and never learns what tripped it.
    //    Nothing is saved and no email is sent.
    if (body.botcheck) {
      return res.status(201).json({
        success: true,
        message: "Thank you, we will contact you shortly.",
      });
    }

    // 2. Validation results (rules live in the routes file)
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    // 3. Clean every text field: strip HTML tags, trim, empty -> null.
    //    (express-validator does not write sanitised values back into
    //    req.body, so the cleaning is done here.)
    const name     = cleanText(body.fullName);
    const email    = cleanText(body.email);
    const phone    = cleanText(body.phone);
    const company  = cleanText(body.companyName);
    const service  = cleanText(body.service);
    const emirate  = cleanText(body.emirate);
    const category = cleanText(body.category);
    const message  = cleanText(body.message);

    // Client-supplied product context – used only when no valid
    // product_id was given (the database wins otherwise, see step 4)
    let productName = cleanText(body.product_name);
    let modelNumber = cleanText(body.model_number);
    let brandName   = cleanText(body.brand_name);

    // Validation passed, but stripping tags may have emptied a field
    if (!name || !email || !phone || !message) {
      return res.status(422).json({
        success: false,
        message: "Name, email, phone and message are required",
      });
    }

    // 4. Product context: when a real product id is given, fill the
    //    product fields from the database instead of trusting the
    //    client. Soft-deleted products do not count as quotable.
    let productId = null;
    if (body.product_id !== undefined && body.product_id !== null) {
      productId = parseInt(body.product_id, 10);
      const product = await pool.query(
        `SELECT p.name, p.model_number, b.name AS brand_name
         FROM products p
         LEFT JOIN brands b ON b.id = p.brand_id
         WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [productId]
      );

      if (product.rows.length > 0) {
        // Database truth overwrites whatever the client sent
        productName = product.rows[0].name;
        modelNumber = product.rows[0].model_number;
        brandName   = product.rows[0].brand_name;
      } else {
        // No such (public) product – never store a broken reference,
        // keep the client's context text instead
        productId = null;
      }
    }

    // 5. Compose the stored message: the visitor's message with the
    //    optional context fields as extra lines at the end
    const extraLines = [];
    if (service)  extraLines.push(`Service: ${service}`);
    if (emirate)  extraLines.push(`Emirate: ${emirate}`);
    if (category) extraLines.push(`Category: ${category}`);

    const fullMessage = extraLines.length > 0
      ? `${message}\n${extraLines.join("\n")}`
      : message;

    // 6. Save (status 'new' – explicit even though it is the default)
    const saved = await pool.query(
      `INSERT INTO quote_requests
         (name, email, phone, company, message, product_id,
          product_name, model_number, brand_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'new')
       RETURNING id`,
      [name, email, phone, company, fullMessage, productId,
       productName, modelNumber, brandName]
    );

    // 7. Send the notification email after saving. A skipped or failed
    //    email never fails the request – the quote is already stored.
    const emailSent = await sendQuoteEmail({
      name, email, phone, company, service, emirate, category,
      message, productName, modelNumber, brandName,
    });
    if (emailSent) {
      await pool.query(
        "UPDATE quote_requests SET email_sent = true WHERE id = $1",
        [saved.rows[0].id]
      );
    }

    // 8. Never return the saved row – just the confirmation
    return res.status(201).json({
      success: true,
      message: "Thank you, we will contact you shortly.",
    });

  } catch (err) {
    next(err);
  }
};

// ── GET /api/quotes ──────────────────────────────────────────────────
// Admin list: paginated, ?status=new|contacted|closed, newest first.
const listQuotes = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    // Defaults: page 1, limit 20 (validation capped the limit at 100)
    const page    = parseInt(req.query.page, 10)  || 1;
    const limit   = parseInt(req.query.limit, 10) || 20;
    const { status } = req.query;

    // Build the WHERE clause with parameterised values only
    const conditions = [];
    const values     = [];
    if (status) {
      values.push(status);
      conditions.push(`status = $${values.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Count matching rows first
    const count = await pool.query(
      `SELECT COUNT(*)::int AS total FROM quote_requests ${where}`,
      values
    );
    const total = count.rows[0].total;

    values.push(limit);
    const limitPlaceholder  = `$${values.length}`;
    values.push((page - 1) * limit);
    const offsetPlaceholder = `$${values.length}`;

    const result = await pool.query(
      `SELECT ${QUOTE_COLUMNS} FROM quote_requests
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      values
    );

    return res.status(200).json({
      success: true,
      quotes: result.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });

  } catch (err) {
    next(err);
  }
};

// ── GET /api/quotes/:id ──────────────────────────────────────────────
const getQuoteById = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ success: false, message: "Quote not found" });
    }

    const result = await pool.query(
      `SELECT ${QUOTE_COLUMNS} FROM quote_requests WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Quote not found" });
    }

    return res.status(200).json({ success: true, quote: result.rows[0] });

  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/quotes/:id ────────────────────────────────────────────
// Updates the status only – anything else the client sends is ignored.
const updateQuoteStatus = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(404).json({ success: false, message: "Quote not found" });
    }

    const result = await pool.query(
      `UPDATE quote_requests SET status = $1 WHERE id = $2
       RETURNING ${QUOTE_COLUMNS}`,
      [req.body.status, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Quote not found" });
    }

    return res.status(200).json({ success: true, quote: result.rows[0] });

  } catch (err) {
    next(err);
  }
};

module.exports = { createQuote, listQuotes, getQuoteById, updateQuoteStatus };
