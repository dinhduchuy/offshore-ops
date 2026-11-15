import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createCopilotProvider,
  createAnthropicProvider,
  createOpenAICompatProvider,
  checkAnthropicModel,
  ProviderError,
  ANTHROPIC_API_VERSION,
  type ChatRequest,
} from "./providers";

const TOOLS = [
  { name: "add_room", description: "Add a room", input_schema: { type: "object", properties: {} } },
];

const REQ: ChatRequest = {
  system: "You are a copilot.",
  messages: [{ role: "user", text: "add a lab" }],
  tools: TOOLS,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("anthropic provider", () => {
  it("sends the Messages API shape and parses text + tool_use", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        content: [
          { type: "text", text: "Adding a lab." },
          { type: "tool_use", id: "tc_1", name: "add_room", input: { preset: "lab" } },
        ],
      }),
    );
    const p = createAnthropicProvider({ provider: "anthropic", apiKey: "sk-test" });
    const res = await p.chat(REQ);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers["x-api-key"]).toBe("sk-test");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.system).toBe("You are a copilot.");
    expect(body.tools).toHaveLength(1);
    expect(body.messages[0]).toEqual({ role: "user", content: "add a lab" });

    expect(res.text).toBe("Adding a lab.");
    expect(res.toolCalls).toEqual([{ id: "tc_1", name: "add_room", input: { preset: "lab" } }]);
  });

  it("round-trips tool results as tool_result blocks", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "Done" }] }));
    const p = createAnthropicProvider({ provider: "anthropic", apiKey: "k" });
    await p.chat({
      ...REQ,
      messages: [
        { role: "user", text: "add a lab" },
        { role: "assistant", text: "", toolCalls: [{ id: "tc_1", name: "add_room", input: {} }] },
        { role: "user", toolResults: [{ id: "tc_1", content: "Added Lab" }] },
      ],
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tc_1" });
  });

  it("throws with status on API errors", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "bad key" }, 401));
    const p = createAnthropicProvider({ provider: "anthropic", apiKey: "bad" });
    await expect(p.chat(REQ)).rejects.toThrow(/Anthropic 401/);
  });
});

describe("anthropic provider — current API surface", () => {
  it("sends anthropic-version 2026-10-21, defaults to claude-opus-5-5, no sampling params", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
    await createAnthropicProvider({ provider: "anthropic", apiKey: "k" }).chat(REQ);
    const [, init] = fetchMock.mock.calls[0];
    expect((init as { headers: Record<string, string> }).headers["anthropic-version"]).toBe(ANTHROPIC_API_VERSION);
    expect(ANTHROPIC_API_VERSION).toBe("2026-10-21");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe("claude-opus-5-5");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("output_config");
    expect((init as { headers: Record<string, string> }).headers).not.toHaveProperty("anthropic-beta");
  });

  it("sends effort and the refusal-fallback beta only for models that support them; returns meta", async () => {
    fetchMock.mockResolvedValue({
      ...jsonResponse({
        model: "claude-opus-5-5",
        stop_reason: "end_turn",
        usage: { input_tokens: 11, output_tokens: 7, iterations: [{ type: "message" }, { type: "fallback_message" }] },
        content: [{ type: "thinking", thinking: "" }, { type: "text", text: "hi" }],
      }),
      headers: { get: (h: string) => (h === "request-id" ? "req_abc" : null) },
    });
    const res = await createAnthropicProvider({ provider: "anthropic", apiKey: "k", model: "claude-opus-5-5" }).chat({ ...REQ, effort: "low", refusalFallback: true });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body);
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.fallbacks).toBe("default");
    expect((init as { headers: Record<string, string> }).headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    expect(res.text).toBe("hi");
    expect(res.meta).toMatchObject({ model: "claude-opus-5-5", stopReason: "end_turn", requestId: "req_abc", usage: { inputTokens: 11, outputTokens: 7 }, fallbackUsed: true });

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "x" }] }));
    await createAnthropicProvider({ provider: "anthropic", apiKey: "k", model: "claude-haiku-4-5" }).chat({ ...REQ, effort: "low", refusalFallback: true });
    const body2 = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body2).not.toHaveProperty("output_config"); // effort unsupported there
    expect(body2).not.toHaveProperty("fallbacks");
  });

  it("parses API errors into typed fields (type, status, request id, retry-after)", async () => {
    fetchMock.mockResolvedValue({
      ...jsonResponse({ type: "error", error: { type: "rate_limit_error", message: "Number of requests has exceeded your rate limit" } }, 429),
      headers: { get: (h: string) => ({ "request-id": "req_429", "retry-after": "20" })[h] ?? null },
    });
    const err = await createAnthropicProvider({ provider: "anthropic", apiKey: "k" }).chat(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ status: 429, errorType: "rate_limit_error", requestId: "req_429", retryAfter: 20 });
  });

  it("checkAnthropicModel uses the free Models API (GET, no body) and reports lifecycle", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "claude-opus-5-5", display_name: "Claude Opus 5.5", lifecycle: "active", type: "model" }));
    const info = await checkAnthropicModel({ provider: "anthropic", apiKey: "k", model: "claude-opus-5-5" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/models/claude-opus-5-5");
    expect((init as { method: string }).method).toBe("GET");
    expect(init as object).not.toHaveProperty("body");
    expect(info).toMatchObject({ id: "claude-opus-5-5", displayName: "Claude Opus 5.5", lifecycle: "active" });

    fetchMock.mockResolvedValue(jsonResponse({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401));
    await expect(checkAnthropicModel({ provider: "anthropic", apiKey: "bad" })).rejects.toMatchObject({ status: 401, errorType: "authentication_error" });
  });
});

