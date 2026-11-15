import { describe, it, expect } from "vitest";
import { vi as VI, en as EN, type Message } from "./messages";
import { translate, translateDynamic, placeholders, missingTranslations, interpolate } from "./core";
import { formatMoney, formatNumber, formatPercent, formatDateTime, formatDate, formatRelative, parseNumber } from "./format";
import { describeError, apiErrorFromBody, toApiError, ApiError } from "./errors";
import { localizedRoomName, roomNameLang, builtinRoomId } from "./rooms";
import { eventText } from "./events";
import { stepTitle, conditionTitle, roleLabel, STEP_EN, STEP_PHASE } from "./domain";
import { CATALOGS } from "./messages";

/** Interface i18n: catalog parity, formatting, error classification, room names, events. */

describe("catalog", () => {
  const viKeys = Object.keys(VI).sort();
  const enKeys = Object.keys(EN).sort();
  it("has the same keys in VI and EN (no missing translation)", () => {
    expect(enKeys).toEqual(viKeys);
  });
  it("uses the same placeholders and plural shape in both languages", () => {
    for (const k of viKeys) {
      const a = (VI as Record<string, Message>)[k];
      const b = (EN as Record<string, Message>)[k];
      expect(typeof a === "string", k).toBe(typeof b === "string");
      expect(placeholders(b), k).toEqual(placeholders(a));
    }
  });
  it("has no empty message", () => {
    for (const [k, v] of Object.entries(CATALOGS.en)) expect(typeof v === "string" ? v.trim() : v.one && v.other, k).toBeTruthy();
  });
  it("plural forms follow the locale; params are interpolated, unknown placeholders stay visible", () => {
    expect(translate("en", "time.secondsAgo", { count: 1 })).toBe("1 second ago");
    expect(translate("en", "time.secondsAgo", { count: 5 })).toBe("5 seconds ago");
    expect(translate("vi", "time.secondsAgo", { count: 1 })).toBe("1 giây trước");
    expect(interpolate("{a} {b}", { a: 1 })).toBe("1 {b}");
  });
  it("records a runtime miss and falls back to Vietnamese, never to another meaning", () => {
    missingTranslations.clear();
    expect(translateDynamic("en", "no.such.key")).toBeUndefined();
    const fake = translate("en", "x.y" as never);
    expect(fake).toBe("x.y");
    expect(missingTranslations.has("en:x.y")).toBe(true);
  });
  it("covers every workflow step (title + phase) and the glossary in both languages", () => {
    for (const k of Object.keys(STEP_PHASE)) {
      expect(STEP_EN[k], k).toBeTruthy();
      expect(translate("en", STEP_PHASE[k])).not.toBe(STEP_PHASE[k]);
    }
    for (const k of viKeys.filter((x) => x.startsWith("g."))) expect(translateDynamic("en", k)).toBeTruthy();
    // legal/operational distinctions survive translation
    expect(translate("en", "status.approved_to_send")).toMatch(/does not send/);
    expect(translate("en", "status.approved")).toMatch(/not completed/);
    expect(translate("en", "status.held")).toMatch(/not confirmed/);
  });
});

