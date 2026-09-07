import { sign } from "../src/signing.js";
const [source, options = "rs:fit:300:200", format = "webp"] =
  process.argv.slice(2);
if (!source || !process.env.EXTERNAL_KEY || !process.env.EXTERNAL_SALT)
  throw new Error(
    "Set EXTERNAL_KEY/EXTERNAL_SALT and pass source URL [options] [format]",
  );
const path =
  "/" +
  options +
  "/" +
  Buffer.from(source).toString("base64url") +
  "." +
  format;
console.log(
  "/" + sign(path, process.env.EXTERNAL_KEY, process.env.EXTERNAL_SALT) + path,
);
