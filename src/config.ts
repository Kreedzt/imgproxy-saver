import { resolve } from "node:path";
export interface Config {
  dataDir: string;
  port: number;
  host: string;
  imgproxyUrl: string;
  externalKey: string;
  externalSalt: string;
  internalKey: string;
  internalSalt: string;
  allowInsecure: boolean;
  allowedHosts: string[];
  allowPrivateSources: boolean;
  maxSourceBytes: number;
  maxResultBytes: number;
  timeoutMs: number;
  concurrency: number;
  queueLimit: number;
  processingVersion: string;
  cacheControl: string;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bool = (key: string) => {
    const v = env[key] ?? "false";
    if (!["true", "false"].includes(v))
      throw new Error(`${key} must be true or false`);
    return v === "true";
  };
  const int = (
    key: string,
    fallback: number,
    max = Number.MAX_SAFE_INTEGER,
  ) => {
    const v = env[key] ?? String(fallback);
    if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > max)
      throw new Error(`Invalid ${key}`);
    return Number(v);
  };
  const allowInsecure = bool("ALLOW_INSECURE");
  const hex = (key: string, optional = false) => {
    const v = env[key] ?? "";
    if (optional && !v) return "";
    if (!/^(?:[a-f\d]{2}){16,}$/i.test(v))
      throw new Error(`${key} must contain at least 16 hex-encoded bytes`);
    return v;
  };
  const imgproxyUrl = env.IMGPROXY_URL ?? "http://imgproxy:8080";
  const url = new URL(imgproxyUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("IMGPROXY_URL must be an HTTP(S) origin");
  const allowedHosts = (env.SOURCE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (!allowedHosts.length)
    throw new Error("SOURCE_ALLOWED_HOSTS is required (exact hostnames)");
  const cacheControl = env.CACHE_CONTROL ?? "no-cache";
  if (/[\r\n]/.test(cacheControl)) throw new Error("Invalid CACHE_CONTROL");
  return {
    dataDir: resolve(env.DATA_DIR ?? "./data"),
    port: int("PORT", 3000, 65535),
    host: env.HOST ?? "0.0.0.0",
    imgproxyUrl: url.origin,
    externalKey: hex("EXTERNAL_KEY", allowInsecure),
    externalSalt: hex("EXTERNAL_SALT", allowInsecure),
    internalKey: hex("INTERNAL_KEY"),
    internalSalt: hex("INTERNAL_SALT"),
    allowInsecure,
    allowedHosts,
    allowPrivateSources: bool("ALLOW_PRIVATE_SOURCES"),
    maxSourceBytes: int("MAX_SOURCE_BYTES", 20 * 1024 * 1024),
    maxResultBytes: int("MAX_RESULT_BYTES", 40 * 1024 * 1024),
    timeoutMs: int("TIMEOUT_MS", 30000),
    concurrency: int("CONCURRENCY", 4),
    queueLimit: int("QUEUE_LIMIT", 64),
    processingVersion: env.PROCESSING_VERSION ?? "1",
    cacheControl,
  };
}
