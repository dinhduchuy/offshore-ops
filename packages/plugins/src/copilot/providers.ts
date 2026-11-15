/**
 * LLM provider adapters for the Diorama copilot. Bring-your-own-LLM:
 * every provider implements the same minimal chat contract, so the
 * copilot works with an Anthropic key, any OpenAI-compatible endpoint
 * (OpenAI, OpenRouter, Groq, LM Studio, vLLM…), a local Ollama, or a
 * ChatGPT-subscription token from the Codex CLI.
 *
 * Dependency-free (fetch only). Server-side ONLY — keys never reach the
 * browser; the app's /api/copilot/chat route calls this.
 */

export interface ProviderToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text?: string;
  /** Assistant turns may carry tool calls */
  toolCalls?: ProviderToolCall[];
  /** User turns may carry results for the previous assistant tool calls */
  toolResults?: Array<{ id: string; content: string }>;
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatRequest {
  system: string;
  messages: ChatTurn[];
  tools: ProviderToolDef[];
  maxTokens?: number;
  /** Anthropic only: output_config.effort (omitted → model default) */
  effort?: ReasoningEffort;
  /** Anthropic only: server-side refusal fallback (`fallbacks: "default"`), models that support it */
  refusalFallback?: boolean;
}

/** Call metadata (Anthropic fills it; other providers may leave it empty). Never contains secrets. */
export interface ChatMeta {
  /** Model that actually served the request (may differ after a refusal fallback) */
  model?: string;
  stopReason?: string;
  requestId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
  fallbackUsed?: boolean;
}

export interface ChatResponse {
  text: string;
  toolCalls: ProviderToolCall[];
  meta?: ChatMeta;
}

export interface CopilotProviderConfig {
  provider: "anthropic" | "openai-compatible" | "ollama" | "codex-auth" | "claude-cli" | "codex-cli";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface CopilotProvider {
  id: CopilotProviderConfig["provider"];
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export class ProviderError extends Error {
  /** Duck-type marker (bundlers may duplicate this class) */
  readonly isProviderError = true;
  constructor(
    message: string,
    public status?: number,
    /** API error type, e.g. authentication_error, not_found_error, rate_limit_error */
    public errorType?: string,
    public requestId?: string,
    /** Seconds, from the retry-after header */
    public retryAfter?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Build a ProviderError from a failed HTTP response (body is read, never the request headers). */
async function errorFromResponse(prefix: string, res: Response): Promise<ProviderError> {
  const body = await res.text().catch(() => "");
  let errorType: string | undefined;
  let message = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { error?: { type?: string; message?: string } | string };
    if (parsed && typeof parsed.error === "object" && parsed.error) {
      errorType = parsed.error.type;
      if (parsed.error.message) message = parsed.error.message.slice(0, 300);
    }
  } catch {
    // non-JSON body
  }
  const header = (name: string) => (typeof res.headers?.get === "function" ? res.headers.get(name) : null);
  const retry = Number(header("retry-after"));
  return new ProviderError(
    `${prefix} ${res.status}${errorType ? ` ${errorType}` : ""}: ${message}`,
    res.status,
    errorType,
    header("request-id") ?? undefined,
    Number.isFinite(retry) && retry > 0 ? retry : undefined,
  );
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

/** Current Claude API version (anthropic-version header). */
export const ANTHROPIC_API_VERSION = "2026-10-21";
export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";
/** Current models (platform.claude.com/docs/en/about-claude/models/overview, checked 2026-11-12). */
export const ANTHROPIC_MODELS: Array<{ id: string; label: string }> = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (khuyến nghị)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (nhanh hơn, rẻ hơn)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (nhanh nhất)" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2 (mạnh nhất, đắt nhất)" },
];
/** Models that accept `fallbacks: "default"` (server-side refusal fallback beta). */
const FALLBACK_MODELS = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Models whose effort parameter is known (anything else: effort is not sent). */
const EFFORT_MODELS = /^claude-(fable|mythos|opus|sonnet|haiku)-5|^claude-opus-4-[678]|^claude-sonnet-4-6/;

function anthropicHeaders(apiKey: string | undefined, betas: string[] = []): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey ?? "",
    "anthropic-version": ANTHROPIC_API_VERSION,
    ...(betas.length ? { "anthropic-beta": betas.join(",") } : {}),
  };
}

/**
 * Free connectivity check: GET /v1/models/{id} (not billed). Verifies the key
 * (401/403), the model id (404) and reachability; returns the model lifecycle.
 * It does NOT prove that a Messages call will succeed (credit balance, quotas).
 */
export async function checkAnthropicModel(cfg: CopilotProviderConfig): Promise<{
  id: string;
  displayName?: string;
  lifecycle?: string;
  requestId?: string;
}> {
  const baseUrl = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const model = cfg.model || ANTHROPIC_DEFAULT_MODEL;
  const res = await fetch(`${baseUrl}/v1/models/${encodeURIComponent(model)}`, {
    method: "GET",
    headers: anthropicHeaders(cfg.apiKey),
  });
  if (!res.ok) throw await errorFromResponse("Anthropic", res);
  const data = (await res.json()) as { id?: string; display_name?: string; lifecycle?: string };
  const requestId = typeof res.headers?.get === "function" ? res.headers.get("request-id") ?? undefined : undefined;
  return { id: data.id ?? model, displayName: data.display_name, lifecycle: data.lifecycle, requestId };
}

