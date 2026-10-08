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
  if (!supabaseUrl || !serviceRoleKey) return respond(500, { error: "Transfer reporting is not configured." });

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
  const reference = typeof body.reference === "string" ? body.reference.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const transferReference = typeof body.transfer_reference === "string" ? body.transfer_reference.trim() : "";
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (
    !/^DPW-[0-9a-f-]{36}$/i.test(reference) ||
    !emailPattern.test(email) || email.length > 254 ||
    !transferReference || transferReference.length > 120
  ) {
    return respond(400, { error: "Enter the donation email and bank transfer reference." });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin
    .from("donations")
    .update({ status: "pending_review", transfer_reference: transferReference })
    .eq("reference", reference)
    .eq("donor_email", email)
    .eq("payment_method", "bank_transfer")
    .eq("status", "awaiting_transfer")
    .select("reference")
    .maybeSingle();
  if (error) return respond(500, { error: "Could not submit the transfer for review." });
  if (!data) return respond(404, { error: "Transfer request not found. Check the reference and email." });

  return respond(200, { message: "Transfer details submitted. We will confirm it after checking the bank receipt." });
});
