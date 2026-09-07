import { readConfig } from "./config.js";
import { createApp } from "./app.js";
const config = readConfig();
const app = await createApp(config);
await app.listen({ port: config.port, host: config.host });
console.log(`imgproxy-saver listening on port ${config.port}`);
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
