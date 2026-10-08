// Service worker: shows the scripture alert even when the app is closed.
self.addEventListener("push", e => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(d.title || "Your scripture has arrived 📖", { body: d.body || "Tap to open today's word.", icon: "assets/images/logo.png", badge: "assets/images/logo.png", vibrate: [120, 60, 120], data: { url: "home.html" } }));
});
self.addEventListener("notificationclick", e => { e.notification.close(); e.waitUntil(clients.openWindow(e.notification.data.url)); });