describe("formatting (locale ≠ value, business time zone)", () => {
  it("money shows the currency code explicitly; the value is identical", () => {
    const sp = (x: string) => x.replace(/\s/g, " ");
    expect(sp(formatMoney("en", 1234.56, "USD"))).toBe("USD 1,234.56");
    expect(formatMoney("vi", 1234.56, "USD").replace(/\s/g, " ")).toBe("1.234,56 USD");
    expect(sp(formatMoney("en", -1234.5, "USD"))).toMatch(/^-USD 1,234.50$|^USD -1,234.50$/);
    expect(sp(formatMoney("en", 1234.56, "VND", 0))).toBe("VND 1,235");
  });
  it("numbers and percentages", () => {
    expect(formatNumber("en", -1234.567, { maxDigits: 2 })).toBe("-1,234.57");
    expect(formatNumber("vi", -1234.567, { maxDigits: 2 })).toBe("-1.234,57");
    expect(formatPercent("en", 0.1234)).toBe("12.3%");
    expect(formatPercent("vi", 0.1234).replace(/\s/g, "")).toBe("12,3%");
    expect(formatNumber("en", null)).toBe("—");
  });
  it("an instant across New Year / midnight is shown in the business zone, the same in both languages", () => {
    const iso = "2026-12-31T17:30:00Z"; // 00:30 on 1 Jan 2027 in Asia/Ho_Chi_Minh
    expect(formatDateTime("en", iso, { year: true })).toBe("01/01/2027, 00:30:00");
    expect(formatDateTime("vi", iso, { year: true })).toMatch(/01\/01\/2027/);
    expect(formatDateTime("vi", iso, { year: true })).toMatch(/00:30:00/);
    // midnight boundary: 16:59:59Z is still the 31st locally
    expect(formatDateTime("en", "2026-12-31T16:59:59Z", { year: true })).toBe("31/12/2026, 23:59:59");
  });
  it("a calendar date never shifts a day", () => {
    expect(formatDate("en", "2026-12-31")).toBe("31/12/2026");
    expect(formatDate("vi", "2027-01-01")).toBe("01/01/2027");
  });
  it("relative time from the catalog", () => {
    expect(formatRelative("en", 0, 500)).toBe("just now");
    expect(formatRelative("en", 0, 61_000)).toBe("1 minute ago");
    expect(formatRelative("vi", 0, 30_000)).toBe("30 giây trước");
  });
  it("parsing is strict per locale: never turns 1,234 into a different value silently", () => {
    expect(parseNumber("en", "1,234.56")).toBe(1234.56);
    expect(parseNumber("vi", "1.234,56")).toBe(1234.56);
    expect(parseNumber("en", "-1,234")).toBe(-1234);
    expect(parseNumber("en", "1.234,56")).toBeNaN();
    expect(parseNumber("vi", "1,234.56")).toBeNaN();
    expect(parseNumber("en", "12,34")).toBeNaN();
    expect(parseNumber("en", "1234.5")).toBe(1234.5);
  });
});

describe("errors (B1): codes, not guesses", () => {
  it("'API service unavailable' without a code is a service problem, never a permission refusal", () => {
    const e = apiErrorFromBody(503, { error: "API service unavailable" });
    const d = describeError(e, "en");
    expect(d.summary).toBe("The service is temporarily unavailable.");
    expect(d.summary).not.toMatch(/person|permission|role|integration/i);
    expect(d.original).toBe("API service unavailable");
    // no status at all → generic, still not a permission text
    expect(describeError(new Error("service exploded"), "en").summary).toBe("Something went wrong.");
  });
  it("network failure (fetch TypeError) is reported as network", () => {
    const d = describeError(toApiError(new TypeError("Failed to fetch")), "en");
    expect(d.kind).toBe("network");
    expect(d.summary).toMatch(/Cannot reach the server/);
  });
  it("permission, person-only, stale package, non-waivable and expiry-like codes keep their meaning and params", () => {
    const role = describeError(apiErrorFromBody(403, { error: "Không có quyền …", code: "role_required", params: { roles: "Trưởng bộ phận HSE / OIM" } }), "en");
    expect(role.summary).toBe("Not permitted: requires role HSE Lead / OIM.");
    const person = describeError(apiErrorFromBody(403, { error: "…", code: "person_required" }), "en");
    expect(person.summary).toMatch(/must be done by a person/);
    const stale = describeError(apiErrorFromBody(409, { error: "Hồ sơ đã thay đổi (đang chờ duyệt: v3)", code: "package_changed", params: { version: 3 } }), "en");
    expect(stale.summary).toBe("The package changed (awaiting decision: v3) — reload to see the new version.");
    const nw = describeError(apiErrorFromBody(409, { error: "Không thể duyệt: …", code: "non_waivable_unmet", params: { conditions: "Vị trí tàu…", conditionCodes: "transport_booked" } }), "en");
    expect(nw.summary).toBe("Cannot approve: a non-waivable condition is not met — Vessel/flight places of the plan in force confirmed by the operator.");
    const rev = describeError(apiErrorFromBody(409, { error: "…", code: "revision_moved", params: { caseNo: "C-1", current: 4, sent: 3 } }), "en");
    expect(rev.summary).toMatch(/moved to rev 4 .*rev 3/);
    const provider = describeError(apiErrorFromBody(502, { error: "overloaded", code: "translation_failed" }), "en");
    expect(provider.summary).toMatch(/Translation failed/);
  });
  it("Vietnamese shows the server's own text for coded errors; request ID kept for support", () => {
    const e = apiErrorFromBody(409, { error: "Hồ sơ đã thay đổi (đang chờ duyệt: v3) — tải lại", code: "package_changed", params: { version: 3 }, requestId: "req_1" });
    const d = describeError(e, "vi");
    expect(d.summary).toBe("Hồ sơ đã thay đổi (đang chờ duyệt: v3) — tải lại");
    expect(d.requestId).toBe("req_1");
    expect(d.code).toBe("package_changed");
  });
  it("rejects malformed codes from a body", () => {
    expect(apiErrorFromBody(400, { error: "x", code: "DROP TABLE" }).code).toBeUndefined();
    expect(new ApiError("http", "x", 400).isApiError).toBe(true);
  });
});

