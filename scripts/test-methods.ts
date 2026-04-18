import { AudioClient } from "../src/bun/rpc/audio-client";
const client = new AudioClient("unix:///tmp/albedo-audio.sock");
await client.connect();
console.log("Methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(client.client)).filter(m => typeof client.client[m] === 'function'));
process.exit(0);
