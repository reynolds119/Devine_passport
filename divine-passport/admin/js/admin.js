import { requireAuth, logout } from "../../js/auth.js";
import { invokeFunction, supabase } from "../../js/supabase.js";
import { $, esc, fmtDate, toast, confirmBox } from "../../js/utils.js";

export async function guard() {
  const profile = await requireAuth("admin", "login.html", "../home.html");
  if (!profile) return null;
  $(".burger")?.addEventListener("click", () => $(".side").classList.toggle("open"));
  $("#logout")?.addEventListener("click", () => logout("login.html"));
  void signupBadge();
  return profile;
}

// Shows how many new members are still waiting for their scripture next to the Signups link.
export async function signupBadge() {
  const link = $("#nav-signups");
  if (!link) return;
  try {
    const { data, error } = await supabase.rpc("admin_signup_summary");
    if (error) throw error;
    link.querySelector(".badge")?.remove();
    if (data.awaiting > 0) link.insertAdjacentHTML("beforeend", `<span class="badge">${data.awaiting}</span>`);
  } catch {
    // The badge is a convenience; ignore failures.
  }
}

export async function dashboard() {
  const adminProfile = await guard();
  if (!adminProfile) return;

  try {
    const count = async query => {
      const { count: total, error } = await query;
      if (error) throw error;
      return total || 0;
    };
    const utcDayStart = new Date();
    utcDayStart.setUTCHours(0, 0, 0, 0);
    const [members, activeScriptures, deliveries, feedbackCount, summary, feedbackResult] = await Promise.all([
      count(supabase.from("profiles").select("user_id", { count: "exact", head: true }).eq("role", "member")),
      count(supabase.from("scriptures").select("id", { count: "exact", head: true }).eq("active", true)),
      count(supabase.from("deliveries").select("id", { count: "exact", head: true }).gte("delivered_at", utcDayStart.toISOString())),
      count(supabase.from("feedback").select("id", { count: "exact", head: true })),
      supabase.rpc("admin_signup_summary"),
      supabase.from("feedback").select("message,created_at,deliveries(scriptures(reference))").order("created_at", { ascending: false }).limit(15),
    ]);
    if (summary.error) throw summary.error;
    if (feedbackResult.error) throw feedbackResult.error;
    const counts = [members, activeScriptures, deliveries, feedbackCount, summary.data.awaiting];
    const feedback = feedbackResult.data.map(item => ({ ...item, reference: item.deliveries?.scriptures?.reference || "Scripture" }));
    counts.forEach((count, index) => { $("#s" + (index + 1)).textContent = count; });
    $("#fb").innerHTML = feedback.length
      ? feedback.map(item => `<div class="item"><div>${esc(item.message)}<small>${esc(item.reference)} · ${fmtDate(item.created_at)}</small></div></div>`).join("")
      : `<div class="empty">No feedback yet.</div>`;
  } catch (error) {
    $("#fb").innerHTML = `<div class="empty">Could not load dashboard information.</div>`;
    toast(error.message, "error");
  }

  const loadUsers = async () => {
    const list = $("#admin-user-list");
    list.innerHTML = `<div class="empty">Loading approved accounts…</div>`;
    try {
      const { data: allUsers, error } = await supabase.from("profiles").select("user_id,full_name,email,role,registration_status").order("full_name");
      if (error) throw error;
      const users = allUsers.filter(item => item.registration_status === "APPROVED");
      const adminCount = users.filter(item => item.role === "admin").length;
      $("#admin-role-count").textContent = `${adminCount} approved admin${adminCount === 1 ? "" : "s"} · ${users.length} approved account${users.length === 1 ? "" : "s"}`;
      list.innerHTML = users.length ? users.map(item => {
        const isAdmin = item.role === "admin";
        const isSelf = item.user_id === adminProfile.user_id;
        const action = isSelf && isAdmin
          ? `<span class="hint">You</span>`
          : `<button class="btn sm ${isAdmin ? "red" : "ghost"}" type="button" data-admin-role="${isAdmin ? "remove" : "add"}" data-user-id="${esc(item.user_id)}">${isAdmin ? "Remove admin" : "Make admin"}</button>`;
        return `<div class="item"><div><b>${esc(item.full_name || item.email || "Unnamed account")}</b><small>${esc(item.email || "")} · ${isAdmin ? "Admin" : "Member"}</small></div>${action}</div>`;
      }).join("") : `<div class="empty">No approved accounts found.</div>`;
    } catch (error) {
      list.innerHTML = `<div class="empty">Could not load approved accounts.</div>`;
      toast(error.message, "error");
    }
  };

  $("#admin-user-list").addEventListener("click", async event => {
    const button = event.target.closest("[data-admin-role]");
    if (!button) return;
    const makeAdmin = button.dataset.adminRole === "add";
    if (!(await confirmBox(`Are you sure you want to ${makeAdmin ? "grant" : "remove"} admin access ${makeAdmin ? "to" : "from"} this account?`))) return;
    button.disabled = true;
    try {
      const { error } = await supabase.rpc("manage_admin_role", { target_user_id: button.dataset.userId, make_admin: makeAdmin });
      if (error) throw error;
      toast(makeAdmin ? "Admin access granted" : "Admin access removed", "success");
      await loadUsers();
    } catch (error) {
      button.disabled = false;
      toast(error.message, "error");
    }
  });
  await loadUsers();

  $("#invite-member")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const { message } = await invokeFunction("invite-member", {
          full_name: $("#invite-name").value.trim(),
          email: $("#invite-email").value.trim(),
          nationality: $("#invite-nationality").value.trim(),
          occupation: $("#invite-occupation").value.trim(),
      });
      form.reset();
      toast(message || "Invitation sent.", "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  const accountForm = $("#wire-account-form");
  if (!accountForm) return;
  const accountFields = {
    currency: $("#wire-currency"),
    beneficiary_name: $("#wire-beneficiary"),
    bank_name: $("#wire-bank"),
    account_number: $("#wire-account-number"),
    iban: $("#wire-iban"),
    swift_bic: $("#wire-swift"),
    routing_number: $("#wire-routing"),
    bank_address: $("#wire-address"),
    payment_instructions: $("#wire-instructions"),
  };

  const loadBankAccounts = async () => {
    try {
      const { data: accounts, error } = await supabase.from("donation_bank_accounts").select("*").order("currency");
      if (error) throw error;
      $("#wire-account-list").innerHTML = accounts.length
        ? accounts.map(account => `<div class="item"><div><b>${esc(account.currency)} · ${esc(account.bank_name)}</b><small>${esc(account.beneficiary_name)} · ${account.is_active ? "Shown to donors" : "Hidden"}</small></div><button class="btn sm ghost" type="button" data-wire-edit="${esc(account.currency)}">Edit</button></div>`).join("")
        : `<div class="empty">No foreign-currency accounts configured.</div>`;
      $("#wire-account-list").onclick = event => {
        const currency = event.target.closest("[data-wire-edit]")?.dataset.wireEdit;
        const account = accounts.find(item => item.currency === currency);
        if (!account) return;
        Object.entries(accountFields).forEach(([key, field]) => { field.value = account[key] || ""; });
        $("#wire-active").checked = Boolean(account.is_active);
        accountForm.scrollIntoView({ behavior: "smooth", block: "center" });
      };
    } catch (error) {
      toast(error.message, "error");
    }
  };

  accountForm.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = accountForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    const row = Object.fromEntries(Object.entries(accountFields).map(([key, field]) => [key, field.value.trim() || null]));
    row.is_active = $("#wire-active").checked;
    try {
      const { error } = await supabase.from("donation_bank_accounts").upsert(row, { onConflict: "currency" });
      if (error) throw error;
      toast("Bank instructions saved", "success");
      accountForm.reset();
      $("#wire-active").checked = true;
      await loadBankAccounts();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      submit.disabled = false;
    }
  });

  const loadWireTransfers = async () => {
    try {
      const { transfers } = await invokeFunction("admin-review-wires", { action: "list" });
      $("#wire-transfer-list").innerHTML = transfers.length
        ? transfers.map(item => `<div class="item wire-transfer"><div><b>${esc(item.donor_name || "Donor")} · ${esc(item.currency)} ${(item.amount_minor / 100).toFixed(2)}</b><small>${esc(item.donor_email)} · Ref ${esc(item.transfer_reference)} · ${fmtDate(item.created_at)}</small><small>Donation ${esc(item.reference)}</small></div><button class="btn sm" type="button" data-wire-review="confirm" data-id="${esc(item.id)}">Confirm received</button><button class="btn sm red" type="button" data-wire-review="reject" data-id="${esc(item.id)}">Reject</button></div>`).join("")
        : `<div class="empty">No transfers awaiting review.</div>`;
    } catch (error) {
      $("#wire-transfer-list").innerHTML = `<div class="empty">Could not load pending transfers.</div>`;
      toast(error.message, "error");
    }
  };

  $("#wire-transfer-list").onclick = async event => {
    const button = event.target.closest("[data-wire-review]");
    if (!button) return;
    const confirm = button.dataset.wireReview === "confirm";
    if (!(await confirmBox(confirm ? "Confirm that this bank transfer has arrived in your account?" : "Reject this reported bank transfer?"))) return;
    button.disabled = true;
    try {
      await invokeFunction("admin-review-wires", { action: button.dataset.wireReview, id: button.dataset.id });
      toast(confirm ? "Donation confirmed" : "Transfer rejected", "success");
      await loadWireTransfers();
    } catch (error) {
      button.disabled = false;
      toast(error.message, "error");
    }
  };

  await Promise.all([loadBankAccounts(), loadWireTransfers()]);
}