function anthropicMessages(messages: ChatTurn[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant") {
      const content: unknown[] = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      }
      return { role: "assistant", content };
    }
    // user turn — may carry tool results
    if (m.toolResults?.length) {
      return {
        role: "user",
        content: [
          ...m.toolResults.map((r) => ({
            type: "tool_result",
            tool_use_id: r.id,
            content: r.content,
          })),
          ...(m.text ? [{ type: "text", text: m.text }] : []),
        ],
      };
    }
    return { role: "user", content: m.text ?? "" };
  });
}

export function createAnthropicProvider(cfg: CopilotProviderConfig): CopilotProvider {
  const baseUrl = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const model = cfg.model || ANTHROPIC_DEFAULT_MODEL;
  return {
    id: "anthropic",
    async chat(req) {
      const fallback = !!req.refusalFallback && FALLBACK_MODELS.has(model);
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: anthropicHeaders(cfg.apiKey, fallback ? [FALLBACK_BETA] : []),
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 2048,
          system: req.system,
          messages: anthropicMessages(req.messages),
          ...(req.tools.length ? { tools: req.tools } : {}),
          ...(req.effort && EFFORT_MODELS.test(model) ? { output_config: { effort: req.effort } } : {}),
          ...(fallback ? { fallbacks: "default" } : {}),
        }),
      });
      if (!res.ok) throw await errorFromResponse("Anthropic", res);
      const data = (await res.json()) as {
        model?: string;
        stop_reason?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
          iterations?: Array<{ type?: string }>;
        };
        content: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
          | { type: string }
        >;
      };
      const meta: ChatMeta = {
        model: data.model,
        stopReason: data.stop_reason,
        requestId: typeof res.headers?.get === "function" ? res.headers.get("request-id") ?? undefined : undefined,
        usage: data.usage
          ? {
              inputTokens: data.usage.input_tokens,
              outputTokens: data.usage.output_tokens,
              cacheReadInputTokens: data.usage.cache_read_input_tokens,
              cacheCreationInputTokens: data.usage.cache_creation_input_tokens,
            }
          : undefined,
        fallbackUsed: (data.usage?.iterations ?? []).some((it) => it.type === "fallback_message") || undefined,
      };
      const text = data.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls = data.content
        .filter((b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      return { text, toolCalls, meta };
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat/completions (OpenAI, OpenRouter, Groq, vLLM, Ollama…)
// ---------------------------------------------------------------------------

const OPENAI_DEFAULT_MODEL = "gpt-5";

function openaiMessages(system: string, messages: ChatTurn[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.text ?? null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: JSON.stringify(tc.input) },
              })),
            }
          : {}),
      });
    } else {
      for (const r of m.toolResults ?? []) {
        out.push({ role: "tool", tool_call_id: r.id, content: r.content });
      }
      if (m.text || !m.toolResults?.length) {
        out.push({ role: "user", content: m.text ?? "" });
      }
    }
  }
  return out;
}

export function createOpenAICompatProvider(
  cfg: CopilotProviderConfig,
  id: CopilotProviderConfig["provider"] = "openai-compatible",
): CopilotProvider {
  const baseUrl = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = cfg.model || OPENAI_DEFAULT_MODEL;
  return {
    id,
    async chat(req) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: openaiMessages(req.system, req.messages),
          ...(req.tools.length
            ? {
                tools: req.tools.map((t) => ({
                  type: "function",
                  function: { name: t.name, description: t.description, parameters: t.input_schema },
                })),
              }
            : {}),
          max_tokens: req.maxTokens ?? 2048,
        }),
      });
      if (!res.ok) throw await errorFromResponse(id, res);
      const data = (await res.json()) as {
        choices: Array<{
          message: {
            content: string | null;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          };
        }>;
      };
      const msg = data.choices?.[0]?.message;
      const toolCalls: ProviderToolCall[] = (msg?.tool_calls ?? []).map((tc) => {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          // tolerate malformed JSON args — pass empty input
        }
        return { id: tc.id, name: tc.function.name, input };
      });
      return { text: msg?.content ?? "", toolCalls };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const PROVIDER_LABELS: Record<CopilotProviderConfig["provider"], string> = {
  "claude-cli": "Claude Code CLI (your existing login — no key)",
  "codex-cli": "Codex CLI (your ChatGPT login — no key)",
  anthropic: "Anthropic API key",
  "openai-compatible": "OpenAI-compatible API (OpenAI, OpenRouter, Groq…)",
  ollama: "Ollama (local)",
  "codex-auth": "Codex token (advanced — custom endpoint)",
};

/**
 * Build a provider from config. For `ollama`, baseUrl defaults to the local
 * server; for `codex-auth` the caller must pre-resolve the token from
 * ~/.codex/auth.json into cfg.apiKey (see credentials.ts).
 */
export function createCopilotProvider(cfg: CopilotProviderConfig): CopilotProvider {
  switch (cfg.provider) {
    case "anthropic":
      return createAnthropicProvider(cfg);
    case "openai-compatible":
      return createOpenAICompatProvider(cfg);
    case "ollama":
      return createOpenAICompatProvider(
        { ...cfg, baseUrl: cfg.baseUrl ?? "http://localhost:11434/v1", model: cfg.model || "llama3.1" },
        "ollama",
      );
    case "codex-auth":
      return createOpenAICompatProvider(cfg, "codex-auth");
    case "claude-cli":
    case "codex-cli":
      throw new ProviderError(
        `${cfg.provider} is a local-CLI provider — use createProvider from copilot/factory (server-side)`,
      );
    default:
      throw new ProviderError(`Unknown provider "${(cfg as { provider: string }).provider}"`);
  }
}
