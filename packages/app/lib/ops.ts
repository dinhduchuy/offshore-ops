import path from "path";
import os from "os";
import fs from "fs";
import { OpsService, isOpsError, loadLlmSettings, type LlmClient, type LlmChatResult, type LlmConfigInput, type OpsLlmSettings, type VisualEvent } from "@diorama/ops";
import { loadCredentials, resolveProviderConfig } from "@diorama/plugins/copilot/credentials";
import { createProvider } from "@diorama/plugins/copilot/factory";
import type { ChatResponse } from "@diorama/plugins/copilot/providers";
import { NextResponse } from "next/server";
import { publish } from "./eventHub";
import { OPERATING_MODE } from "./identity";

/**
 * Server-side singleton for the offshore ops workflow. Anchored on
 * globalThis so every Next.js route bundle shares one service + one runner.
 *
 *   OPS_DB_PATH   SQLite file (default ~/.diorama/ops.db)
 *   OPS_HOME      folder with ops-config.json + sample-data (default ../../oilgas)
 *   Claude API    configured from /ops (POST /api/ops/llm) → ~/.diorama/ops-llm.json
 *                 (mode 0600, key never sent to the browser). Applied immediately to
 *                 the next task, no restart. When this file exists it takes precedence.
 *   OPS_LLM_BASE_URL  optional server-side override of https://api.anthropic.com
 *                 (corporate proxy, or a local mock for tests). Never set from the browser.
 *   OPS_LLM=1     legacy: request LLM processing with the copilot credentials
 *                 (~/.diorama/credentials.json). Read once at start → restart to change.
 *   Missing/invalid config while LLM is requested → agents PAUSE (no silent fallback to rules/demo).
 *   OPS_OPERATING_MODE=demo|production   (see lib/identity.ts)
 */
export const OPS_HOME = process.env.OPS_HOME ?? path.resolve(process.cwd(), "../../oilgas");
export const TEMPLATES_DIR = path.resolve(process.cwd(), "../../templates");

type LlmBuild = { client: LlmClient | null; error?: { status: "missing_credentials" | "invalid_config"; message: string } };

/** Settings file for the /ops Claude API configuration (separate from the copilot credentials). */
export function llmSettingsPath(): string {
  return path.join(process.env.DIORAMA_HOME ?? path.join(os.homedir(), ".diorama"), "ops-llm.json");
}

function toResult(r: ChatResponse): LlmChatResult {
  return {
    text: r.text,
    model: r.meta?.model,
    stopReason: r.meta?.stopReason,
    requestId: r.meta?.requestId,
    usage: r.meta?.usage,
    fallbackUsed: r.meta?.fallbackUsed,
  };
}

/** Server-side base URL override (proxy or local mock); undefined → api.anthropic.com */
export const LLM_BASE_URL = process.env.OPS_LLM_BASE_URL || undefined;

/** Build the Claude API client from saved /ops settings (server-side only). */
export function claudeClient(s: Pick<OpsLlmSettings, "apiKey" | "model" | "effort" | "refusalFallback" | "revision">): LlmClient {
  const provider = createProvider({ provider: "anthropic", apiKey: s.apiKey, model: s.model, baseUrl: LLM_BASE_URL });
  return {
    provider: "anthropic",
    model: s.model,
    configRevision: s.revision,
    source: "ui",
    async chat(system, user, maxTokens) {
      const r = await provider.chat({ system, messages: [{ role: "user", text: user }], tools: [], maxTokens, effort: s.effort, refusalFallback: s.refusalFallback });
      return toResult(r);
    },
  };
}

/** Translate /ops settings into a processing configuration. Never throws. */
export function llmConfigFromSettings(): LlmConfigInput | null {
  let s: OpsLlmSettings | null;
  try {
    s = loadLlmSettings(llmSettingsPath());
  } catch (err) {
    return {
      requested: "llm",
      llm: null,
      error: { status: "invalid_config", message: `không đọc được ${path.basename(llmSettingsPath())}: ${err instanceof Error ? err.message : String(err)}` },
      source: "ui",
    };
  }
  if (!s) return null;
  if (!s.enabled) return { requested: "rules", source: "ui", revision: s.revision };
  if (!s.apiKey) {
    return {
      requested: "llm",
      llm: null,
      error: { status: "missing_credentials", message: "Claude API đang BẬT nhưng chưa có API key" },
      source: "ui",
      revision: s.revision,
      effort: s.effort,
    };
  }
  return { requested: "llm", llm: claudeClient(s), source: "ui", revision: s.revision, effort: s.effort };
}

