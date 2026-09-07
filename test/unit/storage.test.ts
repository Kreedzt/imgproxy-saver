import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Storage } from "../../src/storage.js";
import { hash } from "../../src/keys.js";
import { Singleflight, Gate } from "../../src/singleflight.js";
import { png, temp } from "../helpers.js";
async function* chunks(data: Buffer) {
  yield data.subarray(0, 12);
  yield data.subarray(12);
}
test("atomic object stores bytes and metadata, survives init and supports restore", async () => {
  const t = await temp();
  try {
    const s = new Storage(t.dir);
    await s.init();
    const k = hash("a");
    assert.equal(await s.get("originals", k), undefined);
    const item = await s.put("originals", k, chunks(png), 1000);
    assert.deepEqual(await readFile(item.path), png);
    assert.equal(item.meta.contentType, "image/png");
    assert.equal(item.meta.length, png.length);
    await s.init();
    assert.ok(await s.get("originals", k));
    assert.deepEqual(await readdir(join(t.dir, "tmp")), []);
  } finally {
    await t.close();
  }
});
test("incomplete, overlimit, non-image and broken streams never publish; retry works", async () => {
  const t = await temp();
  try {
    const s = new Storage(t.dir);
    await s.init();
    const k = hash("b");
    await assert.rejects(s.put("originals", k, chunks(png), 10));
    await assert.rejects(
      s.put("originals", k, chunks(png), 1000, {}, png.length + 1),
    );
    await assert.rejects(
      s.put("originals", k, chunks(Buffer.from("<html>oops</html>")), 1000),
    );
    async function* broken() {
      yield png;
      throw new Error("broken");
    }
    await assert.rejects(s.put("originals", k, broken(), 1000));
    assert.equal(await s.get("originals", k), undefined);
    assert.deepEqual(await readdir(join(t.dir, "tmp")), []);
    await s.put("originals", k, chunks(png), 1000);
    assert.ok(await s.get("originals", k));
  } finally {
    await t.close();
  }
});
test("half-written object is invisible and corrupt published object fails explicitly", async () => {
  const t = await temp();
  try {
    const s = new Storage(t.dir);
    await s.init();
    const k = hash("c");
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    async function* slow() {
      yield png;
      started();
      await wait;
    }
    const pending = s.put("variants", k, slow(), 1000);
    await ready;
    assert.equal(await s.get("variants", k), undefined);
    release();
    const saved = await pending;
    await writeFile(saved.path, "bad");
    await assert.rejects(s.get("variants", k), /STORAGE_CORRUPT/);
    await assert.rejects(s.get("originals", "../x"));
  } finally {
    await t.close();
  }
});
test("singleflight deduplicates successes and releases failures for retry", async () => {
  const sf = new Singleflight();
  let n = 0;
  const f = () =>
    sf.run("a", async () => {
      n++;
      return 4;
    });
  assert.deepEqual(await Promise.all([f(), f(), f()]), [4, 4, 4]);
  assert.equal(n, 1);
  await assert.rejects(
    sf.run("b", async () => {
      throw Error("fail");
    }),
  );
  assert.equal(await sf.run("b", async () => 7), 7);
});
test("gate limits concurrency, bounds waiting and recovers after errors", async () => {
  const gate = new Gate(1, 1);
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const a = gate.run(() => wait);
  const b = gate.run(async () => 2);
  await assert.rejects(
    gate.run(async () => 3),
    /QUEUE_FULL/,
  );
  release();
  await a;
  assert.equal(await b, 2);
  await assert.rejects(
    gate.run(async () => {
      throw Error("x");
    }),
  );
  assert.equal(await gate.run(async () => 4), 4);
});
test("SIGKILL during write leaves no published image; restart cleans only temporary files", async () => {
  const { spawn } = await import("node:child_process");
  const t = await temp();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const s = new Storage(t.dir);
    await s.init();
    await s.put("originals", hash("complete"), chunks(png), 1000);
    child = spawn(
      process.execPath,
      ["--import", "tsx", "test/fixtures/interrupted-write.ts", t.dir],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = new Promise<void>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Writer did not start")),
        5000,
      );
      child!.stdout!.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
      child!.once("exit", () => {
        clearTimeout(timer);
        reject(Error("Writer exited before checkpoint"));
      });
    });
    child.kill("SIGKILL");
    await exited;
    assert.equal(await s.get("originals", hash("interrupted")), undefined);
    assert.ok((await readdir(join(t.dir, "tmp"))).length > 0);
    await s.init();
    assert.deepEqual(await readdir(join(t.dir, "tmp")), []);
    assert.ok(await s.get("originals", hash("complete")));
  } finally {
    child?.kill("SIGKILL");
    await t.close();
  }
});
