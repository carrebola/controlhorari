import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vars = Object.fromEntries(
  readFileSync(path.join(root, "cloudflare", ".dev.vars"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);

const encoder = new TextEncoder();
const bytesToBase64 = (bytes) => Buffer.from(bytes).toString("base64");
const base64ToBytes = (value) => new Uint8Array(Buffer.from(value, "base64"));

async function hashPassword(password, salt, pepper) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(`${password}:${pepper}`), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: base64ToBytes(salt), iterations: 100_000 },
    material,
    256,
  );
  return `pbkdf2-sha256:100000:${bytesToBase64(new Uint8Array(bits))}`;
}

const username = process.argv[2] || "carrebola@fpllefia.com";
const password = process.argv[3] || "localdev123";
const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
const hash = await hashPassword(password, salt, vars.AUTH_PEPPER);
const sql = `UPDATE users SET password_hash = '${hash.replaceAll("'", "''")}', password_salt = '${salt.replaceAll("'", "''")}', updated_at = ${Date.now()} WHERE username = '${username.replaceAll("'", "''")}';
DELETE FROM sessions;
`;
const sqlFile = path.join(os.tmpdir(), `controlhorari-reset-password-${Date.now()}.sql`);
writeFileSync(sqlFile, sql, "utf8");
try {
  const result = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "controlhorari", "--local", "--config", "cloudflare/wrangler.jsonc", "--file", sqlFile],
    { encoding: "utf8", shell: true, cwd: root },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
  console.log(`Contraseña local restablecida para ${username}`);
} finally {
  try { unlinkSync(sqlFile); } catch { /* ignore */ }
}