describe("room names (B4/B5)", () => {
  const ops = { label: "Finance · zone_finance", displayName: "Tài chính" };
  it("built-in rooms follow the language; the technical label is never altered", () => {
    expect(localizedRoomName(ops, "en")).toBe("Finance");
    expect(localizedRoomName(ops, "vi")).toBe("Tài chính");
    expect(ops.label).toBe("Finance · zone_finance");
    expect(builtinRoomId({ label: "Hành lang trung tâm" })).toBe("corridor");
    expect(localizedRoomName({ label: "Hành lang trung tâm", displayName: "Hành lang trung tâm" }, "en")).toBe("Central Corridor");
  });
  it("a custom room keeps the name the user gave (B5 probe), in every language", () => {
    const custom = { label: "custom-room-42", displayName: "Reservoir Studies" };
    expect(localizedRoomName(custom, "en")).toBe("Reservoir Studies");
    expect(localizedRoomName(custom, "vi")).toBe("Reservoir Studies");
    expect(roomNameLang(custom, "en")).toBeUndefined();
  });
  it("a renamed built-in room keeps the user's name; explicit localized names win", () => {
    expect(localizedRoomName({ label: "Finance · zone_finance", displayName: "Phòng Tài chính Kế toán" }, "en")).toBe("Phòng Tài chính Kế toán");
    expect(localizedRoomName({ label: "Lab", displayName: "Phòng thí nghiệm", displayNames: { en: "Laboratory" } }, "en")).toBe("Laboratory");
    expect(localizedRoomName({ label: "Operations · zone_ops" }, "en")).toBe("Operations");
    expect(localizedRoomName({ label: "Meeting Room" }, "vi")).toBe("Meeting Room");
  });
});

describe("domain vocabularies and events", () => {
  it("roles/steps/conditions are display labels only; unknown codes fall back to the server text", () => {
    expect(roleLabel("Trưởng bộ phận HSE", "en")).toBe("HSE Lead");
    expect(roleLabel("Trưởng bộ phận HSE", "vi")).toBe("Trưởng bộ phận HSE");
    expect(roleLabel("Vai trò mới", "en")).toBe("Vai trò mới");
    expect(stepTitle("gate.asset", "Phê duyệt cam kết", "en")).toMatch(/Commitment approval/);
    expect(stepTitle("x.unknown", "Bước mới", "en")).toBe("Bước mới");
    expect(conditionTitle({ code: "weather_in_limits", label: "Thời tiết…" }, "en")).toMatch(/Weather forecast/);
  });
  it("event messages render step/decision/wait codes per language; unknown key → undefined (caller shows the original)", () => {
    expect(eventText({ key: "ev.task.started", params: { step: "log.plan", attempt: 2, rev: 3 } }, "en")).toBe('started "Logistics needs & plan" (attempt 2, rev 3)');
    expect(eventText({ key: "ev.decision", params: { actor: "A", role: "OIM", decision: "request_changes", version: 2, step: "gate.readiness" } }, "en")).toMatch(/Request changes package v2/);
    expect(eventText({ key: "ev.attn.waiting", params: { step: "hse.readiness", wait: "date" } }, "en")).toMatch(/Waiting for the execution date/);
    expect(eventText({ key: "ev.generic", params: { agent: "codex", activity: "working", room: "Phòng họp", room_en: "Meeting" } }, "en")).toBe("codex working in Meeting");
    expect(eventText({ key: "ev.generic", params: { agent: "codex", activity: "working", room: "Phòng họp", room_en: "Meeting" } }, "vi")).toBe("codex đang làm việc ở Phòng họp");
    expect(eventText({ key: "ev.nope" }, "en")).toBeUndefined();
  });
});
