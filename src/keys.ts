import { createHash } from "node:crypto";
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const sourceKey = (url: string) => hash(url);
export const variantKey = (target: string, accept: string, version: string) =>
  hash(JSON.stringify([1, version, target, accept]));
