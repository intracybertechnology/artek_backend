/**
 * src/utils/mailer.js
 *
 * Sends the "new quote request" notification email with nodemailer.
 *
 *   - SMTP settings come from .env:
 *       SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *     and the notification goes to QUOTE_TO_EMAIL.
 *   - reply-to is set to the customer's email so the sales team can
 *     answer directly.
 *   - When SMTP_HOST or QUOTE_TO_EMAIL is not configured, sending is
 *     skipped with one clear log line – the quote is still saved.
 *   - Never throws: a failed email must never lose a saved quote, so
 *     errors are caught here and reported to the caller as false.
 */

const nodemailer = require("nodemailer");

// ── Is the email side configured? ───────────────────────────────────
// Host and recipient are the minimum. User/password may stay empty for
// an open local relay and are simply passed through when set.
const isConfigured = () =>
  Boolean(process.env.SMTP_HOST && process.env.QUOTE_TO_EMAIL);

// Build the transport once, on first use
let transporter = null;
const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host:              process.env.SMTP_HOST,
      port:              parseInt(process.env.SMTP_PORT, 10) || 587,
      auth:              process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
      connectionTimeout: 10000,   // do not hang the request on a dead SMTP server
    });
  }
  return transporter;
};

// ── Plain-text body: every field, the product details, the date ──────
const buildBody = (quote) => {
  const lines = [
    `Date:    ${new Date().toISOString()}`,
    "",
    `Name:    ${quote.name}`,
    `Email:   ${quote.email}`,
    `Phone:   ${quote.phone}`,
  ];

  // Optional context – only listed when the visitor filled them in
  if (quote.company)  lines.push(`Company: ${quote.company}`);
  if (quote.service)  lines.push(`Service: ${quote.service}`);
  if (quote.emirate)  lines.push(`Emirate: ${quote.emirate}`);
  if (quote.category) lines.push(`Category: ${quote.category}`);

  lines.push("", "Message:", quote.message);

  // Product context – only listed when present
  if (quote.productName || quote.modelNumber || quote.brandName) {
    lines.push("", "Product:");
    if (quote.productName) lines.push(`  Name:  ${quote.productName}`);
    if (quote.modelNumber) lines.push(`  Model: ${quote.modelNumber}`);
    if (quote.brandName)   lines.push(`  Brand: ${quote.brandName}`);
  }

  return lines.join("\n");
};

// ── Send the notification ────────────────────────────────────────────
// quote = { name, email, phone, company, service, emirate, category,
//           message, productName, modelNumber, brandName }
//
// Resolves true when the email was sent, false when it was skipped
// (not configured) or failed. Never rejects.
const sendQuoteEmail = async (quote) => {
  if (!isConfigured()) {
    console.log("📧  Email not configured, quote saved only");
    return false;
  }

  try {
    await getTransporter().sendMail({
      from:    process.env.SMTP_USER || process.env.QUOTE_TO_EMAIL,
      to:      process.env.QUOTE_TO_EMAIL,
      replyTo: quote.email,                                  // answer the customer directly
      subject: `New quote request: ${quote.productName || quote.service || "General enquiry"} (${quote.name})`,
      text:    buildBody(quote),
    });
    return true;
  } catch (err) {
    console.error("❌  Quote email failed:", err.message);
    return false;
  }
};

module.exports = { sendQuoteEmail };
