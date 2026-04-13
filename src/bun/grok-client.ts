export interface GrokClientConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens: number;
  temperature: number;
}

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image_url";
  image_url: { url: string };
}

export type MessageContent = string | (TextContent | ImageContent)[];

export interface Message {
  role: Role;
  content: MessageContent | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type StreamChunk =
  | { type: "content"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "done" };

export class GrokClient {
  constructor(private config: GrokClientConfig) {}

  async *chatStream(
    messages: Message[],
    tools?: ToolDef[],
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: true,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const response = await this.fetchWithRetry(
      "/chat/completions",
      body,
      0,
      signal
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const toolCallAccumulators = new Map<
      number,
      { id: string; name: string; args: string }
    >();

    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          yield { type: "done" };
          return;
        }

        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { type: "content", text: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (tc.id) {
              toolCallAccumulators.set(idx, {
                id: tc.id,
                name: tc.function?.name ?? "",
                args: "",
              });
            }
            if (tc.function?.arguments) {
              const acc = toolCallAccumulators.get(idx);
              if (acc) {
                acc.args += tc.function.arguments;
              }
            }
            const acc = toolCallAccumulators.get(idx);
            if (acc && acc.args.length > 0 && this.isCompleteJson(acc.args)) {
              yield {
                type: "tool_call",
                id: acc.id,
                name: acc.name,
                arguments: acc.args,
              };
              toolCallAccumulators.delete(idx);
            }
          }
        }
      }
    }

    yield { type: "done" };
  }

  isCompleteJson(text: string): boolean {
    if (!text || text.length === 0) return false;
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private async fetchWithRetry(
    path: string,
    body: unknown,
    attempt: number,
    signal?: AbortSignal
  ): Promise<Response> {
    const MAX_ATTEMPTS = 4;
    const BACKOFF_MS = [0, 500, 1500, 4000];

    if (attempt > 0) {
      await Bun.sleep(BACKOFF_MS[attempt] ?? 4000);
    }

    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://albedo-ai.dev",
        "X-Title": "Albedo AI",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (response.status === 429 || response.status >= 500) {
      if (attempt < MAX_ATTEMPTS - 1) {
        console.warn(
          `[llm] HTTP ${response.status}, retrying (attempt ${attempt + 1})...`
        );
        return this.fetchWithRetry(path, body, attempt + 1, signal);
      }
      const text = await response.text();
      throw new Error(`LLM API error ${response.status}: ${text}`);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error ${response.status}: ${text}`);
    }

    return response;
  }
}
