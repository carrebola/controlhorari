import { decryptSecret } from "./crypto";
import { addRandomMargin, localDate, localParts, weekdayForLocalDate, zonedDateTimeToEpoch } from "./time";
import { punchTimenet } from "./timenet";
import type { Env, JobRow, ScheduleRow, UserRow } from "./types";

const MISSED_AFTER_MS = 10 * 60 * 1000;
const MAX_JOBS_PER_RUN = 3;

interface DueJob extends JobRow {
  username: string;
  display_name: string;
  pin_ciphertext: string;
  pin_iv: string;
  time_zone: string;
}

async function createNotification(
  env: Env,
  userId: string,
  level: "success" | "warning" | "error" | "info",
  title: string,
  message: string,
  jobId?: string,
) {
  await env.DB.prepare(
    "INSERT INTO notifications (id, user_id, level, title, message, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), userId, level, title, message, jobId ?? null, Date.now()).run();
}

async function ensureTodayJobs(env: Env, now: number) {
  const users = await env.DB.prepare("SELECT * FROM users WHERE enabled = 1").all<UserRow>();
  let created = 0;
  for (const user of users.results) {
    const parts = localParts(now, user.time_zone);
    const weekday = weekdayForLocalDate(parts);
    const schedule = await env.DB.prepare("SELECT * FROM schedules WHERE user_id = ? AND weekday = ? AND enabled = 1")
      .bind(user.id, weekday).first<ScheduleRow>();
    if (!schedule) continue;
    const date = localDate(now, user.time_zone);
    for (const [action, configuredTime] of [["entry", schedule.entry_time], ["exit", schedule.exit_time]] as const) {
      const targetAt = addRandomMargin(zonedDateTimeToEpoch(parts, `${configuredTime}:00`, user.time_zone), user.margin_seconds);
      const result = await env.DB.prepare(
        `INSERT OR IGNORE INTO jobs
         (id, user_id, local_date, action, target_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
      ).bind(crypto.randomUUID(), user.id, date, action, targetAt, now, now).run();
      created += result.meta.changes;
    }
  }
  return { usersScanned: users.results.length, jobsCreated: created };
}

async function markMissedJobs(env: Env, now: number) {
  const missed = await env.DB.prepare(
    "SELECT * FROM jobs WHERE status = 'scheduled' AND target_at < ? LIMIT 20",
  ).bind(now - MISSED_AFTER_MS).all<JobRow>();
  for (const job of missed.results) {
    const update = await env.DB.prepare(
      "UPDATE jobs SET status = 'missed', error_code = 'scheduler_delay', error_message = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'",
    ).bind("El programador no pudo ejecutar el fichaje dentro de la ventana segura.", now, job.id).run();
    if (update.meta.changes) {
      await createNotification(
        env,
        job.user_id,
        "error",
        "Fichaje no ejecutado",
        `El fichaje de ${job.action === "entry" ? "entrada" : "salida"} quedó fuera de la ventana segura.`,
        job.id,
      );
    }
  }
}

async function claimDueJobs(env: Env, now: number) {
  const due = await env.DB.prepare(
    `SELECT j.*, u.username, u.display_name, u.pin_ciphertext, u.pin_iv, u.time_zone
     FROM jobs j JOIN users u ON u.id = j.user_id
     WHERE j.status = 'scheduled' AND j.target_at <= ? AND j.target_at >= ? AND u.enabled = 1
     ORDER BY j.target_at ASC LIMIT ?`,
  ).bind(now, now - MISSED_AFTER_MS, MAX_JOBS_PER_RUN).all<DueJob>();
  const claimed: DueJob[] = [];
  for (const job of due.results) {
    const result = await env.DB.prepare(
      `UPDATE jobs SET status = 'claimed', claimed_at = ?, attempt_count = attempt_count + 1, updated_at = ?
       WHERE id = ? AND status = 'scheduled'`,
    ).bind(now, now, job.id).run();
    if (result.meta.changes) claimed.push({ ...job, status: "claimed", claimed_at: now, attempt_count: job.attempt_count + 1 });
  }
  return claimed;
}

async function processJob(env: Env, job: DueJob) {
  const now = Date.now();
  await env.DB.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'claimed'")
    .bind(now, job.id).run();
  let pin: string;
  try {
    pin = await decryptSecret(job.pin_ciphertext, job.pin_iv, env.DATA_ENCRYPTION_KEY);
  } catch {
    await env.DB.prepare(
      "UPDATE jobs SET status = 'failed', error_code = 'decrypt_failed', error_message = ?, executed_at = ?, updated_at = ? WHERE id = ?",
    ).bind("No se pudo descifrar el PIN.", now, now, job.id).run();
    await createNotification(env, job.user_id, "error", "Fichaje fallido", "No se pudo acceder de forma segura al PIN guardado.", job.id);
    return { success: false };
  }

  const result = await punchTimenet(env, pin, job.action, job.local_date);
  const executedAt = Date.now();
  if (result.ok) {
    const status = result.skipped ? "skipped" : "success";
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        "UPDATE jobs SET status = ?, executed_at = ?, timenet_time = ?, error_code = ?, error_message = NULL, updated_at = ? WHERE id = ?",
      ).bind(status, executedAt, result.time ?? null, result.code ?? null, executedAt, job.id),
      env.DB.prepare(
        "INSERT INTO notifications (id, user_id, level, title, message, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        crypto.randomUUID(),
        job.user_id,
        result.skipped ? "info" : "success",
        result.skipped ? "Fichaje omitido con seguridad" : "Fichaje correcto",
        result.message,
        job.id,
        executedAt,
      ),
    ];
    if (!result.skipped && result.time) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO punch_events (id, user_id, job_id, local_date, action, source, recorded_time, created_at) VALUES (?, ?, ?, ?, ?, 'automatic', ?, ?)",
        ).bind(crypto.randomUUID(), job.user_id, job.id, job.local_date, job.action, result.time, executedAt),
      );
    }
    await env.DB.batch(statements);
    return { success: true };
  }

  const canRetry = !result.uncertain && result.code !== "invalid_pin" && job.attempt_count < 2;
  const status = result.uncertain ? "uncertain" : canRetry ? "scheduled" : "failed";
  const nextTarget = canRetry ? executedAt + 60_000 : job.target_at;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE jobs SET status = ?, target_at = ?, executed_at = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`,
    ).bind(status, nextTarget, executedAt, result.code ?? "unknown", result.message.slice(0, 500), executedAt, job.id),
    env.DB.prepare(
      "INSERT INTO notifications (id, user_id, level, title, message, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      crypto.randomUUID(),
      job.user_id,
      canRetry ? "warning" : "error",
      result.uncertain ? "Fichaje con resultado incierto" : canRetry ? "Reintentando fichaje" : "Fichaje fallido",
      canRetry ? `${result.message} Se reintentará una vez dentro de un minuto.` : result.message,
      job.id,
      executedAt,
    ),
  ];
  if (result.code === "invalid_pin") {
    statements.push(env.DB.prepare("UPDATE users SET enabled = 0, updated_at = ? WHERE id = ?").bind(executedAt, job.user_id));
  }
  await env.DB.batch(statements);
  return { success: false };
}

export async function runScheduler(env: Env) {
  const startedAt = Date.now();
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO scheduler_runs (id, started_at, status) VALUES (?, ?, 'running')",
  ).bind(runId, startedAt).run();
  try {
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(startedAt).run();
    const ensured = await ensureTodayJobs(env, startedAt);
    await markMissedJobs(env, startedAt);
    const jobs = await claimDueJobs(env, Date.now());
    const outcomes = await Promise.all(jobs.map((job) => processJob(env, job)));
    const successCount = outcomes.filter((outcome) => outcome.success).length;
    const failureCount = outcomes.length - successCount;
    const finishedAt = Date.now();
    await env.DB.prepare(
      `UPDATE scheduler_runs SET finished_at = ?, status = ?, users_scanned = ?, jobs_created = ?, jobs_processed = ?,
       success_count = ?, failure_count = ?, duration_ms = ? WHERE id = ?`,
    ).bind(
      finishedAt,
      failureCount ? "partial" : "success",
      ensured.usersScanned,
      ensured.jobsCreated,
      jobs.length,
      successCount,
      failureCount,
      finishedAt - startedAt,
      runId,
    ).run();
    return { runId, ...ensured, jobsProcessed: jobs.length, successCount, failureCount, durationMs: finishedAt - startedAt };
  } catch (error) {
    const finishedAt = Date.now();
    const message = error instanceof Error ? error.message : "Error desconocido en el programador.";
    await env.DB.prepare(
      "UPDATE scheduler_runs SET finished_at = ?, status = 'failed', duration_ms = ?, error_message = ? WHERE id = ?",
    ).bind(finishedAt, finishedAt - startedAt, message.slice(0, 500), runId).run();
    throw error;
  }
}
