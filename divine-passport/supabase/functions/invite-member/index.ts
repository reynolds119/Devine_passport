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
  const appUrl = Deno.env.get("APP_URL");
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !appUrl) {
    return respond(500, { error: "Invitation service is not configured." });
  }
  let redirectTo: string;
  try {
    redirectTo = new URL("/profile.html", appUrl).toString();
  } catch {
    return respond(500, { error: "Invitation redirect is not configured." });
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return respond(401, { error: "Sign in with an admin account to invite members." });
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
    return respond(403, { error: "Only approved admins can invite members." });
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
  const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
  const nationality = typeof body.nationality === "string" ? body.nationality.trim() : "";
  const occupation = typeof body.occupation === "string" ? body.occupation.trim() : "";
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (
    email.length > 254 || !emailPattern.test(email) ||
    !fullName || fullName.length > 120 ||
    !nationality || nationality.length > 120 ||
    !occupation || occupation.length > 120
  ) {
    return respond(400, { error: "Enter a valid email and complete all member details." });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: { full_name: fullName, nationality, occupation },
  });
  if (inviteError) return respond(400, { error: inviteError.message });

  return respond(200, { message: "Invitation sent." });
});
