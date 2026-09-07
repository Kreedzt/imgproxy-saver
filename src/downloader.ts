import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { AppError } from "./errors.js";
export interface Policy {
  allowedHosts: string[];
  allowPrivateSources: boolean;
  timeoutMs: number;
}
export type Resolver = (
  host: string,
) => Promise<Array<{ address: string; family: number }>>;
export const isPublicAddress = (address: string) => {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
};
export async function resolveSource(
  url: URL,
  policy: Policy,
  resolver: Resolver = (host) => lookup(host, { all: true }),
) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !policy.allowedHosts.includes(hostname)
  )
    throw new AppError(403, "SOURCE_NOT_ALLOWED");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolver(hostname);
  if (
    !addresses.length ||
    addresses.some(
      (a) =>
        !isIP(a.address) ||
        (!policy.allowPrivateSources && !isPublicAddress(a.address)),
    )
  )
    throw new AppError(403, "SOURCE_ADDRESS_NOT_ALLOWED");
  return addresses[0]!;
}
export function request(
  url: URL,
  signal: AbortSignal,
  headers: Record<string, string>,
  address?: { address: string; family: number },
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.get(
      url,
      {
        signal,
        agent: false,
        headers,
        ...(address
          ? {
              lookup: ((_host, options, cb) => {
                if (options.all) cb(null, [address]);
                else cb(null, address.address, address.family);
              }) satisfies LookupFunction,
            }
          : {}),
      },
      (res) => {
        res.on("error", () => {});
        resolve(res);
      },
    );
    req.on("error", reject);
  });
}
export async function download(
  url: string,
  policy: Policy,
  consume: (res: IncomingMessage) => Promise<void>,
  resolver?: Resolver,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
  try {
    let current = new URL(url);
    for (let hop = 0; hop <= 4; hop++) {
      const address = await Promise.race([
        resolveSource(current, policy, resolver),
        new Promise<never>((_, reject) => {
          if (controller.signal.aborted)
            reject(new AppError(504, "DOWNLOAD_TIMEOUT"));
          else
            controller.signal.addEventListener(
              "abort",
              () => reject(new AppError(504, "DOWNLOAD_TIMEOUT")),
              { once: true },
            );
        }),
      ]);
      const res = await request(
        current,
        controller.signal,
        { "accept-encoding": "identity" },
        address,
      );
      try {
        if ([301, 302, 303, 307, 308].includes(res.statusCode!)) {
          if (!res.headers.location || hop === 4)
            throw new AppError(502, "INVALID_REDIRECT");
          current = new URL(res.headers.location, current);
          continue;
        }
        if (res.statusCode !== 200)
          throw new AppError(502, "SOURCE_HTTP_ERROR");
        if (
          res.headers["content-encoding"] &&
          res.headers["content-encoding"] !== "identity"
        )
          throw new AppError(502, "UNSUPPORTED_ENCODING");
        await consume(res);
        return;
      } finally {
        res.destroy();
      }
    }
  } catch (e) {
    if (controller.signal.aborted) throw new AppError(504, "DOWNLOAD_TIMEOUT");
    if (e instanceof AppError) throw e;
    if ((e as NodeJS.ErrnoException).code === "ENOSPC")
      throw new AppError(507, "STORAGE_FULL");
    throw new AppError(502, "SOURCE_DOWNLOAD_FAILED");
  } finally {
    clearTimeout(timer);
  }
}
export function expectedLength(res: IncomingMessage, max: number) {
  const value = res.headers["content-length"];
  if (value === undefined) return;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new AppError(502, "INCOMPLETE_IMAGE");
  if (n > max) throw new AppError(413, "IMAGE_TOO_LARGE");
  return n;
}
