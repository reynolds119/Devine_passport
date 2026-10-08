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
  if (!supabaseUrl || !serviceRoleKey) return respond(500, { error: "Wire transfer is not configured." });

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
  const currency = typeof body.currency === "string" ? body.currency.toUpperCase() : "";
  const accountId = typeof body.account_id === "string" ? body.account_id : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const donorName = typeof body.donor_name === "string" ? body.donor_name.trim() : "";
  const amount = typeof body.amount === "number" ? body.amount : Number(body.amount);
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (
    !["USD", "GBP", "EUR"].includes(currency) ||
    !/^[0-9a-f-]{36}$/i.test(accountId) ||
    !emailPattern.test(email) || email.length > 254 ||
    donorName.length > 120 || !Number.isFinite(amount) ||
    amount < 1 || amount > 100000 || Math.round(amount * 100) !== amount * 100
  ) {
    return respond(400, { error: "Enter a valid currency, amount, and email." });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: bankAccount, error: accountError } = await admin
    .from("donation_bank_accounts")
    .select("id,currency,beneficiary_name,bank_name,account_number,iban,swift_bic,routing_number,bank_address,payment_instructions")
    .eq("id", accountId)
    .eq("currency", currency)
    .eq("is_active", true)
    .maybeSingle();
  if (accountError) return respond(500, { error: "Could not load the bank instructions." });
  if (!bankAccount) return respond(404, { error: "Those bank instructions are not available." });

  const reference = `DPW-${crypto.randomUUID()}`;
  const amountMinor = Math.round(amount * 100);
  const { error: insertError } = await admin.from("donations").insert({
    reference,
    donor_email: email,
    donor_name: donorName || null,
    amount_minor: amountMinor,
    currency,
    payment_method: "bank_transfer",
    bank_account_id: bankAccount.id,
    status: "awaiting_transfer",
  });
  if (insertError) {
    console.error("Could not create wire donation", insertError.message);
    return respond(500, { error: "Could not prepare the transfer. Please try again." });
  }

  return respond(200, {
    reference,
    amount,
    currency,
    bank_account: bankAccount,
  });
});
