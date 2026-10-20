"use client";

import { useEffect, useState } from "react";
import { Bell, Download, Send } from "lucide-react";
import { Button } from "@/components/ui/button";

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };

async function pushApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/backend/me/push/${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "No se pudo completar la petición.");
  return data;
}

export async function removeDevicePush() {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const sub = await registration?.pushManager?.getSubscription();
  if (!sub) return;
  try { await pushApi("unsubscribe", { endpoint: sub.endpoint }); }
  finally { await sub.unsubscribe(); }
}

export function MobileSetup({ visible }: { visible: boolean }) {
  const [supported, setSupported] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [standalone, setStandalone] = useState(false);
  const [ios, setIos] = useState(false);
  const [install, setInstall] = useState<InstallPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const available = isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    const onInstall = (event: Event) => { event.preventDefault(); setInstall(event as InstallPrompt); };
    const onInstalled = () => { setStandalone(true); setInstall(null); };
    window.addEventListener("beforeinstallprompt", onInstall);
    window.addEventListener("appinstalled", onInstalled);
    (async () => {
      try {
        const config = await pushApi<{ configured: boolean }>("config");
        if (mounted) setConfigured(config.configured);
        if (available) {
          const registration = await navigator.serviceWorker.getRegistration();
          const sub = await registration?.pushManager.getSubscription();
          const status = sub ? await pushApi<{ subscribed: boolean }>("status", { endpoint: sub.endpoint }) : { subscribed: false };
          if (mounted) setSubscribed(status.subscribed && Notification.permission === "granted");
        }
      } catch (cause) { if (mounted) setError(cause instanceof Error ? cause.message : "No se pudo consultar el estado."); }
      finally {
        if (mounted) {
          setStandalone(isStandalone); setIos(isIos); setSupported(available);
          if ("Notification" in window) setPermission(Notification.permission);
          setLoading(false);
        }
      }
    })();
    return () => { mounted = false; window.removeEventListener("beforeinstallprompt", onInstall); window.removeEventListener("appinstalled", onInstalled); };
  }, []);

  async function toggle() {
    setBusy(true); setMessage(""); setError("");
    try {
      if (subscribed) { await removeDevicePush(); setSubscribed(false); setMessage("Notificaciones desactivadas en este dispositivo."); return; }
      // Request permission directly from the user's gesture, including on iOS.
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") throw new Error("Permite las notificaciones en los ajustes del navegador para recibir avisos.");
      const config = await pushApi<{ configured: boolean; publicKey: string }>("config");
      if (!config.configured) throw new Error("El servidor aún no tiene configuradas las notificaciones.");
      await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
      const registration = await navigator.serviceWorker.ready;
      const key = Uint8Array.from(atob(config.publicKey.replace(/-/g, "+").replace(/_/g, "/")), (value) => value.charCodeAt(0));
      const sub = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await pushApi("subscribe", sub.toJSON());
      setSubscribed(true); setMessage("Avisos de fichajes y problemas activados en este dispositivo.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudieron activar los avisos."); }
    finally { setBusy(false); }
  }

  async function test() {
    setBusy(true); setMessage(""); setError("");
    try {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (!sub) throw new Error("Activa primero las notificaciones.");
      await pushApi("test", { endpoint: sub.endpoint });
      setMessage("Prueba enviada. Comprueba que aparece una notificación en el móvil.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo enviar la prueba."); }
    finally { setBusy(false); }
  }

  return <div hidden={!visible} className="space-y-3 pt-5">
    <section className="rounded-2xl border border-zinc-200 bg-white p-4"><h2 className="flex items-center gap-2 font-semibold"><Download className="h-5 w-5 text-emerald-700" />Instalar en el móvil</h2>
      <p className="mt-2 text-sm text-zinc-500">{standalone ? "La app ya está abierta como aplicación instalada." : ios ? "En Safari: Compartir → Añadir a pantalla de inicio. Después ábrela desde su icono." : "En el menú del navegador, elige Instalar aplicación o Añadir a pantalla de inicio."}</p>
      {install && !standalone && <Button className="mt-3 w-full" onClick={async () => { await install.prompt(); await install.userChoice; setInstall(null); }}>Instalar aplicación</Button>}
    </section>
    <section className="rounded-2xl border border-zinc-200 bg-white p-4"><h2 className="flex items-center gap-2 font-semibold"><Bell className="h-5 w-5 text-emerald-700" />Notificaciones del móvil</h2>
      <p className="mt-2 text-sm text-zinc-500">Recibe avisos cuando se registre un fichaje, falle, quede sin confirmar o no se ejecute a tiempo, aunque la app esté cerrada.</p>
      <p className="mt-3 text-xs font-medium text-zinc-600">{loading ? "Comprobando…" : !configured ? "Pendiente de configurar el servidor" : ios && !standalone ? "Instala la app primero para recibir notificaciones" : !supported ? "Este navegador necesita HTTPS y compatibilidad con notificaciones" : permission === "denied" ? "Permiso bloqueado en el navegador" : subscribed ? "Activadas en este dispositivo" : "Desactivadas en este dispositivo"}</p>
      <div className="mt-3 flex gap-2"><Button className="flex-1" disabled={loading || busy || !supported || !configured || (ios && !standalone) || permission === "denied"} onClick={() => void toggle()}>{busy ? "Procesando…" : subscribed ? "Desactivar" : "Activar avisos"}</Button>{subscribed && <Button variant="outline" disabled={busy} onClick={() => void test()}><Send className="h-4 w-4" />Probar</Button>}</div>
      {error && <p role="alert" className="mt-3 text-xs text-red-700">{error}</p>}{message && <p role="status" className="mt-3 text-xs text-emerald-700">{message}</p>}
    </section>
  </div>;
}