describe("openai-compatible provider", () => {
  it("sends chat/completions shape and parses tool_calls", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              content: "On it.",
              tool_calls: [
                { id: "call_1", function: { name: "add_room", arguments: '{"preset":"lab"}' } },
              ],
            },
          },
        ],
      }),
    );
    const p = createOpenAICompatProvider({ provider: "openai-compatible", apiKey: "sk" });
    const res = await p.chat(REQ);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe("Bearer sk");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.messages[0]).toEqual({ role: "system", content: "You are a copilot." });
    expect(body.tools[0].function.name).toBe("add_room");

    expect(res.text).toBe("On it.");
    expect(res.toolCalls).toEqual([{ id: "call_1", name: "add_room", input: { preset: "lab" } }]);
  });

  it("tolerates malformed tool arguments", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [
          { message: { content: null, tool_calls: [{ id: "c", function: { name: "add_room", arguments: "{oops" } }] } },
        ],
      }),
    );
    const p = createOpenAICompatProvider({ provider: "openai-compatible", apiKey: "sk" });
    const res = await p.chat(REQ);
    expect(res.toolCalls[0].input).toEqual({});
  });

  it("respects custom baseUrl", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "hi" } }] }));
    const p = createOpenAICompatProvider({
      provider: "openai-compatible",
      apiKey: "sk",
      baseUrl: "https://openrouter.ai/api/v1/",
    });
    await p.chat(REQ);
    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("maps tool results to role:tool messages", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "done" } }] }));
    const p = createOpenAICompatProvider({ provider: "openai-compatible", apiKey: "sk" });
    await p.chat({
      ...REQ,
      messages: [
        { role: "user", text: "add a lab" },
        { role: "assistant", toolCalls: [{ id: "call_1", name: "add_room", input: {} }] },
        { role: "user", toolResults: [{ id: "call_1", content: "Added Lab" }] },
      ],
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    const toolMsg = body.messages.find((m: { role: string }) => m.role === "tool");
    expect(toolMsg).toMatchObject({ tool_call_id: "call_1", content: "Added Lab" });
  });
});

describe("createCopilotProvider factory", () => {
  it("ollama defaults to the local endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "hi" } }] }));
    const p = createCopilotProvider({ provider: "ollama" });
    await p.chat(REQ);
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("builds each provider kind", () => {
    expect(createCopilotProvider({ provider: "anthropic", apiKey: "k" }).id).toBe("anthropic");
    expect(createCopilotProvider({ provider: "openai-compatible", apiKey: "k" }).id).toBe("openai-compatible");
    expect(createCopilotProvider({ provider: "ollama" }).id).toBe("ollama");
    expect(createCopilotProvider({ provider: "codex-auth", apiKey: "t" }).id).toBe("codex-auth");
  });
});
