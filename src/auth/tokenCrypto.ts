import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

function keyFromHex(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, "hex");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars) — generate with `openssl rand -hex 32`");
  }
  return key;
}

/** Encrypts a refresh token for storage. Output format: iv:authTag:ciphertext, all hex, colon-joined. */
export function encryptToken(plaintext: string, hexKey: string): string {
  const key = keyFromHex(hexKey);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), ciphertext.toString("hex")].join(":");
}

export function decryptToken(stored: string, hexKey: string): string {
  const key = keyFromHex(hexKey);
  const [ivHex, tagHex, dataHex] = stored.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Malformed encrypted token in database");
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
  return plaintext.toString("utf-8");
}
