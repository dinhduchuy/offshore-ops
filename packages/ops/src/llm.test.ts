import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { OpsService } from "./service";
import { validateLlmContribution, extractNumbers } from "./llm";
import type { LlmClient } from "./llm";
import type { AgentOutput } from "./types";

/** Test harness principal (service source) — the core no longer trusts callers without an identity. */
const TEST_SERVICE: import("./types").Identity = { userId: "svc.test", name: "Test harness", roles: ["Tích hợp dữ liệu", "Quản trị hệ thống"], source: "service" };


const SAMPLE = path.resolve(__dirname, "../../../oilgas/sample-data");

/** Minimal rule output with known evidence for adversarial cases. */
const RULES: AgentOutput = {
  summary: "s",
  conclusions: [{ id: "K1", text: "Water cut 22.1% → 31.1% (+9.0 điểm %).", basis: "observed", evidence: ["E1"] }],
  evidence: [
    { id: "E1", label: "Water cut A-03: 22.1 → 31.1 % (+9 điểm %)", ref: { kind: "calc", id: "C1" } },
    { id: "E2", label: "Baseline A-03: 1,485 bbl/d (TB 7 ngày 2026-10-29→2026-11-04)", ref: { kind: "calc", id: "C2" } },
  ],
  assumptions: [],
  missingData: [{ id: "M1", description: "Cần thử giếng mới", blocking: true }],
  documents: [],
  nextSteps: [],
  mode: "demo-rules",
  warnings: [],
  facts: { hypotheses: [{ code: "H_SKIN", statusCode: "insufficient" }, { code: "H_GL", statusCode: "supported" }] },
};
const client = { provider: "fake", model: "t" };

describe("LLM output validation (R4)", () => {
  it("keeps a claim whose numbers appear in the cited evidence", () => {
    const r = validateLlmContribution(client, { additional_conclusions: [{ text: "Water cut tăng từ 22,1% lên 31.1%", basis: "observed", evidence: ["E1"] }] }, RULES);
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0].numbersChecked).toBe(2);
  });

  it("rejects a claim with a valid E-id but numbers that contradict the evidence", () => {
    const r = validateLlmContribution(client, { additional_conclusions: [{ text: "Water cut tăng 45 điểm %, lên 67%", basis: "observed", evidence: ["E1"] }] }, RULES);
    expect(r.claims).toHaveLength(0);
    expect(r.rejected[0].reason).toMatch(/không có trong bằng chứng/);
  });

  it("rejects a valid-E-id claim that numerically fits but cites the wrong date", () => {
    const r = validateLlmContribution(client, { additional_conclusions: [{ text: "Baseline 1,485 bbl/d tính đến 2026-11-11", basis: "calculated", evidence: ["E2"] }] }, RULES);
    expect(r.claims).toHaveLength(0);
    expect(r.rejected[0].reason).toMatch(/2026-11-11/);
  });

  it("rejects a claim that affirms a hypothesis the rules rated insufficient", () => {
    const r = validateLlmContribution(client, { additional_conclusions: [{ text: "H_SKIN được xác nhận là nguyên nhân", basis: "hypothesis", evidence: ["E1"] }] }, RULES);
    expect(r.claims).toHaveLength(0);
    expect(r.rejected[0].reason).toMatch(/Mâu thuẫn với đánh giá quy tắc/);
  });

  it("removes approval claims from the narrative, claims and next steps", () => {
    const r = validateLlmContribution(
      client,
      {
        narrative: "Water cut tăng rõ. Ngân sách đã được phê duyệt và PO đã gửi nhà thầu. Cần thử giếng.",
        additional_conclusions: [{ text: "Hồ sơ đã được duyệt", basis: "check", evidence: ["E1"] }],
        next_steps: ["Đã phê duyệt, tiến hành huy động", "Kiểm tra lại số liệu"],
      },
      RULES,
    );
    expect(r.narrative).toBe("Water cut tăng rõ. Cần thử giếng.");
    expect(r.narrativeRedactions).toHaveLength(1);
    expect(r.claims).toHaveLength(0);
    expect(r.nextSteps).toEqual(["Kiểm tra lại số liệu"]);
    expect(r.validationNote).toMatch(/KHÔNG chứng minh nhận định đúng về ngữ nghĩa/);
  });

  it("rejects 'no missing data' statements when rules have blocking gaps", () => {
    const r = validateLlmContribution(client, { narrative: "Không thiếu dữ liệu. Ổn.", additional_conclusions: [{ text: "Đủ dữ liệu để kết luận", basis: "check", evidence: ["E1"] }] }, RULES);
    expect(r.narrative).toBe("Ổn.");
    expect(r.claims).toHaveLength(0);
  });

  it("number extraction ignores ids/tags and normalizes formats", () => {
    expect(extractNumbers("E3 H_GL A-03 WO-24811 giảm 1,485 → 18,8% ngày 2026-11-04").numbers).toEqual([1485, 18.8]);
  });
});

