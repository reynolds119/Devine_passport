import { requireAuth, logout } from "./auth.js";
import { supabase } from "./supabase.js";
import { $, esc, fmtDate, toast } from "./utils.js";
const p = await requireAuth("member", "login.html", "home.html");
$("#logout")?.addEventListener("click", () => logout("login.html"));
async function load() {
  try {
    const { data: deliveries, error } = await supabase.from("deliveries")
      .select("id,delivered_at,scriptures(reference,body)")
      .eq("user_id", p.user_id)
      .eq("saved", true)
      .order("delivered_at", { ascending: false });
    if (error) throw error;
    $("#list").innerHTML = deliveries.length ? deliveries.map(d => `<div class="card verse"><div class="ref">${esc(d.scriptures.reference)}</div><blockquote>${esc(d.scriptures.body)}</blockquote><small>${fmtDate(d.delivered_at)}</small><button class="btn ghost" data-id="${d.id}" style="margin-top:10px">Remove</button></div>`).join("") : `<div class="card empty">Nothing saved yet. Tap “Save for later” on any scripture.</div>`;
  } catch (error) {
    toast(error.message, "error");
  }
}
$("#list").onclick = async e => {
  const id = e.target.dataset.id;
  if (!id) return;
  try {
    const { error } = await supabase.from("deliveries").update({ saved: false }).eq("id", id).eq("user_id", p.user_id);
    if (error) throw error;
    load();
  } catch (error) {
    toast(error.message, "error");
  }
};
if (p) {
  load();
}
