import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, cp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";
import { createApp } from "../../src/app.js";
import { config, key, salt } from "../helpers.js";
import { sign } from "../../src/signing.js";
const image =
  "darthsim/imgproxy:v3.29.1@sha256:7d12c7c8fc66b3cd5fc8d1e21d0aad25bed8438e5bc8460d95351ac905a71ea3";
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function png(width: number, height: number) {
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const v of b) {
      c ^= v;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    payload.copy(out, 4);
    out.writeUInt32BE(crc(payload), out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(height * (width * 3 + 1), 100);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function target(source: string, option = "rs:fit:32:24", plain = false) {
  const path =
    "/" +
    option +
    "/" +
    (plain
      ? "plain/" + encodeURIComponent(source) + "@png"
      : Buffer.from(source).toString("base64url") + ".png");
  return "/" + sign(path, key, salt) + path;
}
async function ready(url: string) {
  for (let n = 0; n < 60; n++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error("Container not ready");
}
function port(name: string, internal: string) {
  return Number(docker("port", name, internal).split(":").at(-1));
}
test(
  "real Docker: source offline, new sizes, stored hits offline, rebuild and restore",
  { timeout: 180000 },
  async () => {
    await mkdir("work", { recursive: true });
    const dir = await mkdtemp(resolve("work", "e2e-"));
    const data = join(dir, "data");
    await mkdir(join(data, "originals"), { recursive: true });
    const id = "saver-e2e-" + process.pid;
    const origin = id + "-origin",
      proxy = id + "-proxy",
      saver = id + "-app",
      network = id + "-net";
    const containers = new Set<string>();
    const originCode =
      "require('http').createServer((q,r)=>{r.setHeader('Content-Type','image/png');r.end(require('fs').readFileSync('/fixture/image.png'))}).listen(8080,'0.0.0.0')";
    await writeFile(join(dir, "image.png"), png(64, 48));
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    const runProxy = () => {
      docker(
        "run",
        "-d",
        "--name",
        proxy,
        "--network",
        network,
        "-p",
        "127.0.0.1::8080",
        "-e",
        "IMGPROXY_KEY=" + key,
        "-e",
        "IMGPROXY_SALT=" + salt,
        "-e",
        "IMGPROXY_LOCAL_FILESYSTEM_ROOT=/sources",
        "-e",
        "IMGPROXY_ALLOWED_SOURCES=local:///",
        "-v",
        data + "/originals:/sources:ro",
        image,
      );
      containers.add(proxy);
    };
    const runSaver = () => {
      docker(
        "run",
        "-d",
        "--name",
        saver,
        "--user",
        `${process.getuid!()}:${process.getgid!()}`,
        "--network",
        network,
        "-p",
        "127.0.0.1::3000",
        "-v",
        data + ":/data",
        "-e",
        "IMGPROXY_URL=http://" + proxy + ":8080",
        "-e",
        "EXTERNAL_KEY=" + key,
        "-e",
        "EXTERNAL_SALT=" + salt,
        "-e",
        "INTERNAL_KEY=" + key,
        "-e",
        "INTERNAL_SALT=" + salt,
        "-e",
        "SOURCE_ALLOWED_HOSTS=" + origin,
        "-e",
        "ALLOW_PRIVATE_SOURCES=true",
        "imgproxy-saver:checkpoint",
      );
      containers.add(saver);
    };
    try {
      docker("network", "create", network);
      docker(
        "run",
        "-d",
        "--name",
        origin,
        "--network",
        network,
        "-p",
        "127.0.0.1::8080",
        "-v",
        dir + ":/fixture:ro",
        "node:24.15.0-bookworm-slim",
        "node",
        "-e",
        originCode,
      );
      containers.add(origin);
      runProxy();
      const proxyUrl = "http://127.0.0.1:" + port(proxy, "8080/tcp");
      await ready(proxyUrl + "/health");
      // Plain and Base64 variants use exactly the same remote source URL.
      const source = "http://" + origin + ":8080/image.png?token=a%2Bb&x=1";
      runSaver();
      let saverUrl = "http://127.0.0.1:" + port(saver, "3000/tcp");
      await ready(saverUrl + "/healthz");
      const first = target(source);
      let r = await fetch(saverUrl + first);
      assert.equal(
        r.status,
        200,
        await (r.status === 200 ? Promise.resolve("") : r.text()),
      );
      let bytes = Buffer.from(await r.arrayBuffer());
      assert.equal(bytes.readUInt32BE(16), 32);
      assert.equal(bytes.readUInt32BE(20), 24);
      r = await fetch(saverUrl + first);
      assert.equal(r.headers.get("x-storage-status"), "HIT");
      // A second spelling of the same source must reuse the original even with origin stopped.
      docker("stop", origin);
      r = await fetch(saverUrl + target(source, "rs:fit:16:12", true));
      assert.equal(
        r.status,
        200,
        await (r.status === 200 ? Promise.resolve("") : r.text()),
      );
      bytes = Buffer.from(await r.arrayBuffer());
      assert.equal(bytes.readUInt32BE(16), 16);
      assert.equal(bytes.readUInt32BE(20), 12);
      docker("stop", proxy);
      r = await fetch(saverUrl + first);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-storage-status"), "HIT");
      docker("rm", "-f", saver, proxy);
      containers.delete(saver);
      containers.delete(proxy);
      runProxy();
      runSaver();
      saverUrl = "http://127.0.0.1:" + port(saver, "3000/tcp");
      await ready(saverUrl + "/healthz");
      r = await fetch(saverUrl + first);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-storage-status"), "HIT");
      r = await fetch(saverUrl + target(source, "rs:fit:8:6"));
      assert.equal(r.status, 200);
      bytes = Buffer.from(await r.arrayBuffer());
      assert.equal(bytes.readUInt32BE(16), 8);
      // Back up and restore the complete tree and serve with no upstream available.
      await cp(data, join(dir, "restored"), { recursive: true });
      app = await createApp(config(join(dir, "restored")));
      assert.equal(
        (await app.inject({ url: first, headers: { accept: "*/*" } }))
          .statusCode,
        200,
      );
      // Direct real-imgproxy local request uses independent URL construction and same HMAC protocol.
      const local =
        "local:///" +
        (await import("../../src/keys.js")).sourceKey(source).slice(0, 2) +
        "/" +
        (await import("../../src/keys.js")).sourceKey(source) +
        "/body";
      const path =
        "/rs:fit:10:10/" + Buffer.from(local).toString("base64url") + ".png";
      const direct = await fetch(
        "http://127.0.0.1:" +
          port(proxy, "8080/tcp") +
          "/" +
          sign(path, key, salt) +
          path,
      );
      assert.equal(direct.status, 200);
    } finally {
      if (app) await app.close();
      for (const c of containers) {
        try {
          docker("rm", "-f", c);
        } catch {}
      }
      try {
        docker("network", "rm", network);
      } catch {}
      await rm(dir, { recursive: true, force: true });
    }
  },
);
