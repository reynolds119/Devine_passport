export const $ = (s, r = document) => r.querySelector(s);
export const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const fmtDate = d => d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
export function toast(msg, type = "info") {
  let box = $(".toasts"); if (!box) { box = document.createElement("div"); box.className = "toasts"; document.body.append(box); }
  const t = document.createElement("div"); t.className = "toast " + type; t.textContent = msg; box.append(t);
  setTimeout(() => t.remove(), 3500);
}
export function busy(btn, on) { if (on) btn.dataset.l = btn.textContent; btn.disabled = on; btn.textContent = on ? "Please wait…" : btn.dataset.l; }
export function confirmBox(text) {
  return new Promise(res => {
    const m = document.createElement("div"); m.className = "modal";
    m.innerHTML = `<div class="modal-card"><p>${esc(text)}</p><div class="row"><button class="btn ghost" data-v="0">Cancel</button><button class="btn" data-v="1">Confirm</button></div></div>`;
    m.onclick = e => { const v = e.target.dataset.v; if (v !== undefined) { m.remove(); res(v === "1"); } };
    document.body.append(m);
  });
}
