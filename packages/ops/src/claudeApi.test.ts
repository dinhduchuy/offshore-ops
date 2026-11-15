import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { OpsService } from "./service";
import type { LlmClient, LlmChatResult } from "./llm";
import { applyLlmUpdate, classifyLlmError, loadLlmSettings, maskKey, publicLlmSettings, saveLlmSettings, scrubSecrets } from "./llmSettings";
import { createAnthropicProvider } from "../../plugins/src/copilot/providers";

/** Test harness principal (service source) — the core no longer trusts callers without an identity. */
const TEST_SERVICE: import("./types").Identity = { userId: "svc.test", name: "Test harness", roles: ["Tích hợp dữ liệu", "Quản trị hệ thống"], source: "service" };


/**
 * Claude API integration — everything here is MOCKED (no network, no billed calls).
 */

const SAMPLE = path.resolve(__dirname, "../../../oilgas/sample-data");
const FAKE_KEY = "sk-ant-api03-THISISNOTAREALKEY-0123456789abcdef";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-claude-"));
}

const NARRATION = JSON.stringify({ narrative: "Diễn giải thử nghiệm.", additional_conclusions: [], next_steps: [] });

function fakeClient(over: Partial<LlmClient> = {}, reply: () => Promise<string | LlmChatResult> = async () => ({ text: NARRATION, model: "claude-opus-5-5", stopReason: "end_turn", requestId: "req_test", usage: { inputTokens: 1200, outputTokens: 340 } })): LlmClient {
  return { provider: "anthropic", model: "claude-opus-5-5", configRevision: 1, source: "ui", chat: () => reply(), ...over };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settings store: key stays server-side", () => {
  it("saves with mode 0600, masks the key, keeps it when the field is left empty, clears on request", () => {
    const dir = tmp();
    const file = path.join(dir, "ops-llm.json");
    const a = applyLlmUpdate(null, { enabled: true, model: "claude-opus-5-5", effort: "medium", apiKey: FAKE_KEY }, "demo.asset (demo)");
    expect(a.keyChanged).toBe(true);
    saveLlmSettings(file, a.next);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const pub = publicLlmSettings(loadLlmSettings(file));
    expect(JSON.stringify(pub)).not.toContain("THISISNOTAREALKEY");
    expect(pub).toMatchObject({ keyConfigured: true, keyMasked: "sk-ant-…cdef", enabled: true, revision: 1 });

    const b = applyLlmUpdate(loadLlmSettings(file), { model: "claude-sonnet-5-5", apiKey: "" }, "x");
    expect(b.next.apiKey).toBe(FAKE_KEY); // empty field → keep
    expect(b.keyChanged).toBe(false);
    expect(b.next.revision).toBe(2);
    const c = applyLlmUpdate(b.next, { clearKey: true }, "x");
    expect(c.next.apiKey).toBeUndefined();
    expect(c.keyChanged).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects invalid model / effort / key", () => {
    expect(() => applyLlmUpdate(null, { model: "claude opus; rm -rf" }, "x")).toThrow(/Model không hợp lệ/);
    expect(() => applyLlmUpdate(null, { effort: "turbo" }, "x")).toThrow(/Effort/);
    expect(() => applyLlmUpdate(null, { apiKey: "sk-ant short" }, "x")).toThrow(/API key không hợp lệ/);
    expect(maskKey("abc")).toBe("••••");
  });
});

describe("error classification (auth / model / limits / connection)", () => {
  it("maps HTTP status and error types to categories and never echoes a key", () => {
    const e = (status: number | undefined, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });
    expect(classifyLlmError(e(401, "Anthropic 401 authentication_error: invalid x-api-key")).category).toBe("auth");
    expect(classifyLlmError(e(404, "Anthropic 404 not_found_error: model: claude-x")).category).toBe("model");
    const rl = classifyLlmError(e(429, "rate limited", { retryAfter: 30, requestId: "req_1" }));
    expect(rl).toMatchObject({ category: "rate_limit", retryAfter: 30, requestId: "req_1" });
    expect(classifyLlmError(e(400, "Your credit balance is too low")).category).toBe("billing");
    expect(classifyLlmError(e(529, "overloaded")).category).toBe("overloaded");
    expect(classifyLlmError(Object.assign(new TypeError("fetch failed"), {})).category).toBe("connection");
    expect(classifyLlmError(e(401, `bad key ${FAKE_KEY}`)).message).not.toContain("THISISNOTAREALKEY");
    expect(scrubSecrets(`x-api-key: ${FAKE_KEY}`)).not.toContain("THISISNOTAREALKEY");
  });
});

