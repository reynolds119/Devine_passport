import { requireAuth, logout } from "./auth.js";
import { supabase } from "./supabase.js";
import { $, esc, fmtDate, toast } from "./utils.js";
import { chime } from "./sound.js";
const p = await requireAuth("member", "login.html", "home.html");
$("#logout")?.addEventListener("click", () => logout("login.html"));
let cur;
const verse = () => `<div class="card verse">
  <div class="verse-head">
    <span class="tag">Your passport scripture</span>
    <span class="verse-date">${new Date(cur.delivered_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
  </div>
  <div class="ref">${esc(cur.s.reference)}</div>
  <blockquote>${esc(cur.s.body)}</blockquote>
  ${cur.s.note ? `<p class="note">${esc(cur.s.note)}</p>` : ""}
  <div class="row2" style="margin-top:12px"><button class="btn ${cur.saved ? "" : "ghost"}" id="save">${cur.saved ? "★ Saved" : "☆ Save for later"}</button></div>
  <div class="fb"><label>Your feedback on this scripture</label><textarea id="fb" placeholder="How did it speak to you?"></textarea><button class="btn" id="send" style="margin-top:8px">Send feedback</button><div id="fbl"></div></div>
</div>`;
async function show() {
  $("#stage").innerHTML = verse();
  $("#save").onclick = async () => {
    try {
      cur.saved = !cur.saved;
      const { error } = await supabase.from("deliveries").update({ saved: cur.saved }).eq("id", cur.id).eq("user_id", p.user_id);
      if (error) throw error;
      toast(cur.saved ? "Saved to your profile" : "Removed", "success");
      show();
    } catch (error) {
      cur.saved = !cur.saved;
      toast(error.message, "error");
    }
  };
  $("#send").onclick = async () => {
    const message = $("#fb").value.trim();
    if (!message) return;
    try {
      const { error } = await supabase.from("feedback").insert({ delivery_id: cur.id, user_id: p.user_id, message });
      if (error) throw error;
      toast("Feedback sent", "success");
      $("#fb").value = "";
      list();
    } catch (error) {
      toast(error.message, "error");
    }
  };
  list();
}
async function list() {
  try {
    const { data, error } = await supabase.from("feedback").select("message,created_at").eq("delivery_id", cur.id).order("created_at", { ascending: true });
    if (error) throw error;
    $("#fbl").innerHTML = data.map(f => `<div class="fbitem">${esc(f.message)}<br><small>${fmtDate(f.created_at)}</small></div>`).join("");
  } catch (error) {
    toast(error.message, "error");
  }
}
async function revealSound() {
  try {
    if (await chime()) return;
  } catch (error) {
    console.warn("Scripture reveal sound could not play automatically.", error);
  }
}
if (p) {
  $("#hello").textContent = "Hello, " + (p.full_name || "").split(" ")[0];
  const day = new Date();
  $("#day-pill").textContent = day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  try {
    const { data: claimedDelivery, error: claimError } = await supabase.rpc("claim_scripture");
    if (claimError) throw claimError;
    let delivery = Array.isArray(claimedDelivery) ? claimedDelivery[0] : claimedDelivery;
    if (delivery) {
      const { data: scripture, error } = await supabase.from("scriptures").select("reference,body,note").eq("id", delivery.scripture_id).single();
      if (error) throw error;
      delivery = { ...delivery, s: scripture };
    }
    if (!delivery) {
      $("#stage").innerHTML = `<div class="card empty">The church has not broadcast a scripture yet. Please check back soon.</div>`;
    } else {
      cur = delivery;
      show();
      void revealSound();
    }
  } catch (error) {
    toast(error.message, "error");
    $("#stage").innerHTML = `<div class="card empty">Could not load your scripture. Please try again.</div>`;
  }
}
