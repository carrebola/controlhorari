import { authenticate, createUser, login, logout, type NewUserInput } from "./auth";
import { decryptSecret, encryptSecret, secureEqual } from "./crypto";
import { runScheduler } from "./scheduler";
import { readTimenetHistory } from "./timenet";
import type { Env, ScheduleRow, SessionUser, UserRow } from "./types";

type JsonRecord = Record<string, unknown>;

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function error(message: string, status = 400) {
  return json({ ok: false, message }, status);
}

async function bodyAsObject(request: Request): Promise<JsonRecord> {
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("El cuerpo de la petición no es válido.");
  return value as JsonRecord;
}

function stringField(body: JsonRecord, name: string) {
  const value = body[name];
  if (typeof value !== "string") throw new Error(`El campo ${name} no es válido.`);
  return value;
}

async function requireUser(request: Request, env: Env) {
  const user = await authenticate(request, env);
  if (!user) throw new Response(JSON.stringify({ ok: false, message: "Sesión no válida o caducada." }), {
    status: 401,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
  return user;
}

async function dashboard(env: Env, user: SessionUser) {
  const [profile, schedules, jobs, events, notifications, latestRun, dayStats] = await Promise.all([
    env.DB.prepare("SELECT id, username, display_name, role, enabled, margin_seconds, time_zone FROM users WHERE id = ?")
      .bind(user.id).first(),
    env.DB.prepare("SELECT weekday, enabled, entry_time, exit_time FROM schedules WHERE user_id = ? ORDER BY weekday")
      .bind(user.id).all<ScheduleRow>(),
    env.DB.prepare(
      `SELECT id, local_date, action, target_at, status, attempt_count, executed_at, timenet_time, error_code, error_message
       FROM jobs WHERE user_id = ? ORDER BY target_at DESC LIMIT 50`,
    ).bind(user.id).all(),
    env.DB.prepare(
      "SELECT id, local_date, action, source, recorded_time, created_at FROM punch_events WHERE user_id = ? ORDER BY created_at DESC, recorded_time DESC LIMIT 100",
    ).bind(user.id).all(),
    env.DB.prepare(
      "SELECT id, level, title, message, job_id, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
    ).bind(user.id).all(),
    env.DB.prepare("SELECT * FROM scheduler_runs ORDER BY started_at DESC LIMIT 1").first(),
    env.DB.prepare(
      `SELECT
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
       SUM(CASE WHEN status IN ('failed', 'uncertain', 'missed') THEN 1 ELSE 0 END) AS failure_count,
       AVG(CASE WHEN executed_at IS NOT NULL THEN executed_at - target_at END) AS average_delay_ms
       FROM jobs WHERE user_id = ? AND target_at >= ?`,
    ).bind(user.id, Date.now() - 24 * 60 * 60 * 1000).first(),
  ]);
  return {
    ok: true,
    profile,
    schedules: schedules.results,
    jobs: jobs.results,
    events: events.results,
    notifications: notifications.results,
    health: {
      latestRun,
      schedulerHealthy: Boolean(latestRun && Date.now() - Number(latestRun.started_at) < 3 * 60 * 1000 && latestRun.status !== "failed"),
      last24Hours: dayStats,
    },
  };
}

async function syncHistory(env: Env, user: SessionUser) {
  const credentials = await env.DB.prepare("SELECT pin_ciphertext, pin_iv FROM users WHERE id = ?").bind(user.id).first<UserRow>();
  if (!credentials) return error("Usuario no encontrado.", 404);
  const pin = await decryptSecret(credentials.pin_ciphertext, credentials.pin_iv, env.DATA_ENCRYPTION_KEY);
  const remoteEvents = await readTimenetHistory(env, pin);
  const automatic = await env.DB.prepare(
    "SELECT id, job_id, local_date, action, recorded_time FROM punch_events WHERE user_id = ? AND source = 'automatic'",
  ).bind(user.id).all<{ id: string; job_id: string | null; local_date: string; action: string; recorded_time: string }>();
  const minute = (value: string) => value.slice(0, 5);
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const event of remoteEvents) {
    const matched = automatic.results.find((candidate) =>
      candidate.local_date === event.localDate && candidate.action === event.action && minute(candidate.recorded_time) === minute(event.time));
    if (matched) {
      statements.push(env.DB.prepare("UPDATE punch_events SET recorded_time = ? WHERE id = ?").bind(event.time, matched.id));
    } else {
      statements.push(env.DB.prepare(
        "INSERT OR IGNORE INTO punch_events (id, user_id, job_id, local_date, action, source, recorded_time, created_at) VALUES (?, ?, NULL, ?, ?, 'manual', ?, ?)",
      ).bind(crypto.randomUUID(), user.id, event.localDate, event.action, event.time, now));
    }
  }
  for (let offset = 0; offset < statements.length; offset += 50) await env.DB.batch(statements.slice(offset, offset + 50));
  return json({ ok: true, imported: remoteEvents.length, message: `Historial sincronizado: ${remoteEvents.length} fichajes encontrados.` });
}

function validateSchedule(value: unknown) {
  if (!Array.isArray(value) || value.length !== 7) throw new Error("El horario debe contener los siete días de la semana.");
  return value.map((item, weekday) => {
    if (!item || typeof item !== "object") throw new Error("El horario contiene un día no válido.");
    const row = item as JsonRecord;
    const entry = String(row.entry ?? row.entry_time ?? "");
    const exit = String(row.exit ?? row.exit_time ?? "");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(entry) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(exit)) {
      throw new Error(`Las horas del día ${weekday + 1} no son válidas.`);
    }
    return { weekday, enabled: Boolean(row.enabled), entry, exit };
  });
}

