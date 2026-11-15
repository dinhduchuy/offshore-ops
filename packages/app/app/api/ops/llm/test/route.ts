import { NextResponse } from "next/server";
import { classifyLlmError, loadLlmSettings, scrubSecrets } from "@diorama/ops";
import { checkAnthropicModel } from "@diorama/plugins/copilot/providers";
import { getOps, opsError, llmSettingsPath, claudeClient, LLM_BASE_URL, errorJson } from "@/lib/ops";
import { resolveIdentity, identityStatus, OPERATING_MODE } from "@/lib/identity";

/**
 * Connection test for the Claude API.
 *   kind "models"  (default) GET /v1/models/{model} — NOT billed. Verifies key, model, reachability.
 *   kind "message" one minimal Messages call — BILLED (a few tokens). Requires confirmPaid=true.
 * Optional apiKey/model in the body test candidate values before saving; they are not stored.
 */
export async function POST(request: Request) {
  try {
    if (OPERATING_MODE === "production") {
      return errorJson(403, "demo_identity_refused", "Chế độ production chưa có danh tính doanh nghiệp (SSO)");
    }
    const actor = resolveIdentity(request);
    if (!actor) return errorJson(401, "identity_missing", `Cần chọn danh tính trước. ${identityStatus().detail}`);
    getOps().authorizeLlmConfigure(actor); // role from ops-config permissions.llmConfigure (403 otherwise)
    const b = (await request.json().catch(() => ({}))) as { kind?: "models" | "message"; confirmPaid?: boolean; apiKey?: string; model?: string };
    const kind = b.kind === "message" ? "message" : "models";
    if (kind === "message" && b.confirmPaid !== true) {
      return errorJson(400, "paid_call_unconfirmed", "Gọi thử Messages API có tính phí — cần xác nhận confirmPaid");
    }
    const saved = loadLlmSettings(llmSettingsPath());
    const apiKey = b.apiKey?.trim() || saved?.apiKey;
    const model = b.model?.trim() || saved?.model || "claude-opus-5-5";
    const ops = getOps();
    const who = `${actor.userId} (${actor.source})`;
    const base = { kind: kind === "message" ? "message_check" : "check", actor: who, provider: "anthropic", model, keyConfigured: !!apiKey, revision: saved?.revision } as const;
    if (!apiKey) {
      ops.recordLlmEvent({ ...base, status: "error", errorCategory: "missing_key", detail: "Chưa có API key" });
      return NextResponse.json({ ok: true, result: { success: false, code: "missing_key", category: "missing_key", label: "Chưa có API key", message: "Nhập API key rồi kiểm tra lại" } });
    }
    const started = Date.now();
    try {
      if (kind === "models") {
        const info = await checkAnthropicModel({ provider: "anthropic", apiKey, model, baseUrl: LLM_BASE_URL });
        const durationMs = Date.now() - started;
        const retired = info.lifecycle === "retired";
        const detail = `${info.displayName ?? info.id} · lifecycle=${info.lifecycle ?? "?"}`;
        ops.recordLlmEvent({ ...base, status: retired ? "error" : "ok", errorCategory: retired ? "model" : undefined, requestId: info.requestId, durationMs, detail });
        return NextResponse.json({
          ok: true,
          result: retired
            ? { success: false, code: "model_retired", category: "model", label: "Model đã ngừng phục vụ (retired)", message: detail, params: { model: info.displayName ?? info.id, lifecycle: info.lifecycle ?? "?" }, durationMs }
            : {
                success: true,
                code: info.lifecycle === "deprecated" ? "ok_deprecated" : "ok_models",
                params: { model: info.displayName ?? info.id, lifecycle: info.lifecycle ?? "?" },
                label: info.lifecycle === "deprecated" ? "Kết nối OK — model đang deprecated, nên đổi model" : "Kết nối OK — key hợp lệ, model có sẵn",
                message: `${detail}. Kiểm tra này không tính phí và không xác nhận hạn mức tín dụng cho Messages API.`,
                durationMs,
                requestId: info.requestId,
              },
        });
      }
      const client = claudeClient({ apiKey, model, effort: "low", refusalFallback: false, revision: saved?.revision ?? 0 });
      const r = await client.chat("Trả lời đúng một từ: OK", "Kiểm tra kết nối", 256);
      const res = typeof r === "string" ? { text: r } : r;
      const durationMs = Date.now() - started;
      ops.recordLlmEvent({
        ...base,
        status: "ok",
        requestId: res.requestId,
        durationMs,
        inputTokens: res.usage?.inputTokens,
        outputTokens: res.usage?.outputTokens,
        detail: `stop_reason=${res.stopReason ?? "?"}; model=${res.model ?? model}`,
      });
      return NextResponse.json({
        ok: true,
        result: {
          success: true,
          code: "ok_message",
          params: { stopReason: res.stopReason ?? "?", inputTokens: res.usage?.inputTokens ?? "?", outputTokens: res.usage?.outputTokens ?? "?" },
          label: "Gọi Messages API thành công",
          message: `stop_reason=${res.stopReason ?? "?"} · token vào/ra ${res.usage?.inputTokens ?? "?"}/${res.usage?.outputTokens ?? "?"}`,
          durationMs,
          requestId: res.requestId,
        },
      });
    } catch (err) {
      const info = classifyLlmError(err);
      ops.recordLlmEvent({ ...base, status: "error", errorCategory: info.category, httpStatus: info.status, requestId: info.requestId, durationMs: Date.now() - started, detail: scrubSecrets(info.message).slice(0, 300) });
      return NextResponse.json({ ok: true, result: { success: false, code: `cat_${info.category}`, ...info, durationMs: Date.now() - started } });
    }
  } catch (err) {
    return opsError(err);
  }
}
