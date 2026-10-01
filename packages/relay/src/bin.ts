#!/usr/bin/env node
import { startRelay } from "./relay.js";

const port = Number(process.env.BLETHER_RELAY_PORT ?? 7357);
const host = process.env.BLETHER_RELAY_HOST ?? "127.0.0.1";

const relay = await startRelay({ port, host });
console.error(
  `blether relay listening on ${relay.url}\n` +
    "WARNING: insecure dev mode, with no authentication or encryption. Do not expose this relay.",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void relay.close().then(() => process.exit(0)));
}