export async function scriptures() {
  if (!(await guard())) return;

  const loadBroadcast = async () => {
    const { data: broadcast, error } = await supabase.from("scripture_broadcast").select("scripture_id,broadcast_at,scriptures(reference)").eq("singleton", true).maybeSingle();
    if (error) throw error;
    $("#current-broadcast").textContent = broadcast?.scripture_id
      ? `Current broadcast: ${broadcast.scriptures?.reference || "Scripture"} · ${fmtDate(broadcast.broadcast_at)}`
      : "No scripture has been broadcast yet.";
  };

  const load = async () => {
    try {
      const { data, error } = await supabase.from("scriptures").select("id,reference,body,note,active,created_at,delivery_count:deliveries(count)").order("created_at", { ascending: false });
      if (error) throw error;
      const rows = data.map(item => ({ ...item, deliveries_count: item.delivery_count?.[0]?.count || 0 }));
      $("#broadcast-scripture").innerHTML = `<option value="">Choose an active scripture</option>` +
        rows.filter(item => item.active).map(item => `<option value="${esc(item.id)}">${esc(item.reference)}</option>`).join("");
      $("#list").innerHTML = rows.length ? rows.map(item => `<div class="item"><div><b>${esc(item.reference)}</b> ${item.active ? "" : "(paused)"}<small>${esc(item.body.slice(0, 90))} · sent ${item.deliveries_count}×</small></div><button class="btn sm ghost" data-t="${esc(item.id)}" data-a="${Boolean(item.active)}">${item.active ? "Pause" : "Resume"}</button><button class="btn sm red" data-d="${esc(item.id)}">Delete</button></div>`).join("") : `<div class="empty">No scriptures uploaded yet.</div>`;
      await loadBroadcast();
    } catch (error) {
      toast(error.message, "error");
    }
  };

  $("#broadcast").onsubmit = async event => {
    event.preventDefault();
    const scriptureId = $("#broadcast-scripture").value;
    if (!scriptureId) return toast("Choose a scripture to broadcast.", "error");
    if (!(await confirmBox("Broadcast this scripture to all members? It replaces their current scripture."))) return;
    try {
      const { error } = await supabase.from("scripture_broadcast").update({ scripture_id: scriptureId }).eq("singleton", true);
      if (error) throw error;
      toast("Scripture broadcast to all members", "success");
      await loadBroadcast();
      event.target.reset();
    } catch (error) {
      toast(error.message, "error");
    }
  };

  $("#add").onsubmit = async event => {
    event.preventDefault();
    const rows = $("#bulk").value.trim()
      ? $("#bulk").value.trim().split("\n").map(line => line.split("|").map(value => value.trim())).filter(row => row.length >= 2).map(row => ({ reference: row[0], body: row[1], note: row[2] || null }))
      : [{ reference: $("#ref").value.trim(), body: $("#body").value.trim(), note: $("#note").value.trim() || null }];
    if (!rows.length || rows.some(row => !row.reference || !row.body)) return toast("Every scripture needs a reference and text.", "error");
    try {
      const { error } = await supabase.from("scriptures").insert(rows);
      if (error) throw error;
      toast(rows.length + " uploaded", "success");
      event.target.reset();
      await load();
    } catch (error) {
      toast(error.message, "error");
    }
  };

  $("#list").onclick = async event => {
    const data = event.target.closest("button")?.dataset;
    if (!data) return;
    if (data.d && !(await confirmBox("Delete this scripture?"))) return;
    try {
      if (data.t) {
        const { error } = await supabase.from("scriptures").update({ active: data.a !== "true" }).eq("id", data.t);
        if (error) throw error;
      } else if (data.d) {
        const { error } = await supabase.from("scriptures").delete().eq("id", data.d);
        if (error) throw error;
      }
      else return;
      await load();
    } catch (error) {
      toast(error.message, "error");
    }
  };

  await load();
}

