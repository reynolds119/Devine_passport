const nodemailer = require("nodemailer");

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function configError(message) {
  return Object.assign(new Error(message), { status: 503 });
}

// ---------- Email (SMTP) ----------

function emailConfigured() {
  const { SMTP_HOST, SMTP_USER, SMTP_PASSWORD, MAIL_FROM } = process.env;
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASSWORD && MAIL_FROM);
}

let transport;
function mailTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
  }
  return transport;
}

async function sendMail({ to, subject, text, html }) {
  if (!emailConfigured()) {
    throw configError("Email is not configured. Add SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and MAIL_FROM to your environment variables.");
  }
  await mailTransport().sendMail({ from: process.env.MAIL_FROM, to, subject, text, ...(html ? { html } : {}) });
}

// ---------- SMS (Twilio REST API, no extra dependency) ----------

function smsConfigured() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, TWILIO_MESSAGING_SERVICE_SID } = process.env;
  return Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && (TWILIO_FROM || TWILIO_MESSAGING_SERVICE_SID));
}

async function sendSms({ to, text }) {
  if (!smsConfigured()) {
    throw configError("SMS is not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID) to your environment variables.");
  }
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, TWILIO_MESSAGING_SERVICE_SID } = process.env;
  const form = new URLSearchParams({ To: to, Body: text });
  if (TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", TWILIO_MESSAGING_SERVICE_SID);
  else form.set("From", TWILIO_FROM);
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    // Non-JSON error body; fall through to the generic message below.
  }
  if (!response.ok) {
    throw new Error(result.message ? `SMS provider: ${result.message}` : `SMS provider returned ${response.status}.`);
  }
  return result.sid || null;
}

// ---------- Phone numbers ----------

// Returns an E.164 number (+233241234567) or null when the input cannot be trusted.
// Numbers starting with 0 are treated as local numbers of DEFAULT_COUNTRY_CODE (Ghana, 233).
function normalizePhone(input) {
  if (input == null) return null;
  let value = String(input).trim().replace(/[\s().-]/g, "");
  if (!value) return null;
  const defaultCode = String(process.env.DEFAULT_COUNTRY_CODE || "233").replace(/\D/g, "");
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  if (value.startsWith("+")) {
    return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
  }
  if (!/^\d+$/.test(value)) return null;
  if (value.startsWith("0")) {
    const local = value.slice(1);
    const full = `+${defaultCode}${local}`;
    return local.length >= 7 && /^\+[1-9]\d{7,14}$/.test(full) ? full : null;
  }
  return /^[1-9]\d{10,14}$/.test(value) ? `+${value}` : null;
}

// ---------- Scripture messages ----------

function homeLink() {
  try {
    if (!process.env.APP_URL) return null;
    return new URL("/home.html", new URL(process.env.APP_URL).origin).href;
  } catch {
    return null;
  }
}

function scriptureEmail({ fullName, scripture }) {
  const first = String(fullName || "").trim().split(/\s+/)[0] || "Friend";
  const link = homeLink();
  const text = [
    `Hello ${first},`,
    "",
    "Welcome to Divine Passport. Here is your scripture:",
    "",
    scripture.reference,
    scripture.body,
    ...(scripture.note ? ["", scripture.note] : []),
    ...(link ? ["", `Open your passport: ${link}`] : []),
    "",
    "Pure Fire Miracle Ministries International",
  ].join("\n");
  const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:auto;padding:24px;color:#16223f">
  <p>Hello ${escapeHtml(first)},</p>
  <p>Welcome to Divine Passport. Here is your scripture:</p>
  <div style="background:#f1f4fa;border-left:4px solid #f2b632;padding:16px 18px;border-radius:8px">
    <div style="font-weight:700;color:#0a1a3f;margin-bottom:8px">${escapeHtml(scripture.reference)}</div>
    <div style="font-size:17px;line-height:1.6">${escapeHtml(scripture.body).replace(/\n/g, "<br>")}</div>
    ${scripture.note ? `<p style="color:#6b7794;font-size:14px;margin:12px 0 0">${escapeHtml(scripture.note)}</p>` : ""}
  </div>
  ${link ? `<p><a href="${escapeHtml(link)}" style="color:#1f4fd8">Open your passport</a></p>` : ""}
  <p style="color:#6b7794;font-size:13px">Pure Fire Miracle Ministries International</p>
</div>`;
  return { subject: `Your Divine Passport scripture: ${scripture.reference}`, text, html };
}

function scriptureSms({ fullName, scripture }) {
  const first = String(fullName || "").trim().split(/\s+/)[0] || "Friend";
  const link = homeLink();
  const head = `Divine Passport — Hello ${first}. ${scripture.reference}: `;
  const tail = link ? ` ${link}` : "";
  const room = 900 - head.length - tail.length;
  const body = scripture.body.length > room ? `${scripture.body.slice(0, Math.max(0, room - 1)).trimEnd()}…` : scripture.body;
  return `${head}${body}${tail}`;
}

module.exports = {
  emailConfigured,
  smsConfigured,
  sendMail,
  sendSms,
  normalizePhone,
  scriptureEmail,
  scriptureSms,
};
