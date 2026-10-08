import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond(405, { error: "Method not allowed." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY");
  const appUrl = Deno.env.get("APP_URL");
  if (!supabaseUrl || !serviceRoleKey || !paystackSecret || !appUrl) {
    return respond(500, { error: "Donation checkout is not configured." });
  }

  let appOrigin: string;
  try {
    appOrigin = new URL(appUrl).origin;
  } catch {
    return respond(500, { error: "Donation return URL is invalid." });
  }

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return respond(400, { error: "Invalid request body." });
  }
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    return respond(400, { error: "Invalid request body." });
  }

  const body = parsedBody as Record<string, unknown>;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const donorName = typeof body.donor_name === "string" ? body.donor_name.trim() : "";
  const amount = typeof body.amount === "number" ? body.amount : Number(body.amount);
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (
    !emailPattern.test(email) || email.length > 254 ||
    donorName.length > 120 || !Number.isFinite(amount) ||
    amount < 1 || amount > 100000 || Math.round(amount * 100) !== amount * 100
  ) {
    return respond(400, { error: "Enter a valid email and a GHS amount from 1 to 100,000." });
  }

  const amountMinor = Math.round(amount * 100);
  const reference = `DP-${crypto.randomUUID()}`;
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: insertError } = await admin.from("donations").insert({
    reference,
    donor_email: email,
    donor_name: donorName || null,
    amount_minor: amountMinor,
    currency: "GHS",
    status: "pending",
  });
  if (insertError) {
    console.error("Could not record pending donation", insertError.message);
    return respond(500, { error: "Could not start donation. Please try again." });
  }

  let paystackResponse: Response;
  try {
    paystackResponse = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${paystackSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: String(amountMinor),
        currency: "GHS",
        reference,
        callback_url: `${appOrigin}/give.html`,
        channels: ["card", "mobile_money", "bank_transfer"],
        metadata: JSON.stringify({ donor_name: donorName || "Anonymous" }),
      }),
    });
  } catch {
    await admin.from("donations").update({ status: "failed" }).eq("reference", reference);
    return respond(502, { error: "Paystack could not be reached. Please try again." });
  }

  const paystackResult = await paystackResponse.json().catch(() => null);
  const authorizationUrl = paystackResult?.data?.authorization_url;
  let checkoutUrl: URL | null = null;
  try {
    if (typeof authorizationUrl === "string") checkoutUrl = new URL(authorizationUrl);
  } catch {}
  if (
    !paystackResponse.ok || !paystackResult?.status ||
    paystackResult.data?.reference !== reference ||
    checkoutUrl?.protocol !== "https:" ||
    checkoutUrl.hostname !== "checkout.paystack.com"
  ) {
    await admin.from("donations").update({ status: "failed" }).eq("reference", reference);
    console.error("Paystack initialization failed", paystackResult?.message || paystackResponse.status);
    return respond(502, { error: "Could not start Paystack checkout. Please try again." });
  }

  return respond(200, { authorization_url: authorizationUrl, reference });
});
