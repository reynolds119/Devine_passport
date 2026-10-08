const { randomBytes, createHash, scrypt: scryptCallback, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const database = require("./lib/sqlserver");
const { sendMail, sendSms, normalizePhone, scriptureEmail, scriptureSms } = require("./lib/notify");

const scrypt = promisify(scryptCallback);

function json(statusCode, body, headers = {}) {
  return { statusCode, headers: { "Content-Type": "application/json; charset=utf-8", ...headers }, body: JSON.stringify(body) };
}

function cookieValue(headers, name) {
  const cookies = headers.cookie || headers.Cookie || "";
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

function sessionCookie(token, maxAge) {
  const secure = process.env.CONTEXT === "dev" ? "" : "; Secure";
  return `dp_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function requestPath(event) {
  const path = new URL(event.rawUrl || `https://local.invalid${event.path}`).pathname;
  return path.replace(/^\/(?:\.netlify\/functions\/api|api)/, "").replace(/\/+$/, "") || "/";
}

function requestBody(event) {
  if (!event.body) return {};
  const body = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body;
  if (body.length > 1_500_000) throw Object.assign(new Error("Request body is too large."), { status: 413 });
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

// Members who have not yet been sent their scripture successfully.
const AWAITING_SQL = `SELECT COUNT(*) AS total FROM users u
  WHERE u.role = 'member' AND u.registration_status = 'APPROVED'
    AND NOT EXISTS (SELECT 1 FROM scripture_sends x WHERE x.user_id = u.id AND x.status = 'sent')`;

function isDuplicateKey(error) {
  return error.number === 2601 || error.number === 2627;
}

function normalizeProfile(row) {
  if (!row) return null;
  return {
    user_id: row.id,
    email: row.email,
    full_name: row.full_name,
    phone: row.phone,
    delivery_channel: row.delivery_channel || "email",
    nationality: row.nationality,
    occupation: row.occupation,
    profile_photo: row.profile_photo,
    role: row.role,
    registration_status: row.registration_status,
    created_at: row.created_at,
  };
}

async function currentUser(event) {
  const token = cookieValue(event.headers || {}, "dp_session");
  if (!token) return null;
  const [rows] = await database().execute(
    `SELECT TOP (1) u.* FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > SYSUTCDATETIME()
    `,
    [hashToken(token)],
  );
  return normalizeProfile(rows[0]);
}

function requireUser(user) {
  if (!user) throw Object.assign(new Error("Please sign in to continue."), { status: 401 });
  if (user.registration_status !== "APPROVED") {
    const message = user.registration_status === "REJECTED"
      ? "Your registration was not approved."
      : "Your registration is awaiting approval.";
    throw Object.assign(new Error(message), { status: 403 });
  }
  return user;
}

function requireAdmin(user) {
  requireUser(user);
  if (user.role !== "admin") throw Object.assign(new Error("Administrator access is required."), { status: 403 });
  return user;
}

async function newPasswordHash(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function checkPassword(password, encoded) {
  const [algorithm, saltText, keyText] = String(encoded).split("$");
  if (algorithm !== "scrypt" || !saltText || !keyText) return false;
  const expected = Buffer.from(keyText, "base64");
  const actual = await scrypt(typeof password === "string" ? password : "", Buffer.from(saltText, "base64"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function createSession(userId) {
  const token = randomBytes(32).toString("base64url");
  await database().execute(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, DATEADD(DAY, 30, SYSUTCDATETIME()))",
    [randomBytes(16).toString("hex"), userId, hashToken(token)],
  );
  return token;
}

// Validates the "where do you want your scripture?" choice and phone number.
// Returns { channel, phone } ready to store; throws a 400 error otherwise.
function contactPreference(channelInput, phoneInput) {
  const channel = channelInput == null || channelInput === "" ? "email" : String(channelInput);
  if (!["email", "phone"].includes(channel)) {
    throw Object.assign(new Error("Choose whether to receive your scripture by email or phone."), { status: 400 });
  }
  const rawPhone = phoneInput == null ? "" : String(phoneInput).trim();
  const normalized = normalizePhone(rawPhone);
  if (channel === "phone" && !normalized) {
    throw Object.assign(new Error("Enter a valid phone number to receive your scripture by phone (for example +233 24 123 4567 or 024 123 4567)."), { status: 400 });
  }
  if (rawPhone.length > 160) throw Object.assign(new Error("phone is too long."), { status: 400 });
  return { channel, phone: normalized || rawPhone || null };
}

function validPassword(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 200 && /[A-Z]/.test(password) && /[0-9]/.test(password);
}

function appUrl(path) {
  if (!process.env.APP_URL) {
    throw Object.assign(new Error("Set APP_URL to your deployed site origin in Netlify."), { status: 503 });
  }
  const origin = new URL(process.env.APP_URL);
  if (origin.protocol !== "https:" && process.env.CONTEXT !== "dev") {
    throw Object.assign(new Error("APP_URL must use HTTPS."), { status: 503 });
  }
  return new URL(path, origin.origin);
}

async function dispatch(event) {
  const method = event.httpMethod;
  const path = requestPath(event);
  const body = requestBody(event);
  const db = database();
  const user = await currentUser(event);

  if (method === "GET" && path === "/health") {
    await db.query("SELECT 1");
    return json(200, { ok: true });
  }

  if (method === "POST" && path === "/auth/register") {
    const email = String(body.email || "").trim().toLowerCase() || null;
    const fullName = String(body.meta?.full_name || "").trim();
    if (fullName.length < 2 || fullName.length > 120) throw Object.assign(new Error("Enter your full name."), { status: 400 });
    if (!validPassword(body.password)) throw Object.assign(new Error("Password must be at least 8 characters and contain an uppercase letter and a number."), { status: 400 });
    for (const field of ["nationality", "occupation"]) {
      const value = body.meta?.[field];
      if (value != null && String(value).length > 160) throw Object.assign(new Error(`${field} is too long.`), { status: 400 });
    }
    const contact = contactPreference(body.meta?.delivery_channel, body.meta?.phone);
    if ((!email && contact.channel !== "phone") || (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254))) {
      throw Object.assign(new Error(contact.channel === "phone" ? "Enter a valid email address or leave it blank to sign up by SMS." : "Enter a valid email address to receive scriptures by email."), { status: 400 });
    }
    if (!email) {
      const [existing] = await db.execute("SELECT TOP (1) id FROM users WHERE email IS NULL AND phone = ?", [contact.phone]);
      if (existing[0]) throw Object.assign(new Error("An account with this phone number already exists. Sign in with your phone number instead."), { status: 409 });
    }
    const id = randomBytes(16).toString("hex");
    const passwordHash = await newPasswordHash(body.password);
    try {
      await db.execute(
        `INSERT INTO users
          (id, email, password_hash, full_name, phone, delivery_channel, nationality, occupation, registration_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED')`,
        [id, email, passwordHash, fullName, contact.phone, contact.channel, body.meta?.nationality || null, body.meta?.occupation || null],
      );
    } catch (error) {
      if (isDuplicateKey(error)) throw Object.assign(new Error("An account with this email or phone number already exists."), { status: 409 });
      throw error;
    }
    const token = await createSession(id);
    const [rows] = await db.execute("SELECT * FROM users WHERE id = ?", [id]);
    return json(201, { signedIn: true, profile: normalizeProfile(rows[0]) }, { "Set-Cookie": sessionCookie(token, 30 * 24 * 60 * 60) });
  }

  if (method === "POST" && path === "/auth/login") {
    const identifier = String(body.identifier || body.email || "").trim();
    const email = identifier.toLowerCase();
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const phone = isEmail ? null : normalizePhone(identifier);
    const [rows] = isEmail
      ? await db.execute("SELECT TOP (1) * FROM users WHERE email = ?", [email])
      : phone
        ? await db.execute("SELECT TOP (1) * FROM users WHERE email IS NULL AND phone = ?", [phone])
        : [[]];
    if (!rows[0] || !(await checkPassword(body.password, rows[0].password_hash))) throw Object.assign(new Error("Invalid email/phone number or password."), { status: 401 });
    const profile = normalizeProfile(rows[0]);
    if (profile.registration_status !== "APPROVED") {
      const message = profile.registration_status === "REJECTED"
        ? "Your registration was not approved."
        : "Your registration is awaiting admin approval.";
      throw Object.assign(new Error(message), { status: 403 });
    }
    const token = await createSession(profile.user_id);
    return json(200, { profile }, { "Set-Cookie": sessionCookie(token, 30 * 24 * 60 * 60) });
  }

  if (method === "POST" && path === "/auth/logout") {
    const token = cookieValue(event.headers || {}, "dp_session");
    if (token) await db.execute("DELETE FROM sessions WHERE token_hash = ?", [hashToken(token)]);
    return json(200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
  }

  if (method === "GET" && path === "/auth/me") {
    return user ? json(200, { profile: user }) : json(200, { profile: null });
  }

  if (method === "POST" && path === "/auth/password-reset/request") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error("Enter a valid email address."), { status: 400 });
    const [rows] = await db.execute("SELECT id, email FROM users WHERE email = ? AND registration_status = 'APPROVED'", [email]);
    if (rows[0]) {
      const token = randomBytes(32).toString("base64url");
      await db.execute(
        "INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, 'password_reset', DATEADD(HOUR, 1, SYSUTCDATETIME()))",
        [hashToken(token), rows[0].id],
      );
      const resetUrl = appUrl("/reset-password.html");
      resetUrl.searchParams.set("token", token);
      await sendMail({ to: rows[0].email, subject: "Reset your Divine Passport password", text: `Use this link within one hour to reset your password:\n\n${resetUrl.href}\n\nIf you did not request this, ignore this email.` });
    }
    return json(200, { ok: true, message: "If that approved account exists, a password reset link has been sent." });
  }

  if (method === "GET" && path === "/auth/password-reset/validate") {
    const token = new URL(event.rawUrl || `https://local.invalid${event.path}`).searchParams.get("token") || "";
    const [rows] = await db.execute(
      "SELECT token_hash FROM auth_tokens WHERE token_hash = ? AND purpose IN ('password_reset', 'invitation') AND expires_at > SYSUTCDATETIME()",
      [hashToken(token)],
    );
    return json(rows.length ? 200 : 400, { valid: rows.length > 0 });
  }

  if (method === "POST" && path === "/auth/password-reset/complete") {
    const token = String(body.token || "");
    if (!validPassword(body.password)) throw Object.assign(new Error("Password must be at least 8 characters and contain an uppercase letter and a number."), { status: 400 });
    const tokenHash = hashToken(token);
    const [rows] = await db.execute(
      "SELECT user_id FROM auth_tokens WHERE token_hash = ? AND purpose IN ('password_reset', 'invitation') AND expires_at > SYSUTCDATETIME()",
      [tokenHash],
    );
    if (!rows[0]) throw Object.assign(new Error("This password reset link is invalid or expired. Request a new one."), { status: 400 });
    await db.execute("UPDATE users SET password_hash = ?, updated_at = SYSUTCDATETIME() WHERE id = ?", [await newPasswordHash(body.password), rows[0].user_id]);
    await db.execute("DELETE FROM sessions WHERE user_id = ?", [rows[0].user_id]);
    await db.execute("DELETE FROM auth_tokens WHERE token_hash = ?", [tokenHash]);
    return json(200, { ok: true });
  }

  if (method === "PUT" && path === "/profile") {
    requireUser(user);
    const fullName = String(body.full_name || "").trim();
    if (fullName.length < 2 || fullName.length > 120) throw Object.assign(new Error("Enter a name between 2 and 120 characters."), { status: 400 });
    for (const field of ["nationality", "occupation"]) {
      if (body[field] != null && String(body[field]).trim().length > 160) throw Object.assign(new Error(`${field} is too long.`), { status: 400 });
    }
    const contact = contactPreference(body.delivery_channel ?? user.delivery_channel, body.phone);
    if (contact.channel === "email" && !user.email) {
      throw Object.assign(new Error("This account has no email address. Continue receiving scriptures by SMS."), { status: 400 });
    }
    await db.execute(
      `UPDATE users SET full_name = ?, phone = ?, delivery_channel = ?, nationality = ?, occupation = ?, updated_at = SYSUTCDATETIME()
       WHERE id = ?`,
      [fullName, contact.phone, contact.channel, body.nationality ? String(body.nationality).trim() : null, body.occupation ? String(body.occupation).trim() : null, user.user_id],
    );
    const [rows] = await db.execute("SELECT * FROM users WHERE id = ?", [user.user_id]);
    return json(200, { profile: normalizeProfile(rows[0]) });
  }

  if (method === "POST" && path === "/profile/password") {
    requireUser(user);
    if (!validPassword(body.password)) throw Object.assign(new Error("Password must be at least 8 characters and contain an uppercase letter and a number."), { status: 400 });
    await db.execute("UPDATE users SET password_hash = ?, updated_at = SYSUTCDATETIME() WHERE id = ?", [await newPasswordHash(body.password), user.user_id]);
    await db.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?", [user.user_id, hashToken(cookieValue(event.headers || {}, "dp_session"))]);
    return json(200, { ok: true });
  }

  if (method === "PUT" && path === "/profile/photo") {
    requireUser(user);
    const photo = String(body.photo || "");
    if (photo.length > 1_000_000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) {
      throw Object.assign(new Error("Choose a JPEG, PNG, or WebP image smaller than 750 KB."), { status: 400 });
    }
    await db.execute("UPDATE users SET profile_photo = ?, updated_at = SYSUTCDATETIME() WHERE id = ?", [photo, user.user_id]);
    return json(200, { ok: true });
  }

  if (method === "GET" && path === "/scripture/current") {
    requireUser(user);
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [broadcasts] = await connection.execute(
        `SELECT b.scripture_id, b.version, b.updated_at, s.reference, s.body, s.note
         FROM scripture_broadcast b WITH (UPDLOCK, HOLDLOCK)
         JOIN scriptures s ON s.id = b.scripture_id
         WHERE b.singleton = 1 AND s.active = 1`,
      );
      const broadcast = broadcasts[0];
      if (!broadcast) {
        await connection.commit();
        return json(200, { delivery: null });
      }
      const [existing] = await connection.execute(
        "SELECT TOP (1) * FROM deliveries WHERE user_id = ? AND broadcast_version = ?",
        [user.user_id, broadcast.version],
      );
      let delivery = existing[0];
      if (!delivery) {
        const id = randomBytes(16).toString("hex");
        await connection.execute(
          `INSERT INTO deliveries (id, user_id, scripture_id, broadcast_version, delivered_at, read_at)
           VALUES (?, ?, ?, ?, SYSUTCDATETIME(), SYSUTCDATETIME())`,
          [id, user.user_id, broadcast.scripture_id, broadcast.version],
        );
        const [created] = await connection.execute(
          "SELECT * FROM deliveries WHERE user_id = ? AND broadcast_version = ?",
          [user.user_id, broadcast.version],
        );
        delivery = created[0];
      }
      await connection.commit();
      return json(200, { delivery: { ...delivery, s: { reference: broadcast.reference, body: broadcast.body, note: broadcast.note } } });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  const deliveryMatch = path.match(/^\/deliveries\/([a-f0-9-]+)(?:\/(saved|feedback))?$/);
  if (deliveryMatch) {
    requireUser(user);
    const [, id, action] = deliveryMatch;
    if (action === "saved" && method === "PATCH") {
      const saved = Boolean(body.saved);
      const [result] = await db.execute("UPDATE deliveries SET saved = ? WHERE id = ? AND user_id = ?", [saved, id, user.user_id]);
      if (!result.affectedRows) throw Object.assign(new Error("Scripture delivery not found."), { status: 404 });
      return json(200, { ok: true, saved });
    }
    if (action === "feedback" && method === "GET") {
      const [rows] = await db.execute(
        `SELECT f.message, f.created_at
         FROM feedback f JOIN deliveries d ON d.id = f.delivery_id
         WHERE f.delivery_id = ? AND d.user_id = ?
         ORDER BY f.created_at`,
        [id, user.user_id],
      );
      return json(200, { feedback: rows });
    }
    if (action === "feedback" && method === "POST") {
      const message = String(body.message || "").trim();
      if (!message || message.length > 4000) throw Object.assign(new Error("Feedback must be between 1 and 4,000 characters."), { status: 400 });
      const [found] = await db.execute("SELECT id FROM deliveries WHERE id = ? AND user_id = ?", [id, user.user_id]);
      if (!found.length) throw Object.assign(new Error("Scripture delivery not found."), { status: 404 });
      await db.execute("INSERT INTO feedback (id, delivery_id, user_id, message) VALUES (?, ?, ?, ?)", [randomBytes(16).toString("hex"), id, user.user_id, message]);
      return json(201, { ok: true });
    }
  }

  if (method === "GET" && path === "/deliveries/saved") {
    requireUser(user);
    const [rows] = await db.execute(
      `SELECT d.id, d.delivered_at, s.reference, s.body, s.note
       FROM deliveries d JOIN scriptures s ON s.id = d.scripture_id
       WHERE d.user_id = ? AND d.saved = 1 ORDER BY d.delivered_at DESC`,
      [user.user_id],
    );
    return json(200, { deliveries: rows.map(row => ({ ...row, scriptures: { reference: row.reference, body: row.body, note: row.note } })) });
  }

  if (method === "GET" && path === "/donations/bank-accounts") {
    const [rows] = await db.query("SELECT id, currency FROM donation_bank_accounts WHERE is_active = 1 ORDER BY currency");
    return json(200, { accounts: rows });
  }

  if (method === "GET" && path === "/push/key") {
    return json(200, { publicKey: process.env.VAPID_PUBLIC_KEY || null });
  }

  if (path === "/push/subscriptions" && method === "PUT") {
    requireUser(user);
    const endpoint = String(body.endpoint || "");
    const p256dh = String(body.keys?.p256dh || "");
    const auth = String(body.keys?.auth || "");
    if (!endpoint.startsWith("https://") || endpoint.length > 2048 || !p256dh || p256dh.length > 256 || !auth || auth.length > 256) {
      throw Object.assign(new Error("Invalid browser push subscription."), { status: 400 });
    }
    await db.execute(
      `IF EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint_hash = ?)
         UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ? WHERE endpoint_hash = ?
       ELSE
         INSERT INTO push_subscriptions (id, user_id, endpoint, endpoint_hash, p256dh, auth)
         VALUES (?, ?, ?, ?, ?, ?)`,
      [hashToken(endpoint), user.user_id, p256dh, auth, hashToken(endpoint),
        randomBytes(16).toString("hex"), user.user_id, endpoint, hashToken(endpoint), p256dh, auth],
    );
    return json(200, { ok: true });
  }

  if (path === "/push/subscriptions" && method === "DELETE") {
    requireUser(user);
    if (!body.endpoint) throw Object.assign(new Error("Push subscription endpoint is required."), { status: 400 });
    await db.execute("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?", [body.endpoint, user.user_id]);
    return json(200, { ok: true });
  }

  if (method === "POST" && path === "/donations/wire") {
    const email = String(body.email || "").trim().toLowerCase();
    const amount = Number(body.amount);
    const donorName = String(body.donor_name || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000 || donorName.length > 200) {
      throw Object.assign(new Error("Enter a valid email and donation amount."), { status: 400 });
    }
    const [accounts] = await db.execute(
      "SELECT TOP (1) * FROM donation_bank_accounts WHERE id = ? AND currency = ? AND is_active = 1",
      [body.account_id, body.currency],
    );
    if (!accounts[0]) throw Object.assign(new Error("That bank transfer option is no longer available."), { status: 404 });
    const reference = `DP-${Date.now()}-${randomBytes(4).toString("hex").toUpperCase()}`;
    await db.execute(
      `INSERT INTO donations
        (id, reference, payment_method, status, amount_minor, currency, donor_email, donor_name, bank_account_id)
       VALUES (?, ?, 'bank_transfer', 'initialized', ?, ?, ?, ?, ?)`,
      [randomBytes(16).toString("hex"), reference, Math.round(amount * 100), accounts[0].currency, email, donorName || null, accounts[0].id],
    );
    const { id, currency, is_active, created_at, updated_at, ...bank_account } = accounts[0];
    return json(201, { reference, currency, amount, bank_account });
  }

  if (method === "POST" && path === "/donations/wire/report") {
    const email = String(body.email || "").trim().toLowerCase();
    const transferReference = String(body.transfer_reference || "").trim();
    if (!body.reference || !transferReference || transferReference.length > 200) {
      throw Object.assign(new Error("Enter the donation reference and your bank transfer reference."), { status: 400 });
    }
    const [result] = await db.execute(
      `UPDATE donations SET status = 'pending_review', transfer_reference = ?, updated_at = SYSUTCDATETIME()
       WHERE reference = ? AND donor_email = ? AND payment_method = 'bank_transfer' AND status = 'initialized'`,
      [transferReference, body.reference, email],
    );
    if (!result.affectedRows) throw Object.assign(new Error("Donation reference not found or transfer already submitted."), { status: 404 });
    return json(200, { message: "Transfer details submitted. An admin will confirm after the funds arrive." });
  }

  if (method === "POST" && path === "/donations/paystack/initialize") {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) throw Object.assign(new Error("Online donations are not configured. Please try again later."), { status: 503 });
    const email = String(body.email || "").trim().toLowerCase();
    const amount = Number(body.amount);
    const donorName = String(body.donor_name || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !Number.isFinite(amount) || amount < 1 || amount > 100_000 || donorName.length > 200) {
      throw Object.assign(new Error("Paystack donations must be between GHS 1 and GHS 100,000."), { status: 400 });
    }
    const reference = `DP-${Date.now()}-${randomBytes(4).toString("hex").toUpperCase()}`;
    const amountMinor = Math.round(amount * 100);
    await db.execute(
      `INSERT INTO donations
        (id, reference, payment_method, amount_minor, currency, donor_email, donor_name)
       VALUES (?, ?, 'paystack', ?, 'GHS', ?, ?)`,
      [randomBytes(16).toString("hex"), reference, amountMinor, email, donorName || null],
    );
    const payment = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, amount: amountMinor, reference, callback_url: appUrl("/give.html").href }),
    });
    const result = await payment.json();
    if (!payment.ok || !result.status || !result.data?.authorization_url) {
      await db.execute("UPDATE donations SET status = 'failed', updated_at = SYSUTCDATETIME() WHERE reference = ?", [reference]);
      console.error("Paystack initialization failed:", result.message || payment.status);
      throw Object.assign(new Error("Paystack could not start checkout. Please try again."), { status: 502 });
    }
    return json(200, { authorization_url: result.data.authorization_url, reference });
  }

  if (method === "POST" && path === "/donations/paystack/verify") {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) throw Object.assign(new Error("Online donations are not configured."), { status: 503 });
    const reference = String(body.reference || "");
    const [donations] = await db.execute("SELECT amount_minor, currency FROM donations WHERE reference = ? AND payment_method = 'paystack'", [reference]);
    if (!donations[0]) throw Object.assign(new Error("Donation reference not found."), { status: 404 });
    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const verification = await response.json();
    if (!response.ok || !verification.status) throw Object.assign(new Error("Paystack could not verify this payment yet."), { status: 502 });
    const data = verification.data;
    const valid = data.status === "success" && data.amount === Number(donations[0].amount_minor) && data.currency === donations[0].currency;
    const status = valid ? "success" : data.status === "failed" ? "failed" : "initialized";
    await db.execute("UPDATE donations SET status = ?, updated_at = SYSUTCDATETIME() WHERE reference = ?", [status, reference]);
    return json(200, { status: status === "initialized" ? "processing" : status, amount_minor: Number(donations[0].amount_minor) });
  }

  if (method === "POST" && path === "/webhooks/paystack") {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) throw Object.assign(new Error("Paystack webhook is not configured."), { status: 503 });
    const signature = event.headers["x-paystack-signature"] || event.headers["X-Paystack-Signature"];
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body || "", "base64") : Buffer.from(event.body || "");
    const { createHmac } = require("node:crypto");
    const actual = createHmac("sha512", secret).update(rawBody).digest();
    const provided = /^[a-f0-9]{128}$/i.test(signature || "") ? Buffer.from(signature, "hex") : Buffer.alloc(0);
    if (actual.length !== provided.length || !timingSafeEqual(actual, provided)) throw Object.assign(new Error("Invalid Paystack signature."), { status: 401 });
    const notification = JSON.parse(rawBody.toString());
    if (notification.event === "charge.success" && notification.data?.reference) {
      await db.execute(
        `UPDATE donations SET status = 'success', updated_at = SYSUTCDATETIME()
         WHERE reference = ? AND payment_method = 'paystack'
           AND amount_minor = ? AND currency = ?`,
        [notification.data.reference, notification.data.amount, notification.data.currency],
      );
    }
    return json(200, { received: true });
  }

  if (path.startsWith("/admin/")) requireAdmin(user);

  if (method === "POST" && path === "/admin/invitations") {
    const email = String(body.email || "").trim().toLowerCase();
    const fullName = String(body.full_name || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || fullName.length < 2 || fullName.length > 120) {
      throw Object.assign(new Error("Enter a valid email and full name."), { status: 400 });
    }
    const id = randomBytes(16).toString("hex");
    const token = randomBytes(32).toString("base64url");
    try {
      await db.execute(
        `INSERT INTO users (id, email, password_hash, full_name, nationality, occupation, registration_status)
         VALUES (?, ?, ?, ?, ?, ?, 'APPROVED')`,
        [id, email, await newPasswordHash(randomBytes(48).toString("base64url")), fullName, body.nationality || null, body.occupation || null],
      );
      await db.execute(
        "INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, 'invitation', DATEADD(HOUR, 48, SYSUTCDATETIME()))",
        [hashToken(token), id],
      );
      const invitationUrl = appUrl("/reset-password.html");
      invitationUrl.searchParams.set("token", token);
      await sendMail({ to: email, subject: "Your Divine Passport account", text: `Hello ${fullName},\n\nYour account is ready. Set your password within 48 hours using this link:\n\n${invitationUrl.href}` });
    } catch (error) {
      await db.execute("DELETE FROM users WHERE id = ?", [id]);
      if (isDuplicateKey(error)) throw Object.assign(new Error("An account with this email already exists."), { status: 409 });
      throw error;
    }
    return json(201, { message: "Invitation sent." });
  }

  if (method === "GET" && path === "/admin/dashboard") {
    const [[members]] = await db.query("SELECT COUNT(*) AS total FROM users WHERE role = 'member'");
    const [[scriptures]] = await db.query("SELECT COUNT(*) AS total FROM scriptures WHERE active = 1");
    const [[deliveries]] = await db.query("SELECT COUNT(*) AS total FROM deliveries WHERE delivered_at >= CONVERT(date, SYSUTCDATETIME())");
    const [[feedbackCount]] = await db.query("SELECT COUNT(*) AS total FROM feedback");
    const [[awaiting]] = await db.query(AWAITING_SQL);
    const [feedback] = await db.query(
      `SELECT f.message, f.created_at, s.reference
       FROM feedback f JOIN deliveries d ON d.id = f.delivery_id
       JOIN scriptures s ON s.id = d.scripture_id
       ORDER BY f.created_at DESC OFFSET 0 ROWS FETCH NEXT 15 ROWS ONLY`,
    );
    return json(200, { counts: [members.total, scriptures.total, deliveries.total, feedbackCount.total, awaiting.total], feedback });
  }

  if (method === "GET" && path === "/admin/users") {
    const [rows] = await db.query("SELECT id AS user_id, full_name, email, role, registration_status FROM users ORDER BY full_name");
    return json(200, { users: rows });
  }

  if (method === "GET" && path === "/admin/bank-accounts") {
    const [rows] = await db.query("SELECT * FROM donation_bank_accounts ORDER BY currency");
    return json(200, { accounts: rows });
  }

  if (method === "PUT" && path === "/admin/bank-accounts") {
    const allowedCurrencies = ["USD", "GBP", "EUR"];
    if (!allowedCurrencies.includes(body.currency)) throw Object.assign(new Error("Currency must be USD, GBP, or EUR."), { status: 400 });
    const fields = ["beneficiary_name", "bank_name", "account_number", "iban", "swift_bic", "routing_number", "bank_address", "payment_instructions"];
    const row = fields.map(field => body[field] == null ? null : String(body[field]).trim());
    const fieldLimits = [200, 200, 100, 100, 50, 100, 2000, 4000];
    if (row.some((value, index) => value && value.length > fieldLimits[index])) {
      throw Object.assign(new Error("One or more bank details exceed the allowed length."), { status: 400 });
    }
    const updateSql = fields.map(field => `${field} = ?`).concat("is_active = ?").join(", ");
    const insertSql = fields.join(", ");
    const columns = fields.map(() => "?").join(", ");
    await db.execute(
      `IF EXISTS (SELECT 1 FROM donation_bank_accounts WHERE currency = ?)
         UPDATE donation_bank_accounts SET ${updateSql} WHERE currency = ?
       ELSE
         INSERT INTO donation_bank_accounts (id, currency, ${insertSql}, is_active)
         VALUES (?, ?, ${columns}, ?)`,
      [body.currency, ...row, Boolean(body.is_active), body.currency, randomBytes(16).toString("hex"), body.currency, ...row, Boolean(body.is_active)],
    );
    return json(200, { ok: true });
  }

  if (method === "GET" && path === "/admin/wire-transfers") {
    const [transfers] = await db.query(
      `SELECT id, reference, currency, amount_minor, donor_email, donor_name, transfer_reference, created_at
       FROM donations WHERE payment_method = 'bank_transfer' AND status = 'pending_review'
       ORDER BY created_at`,
    );
    return json(200, { transfers });
  }

  const wireMatch = path.match(/^\/admin\/wire-transfers\/([a-f0-9]+)$/);
  if (method === "PATCH" && wireMatch) {
    const status = body.action === "confirm" ? "success" : body.action === "reject" ? "rejected" : null;
    if (!status) throw Object.assign(new Error("Choose confirm or reject."), { status: 400 });
    const [result] = await db.execute(
      "UPDATE donations SET status = ?, updated_at = SYSUTCDATETIME() WHERE id = ? AND payment_method = 'bank_transfer' AND status = 'pending_review'",
      [status, wireMatch[1]],
    );
    if (!result.affectedRows) throw Object.assign(new Error("Transfer is not awaiting review."), { status: 404 });
    return json(200, { ok: true });
  }

  if (method === "GET" && path === "/admin/signups/summary") {
    const [[awaiting]] = await db.query(AWAITING_SQL);
    return json(200, { awaiting: awaiting.total });
  }

  if (method === "GET" && path === "/admin/signups") {
    const query = new URL(event.rawUrl || `https://local.invalid${event.path}`).searchParams;
    const onlyAwaiting = query.get("filter") !== "all";
    const [rows] = await db.query(
      `SELECT u.id AS user_id, u.full_name, u.email, u.phone, u.delivery_channel, u.nationality, u.occupation, u.created_at,
              CASE WHEN EXISTS (SELECT 1 FROM scripture_sends x WHERE x.user_id = u.id AND x.status = 'sent') THEN 1 ELSE 0 END AS has_sent,
              ls.status AS last_status, ls.error AS last_error, ls.created_at AS last_attempt_at, ls.channel AS last_channel
       FROM users u
       OUTER APPLY (SELECT TOP (1) status, error, created_at, channel FROM scripture_sends s WHERE s.user_id = u.id ORDER BY s.created_at DESC) ls
       WHERE u.role = 'member' AND u.registration_status = 'APPROVED'
         ${onlyAwaiting ? "AND NOT EXISTS (SELECT 1 FROM scripture_sends x WHERE x.user_id = u.id AND x.status = 'sent')" : ""}
       ORDER BY u.created_at DESC OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY`,
    );
    const [[awaiting]] = await db.query(AWAITING_SQL);
    const [[total]] = await db.query("SELECT COUNT(*) AS total FROM users WHERE role = 'member' AND registration_status = 'APPROVED'");
    return json(200, { signups: rows, awaiting: awaiting.total, total: total.total });
  }

  if (method === "POST" && path === "/admin/signups/send") {
    const ids = Array.isArray(body.user_ids) ? [...new Set(body.user_ids.map(String))] : [];
    if (!ids.length || ids.length > 25 || ids.some(id => !/^[a-f0-9]{32}$/.test(id))) {
      throw Object.assign(new Error("Choose between 1 and 25 members to send to."), { status: 400 });
    }
    let scriptureId = body.scripture_id ? String(body.scripture_id) : "";
    if (!scriptureId) {
      const [[broadcast]] = await db.query("SELECT scripture_id FROM scripture_broadcast WHERE singleton = 1");
      scriptureId = broadcast?.scripture_id || "";
    }
    if (!scriptureId) throw Object.assign(new Error("Choose a scripture to send, or broadcast one first."), { status: 400 });
    const [scriptures] = await db.execute("SELECT TOP (1) id, reference, body, note FROM scriptures WHERE id = ? AND active = 1", [scriptureId]);
    const scripture = scriptures[0];
    if (!scripture) throw Object.assign(new Error("That scripture is not available. Choose an active scripture."), { status: 400 });

    const [members] = await db.execute(
      `SELECT id, full_name, email, phone, delivery_channel FROM users
       WHERE role = 'member' AND registration_status = 'APPROVED' AND id IN (${ids.map(() => "?").join(", ")})`,
      ids,
    );
    const found = new Map(members.map(member => [member.id, member]));

    const sendOne = async id => {
      const member = found.get(id);
      if (!member) return { user_id: id, ok: false, error: "Member not found." };
      const channel = member.delivery_channel === "phone" ? "phone" : "email";
      const destination = channel === "phone" ? normalizePhone(member.phone) : member.email;
      let error = null;
      try {
        if (!destination) throw new Error("No valid phone number on file.");
        if (channel === "phone") await sendSms({ to: destination, text: scriptureSms({ fullName: member.full_name, scripture }) });
        else await sendMail({ to: destination, ...scriptureEmail({ fullName: member.full_name, scripture }) });
      } catch (caught) {
        error = String(caught.message || "Could not send.").slice(0, 500);
        console.error(`Scripture send to ${member.id} via ${channel} failed:`, caught.message);
      }
      await db.execute(
        `INSERT INTO scripture_sends (id, user_id, scripture_id, channel, destination, status, error, sent_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomBytes(16).toString("hex"), member.id, scripture.id, channel, String(destination || member.phone || "").slice(0, 254) || "unknown", error ? "failed" : "sent", error, user.user_id],
      );
      return { user_id: id, ok: !error, channel, error };
    };

    const results = new Array(ids.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(5, ids.length) }, async () => {
      while (next < ids.length) {
        const index = next++;
        results[index] = await sendOne(ids[index]);
      }
    }));
    return json(200, { results, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
  }

  const roleMatch = path.match(/^\/admin\/users\/([a-f0-9]+)\/role$/);
  if (method === "PATCH" && roleMatch) {
    const role = body.role;
    if (!["admin", "member"].includes(role)) throw Object.assign(new Error("Invalid account role."), { status: 400 });
    if (role === "member" && roleMatch[1] === user.user_id) throw Object.assign(new Error("You cannot remove your own administrator access."), { status: 400 });
    if (role === "member") {
      const [[{ total }]] = await db.query("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND registration_status = 'APPROVED'");
      const [[target]] = await db.execute("SELECT role FROM users WHERE id = ?", [roleMatch[1]]);
      if (target?.role === "admin" && total <= 1) throw Object.assign(new Error("The last administrator cannot be removed."), { status: 409 });
    }
    const [result] = await db.execute("UPDATE users SET role = ?, updated_at = SYSUTCDATETIME() WHERE id = ? AND registration_status = 'APPROVED'", [role, roleMatch[1]]);
    if (!result.affectedRows) throw Object.assign(new Error("Approved account not found."), { status: 404 });
    return json(200, { ok: true });
  }

  if (method === "GET" && path === "/admin/scriptures") {
    const [rows] = await db.query(
      `SELECT s.id, s.reference, s.body, s.note, s.active, s.created_at, counts.deliveries_count
       FROM scriptures s
       OUTER APPLY (SELECT COUNT(*) AS deliveries_count FROM deliveries d WHERE d.scripture_id = s.id) counts
       ORDER BY s.created_at DESC`,
    );
    return json(200, { scriptures: rows });
  }

  if (method === "POST" && path === "/admin/scriptures") {
    const rows = Array.isArray(body.scriptures) ? body.scriptures : [body];
    if (!rows.length || rows.length > 500 || rows.some(row =>
      !String(row.reference || "").trim() ||
      String(row.reference).trim().length > 200 ||
      !String(row.body || "").trim() ||
      String(row.body).trim().length > 60000 ||
      (row.note != null && String(row.note).length > 10000)
    )) {
      throw Object.assign(new Error("Every scripture needs a reference and text (up to 500 at a time)."), { status: 400 });
    }
    for (const row of rows) {
      await db.execute(
        "INSERT INTO scriptures (id, reference, body, note) VALUES (?, ?, ?, ?)",
        [randomBytes(16).toString("hex"), String(row.reference).trim(), String(row.body).trim(), row.note ? String(row.note).trim() : null],
      );
    }
    return json(201, { created: rows.length });
  }

  const scriptureMatch = path.match(/^\/admin\/scriptures\/([a-f0-9]+)$/);
  if (scriptureMatch && method === "PATCH") {
    if (typeof body.active !== "boolean") throw Object.assign(new Error("Scripture active state must be true or false."), { status: 400 });
    await db.execute("UPDATE scriptures SET active = ? WHERE id = ?", [body.active, scriptureMatch[1]]);
    return json(200, { ok: true });
  }
  if (scriptureMatch && method === "DELETE") {
    await db.execute("DELETE FROM scriptures WHERE id = ?", [scriptureMatch[1]]);
    return json(200, { ok: true });
  }

  if (method === "GET" && path === "/admin/broadcast") {
    const [rows] = await db.query(
      `SELECT b.scripture_id, b.version, b.updated_at, s.reference
       FROM scripture_broadcast b LEFT JOIN scriptures s ON s.id = b.scripture_id
       WHERE b.singleton = 1`,
    );
    return json(200, rows[0] || { scripture_id: "", updated_at: null, reference: null });
  }
  if (method === "PUT" && path === "/admin/broadcast") {
    const [rows] = await db.execute("SELECT id FROM scriptures WHERE id = ? AND active = 1", [body.scripture_id]);
    if (!rows.length) throw Object.assign(new Error("Select an active scripture before broadcasting."), { status: 400 });
    await db.execute(
      "UPDATE scripture_broadcast SET scripture_id = ?, version = ?, updated_at = SYSUTCDATETIME() WHERE singleton = 1",
      [body.scripture_id, randomBytes(16).toString("hex")],
    );
    return json(200, { ok: true });
  }

  return json(404, { error: "API endpoint not found." });
}

exports.handler = async event => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: {}, body: "" };
  try {
    return await dispatch(event);
  } catch (error) {
    const status = error.status || (isDuplicateKey(error) ? 409 : 500);
    if (status >= 500) console.error("API request failed:", error);
    return json(status, { error: status >= 500 ? "The server could not complete the request." : error.message });
  }
};
