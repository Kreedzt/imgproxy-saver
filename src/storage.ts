import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import { AppError } from "./errors.js";
export type Kind = "originals" | "variants";
export interface Meta {
  version: 1;
  length: number;
  sha256: string;
  contentType: string;
  createdAt: string;
  sourceKey?: string;
  contentDisposition?: string;
}
export interface Stored {
  path: string;
  meta: Meta;
}
async function syncDir(path: string) {
  const f = await open(path, "r");
  try {
    await f.sync();
  } finally {
    await f.close();
  }
}
export class Storage {
  constructor(public root: string) {}
  async init() {
    await mkdir(this.root, { recursive: true });
    await mkdir(join(this.root, "originals"), { recursive: true });
    await mkdir(join(this.root, "variants"), { recursive: true });
    // Single-process deployment: do not share DATA_DIR between saver instances.
    await rm(join(this.root, "tmp"), { recursive: true, force: true });
    await mkdir(join(this.root, "tmp"), { recursive: true });
    await syncDir(this.root);
  }
  private directory(kind: Kind, key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid storage key");
    return join(this.root, kind, key.slice(0, 2), key);
  }
  async get(kind: Kind, key: string): Promise<Stored | undefined> {
    const dir = this.directory(kind, key);
    let raw: string;
    try {
      raw = await readFile(join(dir, "meta.json"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          await stat(dir);
        } catch (x) {
          if ((x as NodeJS.ErrnoException).code === "ENOENT") return;
          throw x;
        }
        throw new AppError(500, "STORAGE_CORRUPT");
      }
      throw e;
    }
    try {
      const m = JSON.parse(raw) as Meta;
      const info = await stat(join(dir, "body"));
      if (
        m.version !== 1 ||
        !Number.isSafeInteger(m.length) ||
        m.length < 1 ||
        m.length !== info.size ||
        !info.isFile() ||
        !/^[a-f0-9]{64}$/.test(m.sha256) ||
        !/^image\/[a-z0-9.+-]+$/.test(m.contentType)
      )
        throw new Error("Invalid metadata");
      return { path: join(dir, "body"), meta: m };
    } catch {
      throw new AppError(500, "STORAGE_CORRUPT");
    }
  }
  async put(
    kind: Kind,
    key: string,
    body: AsyncIterable<Uint8Array>,
    maxBytes: number,
    extra: Partial<Pick<Meta, "sourceKey" | "contentDisposition">> = {},
    expectedLength?: number,
  ): Promise<Stored> {
    const destination = this.directory(kind, key);
    const parent = join(this.root, kind, key.slice(0, 2));
    await mkdir(parent, { recursive: true });
    await syncDir(join(this.root, kind));
    const temp = await mkdtemp(join(this.root, "tmp", "object-"));
    let published = false;
    try {
      const handle = await open(join(temp, "body"), "wx", 0o644);
      const digest = createHash("sha256");
      let length = 0;
      const head: Buffer[] = [];
      let headLength = 0;
      try {
        for await (const chunk of body) {
          const bytes = Buffer.from(chunk);
          length += bytes.length;
          if (length > maxBytes) throw new AppError(413, "IMAGE_TOO_LARGE");
          if (headLength < 8192) {
            const part = bytes.subarray(0, 8192 - headLength);
            head.push(part);
            headLength += part.length;
          }
          digest.update(bytes);
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await handle.write(
              bytes,
              offset,
              bytes.length - offset,
            );
            if (bytesWritten === 0) throw new Error("Short write");
            offset += bytesWritten;
          }
        }
        if (
          length === 0 ||
          (expectedLength !== undefined && expectedLength !== length)
        )
          throw new AppError(502, "INCOMPLETE_IMAGE");
        let type: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
        try {
          type = await fileTypeFromBuffer(Buffer.concat(head));
        } catch {
          throw new AppError(415, "INVALID_IMAGE");
        }
        // SVG/XML requires a dedicated sanitizer and is intentionally excluded in v1.
        if (!type?.mime.startsWith("image/"))
          throw new AppError(415, "INVALID_IMAGE");
        await handle.sync();
        const meta: Meta = {
          version: 1,
          length,
          sha256: digest.digest("hex"),
          contentType: type.mime,
          createdAt: new Date().toISOString(),
          ...extra,
        };
        const mf = await open(join(temp, "meta.json"), "wx", 0o644);
        try {
          await mf.writeFile(JSON.stringify(meta));
          await mf.sync();
        } finally {
          await mf.close();
        }
      } finally {
        await handle.close();
      }
      await chmod(temp, 0o755);
      await syncDir(temp);
      await rename(temp, destination);
      published = true;
      await syncDir(parent);
      return (await this.get(kind, key))!;
    } finally {
      if (!published) await rm(temp, { recursive: true, force: true });
    }
  }
  stream(stored: Stored) {
    return createReadStream(stored.path);
  }
}
