import { invokeFunction, supabase } from "./supabase.js";

const decodeKey = value => {
  const decoded = atob((value + "=".repeat((4 - value.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
};

export async function enablePush() {
  if (!("serviceWorker" in navigator && "PushManager" in window)) {
    throw new Error("Push isn't supported here. On iPhone, add the app to your Home Screen first.");
  }
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications were blocked in your browser.");
  const { publicKey } = await invokeFunction("push-key");
  if (!publicKey) throw new Error("Push alerts aren't configured yet. Ask an administrator to configure VAPID keys.");
  const registration = await navigator.serviceWorker.register("sw.js");
  await navigator.serviceWorker.ready;
  const subscription = (await registration.pushManager.getSubscription()) || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeKey(publicKey),
  });
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error("Please sign in before enabling alerts.");
  const json = subscription.toJSON();
  const { error } = await supabase.from("push_subscriptions").upsert({
    user_id: user.id,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
  }, { onConflict: "endpoint" });
  if (error) throw error;
}
