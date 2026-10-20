import { authenticate, createUser, login, logout, type NewUserInput } from "./auth";
import { decryptSecret, encryptSecret, secureEqual, sha256 } from "./crypto";
import { runScheduler } from "./scheduler";
import { guardedPunch } from "./punch-guard";
import { flushPush, pushConfig, testPush, validSubscription } from "./push";
import { punchTimenet, readTimenetHistory, TimenetError, type PunchResult } from "./timenet";
import { configuredPunchPlan, localDate, weekdayForLocalDate } from "./time";
import type { CalendarDayRow, Env, ScheduleRow, SessionUser, UserRow } from "./types";

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
  const [profile, schedules, jobs, events, notifications, latestRun, dayStats, calendar] = await Promise.all([
    env.DB.prepare("SELECT id, username, display_name, role, enabled, margin_seconds, time_zone FROM users WHERE id = ?")
      .bind(user.id).first(),
    env.DB.prepare("SELECT weekday, enabled, entry_time, exit_time FROM schedules WHERE user_id = ? ORDER BY weekday")
      .bind(user.id).all<ScheduleRow>(),
    env.DB.prepare(
      `SELECT id, local_date, action, target_at, planned_at, status, attempt_count, executed_at, timenet_time, error_code, error_message
       FROM jobs WHERE user_id = ? ORDER BY target_at DESC LIMIT 200`,
    ).bind(user.id).all(),
    env.DB.prepare(
      "SELECT id, local_date, action, source, recorded_time, created_at FROM punch_events WHERE user_id = ? ORDER BY substr(local_date,7,4) DESC, substr(local_date,4,2) DESC, substr(local_date,1,2) DESC, recorded_time DESC LIMIT 1000",
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
    env.DB.prepare("SELECT * FROM calendar_days WHERE user_id = ? ORDER BY substr(local_date,7,4) DESC, substr(local_date,4,2) DESC, substr(local_date,1,2) DESC LIMIT 366")
      .bind(user.id).all<CalendarDayRow>(),
  ]);
  return {
    ok: true,
    profile,
    schedules: schedules.results,
    jobs: jobs.results,
    events: events.results,
    calendar: calendar.results,
    notifications: notifications.results,
    health: {
      latestRun,
      schedulerHealthy: Boolean(latestRun && Date.now() - Number(latestRun.started_at) < 3 * 60 * 1000 && latestRun.status !== "failed"),
      last24Hours: dayStats,
    },
  };
}

async function todayDashboard(env: Env, user: SessionUser) {
  const profile = await env.DB.prepare("SELECT id, username, display_name, role, enabled, margin_seconds, time_zone FROM users WHERE id = ?")
    .bind(user.id).first<Pick<UserRow, "id" | "username" | "display_name" | "role" | "enabled" | "margin_seconds" | "time_zone">>();
  if (!profile) throw new TimenetError("Usuario no encontrado.", 404);
  const date = localDate(Date.now(), profile.time_zone);
  const [schedules, jobs, events, calendar, notifications] = await Promise.all([
    env.DB.prepare("SELECT weekday, enabled, entry_time, exit_time FROM schedules WHERE user_id = ? ORDER BY weekday").bind(user.id).all(),
    env.DB.prepare("SELECT * FROM jobs WHERE user_id = ? AND local_date = ?").bind(user.id, date).all(),
    env.DB.prepare("SELECT id, local_date, action, source, recorded_time, created_at FROM punch_events WHERE user_id = ? AND local_date = ? ORDER BY recorded_time").bind(user.id, date).all(),
    env.DB.prepare("SELECT * FROM calendar_days WHERE user_id = ? AND local_date = ?").bind(user.id, date).all(),
    env.DB.prepare("SELECT id, level, title, message, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").bind(user.id).all(),
  ]);
  return { ok: true, date, profile, schedules: schedules.results, jobs: jobs.results, events: events.results,
    calendar: calendar.results, notifications: notifications.results, health: { latestRun: null, schedulerHealthy: false, last24Hours: null } };
}

