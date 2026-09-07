import { createServer, type RequestListener, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=",
  "base64",
);
export const key = "ab".repeat(32),
  salt = "cd".repeat(32);
export async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "saver-test-"));
  return { dir, close: () => rm(dir, { recursive: true, force: true }) };
}
export async function serve(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => stop(server),
  };
}
export async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
}
export function config(
  dataDir: string,
  imgproxyUrl = "http://127.0.0.1:1",
): Config {
  return {
    dataDir,
    imgproxyUrl,
    port: 3000,
    host: "127.0.0.1",
    externalKey: key,
    externalSalt: salt,
    internalKey: key,
    internalSalt: salt,
    allowInsecure: false,
    allowedHosts: ["127.0.0.1"],
    allowPrivateSources: true,
    maxSourceBytes: 1024 * 1024,
    maxResultBytes: 1024 * 1024,
    timeoutMs: 2000,
    concurrency: 2,
    queueLimit: 8,
    processingVersion: "1",
    cacheControl: "no-cache",
  };
}
