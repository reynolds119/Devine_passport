import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const textEncoder = new TextEncoder();

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function matchesSignature(expected: string, received: string) {
  if (!/^[a-f0-9]{128}$/i.test(received) || expected.length !== received.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= expected.charCodeAt(index) ^ received.toLowerCase().charCodeAt(index);
  }
  return difference === 0;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return jsonResponse(405, { error: "Method not allowed." });

  const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!paystackSecret || !supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: "Webhook is not configured." });
  }

  const rawBody = await request.text();
  const receivedSignature = request.headers.get("x-paystack-signature") || "";
  const signingKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(paystackSecret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", signingKey, textEncoder.encode(rawBody));
  const expectedSignature = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (!matchesSignature(expectedSignature, receivedSignature)) {
    return jsonResponse(401, { error: "Invalid webhook signature." });
  }

  let event: { event?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { error: "Invalid webhook body." });
  }
  if (event.event !== "charge.success") return new Response("ok");

  const data = event.data;
  const reference = data?.reference;
  if (typeof reference !== "string" || !/^DP-[0-9a-f-]{36}$/i.test(reference)) {
    return new Response("ok");
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: donation, error: lookupError } = await admin
    .from("donations")
    .select("id,amount_minor,currency,status")
    .eq("reference", reference)
    .maybeSingle();
  if (lookupError) return jsonResponse(500, { error: "Could not load donation." });
  if (!donation) return new Response("ok");

  if (
    data?.status !== "success" ||
    data.amount !== donation.amount_minor ||
    data.currency !== donation.currency
  ) {
    console.error("Paystack webhook details did not match donation", reference);
    return new Response("ok");
  }
  if (donation.status === "success") return new Response("ok");

  const paidAt = typeof data.paid_at === "string" ? data.paid_at : new Date().toISOString();
  const { error: updateError } = await admin
    .from("donations")
    .update({ status: "success", paid_at: paidAt })
    .eq("id", donation.id);
  if (updateError) return jsonResponse(500, { error: "Could not record verified donation." });

  return new Response("ok");
});
