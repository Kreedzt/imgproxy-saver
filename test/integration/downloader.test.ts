import { test } from "node:test";
import assert from "node:assert/strict";
import { download, expectedLength, request } from "../../src/downloader.js";
import { Storage } from "../../src/storage.js";
import { hash } from "../../src/keys.js";
import { serve, png, temp } from "../helpers.js";
const policy = {
  allowedHosts: ["127.0.0.1"],
  allowPrivateSources: true,
  timeoutMs: 500,
};
test("downloads valid redirect, pins DNS lookup, rejects bad redirect, status, size, encoding and truncation", async () => {
  const t = await temp();
  const origin = await serve((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/image" });
      res.end();
    } else if (req.url === "/bad-redirect") {
      res.writeHead(302, { location: "http://localhost/a" });
      res.end();
    } else if (req.url === "/truncated") {
      res.writeHead(200, { "content-length": png.length + 5 });
      res.end(png);
    } else if (req.url === "/html") {
      res.end("<html>failed</html>");
    } else if (req.url === "/missing") {
      res.writeHead(404);
      res.end();
    } else if (req.url === "/compressed") {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(png);
    } else if (req.url === "/timeout") {
    } else {
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": png.length,
      });
      res.end(png);
    }
  });
  try {
    const s = new Storage(t.dir);
    await s.init();
    const fetch = (path: string, max = 1000) =>
      download(origin.url + path, policy, async (res) => {
        await s.put(
          "originals",
          hash(path),
          res,
          max,
          {},
          expectedLength(res, max),
        );
      });
    await fetch("/redirect");
    assert.ok(await s.get("originals", hash("/redirect")));
    for (const path of [
      "/bad-redirect",
      "/truncated",
      "/html",
      "/missing",
      "/compressed",
      "/timeout",
    ]) {
      await assert.rejects(fetch(path));
      assert.equal(await s.get("originals", hash(path)), undefined);
    }
    await assert.rejects(fetch("/large", 10));
    const url = new URL(origin.url + "/image");
    url.hostname = "example.invalid";
    const res = await request(
      url,
      AbortSignal.timeout(1000),
      {},
      { address: "127.0.0.1", family: 4 },
    );
    let bytes = 0;
    for await (const c of res) bytes += c.length;
    assert.equal(bytes, png.length);
  } finally {
    await origin.close();
    await t.close();
  }
});
test("redirect policy is rechecked; storage-full error retains 507 status", async () => {
  const origin = await serve((_req, res) => {
    res.writeHead(302, { location: "http://10.0.0.1/private" });
    res.end();
  });
  try {
    await assert.rejects(
      download(
        origin.url,
        {
          ...policy,
          allowedHosts: ["127.0.0.1", "10.0.0.1"],
          allowPrivateSources: false,
        },
        async () => {},
      ),
    );
    const image = await serve((_req, res) => res.end(png));
    try {
      await assert.rejects(
        download(image.url, policy, async () => {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        }),
        (e) => (e as { statusCode: number }).statusCode === 507,
      );
    } finally {
      await image.close();
    }
  } finally {
    await origin.close();
  }
});
