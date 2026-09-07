import { AppError } from "./errors.js";
const optionsAllowed = new Set(
  "resize rs size s resizing_type rt width w height h min-width mw min-height mh zoom z dpr enlarge el extend ex extend_aspect_ratio extend_ar exar gravity g crop c trim t padding pd auto_rotate ar rotate rot background bg blur bl sharpen sh pixelate pix strip_metadata sm keep_copyright kcr strip_color_profile scp enforce_thumbnail eth quality q format_quality fq max_bytes mb format f ext skip_processing skp raw cachebuster cb expires exp filename fn return_attachment att".split(
    " ",
  ),
);
export interface Parsed {
  signature: string;
  signedPath: string;
  options: string[];
  sourceUrl: string;
  extension: string;
  expires?: number;
}
export function parseTarget(
  target: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Parsed {
  const bad = () => new AppError(400, "INVALID_IMGPROXY_URL");
  // imgproxy 3.29 ignores the outer query string before verification and parsing.
  const path = target.split("?")[0]!;
  if (path.includes("#") || /[\x00-\x20\x7f]/.test(path)) throw bad();
  const match = /^\/([^/]+)(\/.*)$/.exec(path);
  if (!match) throw bad();
  const signature = match[1]!,
    signedPath = match[2]!;
  const parts = signedPath.slice(1).split("/");
  const options: string[] = [];
  let expires: number | undefined;
  while (parts[0]?.includes(":")) {
    const opt = parts.shift()!;
    const [name, ...args] = opt.split(":");
    if (!optionsAllowed.has(name!))
      throw new AppError(400, "UNSUPPORTED_OPTION");
    if (name === "expires" || name === "exp") {
      if (
        args.length !== 1 ||
        !/^\d+$/.test(args[0]!) ||
        !Number.isSafeInteger(Number(args[0]))
      )
        throw bad();
      expires = Number(args[0]);
      if (expires <= nowSeconds) throw new AppError(403, "URL_EXPIRED");
    }
    options.push(opt);
  }
  let sourceUrl: string;
  let extension = "";
  try {
    if (parts[0] === "plain") {
      const split = parts.slice(1).join("/").split("@");
      if (split.length > 2) throw bad();
      sourceUrl = decodeURIComponent(split[0]!);
      extension = split[1] ?? "";
    } else {
      const split = parts.join("").split(".");
      if (split.length > 2) throw bad();
      const encoded = split[0]!.replace(/=+$/, "");
      if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw bad();
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded) throw bad();
      sourceUrl = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      extension = split[1] ?? "";
    }
    // Legacy clients Base64-encode raw spaces. Encode only those spaces so
    // existing percent escapes, query ordering and storage keys stay intact.
    // Keep signedPath unchanged: signatures cover the original request bytes.
    sourceUrl = sourceUrl.replace(/ /g, "%20");
    const u = new URL(sourceUrl);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.hash ||
      /[\x00-\x20\x7f\\]/.test(sourceUrl)
    )
      throw bad();
    if (extension && !/^[a-z0-9]+$/.test(extension)) throw bad();
  } catch {
    throw bad();
  }
  return { signature, signedPath, options, sourceUrl, extension, expires };
}
export function localPath(parsed: Parsed, key: string) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid storage key");
  const source = Buffer.from(
    `local:///${key.slice(0, 2)}/${key}/body`,
  ).toString("base64url");
  return `/${[...parsed.options, source + (parsed.extension ? "." + parsed.extension : "")].join("/")}`;
}
