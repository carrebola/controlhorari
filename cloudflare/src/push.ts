import webpush from "web-push";
import type { Env } from "./types";

type Subscription = { id: string; endpoint: string; p256dh: string; auth: string };
type PushPayload = { title: string; body: string; tag: string; url: string; level: string };

export function pushConfig(env: Env) {
  return { configured: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY), publicKey: env.VAPID_PUBLIC_KEY || "" };
}

export function validSubscription(value: unknown): value is { endpoint: string; keys: { p256dh: string; auth: string } } {
  if (!value || typeof value !== "object") return false;
  const sub = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof sub.endpoint !== "string" || sub.endpoint.length > 4096 || !sub.keys) return false;
  try {
    const url = new URL(sub.endpoint);
    const allowed = /^(fcm\.googleapis\.com|(?:[\w-]+\.)*push\.services\.mozilla\.com|(?:[\w-]+\.)*push\.apple\.com|(?:[\w-]+\.)*notify\.windows\.com)$/i;
    if (url.protocol !== "https:" || url.port || url.username || url.password || !allowed.test(url.hostname)) return false;
    const decode = (key: unknown) => typeof key === "string" && /^[\w-]+={0,2}$/.test(key) ? atob(key.replace(/-/g, "+").replace(/_/g, "/")) : "";
    return decode(sub.keys.p256dh).length === 65 && decode(sub.keys.auth).length === 16;
  } catch { return false; }
}

async function send(env: Env, sub: Subscription, payload: PushPayload) {
  const details = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
    vapidDetails: { subject: env.VAPID_SUBJECT || env.APP_ORIGIN, publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! },
    TTL: 3600, urgency: "high",
  });
  const response = await fetch(details.endpoint, { method: "POST", headers: details.headers as HeadersInit, body: details.body ? new Uint8Array(details.body) : undefined, redirect: "manual", signal: AbortSignal.timeout(8000) });
  if (response.status === 404 || response.status === 410) {
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(sub.id).run();
    return false;
  }
  if (!response.ok) throw new Error(`El proveedor push respondió ${response.status}`);
  return true;
}

export async function testPush(env: Env, userId: string, endpoint: string) {
  if (!pushConfig(env).configured) throw new Error("Las notificaciones no están configuradas en el servidor.");
  const sub = await env.DB.prepare("SELECT * FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").bind(userId, endpoint).first<Subscription>();
  if (!sub) throw new Error("Activa las notificaciones en este dispositivo primero.");
  const accepted = await send(env, sub, { title: "Notificaciones activadas", body: "Recibirás un aviso cuando se registre un fichaje o haya un problema.", tag: `test-${crypto.randomUUID()}`, url: "/?view=notifications", level: "info" });
  if (!accepted) throw new Error("La suscripción ha caducado. Desactiva y vuelve a activar las notificaciones.");
}

export async function flushPush(env: Env) {
  if (!pushConfig(env).configured) return;
  const now = Date.now();
  await env.DB.prepare("UPDATE notifications SET push_state = 'pending' WHERE push_state = 'sending' AND push_updated_at < ?").bind(now - 120_000).run();
  const pending = await env.DB.prepare("SELECT id, user_id, title, message, level FROM notifications WHERE push_state = 'pending' AND push_attempts < 3 ORDER BY created_at LIMIT 20")
    .all<{ id: string; user_id: string; title: string; message: string; level: string }>();
  for (const notice of pending.results) {
    const claim = await env.DB.prepare("UPDATE notifications SET push_state = 'sending', push_attempts = push_attempts + 1, push_updated_at = ? WHERE id = ? AND push_state = 'pending'").bind(now, notice.id).run();
    if (!claim.meta.changes) continue;
    try {
      const subscriptions = await env.DB.prepare("SELECT s.* FROM push_subscriptions s WHERE s.user_id = ? AND NOT EXISTS (SELECT 1 FROM push_deliveries d WHERE d.notice_id = ? AND d.subscription_id = s.id)").bind(notice.user_id, notice.id).all<Subscription>();
      const results = await Promise.allSettled(subscriptions.results.map(async (sub) => {
        await send(env, sub, { title: notice.title, body: notice.message, tag: notice.id, url: "/?view=notifications", level: notice.level });
        // Expired subscriptions were removed together with their receipts.
        await env.DB.prepare("INSERT OR IGNORE INTO push_deliveries (notice_id, subscription_id) SELECT ?, id FROM push_subscriptions WHERE id = ?").bind(notice.id, sub.id).run();
      }));
      if (results.some((result) => result.status === "rejected")) throw new Error("No se pudo enviar a todos los dispositivos.");
      await env.DB.prepare("UPDATE notifications SET push_state = 'sent' WHERE id = ?").bind(notice.id).run();
    } catch (cause) {
      console.error("Fallo de envío push", cause instanceof Error ? cause.message : "Error de envío");
      await env.DB.prepare("UPDATE notifications SET push_state = CASE WHEN push_attempts >= 3 THEN 'failed' ELSE 'pending' END WHERE id = ?").bind(notice.id).run();
    }
  }
}
