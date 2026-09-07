import type { Config } from "./config.js";
import { Storage } from "./storage.js";
import { parseTarget } from "./protocol.js";
import { verify } from "./signing.js";
import { sourceKey, variantKey } from "./keys.js";
import { Singleflight, Gate } from "./singleflight.js";
import { download, expectedLength } from "./downloader.js";
import { processImage } from "./imgproxy-client.js";
export class ImageService {
  readonly storage: Storage;
  private sources = new Singleflight();
  private results = new Singleflight();
  private downloads: Gate;
  private processors: Gate;
  constructor(private config: Config) {
    this.storage = new Storage(config.dataDir);
    this.downloads = new Gate(config.concurrency, config.queueLimit);
    this.processors = new Gate(config.concurrency, config.queueLimit);
  }
  async get(target: string, accept: string) {
    const parsed = parseTarget(target);
    verify(
      parsed.signature,
      parsed.signedPath,
      this.config.externalKey,
      this.config.externalSalt,
      this.config.allowInsecure,
    );
    const source = sourceKey(parsed.sourceUrl),
      result = variantKey(target, accept, this.config.processingVersion);
    const existing = await this.storage.get("variants", result);
    if (existing)
      return { stored: existing, status: "HIT", expires: parsed.expires };
    const stored = await this.results.run(result, async () => {
      const again = await this.storage.get("variants", result);
      if (again) return again;
      await this.sources.run(source, async () => {
        if (await this.storage.get("originals", source)) return;
        await this.downloads.run(() =>
          download(parsed.sourceUrl, this.config, async (res) => {
            await this.storage.put(
              "originals",
              source,
              res,
              this.config.maxSourceBytes,
              {},
              expectedLength(res, this.config.maxSourceBytes),
            );
          }),
        );
      });
      return this.processors.run(() =>
        processImage(this.config, this.storage, parsed, source, result, accept),
      );
    });
    return { stored, status: "MISS", expires: parsed.expires };
  }
}
