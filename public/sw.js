self.addEventListener("push", (event) => {
  const data = event.data?.json() || {};
  event.waitUntil(self.registration.showNotification(data.title || "Control Horari", {
    body: data.body || "Hay una novedad en tu fichaje.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: data.tag || "controlhorari",
    data: { url: data.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || "/"));
});
