import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../../src/app.js";
import { sign, verify } from "../../src/signing.js";
import { png, temp, serve, config, key, salt } from "../helpers.js";
function target(source: string, opts = "rs:fit:20:20") {
  const path =
    "/" + opts + "/" + Buffer.from(source).toString("base64url") + ".png";
  return "/" + sign(path, key, salt) + path;
}
test("legacy bot URLs download escaped sources, cache results, and respect migration mode", async () => {
  const t = await temp();
  const requests: string[] = [];
  let processes = 0;
  const origin = await serve((req, res) => {
    requests.push(req.url!);
    res.end(png);
  });
  const processor = await serve(async (req, res) => {
    try {
      const [signature, ...parts] = req.url!.slice(1).split("/");
      verify(signature!, "/" + parts.join("/"), key, salt);
      assert.deepEqual(parts.slice(0, 2), [
        "size:200:200",
        "resizing_type:fit",
      ]);
      const local = Buffer.from(parts.at(-1)!, "base64url").toString();
      assert.ok(local.startsWith("local:///"));
      const body = await readFile(
        join(t.dir, "originals", local.slice("local:///".length)),
      );
      processes++;
      res.end(body);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  const cfg = { ...config(t.dir, processor.url), allowInsecure: true };
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const botUrl = (source: string) =>
    "/sig/size:200:200/resizing_type:fit/" +
    Buffer.from(source).toString("base64url");
  try {
    app = await createApp(cfg);
    const url = botUrl(
      origin.url + "/path with spaces/image.png?token=a+b&x=%40",
    );
    const first = await app.inject({ url });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.rawPayload, png);
    assert.equal(first.headers["x-storage-status"], "MISS");
    assert.deepEqual(requests, [
      "/path%20with%20spaces/image.png?token=a+b&x=%40",
    ]);
    assert.equal(
      (await app.inject({ url })).headers["x-storage-status"],
      "HIT",
    );
    assert.equal(processes, 1);
    assert.equal(requests.length, 1);
    // Migration mode does not bypass the source allowlist.
    const denied = await app.inject({
      url: botUrl("https://not-allowed.example/image.png"),
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error, "SOURCE_NOT_ALLOWED");
    await app.close();
    app = await createApp({ ...cfg, allowInsecure: false });
    const strict = await app.inject({ url });
    assert.equal(strict.statusCode, 403);
    assert.equal(strict.json().error, "INVALID_SIGNATURE");
    assert.equal(processes, 1);
  } finally {
    await app?.close();
    await origin.close();
    await processor.close();
    await t.close();
  }
});
test("end-to-end service: reuse, new variants, concurrency, headers, auth, restart and restore", async () => {
  const t = await temp(),
    backup = await temp();
  let downloads = 0,
    processes = 0;
  let originUp = true,
    processorUp = true;
  const origin = await serve((_req, res) => {
    downloads++;
    if (!originUp) {
      res.writeHead(503);
      res.end();
      return;
    }
    res.end(png);
  });
  const processor = await serve(async (req, res) => {
    processes++;
    if (!processorUp) {
      res.writeHead(503);
      res.end();
      return;
    }
    try {
      const [signature, ...parts] = req.url!.slice(1).split("/");
      verify(signature!, "/" + parts.join("/"), key, salt);
      const encoded = parts.at(-1)!.split(".")[0]!;
      const local = Buffer.from(encoded, "base64url").toString();
      assert.ok(local.startsWith("local:///"));
      const body = await readFile(
        join(t.dir, "originals", local.slice("local:///".length)),
      );
      res.writeHead(200, {
        "content-type": "image/png",
        "content-disposition": 'inline; filename="image.png"',
      });
      res.end(body);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  let app = await createApp(config(t.dir, processor.url));
  try {
    const url = target(origin.url + "/a?token=1");
    let r = await app.inject({ url });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.rawPayload, png);
    assert.equal(r.headers["x-storage-status"], "MISS");
    assert.equal(downloads, 1);
    assert.equal(processes, 1);
    r = await app.inject({ url });
    assert.equal(r.headers["x-storage-status"], "HIT");
    assert.equal(downloads, 1);
    assert.equal(processes, 1);
    const head = await app.inject({ url, method: "HEAD" });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, "");
    assert.equal(Number(head.headers["content-length"]), png.length);
    const conditional = await app.inject({
      url,
      headers: { "if-none-match": "W/" + r.headers.etag },
    });
    assert.equal(conditional.statusCode, 304);
    assert.equal(conditional.body, "");
    originUp = false;
    const next = target(origin.url + "/a?token=1", "rs:fit:40:40");
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => app.inject({ url: next })),
    );
    assert.ok(concurrent.every((r) => r.statusCode === 200));
    assert.equal(downloads, 1);
    assert.equal(processes, 2);
    await app.inject({ url: next, headers: { accept: "image/webp" } });
    assert.equal(processes, 3);
    assert.equal(downloads, 1);
    processorUp = false;
    assert.equal((await app.inject({ url })).statusCode, 200);
    assert.equal(
      (
        await app.inject({
          url: target(origin.url + "/a?token=1", "rs:fit:60:60"),
        })
      ).statusCode,
      502,
    );
    assert.equal(
      (await app.inject({ url: url.replace(/^\/[^/]+/, "/invalid") }))
        .statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url, headers: { authorization: "Bearer test" } }))
        .statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ url: target(origin.url + "/a?token=1", "exp:1") }))
        .statusCode,
      403,
    );
    await app.close();
    app = await createApp(config(t.dir, processor.url));
    assert.equal(
      (await app.inject({ url })).headers["x-storage-status"],
      "HIT",
    );
    await cp(t.dir, join(backup.dir, "restore"), { recursive: true });
    const restored = await createApp(
      config(join(backup.dir, "restore"), processor.url),
    );
    try {
      assert.equal((await restored.inject({ url })).statusCode, 200);
    } finally {
      await restored.close();
    }
    assert.equal((await app.inject({ url: "/healthz" })).statusCode, 200);
  } finally {
    await app.close();
    await origin.close();
    await processor.close();
    await t.close();
    await backup.close();
  }
});
test("different variants requested concurrently share one source download; processing errors retry", async () => {
  const t = await temp();
  let downloads = 0,
    processes = 0;
  const origin = await serve((_req, res) => {
    downloads++;
    setTimeout(() => res.end(png), 30);
  });
  const processor = await serve((_req, res) => {
    processes++;
    if (processes === 1) {
      res.writeHead(500);
      res.end();
    } else res.end(png);
  });
  const app = await createApp(config(t.dir, processor.url));
  try {
    const urls = [
      target(origin.url + "/a", "w:10"),
      target(origin.url + "/a", "w:20"),
    ];
    const replies = await Promise.all(urls.map((url) => app.inject({ url })));
    assert.deepEqual(replies.map((r) => r.statusCode).sort(), [200, 502]);
    assert.equal(downloads, 1);
    const failed = urls[replies.findIndex((r) => r.statusCode === 502)]!;
    assert.equal((await app.inject({ url: failed })).statusCode, 200);
    assert.equal(downloads, 1);
    assert.equal(processes, 3);
  } finally {
    await app.close();
    await origin.close();
    await processor.close();
    await t.close();
  }
});
test("stored hit rechecks expires and signature key rotation before serving", async (ctx) => {
  const t = await temp();
  const origin = await serve((_req, res) => res.end(png));
  const processor = await serve((_req, res) => res.end(png));
  ctx.mock.timers.enable({ apis: ["Date"], now: 2000000 });
  let app = await createApp(config(t.dir, processor.url));
  try {
    const url = target(origin.url + "/a", "exp:2100/w:10");
    assert.equal((await app.inject({ url })).statusCode, 200);
    ctx.mock.timers.setTime(2101000);
    assert.equal((await app.inject({ url })).statusCode, 403);
    ctx.mock.timers.setTime(2000000);
    await app.close();
    app = await createApp({
      ...config(t.dir, processor.url),
      externalKey: "ef".repeat(32),
    });
    assert.equal((await app.inject({ url })).statusCode, 403);
  } finally {
    ctx.mock.timers.reset();
    await app.close();
    await origin.close();
    await processor.close();
    await t.close();
  }
});
