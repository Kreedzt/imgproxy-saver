import Fastify from "fastify";
import type { Config } from "./config.js";
import { ImageService } from "./image-service.js";
import { AppError } from "./errors.js";
export async function createApp(config: Config) {
  const app = Fastify({
    logger: false,
    exposeHeadRoutes: false,
    routerOptions: { maxParamLength: 16384 },
    bodyLimit: 1024,
  });
  const service = new ImageService(config);
  await service.storage.init();
  app.get("/healthz", async () => ({ status: "ok" }));
  app.route({
    method: ["GET", "HEAD"],
    url: "/*",
    handler: async (req, reply) => {
      const target = req.raw.url!;
      if (target.length > 16384) throw new AppError(414, "URL_TOO_LONG");
      if (req.headers.authorization || req.headers.cookie)
        throw new AppError(400, "PRIVATE_REQUEST_UNSUPPORTED");
      const result = await service.get(target, req.headers.accept ?? "");
      const m = result.stored.meta;
      if (
        result.expires !== undefined &&
        result.expires <= Math.floor(Date.now() / 1000)
      )
        throw new AppError(403, "URL_EXPIRED");
      const etag = '"' + m.sha256 + '"';
      reply
        .header("ETag", etag)
        .header("Vary", "Accept")
        .header("X-Storage-Status", result.status)
        .header(
          "Cache-Control",
          result.expires !== undefined ? "no-cache" : config.cacheControl,
        )
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox");
      const condition = req.headers["if-none-match"];
      if (
        condition &&
        condition
          .split(",")
          .some(
            (x) => x.trim() === "*" || x.trim().replace(/^W\//, "") === etag,
          )
      )
        return reply.code(304).send();
      reply
        .header("Content-Type", m.contentType)
        .header("Content-Length", m.length);
      if (m.contentDisposition)
        reply.header("Content-Disposition", m.contentDisposition);
      if (req.method === "HEAD") return reply.send();
      return reply.send(service.storage.stream(result.stored));
    },
  });
  app.setErrorHandler((error, _req, reply) => {
    const err = error as Error & { code?: string; statusCode?: number };
    const code =
      err instanceof AppError
        ? err.code
        : err.code === "ENOSPC"
          ? "STORAGE_FULL"
          : "INTERNAL_ERROR";
    const status =
      err instanceof AppError
        ? err.statusCode
        : err.code === "ENOSPC"
          ? 507
          : err.statusCode && err.statusCode >= 400 && err.statusCode < 500
            ? err.statusCode
            : 500;
    // Do not serialize upstream URLs, secrets, raw requests or exception messages.
    reply
      .code(status)
      .header("Cache-Control", "no-store")
      .send({ error: code });
  });
  return app;
}
