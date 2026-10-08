import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@10.0.15";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const respond = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>\"]/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;",
}[character] || character));

function normalizePhone(input: unknown) {
  let value = String(input ?? "").trim().replace(/[\s().-]/g, "");
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  if (value.startsWith("+")) return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
  if (!/^\d+$/.test(value)) return null;
  if (value.startsWith("0")) {
    const countryCode = (Deno.env.get("DEFAULT_COUNTRY_CODE") || "233").replace(/\D/g, "");
    value = `+${countryCode}${value.slice(1)}`;
  } else if (/^[1-9]\d{10,14}$/.test(value)) value = `+${value}`;
  return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
}

async function sendSms(to: string, text: string) {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM");
  const messagingService = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID");
  if (!sid || !token || (!from && !messagingService)) throw new Error("SMS delivery is not configured.");

  const form = new URLSearchParams({ To: to, Body: text });
  if (messagingService) form.set("MessagingServiceSid", messagingService);
  else form.set("From", from!);
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || `SMS provider returned ${response.status}.`);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond(405, { error: "Method not allowed." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return respond(500, { error: "Scripture delivery is not configured." });

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return respond(401, { error: "Sign in as an admin to send scriptures." });
  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: authData, error: authError } = await caller.auth.getUser();
  if (authError || !authData.user) return respond(401, { error: "Your session is invalid or expired." });
  const { data: profile, error: profileError } = await caller.from("profiles")
    .select("role,registration_status").eq("user_id", authData.user.id).maybeSingle();
  if (profileError) return respond(500, { error: "Could not verify administrator access." });
  if (profile?.role !== "admin" || profile.registration_status !== "APPROVED") {
    return respond(403, { error: "Only approved admins can send scriptures." });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return respond(400, { error: "Invalid request body." });
  }
  const ids = Array.isArray(body.user_ids) ? [...new Set(body.user_ids.filter((id): id is string => typeof id === "string"))] : [];
  if (!ids.length || ids.length > 25 || ids.some(id => !/^[0-9a-f-]{36}$/i.test(id))) {
    return respond(400, { error: "Choose between 1 and 25 members to send to." });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  let scriptureId = typeof body.scripture_id === "string" ? body.scripture_id : "";
  if (!scriptureId) {
    const { data: broadcast, error } = await admin.from("scripture_broadcast").select("scripture_id").eq("singleton", true).maybeSingle();
    if (error) return respond(500, { error: "Could not load the current broadcast." });
    scriptureId = broadcast?.scripture_id || "";
  }
  const { data: scripture, error: scriptureError } = await admin.from("scriptures")
    .select("id,reference,body,note").eq("id", scriptureId).eq("active", true).maybeSingle();
  if (scriptureError) return respond(500, { error: "Could not load the selected scripture." });
  if (!scripture) return respond(400, { error: "Choose an active scripture or broadcast one first." });

  const { data: members, error: membersError } = await admin.from("profiles")
    .select("user_id,full_name,email,phone,delivery_channel")
    .in("user_id", ids).eq("role", "member").eq("registration_status", "APPROVED");
  if (membersError) return respond(500, { error: "Could not load the selected members." });
  const mailHost = Deno.env.get("SMTP_HOST");
  const mailUser = Deno.env.get("SMTP_USER");
  const mailPassword = Deno.env.get("SMTP_PASSWORD");
  const mailFrom = Deno.env.get("MAIL_FROM");
  const mailer = mailHost && mailUser && mailPassword && mailFrom
    ? nodemailer.createTransport({
        host: mailHost,
        port: Number(Deno.env.get("SMTP_PORT") || 587),
        secure: Deno.env.get("SMTP_SECURE") === "true",
        auth: { user: mailUser, pass: mailPassword },
      })
    : null;

  const memberById = new Map((members || []).map(member => [member.user_id, member]));
  const results = await Promise.all(ids.map(async userId => {
    const member = memberById.get(userId);
    if (!member) return { user_id: userId, ok: false, error: "Approved member not found." };

    const channel = member.delivery_channel === "phone" ? "phone" : "email";
    const destination = channel === "phone" ? normalizePhone(member.phone) : member.email;
    let errorMessage: string | null = null;
    try {
      if (!destination) throw new Error(channel === "phone" ? "No valid phone number on file." : "No email address on file.");
      const fullName = member.full_name || "Member";
      const text = `Hello ${fullName},\n\n${scripture.reference}\n\n${scripture.body}${scripture.note ? `\n\n${scripture.note}` : ""}\n\nDivine Passport`;
      if (channel === "phone") await sendSms(destination, text);
      else {
        if (!mailer || !mailFrom) throw new Error("Email delivery is not configured.");
        await mailer.sendMail({
          from: mailFrom,
          to: destination,
          subject: `Your Divine Passport scripture: ${scripture.reference}`,
          text,
          html: `<p>Hello ${escapeHtml(fullName)},</p><h2>${escapeHtml(scripture.reference)}</h2><p>${escapeHtml(scripture.body).replace(/\n/g, "<br>")}</p>${scripture.note ? `<p>${escapeHtml(scripture.note).replace(/\n/g, "<br>")}</p>` : ""}<p>Divine Passport</p>`,
        });
      }
    } catch (error) {
      errorMessage = String(error instanceof Error ? error.message : "Could not send.").slice(0, 500);
      console.error(`Scripture delivery failed for ${userId}:`, errorMessage);
    }

    const { error: logError } = await admin.from("scripture_sends").insert({
      user_id: userId,
      scripture_id: scripture.id,
      channel,
      destination: String(destination || member.phone || member.email || "unknown").slice(0, 254),
      status: errorMessage ? "failed" : "sent",
      error: errorMessage,
      sent_by: authData.user.id,
    });
    if (logError) console.error("Could not record scripture delivery attempt:", logError.message);
    return { user_id: userId, ok: !errorMessage, channel, error: errorMessage };
  }));

  return respond(200, {
    results,
    sent: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok).length,
  });
});