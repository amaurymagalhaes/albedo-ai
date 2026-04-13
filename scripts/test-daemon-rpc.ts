import { DaemonClient } from "../src/bun/rpc/daemon-client";

const client = new DaemonClient("unix:///tmp/albedo-mock-daemon.sock");

try {
  const tools = await client.listTools();
  console.log("Tools:");
  for (const t of tools) {
    console.log(`  - ${t.name}: ${t.description} (dangerous: ${t.dangerous})`);
  }

  const awareness = await client.getAwareness();
  console.log("\nAwareness:", JSON.stringify(awareness, null, 2));

  const result = await client.executeTool("get_time", '{"timezone":"UTC"}');
  console.log("\nTool result:", result);
} catch (err) {
  console.error("Error:", err);
} finally {
  client.close();
}
