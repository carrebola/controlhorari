import type { Env, JobAction } from "./types";
import type { PunchResult } from "./timenet";
import type { TimenetHistoryEvent } from "./timenet-history";

const duplicate = (): PunchResult => ({ ok: true, skipped: true, code: "already_registered", message: "Ya existe este fichaje para hoy. No se ha repetido." });

// Both entry points use the same durable lock, including across Worker instances.
// Confirmed or uncertain clicks are never automatically retried.
export async function guardedPunch(
  env: Env, userId: string, date: string, action: JobAction,
  readHistory: () => Promise<{ days: { localDate: string }[]; events: TimenetHistoryEvent[] }>,
  execute: () => Promise<PunchResult>,
): Promise<PunchResult> {
  const recorded = await env.DB.prepare("SELECT id FROM punch_events WHERE user_id = ? AND local_date = ? AND action = ? LIMIT 1")
    .bind(userId, date, action).first();
  if (recorded) return duplicate();
  const token = crypto.randomUUID();
  const acquired = await env.DB.prepare("INSERT OR IGNORE INTO punch_guards (user_id, local_date, action, token, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
    .bind(userId, date, action, token, Date.now()).run();
  if (!acquired.meta.changes) {
    const guard = await env.DB.prepare("SELECT status FROM punch_guards WHERE user_id = ? AND local_date = ? AND action = ?")
      .bind(userId, date, action).first<{ status: string }>();
    if (guard?.status === "confirmed") return duplicate();
    return { ok: false, uncertain: true, code: "punch_locked", message: "Hay un fichaje en curso o pendiente de revisión. No se enviará otro." };
  }
  let attempted = false;
  try {
    const history = await readHistory();
    if (!history.days.some((day) => day.localDate === date)) throw new Error("El historial no incluye el día del fichaje.");
    let result: PunchResult;
    if (history.events.some((event) => event.localDate === date && event.action === action)) {
      result = duplicate();
    } else {
      attempted = true;
      result = await execute();
    }
    if (result.uncertain || (result.ok && !result.skipped) || result.code === "already_registered") {
      await env.DB.prepare("UPDATE punch_guards SET status = ? WHERE user_id = ? AND token = ?")
        .bind(result.uncertain ? "uncertain" : "confirmed", userId, token).run();
    } else {
      await env.DB.prepare("DELETE FROM punch_guards WHERE user_id = ? AND token = ?").bind(userId, token).run();
    }
    return result;
  } catch (cause) {
    console.error("No se pudo verificar el fichaje", cause);
    if (attempted) {
      await env.DB.prepare("UPDATE punch_guards SET status = 'uncertain' WHERE user_id = ? AND token = ?").bind(userId, token).run();
    } else {
      await env.DB.prepare("DELETE FROM punch_guards WHERE user_id = ? AND token = ?").bind(userId, token).run();
    }
    return { ok: false, uncertain: attempted, code: attempted ? "confirmation_failed" : "history_unavailable", message: attempted ? "No se pudo confirmar el resultado. No se repetirá sin revisión." : "No se pudo comprobar el historial de Timenet. No se ha enviado el fichaje." };
  }
}
