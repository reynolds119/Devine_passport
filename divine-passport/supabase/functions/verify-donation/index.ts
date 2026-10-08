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
  if (!supabaseUrl || !serviceRoleKey || !paystackSecret) {
    return respond(500, { error: "Donation verification is not configured." });
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
  const reference = (parsedBody as Record<string, unknown>).reference;
  if (typeof reference !== "string" || !/^DP-[0-9a-f-]{36}$/i.test(reference)) {
    return respond(400, { error: "Invalid donation reference." });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: donation, error: lookupError } = await admin
    .from("donations")
    .select("id,amount_minor,currency,status")
    .eq("reference", reference)
    .maybeSingle();
  if (lookupError) return respond(500, { error: "Could not check this donation." });
  if (!donation) return respond(404, { error: "Donation reference not found." });
  if (donation.status === "success") {
    return respond(200, { status: "success", amount_minor: donation.amount_minor, currency: donation.currency });
  }

  let verificationResponse: Response;
  try {
    verificationResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${paystackSecret}` } },
    );
  } catch {
    return respond(502, { error: "Could not verify payment with Paystack." });
  }

  const verification = await verificationResponse.json().catch(() => null);
  const transaction = verification?.data;
  if (!verificationResponse.ok || !verification?.status || !transaction) {
    return respond(502, { error: "Paystack could not verify this payment." });
  }
  if (
    transaction.reference !== reference ||
    transaction.amount !== donation.amount_minor ||
    transaction.currency !== donation.currency
  ) {
    return respond(409, { error: "Verified payment details do not match this donation." });
  }

  if (transaction.status === "success") {
    const { error: updateError } = await admin
      .from("donations")
      .update({ status: "success", paid_at: transaction.paid_at || new Date().toISOString() })
      .eq("id", donation.id);
    if (updateError) return respond(500, { error: "Payment was verified but could not be recorded." });
    return respond(200, { status: "success", amount_minor: donation.amount_minor, currency: donation.currency });
  }

  if (transaction.status === "failed" || transaction.status === "abandoned") {
    await admin.from("donations").update({ status: "failed" }).eq("id", donation.id);
    return respond(200, { status: "failed" });
  }

  return respond(200, { status: "pending" });
});
