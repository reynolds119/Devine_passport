
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve((request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed." }), {
    status: 405,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  if (!publicKey) return new Response(JSON.stringify({ error: "Push alerts are not configured." }), {
    status: 503,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

  return new Response(JSON.stringify({ publicKey }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});