describe("hot configuration (no restart)", () => {
  it("blocked (key missing) → configure from /ops → next tasks run on Claude with the new revision", async () => {
    const dir = tmp();
    const svc = new OpsService({ dbPath: path.join(dir, "x.db"), taskDelayMs: 0, systemActor: TEST_SERVICE, requestedMode: "llm", llm: null, llmSource: "ui", llmRevision: 1, llmConfigError: { status: "missing_credentials", message: "Claude API đang BẬT nhưng chưa có API key" } });
    expect(svc.modeInfo()).toMatchObject({ effective: "blocked", source: "ui", reloadRequiresRestart: false });
    await svc.loadSample(SAMPLE, "base");
    await svc.orch.runUntilIdle();
    expect(svc.db.prepare("SELECT COUNT(*) c FROM task_runs").get()!.c).toBe(0); // paused, NOT run on rules

    const mode = svc.configureLlm({ requested: "llm", llm: fakeClient({ configRevision: 2 }), source: "ui", revision: 2, effort: "medium" });
    expect(mode).toMatchObject({ effective: "llm", model: "claude-opus-5-5", configRevision: 2, reloadRequiresRestart: false });
    await svc.orch.runUntilIdle();

    const runs = svc.db.prepare("SELECT mode, llm_config_json FROM task_runs WHERE mode != 'human'").all();
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) {
      expect(r.mode).toBe("llm");
      expect(JSON.parse(r.llm_config_json as string)).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", effort: "medium", source: "ui", revision: 2 });
    }
    const call = svc.db.prepare("SELECT * FROM llm_calls ORDER BY id LIMIT 1").get()!;
    expect(call).toMatchObject({ status: "ok", served_model: "claude-opus-5-5", stop_reason: "end_turn", request_id: "req_test", input_tokens: 1200, output_tokens: 340, config_revision: 2 });
    expect(typeof call.duration_ms).toBe("number");
    expect(svc.modeInfo().configurationStatus).toBe("verified");
    expect(svc.llmHistory().totals).toMatchObject({ input_tokens: 1200 * runs.length, output_tokens: 340 * runs.length });
    svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a task already running keeps the configuration it started with", async () => {
    const dir = tmp();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const callStarted = new Promise<void>((r) => (started = r));
    const slow = fakeClient({ configRevision: 5 }, async () => {
      started();
      await gate;
      return { text: NARRATION, model: "claude-opus-5-5", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const svc = new OpsService({ dbPath: path.join(dir, "x.db"), taskDelayMs: 0, systemActor: TEST_SERVICE, requestedMode: "llm", llm: slow, llmSource: "ui", llmRevision: 5 });
    await svc.loadSample(SAMPLE, "base");
    svc.orch.tick();
    await callStarted;
    const runningRun = svc.db.prepare("SELECT id FROM task_runs WHERE status = 'running'").get()!;

    // Switch to rules while that call is in flight
    svc.configureLlm({ requested: "rules", source: "ui", revision: 6 });
    release();
    await svc.orch.runUntilIdle();

    const first = svc.db.prepare("SELECT mode, status, output_json FROM task_runs WHERE id = ?").get(runningRun.id)!;
    expect(first.mode).toBe("llm");
    expect(first.status).not.toBe("error");
    expect(JSON.parse(first.output_json as string).mode).toBe("llm");
    const later = svc.db.prepare("SELECT mode FROM task_runs WHERE id > ? AND mode != 'human'").all(runningRun.id);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((r) => r.mode === "demo-rules")).toBe(true);
    svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Claude API errors are shown, never silently replaced", () => {
  it("auth error → task error with category, last_call_failed, no rules/demo fallback, secret not stored", async () => {
    const dir = tmp();
    const failing = fakeClient({}, async () => {
      throw Object.assign(new Error(`Anthropic 401 authentication_error: invalid x-api-key ${FAKE_KEY}`), { status: 401, errorType: "authentication_error", requestId: "req_401" });
    });
    const svc = new OpsService({ dbPath: path.join(dir, "x.db"), taskDelayMs: 0, systemActor: TEST_SERVICE, requestedMode: "llm", llm: failing, llmSource: "ui", llmRevision: 1 });
    await svc.loadSample(SAMPLE, "base");
    await svc.orch.runUntilIdle();
    const t = svc.state().workflows[0].tasks.find((x) => x.key === "ops.anomaly")!;
    expect(t.status).toBe("error");
    expect(t.note).toMatch(/Lỗi xác thực/);
    expect(svc.modeInfo()).toMatchObject({ effective: "llm", configurationStatus: "last_call_failed", lastLlmErrorCategory: "auth" });
    expect(svc.db.prepare("SELECT COUNT(*) c FROM task_runs WHERE mode = 'demo-rules'").get()!.c).toBe(0);
    const call = svc.db.prepare("SELECT * FROM llm_calls").get()!;
    expect(call).toMatchObject({ status: "error", error_category: "auth", http_status: 401, request_id: "req_401" });
    // no secret anywhere in the database
    for (const table of ["llm_calls", "task_runs", "tasks", "events", "llm_config_events"]) {
      for (const row of svc.db.prepare(`SELECT * FROM ${table}`).all()) expect(JSON.stringify(row)).not.toContain("THISISNOTAREALKEY");
    }
    svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refusal and max_tokens stop reasons are errors, not partial results", async () => {
    for (const [stopReason, category] of [["refusal", "refusal"], ["max_tokens", "truncated"]] as const) {
      const dir = tmp();
      const c = fakeClient({}, async () => ({ text: stopReason === "max_tokens" ? '{"narrative": "bị cắt' : "", stopReason, usage: { inputTokens: 5, outputTokens: 7 } }));
      const svc = new OpsService({ dbPath: path.join(dir, "x.db"), taskDelayMs: 0, systemActor: TEST_SERVICE, requestedMode: "llm", llm: c });
      await svc.loadSample(SAMPLE, "base");
      await svc.orch.runUntilIdle();
      const call = svc.db.prepare("SELECT status, error_category, output_tokens FROM llm_calls").get()!;
      expect(call).toMatchObject({ status: "error", error_category: category, output_tokens: 7 });
      expect(svc.state().workflows[0].tasks.find((x) => x.key === "ops.anomaly")!.status).toBe("error");
      svc.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("integration with the existing Anthropic adapter (HTTP mocked)", () => {
  it("sends the current API version/model/effort and records usage from the response", async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h === "request-id" ? "req_mock_1" : null) },
        json: async () => ({
          model: body.model,
          stop_reason: "end_turn",
          usage: { input_tokens: 2048, output_tokens: 256, cache_read_input_tokens: 0 },
          content: [{ type: "thinking", thinking: "" }, { type: "text", text: NARRATION }],
        }),
        text: async () => "",
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createAnthropicProvider({ provider: "anthropic", apiKey: FAKE_KEY, model: "claude-opus-5-5" });
    const client: LlmClient = {
      provider: "anthropic",
      model: "claude-opus-5-5",
      configRevision: 3,
      async chat(system, user, maxTokens) {
        const r = await provider.chat({ system, messages: [{ role: "user", text: user }], tools: [], maxTokens, effort: "medium", refusalFallback: true });
        return { text: r.text, model: r.meta?.model, stopReason: r.meta?.stopReason, requestId: r.meta?.requestId, usage: r.meta?.usage };
      },
    };
    const dir = tmp();
    const svc = new OpsService({ dbPath: path.join(dir, "x.db"), taskDelayMs: 0, systemActor: TEST_SERVICE, requestedMode: "llm", llm: client, llmSource: "ui", llmRevision: 3 });
    await svc.loadSample(SAMPLE, "base");
    await svc.orch.runUntilIdle();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["anthropic-version"]).toBe("2026-10-21");
    expect(init.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 16000, output_config: { effort: "medium" }, fallbacks: "default" });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("thinking");
    expect(svc.db.prepare("SELECT status, input_tokens, output_tokens, request_id, config_revision FROM llm_calls LIMIT 1").get()).toMatchObject({
      status: "ok",
      input_tokens: 2048,
      output_tokens: 256,
      request_id: "req_mock_1",
      config_revision: 3,
    });
    svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