async function syncHistory(env: Env, user: SessionUser, todayOnly = false) {
  const credentials = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first<UserRow>();
  if (!credentials) return error("Usuario no encontrado.", 404);
  const pin = await decryptSecret(credentials.pin_ciphertext, credentials.pin_iv, env.DATA_ENCRYPTION_KEY);
  const snapshot = await readTimenetHistory(env, pin);
  const today = localDate(Date.now(), credentials.time_zone);
  if (todayOnly && !snapshot.days.some((day) => day.localDate === today)) throw new TimenetError("El historial de Timenet no incluye el día de hoy.", 502);
  let remoteEvents = todayOnly ? snapshot.events.filter((event) => event.localDate === today) : snapshot.events;
  let days = todayOnly ? snapshot.days.filter((day) => day.localDate === today) : snapshot.days;
  const previous = await env.DB.prepare(`SELECT * FROM calendar_days WHERE user_id = ?${todayOnly ? " AND local_date = ?" : ""}`)
    .bind(...(todayOnly ? [user.id, today] : [user.id])).all<CalendarDayRow>();
  // Bootstrap the available calendar once. Warm daily refreshes never rewrite it.
  if (todayOnly && !previous.results.length) {
    previous.results = (await env.DB.prepare("SELECT * FROM calendar_days WHERE user_id = ?").bind(user.id).all<CalendarDayRow>()).results;
    remoteEvents = snapshot.events;
    days = snapshot.days;
  }
  const schedules = await env.DB.prepare("SELECT * FROM schedules WHERE user_id = ?").bind(user.id).all<ScheduleRow>();
  const automatic = await env.DB.prepare(
    `SELECT id, job_id, local_date, action, recorded_time FROM punch_events WHERE user_id = ? AND source = 'automatic'${todayOnly ? " AND local_date = ?" : ""}`,
  ).bind(...(todayOnly ? [user.id, today] : [user.id])).all<{ id: string; job_id: string | null; local_date: string; action: string; recorded_time: string }>();
  const minute = (value: string) => value.slice(0, 5);
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  const dateKey = (date: string) => date.split("/").reverse().join("-");
  for (const day of days) {
    const old = previous.results.find((row) => row.local_date === day.localDate);
    // The daily refresh only imports actual marks. Calendar and random plans
    // are refreshed explicitly, or initialized when today's plan is absent.
    const [d, m, y] = day.localDate.split("/").map(Number);
    const parts = { day: d, month: m, year: y };
    const upcoming = dateKey(day.localDate) >= dateKey(today);
    const schedule = schedules.results.find((row) => row.weekday === weekdayForLocalDate(parts));
    const expectedKey = schedule?.enabled && day.entryTime && day.exitTime
      ? JSON.stringify([schedule.entry_time, schedule.exit_time, credentials.margin_seconds, credentials.time_zone]) : null;
    if (!todayOnly || !old || (upcoming && (old.plan_key !== expectedKey || (expectedKey && (old.random_entry_at === null || old.random_exit_at === null))))) {
      const plan = upcoming ? configuredPunchPlan(parts, credentials.time_zone, schedule, credentials.margin_seconds,
        { ...old, entry_time: day.entryTime, exit_time: day.exitTime, random_entry_at: old?.random_entry_at ?? null, random_exit_at: old?.random_exit_at ?? null }) : null;
      const entryAt = upcoming ? plan?.entryAt ?? null : old?.random_entry_at ?? null;
      const exitAt = upcoming ? plan?.exitAt ?? null : old?.random_exit_at ?? null;
      statements.push(env.DB.prepare(
        `INSERT INTO calendar_days (user_id, local_date, label, entry_time, exit_time, random_entry_at, random_exit_at, margin_seconds, synced_at, plan_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, local_date) DO UPDATE SET label=excluded.label, entry_time=excluded.entry_time, exit_time=excluded.exit_time,
         random_entry_at=excluded.random_entry_at, random_exit_at=excluded.random_exit_at, margin_seconds=excluded.margin_seconds, synced_at=excluded.synced_at, plan_key=excluded.plan_key`,
      ).bind(user.id, day.localDate, day.label, day.entryTime, day.exitTime, entryAt, exitAt, upcoming ? credentials.margin_seconds : old?.margin_seconds ?? credentials.margin_seconds, now, upcoming ? plan?.key ?? null : old?.plan_key ?? null));
      if (upcoming && plan) {
        for (const [action, target] of [["entry", plan.entryAt], ["exit", plan.exitAt]] as const) {
          statements.push(env.DB.prepare("UPDATE jobs SET target_at = ?, planned_at = ?, updated_at = ? WHERE user_id = ? AND local_date = ? AND action = ? AND status = 'scheduled' AND attempt_count = 0 AND target_at > ?")
            .bind(target, target, now, user.id, day.localDate, action, now));
        }
      }
    }
    // Replace imported marks only for dates confirmed by this complete response.
    // This also removes old false punches parsed from future schedule labels.
    statements.push(env.DB.prepare("DELETE FROM punch_events WHERE user_id = ? AND local_date = ? AND source != 'automatic'")
      .bind(user.id, day.localDate));
  }
  for (const event of remoteEvents) {
    statements.push(env.DB.prepare("UPDATE punch_guards SET status = 'confirmed' WHERE user_id = ? AND local_date = ? AND action = ? AND status = 'uncertain'")
      .bind(user.id, event.localDate, event.action));
    const matched = automatic.results.find((candidate) =>
      candidate.local_date === event.localDate && candidate.action === event.action && minute(candidate.recorded_time) === minute(event.time));
    if (matched) {
      statements.push(env.DB.prepare("UPDATE punch_events SET recorded_time = ? WHERE id = ?").bind(event.time, matched.id));
    } else {
      statements.push(env.DB.prepare(
        "INSERT OR IGNORE INTO punch_events (id, user_id, job_id, local_date, action, source, recorded_time, created_at) VALUES (?, ?, NULL, ?, ?, 'manual', ?, ?)",
      ).bind(`timenet:${user.id}:${event.remoteId}`, user.id, event.localDate, event.action, event.time, now));
    }
  }
  // Keep replacement atomic: failed imports must preserve the previous history.
  await env.DB.batch(statements);
  await env.DB.prepare("UPDATE manual_punch_requests SET status = 'reviewed', updated_at = ? WHERE user_id = ? AND (status = 'uncertain' OR (status = 'running' AND created_at < ?))")
    .bind(now, user.id, now - 5 * 60_000).run();
  if (todayOnly) return json(await todayDashboard(env, user));
  return json({ ok: true, imported: remoteEvents.length, message: `Calendario sincronizado: ${snapshot.days.length} días y ${remoteEvents.length} fichajes reales.` });
}

