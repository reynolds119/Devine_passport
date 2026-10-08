const webpush = require("web-push");
const database = require("./lib/sqlserver");

exports.config = { schedule: "0 8 * * *" };

exports.handler = async () => {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    throw new Error("Scheduled scripture notifications require VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT.");
  }

  const db = database();
  const [broadcasts] = await db.query(
    `SELECT s.reference, s.body
     FROM scripture_broadcast b JOIN scriptures s ON s.id = b.scripture_id
     WHERE b.singleton = 1 AND s.active = 1`,
  );
  if (!broadcasts[0]) return { statusCode: 200, body: "No scripture has been broadcast." };

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const [subscriptions] = await db.query("SELECT id, endpoint, p256dh, auth FROM push_subscriptions");
  const notice = JSON.stringify({
    title: "Your Divine Passport scripture",
    body: `${broadcasts[0].reference} — ${broadcasts[0].body}`.slice(0, 3000),
    url: "/home.html",
  });
  const results = await Promise.allSettled(subscriptions.map(async subscription => {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        notice,
      );
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        await db.execute("DELETE FROM push_subscriptions WHERE id = ?", [subscription.id]);
        return;
      }
      throw error;
    }
  }));
  const failures = results.filter(result => result.status === "rejected");
  if (failures.length) {
    console.error(`${failures.length} of ${subscriptions.length} push notifications failed.`, failures.map(result => result.reason));
  }
  return { statusCode: 200, body: `Sent ${subscriptions.length - failures.length} scripture reminders.` };
};