export async function signups() {
  if (!(await guard())) return;

  let filter = "awaiting";
  let rows = [];
  let busyNow = false;
  const selected = new Set();

  const channelLabel = row => row.delivery_channel === "phone" ? "Phone (SMS)" : "Email";
  const destination = row => row.delivery_channel === "phone" ? (row.phone || "No phone number") : row.email;
  const status = row => {
    if (row.has_sent) return `<span class="pill ok">Sent</span>`;
    if (row.last_status === "failed") return `<span class="pill bad">Failed</span><small>${esc(row.last_error || "Could not send.")}</small>`;
    return `<span class="pill new">New</span>`;
  };

  const render = () => {
    $("#list").innerHTML = rows.length
      ? rows.map(row => `<div class="item signup"><input type="checkbox" data-pick="${esc(row.user_id)}" aria-label="Select ${esc(row.full_name)}" ${selected.has(row.user_id) ? "checked" : ""}><div><b>${esc(row.full_name)}</b><small>${esc(channelLabel(row))} · ${esc(destination(row))}</small><small>${[row.nationality, row.occupation].filter(Boolean).map(esc).join(" · ")}${row.nationality || row.occupation ? " · " : ""}Joined ${fmtDate(row.created_at)}</small></div><div style="flex:none;text-align:right">${status(row)}</div><button class="btn sm" type="button" data-send="${esc(row.user_id)}">${row.has_sent ? "Resend" : "Send"}</button></div>`).join("")
      : `<div class="empty">${filter === "awaiting" ? "No new members are waiting for a scripture." : "No members yet."}</div>`;
    $("#send-selected").textContent = selected.size ? `Send to selected (${selected.size})` : "Send to selected";
    $("#send-selected").disabled = !selected.size || busyNow;
    document.querySelectorAll("[data-filter]").forEach(button => button.classList.toggle("on", button.dataset.filter === filter));
  };

  const load = async () => {
    try {
      const { data, error } = await supabase.rpc("admin_signups", { only_awaiting: filter === "awaiting" });
      if (error) throw error;
      rows = data.signups;
      for (const id of [...selected]) if (!rows.some(row => row.user_id === id)) selected.delete(id);
      $("#s-awaiting").textContent = data.awaiting;
      $("#s-total").textContent = data.total;
      render();
      void signupBadge();
    } catch (error) {
      $("#list").innerHTML = `<div class="empty">Could not load signups.</div>`;
      toast(error.message, "error");
    }
  };

  const loadScriptures = async () => {
    try {
      const [scripturesResult, broadcastResult] = await Promise.all([
        supabase.from("scriptures").select("id,reference,active").order("created_at", { ascending: false }),
        supabase.from("scripture_broadcast").select("scripture_id,scriptures(reference)").eq("singleton", true).maybeSingle(),
      ]);
      if (scripturesResult.error) throw scripturesResult.error;
      if (broadcastResult.error) throw broadcastResult.error;
      const all = scripturesResult.data;
      const broadcast = broadcastResult.data || {};
      $("#scripture").innerHTML = `<option value="">${broadcast.scripture_id ? `Current broadcast: ${esc(broadcast.reference || "Scripture")}` : "No broadcast yet — choose a scripture"}</option>` +
        all.filter(item => item.active).map(item => `<option value="${esc(item.id)}">${esc(item.reference)}</option>`).join("");
    } catch (error) {
      toast(error.message, "error");
    }
  };

  const sendTo = async ids => {
    if (busyNow || !ids.length) return;
    busyNow = true;
    render();
    let sent = 0;
    const failures = [];
    try {
      for (let i = 0; i < ids.length; i += 25) {
        const { results } = await invokeFunction("send-scriptures", {
          user_ids: ids.slice(i, i + 25),
          scripture_id: $("#scripture").value || undefined,
        });
        for (const result of results) {
          if (result.ok) { sent++; selected.delete(result.user_id); }
          else failures.push(result.error);
        }
      }
    } catch (error) {
      toast(error.message, "error");
    }
    busyNow = false;
    if (sent) toast(`Scripture sent to ${sent} member${sent === 1 ? "" : "s"}`, "success");
    if (failures.length) toast(`${failures.length} could not be sent: ${failures[0]}`, "error");
    await load();
  };

  $("#list").addEventListener("change", event => {
    const id = event.target.dataset.pick;
    if (!id) return;
    if (event.target.checked) selected.add(id); else selected.delete(id);
    render();
  });
  $("#list").addEventListener("click", async event => {
    const id = event.target.closest("[data-send]")?.dataset.send;
    if (!id) return;
    const row = rows.find(item => item.user_id === id);
    if (row?.has_sent && !(await confirmBox(`${row.full_name} already received a scripture. Send another?`))) return;
    await sendTo([id]);
  });
  $("#send-selected").addEventListener("click", async () => {
    const ids = [...selected];
    if (!(await confirmBox(`Send the scripture to ${ids.length} member${ids.length === 1 ? "" : "s"} by their chosen email or phone?`))) return;
    await sendTo(ids);
  });
  $("#select-all").addEventListener("click", () => {
    const all = rows.every(row => selected.has(row.user_id));
    rows.forEach(row => all ? selected.delete(row.user_id) : selected.add(row.user_id));
    render();
  });
  document.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => {
    filter = button.dataset.filter;
    selected.clear();
    load();
  }));

  await Promise.all([load(), loadScriptures()]);
  // Pick up new signups without a manual refresh.
  setInterval(() => { if (!busyNow && !document.hidden) load(); }, 30_000);
}