/** Re-read the settings file and apply it to the running service (next task onward). */
export function reloadLlmFromSettings() {
  const c = llmConfigFromSettings() ?? { requested: "rules" as const, source: "ui" as const };
  return getOps().configureLlm(c);
}

/** Legacy: build the LLM client from the copilot credentials when OPS_LLM=1. */
function buildLlm(): LlmBuild {
  if (process.env.OPS_LLM !== "1") return { client: null };
  let creds;
  try {
    creds = loadCredentials();
  } catch (err) {
    return { client: null, error: { status: "invalid_config", message: `không đọc được credentials: ${err instanceof Error ? err.message : String(err)}` } };
  }
  if (!creds) {
    return { client: null, error: { status: "missing_credentials", message: "OPS_LLM=1 nhưng chưa có credentials LLM (cấu hình trong Copilot của Offshore Ops)" } };
  }
  try {
    const cfg = resolveProviderConfig(creds);
    const provider = createProvider(cfg);
    return {
      client: {
        provider: cfg.provider,
        model: cfg.model,
        source: "env",
        async chat(system, user, maxTokens) {
          const res = await provider.chat({ system, messages: [{ role: "user", text: user }], tools: [], maxTokens });
          return toResult(res);
        },
      },
    };
  } catch (err) {
    return { client: null, error: { status: "invalid_config", message: `cấu hình provider không hợp lệ: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

function toDioramaEvent(e: VisualEvent) {
  return {
    type: e.type,
    room: e.room ?? "",
    agent: e.agent,
    payload: { label: e.label, msg: e.msg, eventId: e.eventId, workflowId: e.workflowId, taskId: e.taskId, source: e.source },
    timestamp: Date.parse(e.ts),
  };
}

const KEY = "__dioramaOpsService__";

export function getOps(): OpsService {
  const g = globalThis as Record<string, unknown>;
  if (!g[KEY]) {
    const fromUi = llmConfigFromSettings();
    const llm = fromUi ? { client: fromUi.llm ?? null, error: fromUi.error } : buildLlm();
    const configPath = path.join(OPS_HOME, "ops-config.json");
    const svc = new OpsService({
      dbPath: process.env.OPS_DB_PATH ?? path.join(os.homedir(), ".diorama", "ops.db"),
      configPath: fs.existsSync(configPath) ? configPath : undefined,
      publish: (e) => publish(toDioramaEvent(e)),
      // OPS_LLM=1 requests LLM processing; otherwise ops-config.json decides (default: rules)
      requestedMode: fromUi ? fromUi.requested : process.env.OPS_LLM === "1" ? "llm" : undefined,
      llm: llm.client,
      llmConfigError: llm.error,
      llmSource: fromUi ? "ui" : undefined,
      llmRevision: fromUi?.revision,
      llmEffort: fromUi?.effort,
      operatingMode: OPERATING_MODE,
    });
    if (svc.modeInfo().effective === "blocked") console.error(`[ops] ${svc.modeInfo().detail}`);
    svc.start();
    g[KEY] = svc;
  }
  return g[KEY] as OpsService;
}

/**
 * Uniform JSON error responses for ops routes:
 *   { ok:false, error: <original text>, code: <stable code>, params: {...}, requestId }
 * The interface renders `code` + `params` from its catalog (VI/EN); `error` and `requestId`
 * stay available as support details. Server errors are logged with the same requestId.
 */
const requestId = () => `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function errorJson(status: number, code: string, message: string, params?: Record<string, string | number | null | undefined>) {
  return NextResponse.json({ ok: false, error: message, code, ...(params ? { params } : {}), requestId: requestId() }, { status });
}

export function opsError(err: unknown) {
  if (isOpsError(err)) {
    const e = err as { status: number; message: string; code?: string; params?: Record<string, string | number | null | undefined> };
    return errorJson(e.status, e.code ?? `http_${e.status}`, e.message, e.params);
  }
  const id = requestId();
  console.error(`[ops] ${id}`, err);
  return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err), code: "internal", requestId: id }, { status: 500 });
}