async function updateConfig(request: Request, env: Env, user: SessionUser) {
  const body = await bodyAsObject(request);
  const enabled = Boolean(body.enabled);
  const margin = Number(body.marginSeconds);
  if (!Number.isInteger(margin) || margin < 0 || margin > 3600) return error("El margen debe estar entre 0 y 3600 segundos.");
  const schedules = validateSchedule(body.schedules);
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE users SET enabled = ?, margin_seconds = ?, updated_at = ? WHERE id = ?")
      .bind(enabled ? 1 : 0, margin, now, user.id),
  ];
  if (!enabled) {
    statements.push(
      env.DB.prepare("UPDATE jobs SET status = 'skipped', error_code = 'disabled', updated_at = ? WHERE user_id = ? AND status = 'scheduled' AND target_at > ?")
        .bind(now, user.id, now),
    );
  } else {
    // A disabled future job is deliberately discarded so the next scheduler
    // cycle can recreate it with the current hours and random margin.
    statements.push(
      env.DB.prepare("DELETE FROM jobs WHERE user_id = ? AND status = 'skipped' AND error_code = 'disabled' AND target_at > ?")
        .bind(user.id, now),
    );
  }
  if (typeof body.timenetPin === "string" && body.timenetPin.length) {
    if (!/^\d{3,20}$/.test(body.timenetPin)) return error("El PIN debe contener solo números.");
    const encrypted = await encryptSecret(body.timenetPin, env.DATA_ENCRYPTION_KEY);
    statements.push(
      env.DB.prepare("UPDATE users SET pin_ciphertext = ?, pin_iv = ?, updated_at = ? WHERE id = ?")
        .bind(encrypted.ciphertext, encrypted.iv, now, user.id),
    );
  }
  for (const schedule of schedules) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO schedules (user_id, weekday, enabled, entry_time, exit_time) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, weekday) DO UPDATE SET enabled = excluded.enabled, entry_time = excluded.entry_time, exit_time = excluded.exit_time`,
      ).bind(user.id, schedule.weekday, schedule.enabled ? 1 : 0, schedule.entry, schedule.exit),
    );
  }
  await env.DB.batch(statements);
  return json({ ok: true, message: "Configuración guardada." });
}

async function adminHealth(env: Env) {
  const [latestRuns, statusCounts, users, recentFailures] = await Promise.all([
    env.DB.prepare("SELECT * FROM scheduler_runs ORDER BY started_at DESC LIMIT 30").all(),
    env.DB.prepare("SELECT status, COUNT(*) AS count FROM jobs WHERE target_at >= ? GROUP BY status")
      .bind(Date.now() - 7 * 24 * 60 * 60 * 1000).all(),
    env.DB.prepare("SELECT COUNT(*) AS total, SUM(enabled) AS enabled FROM users").first(),
    env.DB.prepare(
      `SELECT j.id, j.local_date, j.action, j.status, j.error_code, j.error_message, j.updated_at, u.username, u.display_name
       FROM jobs j JOIN users u ON u.id = j.user_id
       WHERE j.status IN ('failed', 'uncertain', 'missed') ORDER BY j.updated_at DESC LIMIT 30`,
    ).all(),
  ]);
  return json({ ok: true, latestRuns: latestRuns.results, statusCounts: statusCounts.results, users, recentFailures: recentFailures.results });
}

async function route(request: Request, env: Env) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (method === "GET" && url.pathname === "/health") return json({ ok: true, service: "controlhorari-worker", time: Date.now() });

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const body = await bodyAsObject(request);
    const result = await login(env, stringField(body, "username"), stringField(body, "password"));
    return result ? json({ ok: true, ...result }) : error("Usuario o contraseña incorrectos.", 401);
  }
  if (method === "POST" && url.pathname === "/api/auth/logout") {
    await logout(request, env);
    return json({ ok: true });
  }

  if (method === "POST" && url.pathname === "/api/admin/users") {
    const caller = await authenticate(request, env);
    const setupSecret = request.headers.get("x-admin-setup-secret");
    const setupAuthorized = Boolean(env.ADMIN_SETUP_SECRET && setupSecret && await secureEqual(setupSecret, env.ADMIN_SETUP_SECRET));
    if (caller?.role !== "admin" && !setupAuthorized) return error("No autorizado.", 403);
    const body = await bodyAsObject(request);
    try {
      const created = await createUser(env, {
        username: stringField(body, "username"),
        displayName: stringField(body, "displayName"),
        password: stringField(body, "password"),
        timenetPin: stringField(body, "timenetPin"),
        role: body.role === "admin" ? "admin" : "user",
      } satisfies NewUserInput);
      return json({ ok: true, user: created }, 201);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "No se pudo crear el usuario.";
      return error(message.includes("UNIQUE") ? "Ese nombre de usuario ya existe." : message, 409);
    }
  }

  if (method === "POST" && url.pathname === "/internal/run-scheduler") {
    const providedSecret = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!env.CRON_SECRET || !providedSecret || !(await secureEqual(providedSecret, env.CRON_SECRET))) return error("No autorizado.", 403);
    return json({ ok: true, ...(await runScheduler(env)) });
  }

  const user = await requireUser(request, env);
  if (method === "GET" && url.pathname === "/api/me") return json(await dashboard(env, user));
  if (method === "PUT" && url.pathname === "/api/me/config") return updateConfig(request, env, user);
  if (method === "POST" && url.pathname === "/api/me/history/sync") return syncHistory(env, user);
  if (method === "POST" && url.pathname === "/api/me/notifications/read") {
    await env.DB.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").bind(Date.now(), user.id).run();
    return json({ ok: true });
  }
  if (method === "GET" && url.pathname === "/api/admin/health") {
    if (user.role !== "admin") return error("No autorizado.", 403);
    return adminHealth(env);
  }
  if (method === "GET" && url.pathname === "/api/admin/users") {
    if (user.role !== "admin") return error("No autorizado.", 403);
    const users = await env.DB.prepare(
      "SELECT id, username, display_name, role, enabled, time_zone, created_at FROM users ORDER BY display_name",
    ).all();
    return json({ ok: true, users: users.results });
  }
  return error("Ruta no encontrada.", 404);
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || origin !== env.APP_ORIGIN) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type, x-admin-setup-secret",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const response = await route(request, env);
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(cors)) headers.set(name, value);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (cause) {
      if (cause instanceof Response) return cause;
      console.error(cause);
      return error("Error interno del servidor.", 500);
    }
  },
  async scheduled(_controller, env, context): Promise<void> {
    context.waitUntil(runScheduler(env));
  },
} satisfies ExportedHandler<Env>;
