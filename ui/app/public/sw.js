// Service worker: push alerts only. It has no fetch handler, so it never
// caches or changes a request. cam-helper (helper/) sends each push as JSON:
// {"title": "...", "body": "...", "url": "/#review=<id>"}.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Cameras", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Cameras", {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // The helper gives each alert its own tag. Never the link: one review
      // can hold a smoke alarm and a bark, and the second would silently
      // replace the first.
      tag: data.tag || undefined,
      data: { url: data.url || "/" },
    }),
  );
});

// A tap opens the app on the clip: an open window navigates there, else a new
// one opens.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin) {
          return w.focus().then(() => w.navigate(url));
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
