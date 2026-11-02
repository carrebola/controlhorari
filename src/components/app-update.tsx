"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "controlhorari-app-version";

type UpdateReason = "build" | "service-worker";

export function AppUpdateBanner() {
  const [reason, setReason] = useState<UpdateReason | null>(null);
  const waitingWorker = useRef<ServiceWorker | null>(null);
  const refreshing = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let registration: ServiceWorkerRegistration | null = null;
    let pollId = 0;

    const show = (next: UpdateReason, worker?: ServiceWorker | null) => {
      if (cancelled) return;
      if (worker) waitingWorker.current = worker;
      setReason((current) => current ?? next);
    };

    const trackWaiting = (worker: ServiceWorker | null | undefined) => {
      if (!worker) return;
      const ready = () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) show("service-worker", worker);
      };
      ready();
      worker.addEventListener("statechange", ready);
    };

    const onControllerChange = () => {
      if (refreshing.current) return;
      refreshing.current = true;
      window.location.reload();
    };

    const checkBuildVersion = async () => {
      try {
        const response = await fetch("/app-version", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { version?: string };
        const version = data.version?.trim();
        if (!version || cancelled) return;
        const previous = window.localStorage.getItem(STORAGE_KEY);
        if (!previous) {
          window.localStorage.setItem(STORAGE_KEY, version);
          return;
        }
        if (previous !== version) show("build");
      } catch {
        /* Offline or first paint without network: skip. */
      }
    };

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
      void navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then((reg) => {
          if (cancelled) return;
          registration = reg;
          trackWaiting(reg.waiting);
          reg.addEventListener("updatefound", () => trackWaiting(reg.installing));
          void reg.update();
          pollId = window.setInterval(() => void reg.update(), 5 * 60_000);
        })
        .catch(() => {
          /* Registration can fail on insecure contexts. */
        });
    }

    void checkBuildVersion();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void checkBuildVersion();
      void registration?.update();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange);
      if (pollId) window.clearInterval(pollId);
    };
  }, []);

  if (!reason) return null;

  const applyUpdate = () => {
    const worker = waitingWorker.current;
    if (worker) {
      worker.postMessage({ type: "SKIP_WAITING" });
      window.setTimeout(() => {
        if (!refreshing.current) window.location.reload();
      }, 1200);
      return;
    }
    void fetch("/app-version", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { version?: string }) => {
        if (data.version) window.localStorage.setItem(STORAGE_KEY, data.version);
      })
      .finally(() => window.location.reload());
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
      <div className="pointer-events-auto flex max-w-lg items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-950 shadow-lg shadow-emerald-900/10">
        <p className="min-w-0 flex-1 font-medium">Hay una nueva versión de la app.</p>
        <Button type="button" className="h-10 shrink-0" onClick={applyUpdate}>
          <RefreshCcw className="h-4 w-4" aria-hidden="true" />
          Actualizar
        </Button>
      </div>
    </div>
  );
}
