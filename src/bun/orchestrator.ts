import type { AlbedoRPCSchema } from "../rpc-schema";

export class Orchestrator {
  private rpc: any;
  private started = false;

  constructor(rpc: any) {
    this.rpc = rpc;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    console.log("[orchestrator] started");
  }

  async processUtterance(text: string): Promise<void> {
    console.log("[orchestrator] processing utterance:", text);
    this.rpc.send("subtitle", {
      text: `Processing: "${text}"...`,
    });
    this.rpc.send("speaking-state", { speaking: true });
    const expression = this.inferExpression(text);
    this.rpc.send("set-expression", { expression });
    this.rpc.send("speaking-state", { speaking: false });
    this.rpc.send("subtitle", { text: "" });
  }

  inferExpression(
    text: string
  ): "neutral" | "happy" | "sad" | "alert" {
    const lower = text.toLowerCase();
    if (
      lower.includes("happy") ||
      lower.includes("great") ||
      lower.includes("awesome") ||
      lower.includes("thank")
    ) {
      return "happy";
    }
    if (
      lower.includes("sad") ||
      lower.includes("sorry") ||
      lower.includes("unfortunately")
    ) {
      return "sad";
    }
    if (
      lower.includes("alert") ||
      lower.includes("warning") ||
      lower.includes("critical") ||
      lower.includes("error")
    ) {
      return "alert";
    }
    return "neutral";
  }
}
