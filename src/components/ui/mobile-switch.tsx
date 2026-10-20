"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function MobileSwitch({ checked, onChange, label, children, disabled = false, compact = false }: {
  checked: boolean;
  onChange: () => void;
  label: string;
  children?: ReactNode;
  disabled?: boolean;
  compact?: boolean;
}) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={onChange}
    className={cn("mobile-switch touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:opacity-50", compact && "mobile-switch-compact")}>
    {children && <span className="min-w-0 text-left">{children}</span>}
    <span aria-hidden="true" className={cn("switch-track", checked && "switch-track-on")}><span className="switch-thumb" /></span>
    {compact && <span className="text-xs font-semibold text-zinc-600">Auto {checked ? "ON" : "OFF"}</span>}
  </button>;
}
