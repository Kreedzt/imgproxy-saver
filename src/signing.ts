import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors.js";
export function sign(path: string, key: string, salt: string): string {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(Buffer.from(salt, "hex"))
    .update(path)
    .digest("base64url");
}
export function verify(
  signature: string,
  path: string,
  key: string,
  salt: string,
  allowInsecure = false,
) {
  if (allowInsecure && signature === "insecure") return;
  if (!key || !salt || !/^[A-Za-z0-9_-]{43}$/.test(signature))
    throw new AppError(403, "INVALID_SIGNATURE");
  const expected = sign(path, key, salt);
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
    throw new AppError(403, "INVALID_SIGNATURE");
}
