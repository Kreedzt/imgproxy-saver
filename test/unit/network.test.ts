import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicAddress, resolveSource } from "../../src/downloader.js";
const policy = {
  allowedHosts: ["example.com"],
  allowPrivateSources: false,
  timeoutMs: 1000,
};
test("IPv4/IPv6 reserved and mapped private addresses rejected", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "224.0.0.1",
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});
test("all DNS answers validated; one pinned answer selected; host policy enforced", async () => {
  let calls = 0;
  const chosen = await resolveSource(
    new URL("https://example.com/a"),
    policy,
    async () => {
      calls++;
      return [{ address: "8.8.8.8", family: 4 }];
    },
  );
  assert.equal(chosen.address, "8.8.8.8");
  assert.equal(calls, 1);
  await assert.rejects(
    resolveSource(new URL("https://example.com"), policy, async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
  );
  await assert.rejects(resolveSource(new URL("https://other.com"), policy));
  await assert.rejects(
    resolveSource(new URL("https://u:p@example.com"), policy),
  );
});
