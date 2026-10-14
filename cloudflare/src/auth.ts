import { encryptSecret, hashPassword, randomBase64, sha256, verifyPassword } from "./crypto";
import type { Env, SessionUser, UserRole, UserRow } from "./types";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function tokenFromRequest(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

export async function authenticate(request: Request, env: Env): Promise<SessionUser | null> {
  const token = tokenFromRequest(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).bind(tokenHash, now).first<{ id: string; username: string; display_name: string; role: UserRole }>();
  if (!row) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

export async function login(env: Env, username: string, password: string) {
  const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
    .bind(username.trim()).first<UserRow>();
  if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash, env.AUTH_PEPPER))) return null;
  const token = randomBase64(32);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), user.id, now, now + SESSION_TTL_MS).run();
  return {
    token,
    expiresAt: now + SESSION_TTL_MS,
    user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role },
  };
}

export async function logout(request: Request, env: Env) {
  const token = tokenFromRequest(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}

export interface NewUserInput {
  username: string;
  displayName: string;
  password: string;
  timenetPin: string;
  role?: UserRole;
}

export async function createUser(env: Env, input: NewUserInput) {
  const username = input.username.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new Error("El usuario debe tener entre 3 y 40 caracteres válidos.");
  if (displayName.length < 2 || displayName.length > 80) throw new Error("El nombre visible no es válido.");
  if (input.password.length < 10) throw new Error("La contraseña debe tener al menos 10 caracteres.");
  if (!/^\d{3,20}$/.test(input.timenetPin)) throw new Error("El PIN de Timenet debe contener solo números.");
  const salt = randomBase64(16);
  const encryptedPin = await encryptSecret(input.timenetPin, env.DATA_ENCRYPTION_KEY);
  const now = Date.now();
  const id = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO users
       (id, username, display_name, role, password_hash, password_salt, pin_ciphertext, pin_iv, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      username,
      displayName,
      input.role === "admin" ? "admin" : "user",
      await hashPassword(input.password, salt, env.AUTH_PEPPER),
      salt,
      encryptedPin.ciphertext,
      encryptedPin.iv,
      now,
      now,
    ),
  ];
  for (let weekday = 0; weekday < 7; weekday++) {
    statements.push(
      env.DB.prepare("INSERT INTO schedules (user_id, weekday, enabled, entry_time, exit_time) VALUES (?, ?, ?, '09:00', '17:00')")
        .bind(id, weekday, weekday < 5 ? 1 : 0),
    );
  }
  await env.DB.batch(statements);
  return { id, username, displayName, role: input.role === "admin" ? "admin" : "user" };
}
