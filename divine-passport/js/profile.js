import { requireAuth, logout, validPassword } from "./auth.js";
import { supabase } from "./supabase.js";
import { updateProfilePhoto } from "./auth.js";
import { enablePush } from "./push.js";
import { $, toast, busy } from "./utils.js";
const p = await requireAuth("member", "login.html", "home.html");
const pic = u => { $("#pick").style.backgroundImage = `url(${u})`; $("#pick").textContent = ""; };
const channel = () => $("#channel").value;
const syncPhoneRequirement = () => {
  const needPhone = channel() === "phone";
  $("#phone").required = needPhone;
  $("#phone-opt").textContent = needPhone ? "(required)" : "(optional)";
};
if (p) {
  $("#nm").textContent = p.full_name || "Profile"; $("#em").textContent = p.email || p.phone || ""; $("#name").value = p.full_name || ""; $("#phone").value = p.phone || ""; $("#channel").value = p.delivery_channel || "email"; $("#nat").value = p.nationality || ""; $("#occ").value = p.occupation || "";
  if (!p.email) {
    $("#channel").querySelector('option[value="email"]').disabled = true;
    $("#channel").value = "phone";
    $("#channel-hint").textContent = "This account has no email address, so scriptures can only be sent by SMS.";
  }
  syncPhoneRequirement();
  if (p.profile_photo) pic(p.profile_photo);
  $("#logout2").onclick = () => logout("login.html");
  $("#channel").onchange = syncPhoneRequirement;
  $("#photo").onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 750 * 1024) {
      toast("Choose a JPEG, PNG, or WebP image smaller than 750 KB.", "error");
      return;
    }
    pic(URL.createObjectURL(file));
    try {
      const photoUrl = await updateProfilePhoto(file);
      p.profile_photo = photoUrl;
      pic(photoUrl);
      toast("Photo updated", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  };
  $("#pf").onsubmit = async e => {
    e.preventDefault();
    const phone = $("#phone").value.trim();
    const deliveryChannel = $("#channel").value;
    if (deliveryChannel === "phone" && !phone) {
      toast("Enter your phone number to receive scriptures by SMS.", "error");
      $("#phone").focus();
      return;
    }
    try {
      const { error } = await supabase.from("profiles").update({
        full_name: $("#name").value.trim(),
        phone: phone || null,
        delivery_channel: deliveryChannel,
        nationality: $("#nat").value.trim(),
        occupation: $("#occ").value.trim(),
      }).eq("user_id", p.user_id);
      if (error) throw error;
      toast("Profile saved", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  };
  $("#pw").onsubmit = async e => {
    e.preventDefault();
    if (!validPassword($("#np").value)) return toast("Password is too weak", "error");
    try {
      const { error } = await supabase.auth.updateUser({ password: $("#np").value });
      if (error) throw error;
      toast("Password changed", "success");
      e.target.reset();
    } catch (error) {
      toast(error.message, "error");
    }
  };
  $("#push").onclick = async e => { busy(e.target, true); try { await enablePush(p.user_id); toast("Alerts enabled", "success"); } catch (err) { toast(err.message, "error"); } busy(e.target, false); };
}
