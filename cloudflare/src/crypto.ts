const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: string, right: string) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

export async function sha256(value: string) {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export async function secureEqual(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  return constantTimeEqual(leftHash, rightHash);
}

export async function hashPassword(password: string, salt: string, pepper: string) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(`${password}:${pepper}`), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: base64ToBytes(salt), iterations: 120_000 },
    material,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
}

export function randomBase64(size = 32) {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(size)));
}

export async function verifyPassword(password: string, salt: string, expected: string, pepper: string) {
  return constantTimeEqual(await hashPassword(password, salt, pepper), expected);
}

async function importEncryptionKey(encodedKey: string) {
  const bytes = base64ToBytes(encodedKey);
  if (bytes.byteLength !== 32) throw new Error("DATA_ENCRYPTION_KEY debe contener exactamente 32 bytes en base64.");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(value: string, encodedKey: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey(encodedKey);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value));
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}

export async function decryptSecret(ciphertext: string, iv: string, encodedKey: string) {
  const key = await importEncryptionKey(encodedKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext),
  );
  return decoder.decode(plaintext);
}
