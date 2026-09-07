import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { parseTarget, localPath } from "../../src/protocol.js";
import { sign, verify } from "../../src/signing.js";
import { sourceKey, variantKey } from "../../src/keys.js";
import { readConfig } from "../../src/config.js";
const key = "ab".repeat(32),
  salt = "cd".repeat(32);
test("signature matches independent HMAC vector, rejects tampering", () => {
  const path = "/rs:fit:20:30/plain/https%3A%2F%2Fexample.com%2Fa.png@webp";
  const expected = createHmac("sha256", Buffer.from(key, "hex"))
    .update(Buffer.concat([Buffer.from(salt, "hex"), Buffer.from(path)]))
    .digest("base64url");
  assert.equal(sign(path, key, salt), expected);
  verify(expected, path, key, salt);
  assert.throws(() => verify(expected, path + "a", key, salt));
  assert.throws(() => verify("insecure", path, key, salt));
  verify("insecure", path, "", "", true);
});
test("plain preserves encoded source query, percent and at exactly once; outer query ignored", () => {
  const source = "https://example.com/a%20b.png?token=a+b&x=%40";
  const parsed = parseTarget(
    "/sig/rs:fit:20:30/plain/" + encodeURIComponent(source) + "@webp?outer=1",
  );
  assert.equal(parsed.sourceUrl, source);
  assert.equal(parsed.extension, "webp");
  assert.ok(!parsed.signedPath.includes("?"));
  assert.match(localPath(parsed, sourceKey(source)), /^\/rs:fit:20:30\//);
});
test("base64 segmented URL and source queries round trip", () => {
  const url = "https://example.com/a?x=2&x=1";
  const b = Buffer.from(url).toString("base64url");
  assert.equal(
    parseTarget("/sig/q:80/" + b.slice(0, 10) + "/" + b.slice(10) + ".png")
      .sourceUrl,
    url,
  );
});
test("expiry is checked each request and unsupported features fail closed", () => {
  const end = "/plain/https://example.com/a";
  assert.throws(() => parseTarget("/s/exp:100" + end, 100));
  assert.equal(parseTarget("/s/exp:101" + end, 100).expires, 101);
  for (const option of ["wm:1", "preset:test", "msfs:0", "unknown:1"])
    assert.throws(() => parseTarget("/s/" + option + end));
  for (const target of [
    "/s/%%%",
    "/s/plain/file:///etc/passwd",
    "/s/plain/https://u:p@example.com/a",
    "/s/plain/https://example.com/a@b@c",
    "/s/plain/https%ZZ",
  ])
    assert.throws(() => parseTarget(target));
});
test("keys isolate queries, headers and processing configuration", () => {
  assert.notEqual(sourceKey("https://x/a?q=1"), sourceKey("https://x/a?q=2"));
  assert.notEqual(
    variantKey("/a?x=1", "image/webp", "1"),
    variantKey("/a?x=2", "image/webp", "1"),
  );
  assert.notEqual(
    variantKey("/a", "image/webp", "1"),
    variantKey("/a", "image/png", "1"),
  );
  assert.notEqual(variantKey("/a", "", "1"), variantKey("/a", "", "2"));
});
test("configuration fails closed and validates numbers and credentials", () => {
  const env = {
    SOURCE_ALLOWED_HOSTS: "example.com",
    EXTERNAL_KEY: key,
    EXTERNAL_SALT: salt,
    INTERNAL_KEY: key,
    INTERNAL_SALT: salt,
  };
  assert.equal(readConfig(env).port, 3000);
  assert.throws(() => readConfig({}));
  assert.throws(() => readConfig({ ...env, PORT: "1x" }));
  assert.throws(() => readConfig({ ...env, ALLOW_INSECURE: "yes" }));
  assert.throws(() =>
    readConfig({ ...env, IMGPROXY_URL: "http://example.com/path" }),
  );
});
