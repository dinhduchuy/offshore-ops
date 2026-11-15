import { NextResponse } from "next/server";
import { applyLlmUpdate, loadLlmSettings, publicLlmSettings, saveLlmSettings, type LlmSettingsUpdate } from "@diorama/ops";
import { ANTHROPIC_MODELS } from "@diorama/plugins/copilot/providers";
import { getOps, opsError, llmSettingsPath, reloadLlmFromSettings, errorJson } from "@/lib/ops";
import { resolveIdentity, identityStatus, OPERATING_MODE } from "@/lib/identity";

/**
 * Claude API configuration for the ops workflow.
 *   GET  → masked settings + effective mode + history (never the key)
 *   POST → save (server-side file, 0600) and apply to the NEXT task without restart
 * Editing requires a server-side identity; production mode has no identity
 * provider yet, so editing is refused there (edit the file + restart instead).
 */

function readSettings() {
  try {
    return { settings: loadLlmSettings(llmSettingsPath()), error: null as string | null };
  } catch (err) {
    return { settings: null, error: `Không đọc được file cấu hình: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function GET() {
  try {
    const ops = getOps();
    const { settings, error } = readSettings();
    return NextResponse.json({
      ok: true,
      settings: publicLlmSettings(settings),
      settingsError: error,
      mode: ops.modeInfo(),
      models: ANTHROPIC_MODELS,
      operatingMode: OPERATING_MODE,
      history: ops.llmHistory(30),
    });
  } catch (err) {
    return opsError(err);
  }
}

export async function POST(request: Request) {
  try {
    if (OPERATING_MODE === "production") {
      return errorJson(403, "demo_identity_refused", "Chế độ production chưa có danh tính doanh nghiệp (SSO) — không cho sửa cấu hình qua giao diện");
    }
    const actor = resolveIdentity(request);
    if (!actor) return errorJson(401, "identity_missing", `Cần chọn danh tính trước khi đổi cấu hình. ${identityStatus().detail}`);
    getOps().authorizeLlmConfigure(actor); // role from ops-config permissions.llmConfigure (403 otherwise)
    const body = (await request.json().catch(() => ({}))) as LlmSettingsUpdate;
    const { settings: current, error } = readSettings();
    if (error) return errorJson(500, "internal", error);
    let next, keyChanged;
    try {
      ({ next, keyChanged } = applyLlmUpdate(current, body, `${actor.userId} (${actor.source})`));
    } catch (err) {
      return errorJson(400, "invalid_input", err instanceof Error ? err.message : String(err), { field: "settings" });
    }
    saveLlmSettings(llmSettingsPath(), next);
    const mode = reloadLlmFromSettings();
    getOps().recordLlmEvent({
      kind: "config",
      actor: `${actor.userId} (${actor.source})`,
      provider: "anthropic",
      model: next.model,
      enabled: next.enabled,
      keyConfigured: !!next.apiKey,
      keyChanged,
      revision: next.revision,
      status: "saved",
      detail: `effort=${next.effort}; refusalFallback=${next.refusalFallback}; hiệu lực=${mode.effective}`,
    });
    return NextResponse.json({ ok: true, settings: publicLlmSettings(next), mode });
  } catch (err) {
    return opsError(err);
  }
}