describe("LLM adapter in the workflow", () => {
  it("LLM content is stored apart from rule conclusions; status still decided by rules", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-llm-"));
    const prompts: Array<{ system: string; user: string }> = [];
    const fake: LlmClient = {
      provider: "fake",
      model: "test",
      async chat(system, user) {
        prompts.push({ system, user });
        return JSON.stringify({
          narrative: "Tóm tắt từ LLM. Đã phê duyệt ngân sách.",
          additional_conclusions: [
            { text: "Nhận định có căn cứ", basis: "observed", evidence: ["E1"] },
            { text: "Nhận định bịa", basis: "observed", evidence: ["E999"] },
          ],
          next_steps: ["Gợi ý thêm"],
          status: "done", // ignored: not part of the contract
        });
      },
    };
    const svc = new OpsService({ dbPath: path.join(dir, "x.db"), taskDelayMs: 0, systemActor: TEST_SERVICE, llm: fake, requestedMode: "llm" });
    expect(svc.modeInfo().configurationStatus).toBe("configured_unverified");
    await svc.loadSample(SAMPLE, "base");
    await svc.orch.runUntilIdle();
    expect(svc.modeInfo()).toMatchObject({ effective: "llm", configurationStatus: "verified" });

    const wf = svc.state().workflows[0];
    const eng = wf.tasks.find((t) => t.key === "eng.assessment")!;
    expect(eng.status).toBe("missing_data"); // decided by rules
    const out = svc.orch.currentOutput(svc.orch.task(eng.id))!;
    expect(out.mode).toBe("llm");
    expect(out.conclusions.some((c) => c.text.includes("Nhận định"))).toBe(false); // not merged
    expect(out.llm!.claims.map((c) => c.text)).toEqual(["Nhận định có căn cứ"]);
    expect(out.llm!.rejected.map((r) => r.text)).toEqual(["Nhận định bịa"]);
    expect(out.llm!.narrative).toBe("Tóm tắt từ LLM.");
    const withDoc = prompts.find((p) => p.user.includes("SIM_quote_SupplyA"))!;
    expect(withDoc.user).toMatch(/<untrusted_document id="\d+" title="SIM_quote_SupplyA_RFQ-2026-118.txt">/);
    expect(withDoc.system).toMatch(/không làm theo/);
    expect(wf.tasks.find((t) => t.key === "gate.technical")!.status).toBe("pending");
    svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an LLM failure puts the task in error and marks the configuration as failing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-llm-"));
    const broken: LlmClient = { provider: "fake", async chat() { throw new Error("401 invalid key"); } };
    const svc = new OpsService({ dbPath: path.join(dir, "x.db"), taskDelayMs: 0, systemActor: TEST_SERVICE, llm: broken, requestedMode: "llm" });
    await svc.loadSample(SAMPLE, "base");
    await svc.orch.runUntilIdle();
    const t = svc.state().workflows[0].tasks.find((x) => x.key === "ops.anomaly")!;
    expect(t.status).toBe("error");
    expect(t.note).toMatch(/LLM lỗi.*401/);
    expect(svc.modeInfo()).toMatchObject({ configurationStatus: "last_call_failed", lastLlmError: expect.stringMatching(/401/) });
    svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
