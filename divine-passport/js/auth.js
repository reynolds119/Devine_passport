import { supabase } from "./supabase.js";

const profileFields = "user_id,email,full_name,phone,delivery_channel,nationality,occupation,profile_photo,role,registration_status,created_at";

export function authRedirectUrl(path) {
  const configuredOrigin = import.meta.env.VITE_APP_URL?.trim();
  const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  const origin = configuredOrigin || (isLocalHost ? "" : location.origin);
  return origin ? new URL(path, `${origin.replace(/\/$/, "")}/`).href : undefined;
}

function normalizePhone(input) {
  let value = String(input || "").trim().replace(/[\s().-]/g, "");
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  if (value.startsWith("+")) return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
  if (!/^\d+$/.test(value)) return null;
  if (value.startsWith("0")) value = `+233${value.slice(1)}`;
  else if (/^[1-9]\d{10,14}$/.test(value)) value = `+${value}`;
  return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
}

export async function getProfile() {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) return null;

  const { data: profile, error } = await supabase
    .from("profiles")
    .select(profileFields)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (!profile) throw new Error("Your account profile is missing. Run sql/setup_project.sql in the Supabase SQL Editor.");

  return {
    ...profile,
    user_id: user.id,
    email: profile.email || user.email || null,
    phone: profile.phone || user.phone || null,
    delivery_channel: profile.delivery_channel || "email",
  };
}

export async function requireAuth(role, loginUrl, homeUrl) {
  const profile = await getProfile();
  if (!profile) {
    location.replace(loginUrl);
    return null;
  }
  if (role === "admin" && profile.role !== "admin") {
    location.replace(homeUrl);
    return null;
  }
  if (role === "member" && profile.role === "admin") {
    location.replace("admin/dashboard.html");
    return null;
  }
  if (profile.registration_status !== "APPROVED") {
    await supabase.auth.signOut();
    location.replace(loginUrl + "?pending=1");
    return null;
  }
  return profile;
}

export async function login(identifier, password) {
  const value = identifier.trim();
  const credentials = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    ? { email: value.toLowerCase(), password }
    : { phone: normalizePhone(value), password };
  if (!credentials.email && !credentials.phone) throw new Error("Enter a valid email address or phone number.");
  const { error } = await supabase.auth.signInWithPassword(credentials);
  if (error) throw error;
  return getProfile();
}

export async function updateProfilePhoto(file) {
  if (!file || file.size > 750 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Choose a JPEG, PNG, or WebP image smaller than 750 KB.");
  }
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error("Please sign in before changing your photo.");

  const extension = file.type.split("/")[1].replace("jpeg", "jpg");
  const path = `${user.id}/profile-${Date.now()}.${extension}`;
  const { error: uploadError } = await supabase.storage.from("avatars").upload(path, file, { contentType: file.type });
  if (uploadError) throw uploadError;

  const { data: { publicUrl } } = supabase.storage.from("avatars").getPublicUrl(path);
  const { error } = await supabase.from("profiles").update({ profile_photo: publicUrl }).eq("user_id", user.id);
  if (error) throw error;
  return publicUrl;
}

export async function register(form, photo) {
  if (photo && (photo.size > 750 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(photo.type))) {
    throw new Error("Choose a JPEG, PNG, or WebP image smaller than 750 KB.");
  }

  const meta = { ...form.meta };
  const phone = normalizePhone(meta.phone);
  if (meta.delivery_channel === "phone" && !phone) throw new Error("Enter a valid phone number with its country code.");
  meta.phone = phone;

  const usePhone = meta.delivery_channel === "phone";
  const credentials = usePhone ? { phone } : { email: form.email.trim().toLowerCase() };
  const redirectTo = authRedirectUrl("login.html");
  const { data, error } = await supabase.auth.signUp({
    ...credentials,
    password: form.password,
    options: {
      data: { ...meta, email: form.email.trim().toLowerCase() || null },
      ...(redirectTo ? { emailRedirectTo: redirectTo } : {}),
    },
  });
  if (error) throw error;

  if (!data.session) {
    return { signedIn: false, confirmationRequired: true, channel: usePhone ? "phone" : "email", phone };
  }

  const profile = await getProfile();
  if (photo) {
    try {
      profile.profile_photo = await updateProfilePhoto(photo);
    } catch (error) {
      throw new Error(`Your account was created, but the photo could not be saved. Add it from your profile after signing in. ${error.message}`);
    }
  }
  return { signedIn: true, profile };
}

export async function verifyPhoneSignup(phone, token, photo) {
  const { error } = await supabase.auth.verifyOtp({ phone, token, type: "sms" });
  if (error) throw error;
  const profile = await getProfile();
  if (photo) profile.profile_photo = await updateProfilePhoto(photo);
  return profile;
}

export const logout = async to => {
  await supabase.auth.signOut();
  location.replace(to);
};

export const validPassword = password =>
  password.length >= 8 && /[A-Z]/.test(password) && /[0-9]/.test(password);
