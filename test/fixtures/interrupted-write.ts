import { Storage } from "../../src/storage.js";
import { hash } from "../../src/keys.js";
import { png } from "../helpers.js";
const storage = new Storage(process.argv[2]!);
await storage.init();
setInterval(() => {}, 1000);
async function* interrupted() {
  yield png;
  process.stdout.write("WRITING\n");
  await new Promise(() => {});
}
await storage.put("originals", hash("interrupted"), interrupted(), 1024);