async function manualPunch(request: Request, env: Env, user: SessionUser) {
  const body = await bodyAsObject(request);
  if (body.action !== "entry" && body.action !== "exit") return error("Elige entrada o salida.");
  if (typeof body.requestId !== "string" || !/^[\da-f-]{36}$/i.test(body.requestId)) return error("Petición de fichaje no válida.");
  const existing = await env.DB.prepare("SELECT action, response FROM manual_punch_requests WHERE id = ? AND user_id = ?")
    .bind(body.requestId, user.id).first<{ action: string; response: string | null }>();
  if (existing) {
    if (existing.action !== body.action) return error("La petición ya se usó para otro fichaje.", 409);
    return existing.response ? json(JSON.parse(existing.response)) : error("Hay un fichaje en curso. Sincroniza antes de repetir.", 409);
  }
  const now = Date.now();
  const credentials = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first<UserRow>();
  if (!credentials) return error("Usuario no encontrado.", 404);
  const date = localDate(now, credentials.time_zone);
  const acquired = await env.DB.prepare("INSERT OR IGNORE INTO manual_punch_requests (id, user_id, action, local_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)")
    .bind(body.requestId, user.id, body.action, date, now, now).run();
  if (!acquired.meta.changes) return error("Hay un fichaje pendiente de confirmar. Sincroniza Timenet antes de continuar.", 409);
  let result: PunchResult;
  try {
    const pin = await decryptSecret(credentials.pin_ciphertext, credentials.pin_iv, env.DATA_ENCRYPTION_KEY);
    const action = body.action;
    result = await guardedPunch(env, user.id, date, action,
      () => readTimenetHistory(env, pin),
      () => punchTimenet(env, pin, action, date, true, credentials.time_zone));
  } catch (cause) {
    console.error("No se pudo iniciar el fichaje manual", cause);
    result = { ok: false, message: "No se pudo conectar con Timenet. Vuelve a intentarlo.", code: "connection_failed" };
  }
  const finishedAt = Date.now();
  const status = result.uncertain ? "uncertain" : !result.ok ? "failed" : result.skipped ? "skipped" : "success";
  const updates = [env.DB.prepare("UPDATE manual_punch_requests SET status = ?, response = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(status, JSON.stringify(result), finishedAt, body.requestId, user.id)];
  if (result.ok && !result.skipped && result.time && credentials) {
    updates.push(env.DB.prepare("INSERT INTO punch_events (id, user_id, job_id, local_date, action, source, recorded_time, created_at) VALUES (?, ?, NULL, ?, ?, 'manual', ?, ?)")
      .bind(`manual:${body.requestId}`, user.id, localDate(finishedAt, credentials.time_zone), body.action, result.time, finishedAt));
  }
  await env.DB.batch(updates);
  await env.DB.prepare("INSERT INTO notifications (id, user_id, level, title, message, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), user.id, !result.ok ? "error" : result.skipped ? "info" : "success", !result.ok ? "Problema con el fichaje manual" : result.skipped ? "Fichaje manual omitido" : `Fichaje manual: ${body.action === "entry" ? "entrada" : "salida"}`, result.message, finishedAt).run();
  return json(result);
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
  const oldUser = await env.DB.prepare("SELECT margin_seconds, time_zone FROM users WHERE id = ?").bind(user.id).first<{ margin_seconds: number; time_zone: string }>();
  const oldSchedules = await env.DB.prepare("SELECT * FROM schedules WHERE user_id = ?").bind(user.id).all<ScheduleRow>();
  const planChanged = oldUser?.margin_seconds !== margin || schedules.some((day) => {
    const old = oldSchedules.results.find((row) => row.weekday === day.weekday);
    return !old || Boolean(old.enabled) !== day.enabled || old.entry_time !== day.entry || old.exit_time !== day.exit;
  });
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE users SET enabled = ?, margin_seconds = ?, updated_at = ? WHERE id = ?")
      .bind(enabled ? 1 : 0, margin, now, user.id),
  ];
  if (planChanged) statements.push(env.DB.prepare("DELETE FROM jobs WHERE user_id = ? AND (status = 'scheduled' OR (status = 'skipped' AND error_code = 'non_working_day')) AND attempt_count = 0 AND target_at > ?")
    .bind(user.id, now));
  if (planChanged) {
    const timeZone = oldUser?.time_zone ?? env.TIME_ZONE;
    const todayKey = localDate(now, timeZone).split("/").reverse().join("-");
    const calendar = await env.DB.prepare("SELECT * FROM calendar_days WHERE user_id = ? AND substr(local_date,7,4) || '-' || substr(local_date,4,2) || '-' || substr(local_date,1,2) >= ?")
      .bind(user.id, todayKey).all<CalendarDayRow>();
    for (const day of calendar.results) {
      const [d, m, y] = day.local_date.split("/").map(Number);
      const parts = { day: d, month: m, year: y };
      const schedule = schedules[weekdayForLocalDate(parts)];
      const plan = configuredPunchPlan(parts, timeZone, { enabled: schedule.enabled ? 1 : 0, entry_time: schedule.entry, exit_time: schedule.exit }, margin, day);
      statements.push(env.DB.prepare("UPDATE calendar_days SET random_entry_at = ?, random_exit_at = ?, margin_seconds = ?, plan_key = ? WHERE user_id = ? AND local_date = ?")
        .bind(plan?.entryAt ?? null, plan?.exitAt ?? null, margin, plan?.key ?? null, user.id, day.local_date));
    }
  }
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
  if (method === "GET" && url.pathname === "/health") return json({ ok: true, service: "controlhorari-worker", release: "2026-10-14-admin-setup-v2", time: Date.now() });

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const body = await bodyAsObject(request);
    const username = stringField(body, "username").trim().toLowerCase();
    const password = stringField(body, "password");
    if (username.length > 254 || password.length > 256) return error("Usuario o contraseña incorrectos.", 401);
    const now = Date.now();
    const key = await sha256(username);
    const allowance = await env.DB.prepare(`INSERT INTO login_limits (key, attempts, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END,
      expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
      WHERE expires_at <= ? OR attempts < 12`).bind(key, now + 15 * 60_000, now, now, now).run();
    if (!allowance.meta.changes) return json({ ok: false, message: "Demasiados intentos. Vuelve a intentarlo en 15 minutos." }, 429, { "retry-after": "900" });
    const result = await login(env, username, password);
    return result ? json({ ok: true, ...result }) : error("Usuario o contraseña incorrectos.", 401);
  }
  if (method === "POST" && url.pathname === "/api/auth/logout") {
    await logout(request, env);
    return json({ ok: true });
  }

  if (method === "POST" && url.pathname === "/api/admin/users") {
    const caller = await authenticate(request, env);
    const setupSecret = request.headers.get("x-admin-setup-secret");
    const existingUser = await env.DB.prepare("SELECT id FROM users LIMIT 1").first();
    const setupAuthorized = !existingUser && Boolean(env.ADMIN_SETUP_SECRET && setupSecret && await secureEqual(setupSecret, env.ADMIN_SETUP_SECRET));
    if (caller?.role !== "admin" && !setupAuthorized) {
      return json({ ok: false, message: "No autorizado.", code: existingUser ? "setup_closed" : !env.ADMIN_SETUP_SECRET ? "setup_secret_missing" : "setup_secret_mismatch" }, 403);
    }
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
  if (method === "GET" && url.pathname === "/api/me/push/config") return json({ ok: true, ...pushConfig(env) });
  if (method === "POST" && url.pathname === "/api/me/push/status") {
    const body = await bodyAsObject(request);
    const sub = await env.DB.prepare("SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").bind(user.id, stringField(body, "endpoint")).first();
    return json({ ok: true, subscribed: Boolean(sub) });
  }
  if (method === "POST" && url.pathname === "/api/me/push/subscribe") {
    if (!pushConfig(env).configured) return error("Las notificaciones no están configuradas en el servidor.", 503);
    const body = await bodyAsObject(request);
    if (!validSubscription(body)) return error("Suscripción no válida.");
    const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM push_subscriptions WHERE user_id = ? AND endpoint != ?").bind(user.id, body.endpoint).first<{ total: number }>();
    if ((count?.total ?? 0) >= 10) return error("Ya hay diez dispositivos registrados. Desactiva alguno primero.");
    await env.DB.prepare("INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth")
      .bind(crypto.randomUUID(), user.id, body.endpoint, body.keys.p256dh, body.keys.auth, Date.now()).run();
    return json({ ok: true });
  }
  if (method === "POST" && url.pathname === "/api/me/push/unsubscribe") {
    const body = await bodyAsObject(request);
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").bind(user.id, stringField(body, "endpoint")).run();
    return json({ ok: true });
  }
  if (method === "POST" && url.pathname === "/api/me/push/test") {
    const body = await bodyAsObject(request);
    try { await testPush(env, user.id, stringField(body, "endpoint")); return json({ ok: true }); }
    catch (cause) { return error(cause instanceof Error ? cause.message : "No se pudo enviar la prueba.", 502); }
  }
  if (method === "GET" && url.pathname === "/api/me") return json(await dashboard(env, user));
  if (method === "GET" && url.pathname === "/api/me/today") return json(await todayDashboard(env, user));
  if (method === "POST" && url.pathname === "/api/me/today/sync") return syncHistory(env, user, true);
  if (method === "PUT" && url.pathname === "/api/me/config") return updateConfig(request, env, user);
  if (method === "POST" && url.pathname === "/api/me/history/sync") return syncHistory(env, user);
  if (method === "POST" && url.pathname === "/api/me/punch") return manualPunch(request, env, user);
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
  async fetch(request, env, context): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const response = await route(request, env);
      context.waitUntil(flushPush(env).catch((cause) => console.error("No se pudieron procesar los avisos push", cause)));
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(cors)) headers.set(name, value);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (cause) {
      if (cause instanceof Response) return cause;
      if (cause instanceof TimenetError) return error(cause.message, cause.status);
      console.error(cause);
      return error("Error interno del servidor.", 500);
    }
  },
  async scheduled(_controller, env, context): Promise<void> {
    context.waitUntil(runScheduler(env).finally(() => flushPush(env)));
  },
} satisfies ExportedHandler<Env>;
