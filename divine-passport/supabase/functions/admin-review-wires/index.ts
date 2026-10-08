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
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return respond(500, { error: "Donation review is not configured." });
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return respond(401, { error: "Sign in as an admin to review transfers." });
  }
  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: authData, error: authError } = await caller.auth.getUser();
  if (authError || !authData.user) return respond(401, { error: "Your session is invalid or expired." });

  const { data: profile, error: profileError } = await caller
    .from("profiles")
    .select("role,registration_status")
    .eq("user_id", authData.user.id)
    .maybeSingle();
  if (profileError) return respond(500, { error: "Could not verify admin permissions." });
  if (profile?.role !== "admin" || profile.registration_status !== "APPROVED") {
    return respond(403, { error: "Only approved admins can review transfers." });
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

  if (body.action === "list") {
    const { data, error } = await caller
      .from("donations")
      .select("id,reference,donor_email,donor_name,amount_minor,currency,transfer_reference,created_at,status")
      .eq("payment_method", "bank_transfer")
      .eq("status", "pending_review")
      .order("created_at", { ascending: true });
    if (error) return respond(500, { error: "Could not load transfers for review." });
    return respond(200, { transfers: data || [] });
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return respond(400, { error: "Invalid transfer id." });
  const status = body.action === "confirm" ? "success" : body.action === "reject" ? "failed" : null;
  if (!status) return respond(400, { error: "Unknown review action." });

  const service = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const update = status === "success"
    ? { status, paid_at: new Date().toISOString() }
    : { status };
  const { data, error } = await service
    .from("donations")
    .update(update)
    .eq("id", id)
    .eq("payment_method", "bank_transfer")
    .eq("status", "pending_review")
    .select("id")
    .maybeSingle();
  if (error) return respond(500, { error: "Could not update the transfer." });
  if (!data) return respond(409, { error: "This transfer has already been reviewed." });

  return respond(200, { status });
});
