import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import { request, expectedLength } from "./downloader.js";
import { sign } from "./signing.js";
import { localPath, type Parsed } from "./protocol.js";
import { Storage, type Stored } from "./storage.js";
export async function processImage(
  config: Config,
  storage: Storage,
  parsed: Parsed,
  source: string,
  result: string,
  accept: string,
): Promise<Stored> {
  const path = localPath(parsed, source);
  const url = new URL(
    config.imgproxyUrl +
      "/" +
      sign(path, config.internalKey, config.internalSalt) +
      path,
  );
  const signal = AbortSignal.timeout(config.timeoutMs);
  try {
    const res = await request(url, signal, {
      accept: accept,
      "accept-encoding": "identity",
    });
    try {
      if (res.statusCode !== 200)
        throw new AppError(
          res.statusCode && res.statusCode >= 400 && res.statusCode < 500
            ? 422
            : 502,
          "IMGPROXY_FAILED",
        );
      if (
        res.headers["content-encoding"] &&
        res.headers["content-encoding"] !== "identity"
      )
        throw new AppError(502, "UNSUPPORTED_ENCODING");
      const disposition = res.headers["content-disposition"];
      return await storage.put(
        "variants",
        result,
        res,
        config.maxResultBytes,
        {
          sourceKey: source,
          ...(disposition ? { contentDisposition: disposition } : {}),
        },
        expectedLength(res, config.maxResultBytes),
      );
    } finally {
      res.destroy();
    }
  } catch (e) {
    if (signal.aborted) throw new AppError(504, "PROCESSING_TIMEOUT");
    if (e instanceof AppError) throw e;
    if ((e as NodeJS.ErrnoException).code === "ENOSPC")
      throw new AppError(507, "STORAGE_FULL");
    throw new AppError(502, "PROCESSING_FAILED");
  }
}
