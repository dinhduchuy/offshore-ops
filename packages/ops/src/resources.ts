import type { Database } from "./db";
import { nowIso, num, sha256, tx } from "./db";
import { addHoursIso, now } from "./clock";

/**
 * Shared-resource ledger (budget, vessel deck space, helicopter seats).
 *
 *            hold()                         person records external ref
 *   (none) ─────────► held ───────────────────────────────► confirmed ──(execution done)──► consumed
 *                      │  │ time passes (expires_at)            │
 *                      │  └──────────────► expired              │ plan needs other content
 *                      │                                        ▼
 *                      │ plan dropped                 amendment row "held" (amendment_of = confirmed)
 *                      ▼                                        │ person confirms amended booking
 *                   released                                    ▼
 *                                                   new row confirmed; old row → superseded
 *   confirmed ──(plan dropped / case closed)──► cancel_requested ──(person records cancellation)──► cancelled
 *
 * Capacity: held, confirmed, cancel_requested and consumed rows occupy capacity.
 * A booking and its pending amendment are ONE chain and count once (max of the two),
 * so amending 10 → 70 needs 70, not 80. A confirmed booking is never edited in place,
 * never auto-cancelled, and never frees capacity until a person records the cancellation.
 * All writes run inside BEGIN IMMEDIATE (single writer) — check and write cannot interleave.
 *
 * Expiry boundary: a hold is valid strictly BEFORE expires_at; at expires_at it has expired
 * (every check uses `expires_at <= now`).
 * Every transition is written to reservation_events (with revision, content hash and, for
 * person actions, the idempotency key) — the evidence for carry-forward and audits.
 */

export type ResourceType = "budget" | "vessel_deck" | "flight_seats";

export interface HoldResult {
  status: "held" | "conflict";
  id: number | null;
  /** Capacity occupied by OTHER cases */
  heldByOthers: number;
  /** capacity − everything else occupying it (null when capacity unknown) */
  availableToCase: number | null;
  conflicts: Array<{ workflowId: number; caseNo: string; quantity: number; status: string }>;
}

export class ResourceError extends Error {
  readonly isOpsError = true;
  constructor(public status: number, message: string) {
    super(message);
    this.name = "OpsError";
  }
}

const OCCUPYING = ["held", "confirmed", "cancel_requested", "consumed"];

/** expires_at is the first instant the hold is no longer valid. */
export function isExpiredAt(expiresAt: unknown, at: string = now().toISOString()): boolean {
  return expiresAt !== null && expiresAt !== undefined && expiresAt !== "" && String(expiresAt) <= at;
}

/** Content a booking confirmation is about (independent of the revision that requested it). */
export function bookingContentSha(c: { type: string; key: string; quantity: number; unit: string; workflowId: number }): string {
  return sha256(JSON.stringify([c.type, c.key, Number(c.quantity), c.unit, Number(c.workflowId)]));
}

export function logReservationEvent(
  db: Database,
  e: { reservationId: number; workflowId: number; kind: string; from?: number | null; to?: number | null; contentSha?: string | null; actor?: string | null; idempotencyKey?: string | null; requestHash?: string | null; detail?: Record<string, unknown> },
): void {
  db.prepare(
    `INSERT INTO reservation_events (reservation_id, workflow_id, ts, kind, from_revision, to_revision, content_sha, actor, idempotency_key, request_hash, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.reservationId, e.workflowId, nowIso(), e.kind, e.from ?? null, e.to ?? null, e.contentSha ?? null, e.actor ?? null, e.idempotencyKey ?? null, e.requestHash ?? null, JSON.stringify(e.detail ?? {}));
}
const shaOfRow = (r: Record<string, unknown>) => bookingContentSha({ type: String(r.resource_type), key: String(r.resource_key), quantity: Number(r.quantity), unit: String(r.unit), workflowId: num(r.workflow_id) });
const OCC_SQL = `(${OCCUPYING.map((s) => `'${s}'`).join(",")})`;

interface Row {
  id: number;
  workflow_id: number;
  case_no: string;
  quantity: number;
  status: string;
  amendment_of: number | null;
}

/** Mark holds past their expiry. Every check below also tests expiry directly (no reliance on this having run). */
export function expireHolds(db: Database): number {
  const t = now().toISOString();
  const rows = db.prepare("SELECT id, workflow_id, case_revision, expires_at FROM reservations WHERE status = 'held' AND expires_at IS NOT NULL AND expires_at <= ?").all(t);
  for (const r of rows) {
    db.prepare("UPDATE reservations SET status = 'expired', released_at = ?, release_reason = 'Hết hạn giữ chỗ (policy.holdDays)', updated_at = ? WHERE id = ? AND status = 'held'").run(nowIso(), nowIso(), num(r.id));
    logReservationEvent(db, { reservationId: num(r.id), workflowId: num(r.workflow_id), kind: "expire", from: num(r.case_revision), detail: { expiresAt: r.expires_at } });
  }
  return rows.length;
}

function occupyingRows(db: Database, type: ResourceType, key: string): Row[] {
  return db
    .prepare(
      `SELECT r.id, r.workflow_id, w.case_no, r.quantity, r.status, r.amendment_of FROM reservations r JOIN workflows w ON w.id = r.workflow_id
        WHERE r.resource_type = ? AND r.resource_key = ? AND r.status IN ${OCC_SQL} AND NOT (r.status = 'held' AND r.expires_at IS NOT NULL AND r.expires_at <= ?)`,
    )
    .all(type, key, now().toISOString())
    .map((r) => ({ id: num(r.id), workflow_id: num(r.workflow_id), case_no: String(r.case_no), quantity: Number(r.quantity), status: String(r.status), amendment_of: r.amendment_of === null ? null : num(r.amendment_of) }));
}

function rootOf(db: Database, id: number): number {
  let cur = id;
  for (let i = 0; i < 50; i++) {
    const r = db.prepare("SELECT amendment_of FROM reservations WHERE id = ?").get(cur);
    if (!r || r.amendment_of === null || r.amendment_of === undefined) return cur;
    cur = num(r.amendment_of);
  }
  return cur;
}

/** Group occupying rows by booking chain; each chain counts its largest quantity. */
function chains(db: Database, rows: Row[]): Map<number, Row[]> {
  const out = new Map<number, Row[]>();
  for (const r of rows) {
    const root = rootOf(db, r.id);
    if (!out.has(root)) out.set(root, []);
    out.get(root)!.push(r);
  }
  return out;
}
const chainQty = (rs: Row[]) => Math.max(0, ...rs.map((r) => r.quantity));

/** Capacity occupied on a resource (optionally excluding one case). */
export function resourceUsage(db: Database, type: ResourceType, key: string, excludeWorkflowId?: number): number {
  let total = 0;
  for (const rs of chains(db, occupyingRows(db, type, key)).values()) {
    if (excludeWorkflowId !== undefined && rs[0].workflow_id === excludeWorkflowId) continue;
    total += chainQty(rs);
  }
  return total;
}

export function othersOn(db: Database, type: ResourceType, key: string, workflowId: number): HoldResult["conflicts"] {
  const out: HoldResult["conflicts"] = [];
  for (const rs of chains(db, occupyingRows(db, type, key)).values()) {
    if (rs[0].workflow_id === workflowId) continue;
    out.push({ workflowId: rs[0].workflow_id, caseNo: rs[0].case_no, quantity: chainQty(rs), status: rs.map((r) => r.status).join("+") });
  }
  return out;
}

/** Read-only: how much of a resource other cases occupy (used to choose among options before holding). */
export function heldByOthers(db: Database, type: ResourceType, key: string, workflowId: number): { qty: number; conflicts: HoldResult["conflicts"] } {
  const c = othersOn(db, type, key, workflowId);
  return { qty: c.reduce((s, x) => s + x.quantity, 0), conflicts: c };
}

export function hold(
  db: Database,
  p: { workflowId: number; revision: number; type: ResourceType; key: string; quantity: number; unit: string; capacity: number | null; taskId: number | null; holdDays: number },
): HoldResult {
  return tx(db, () => {
    expireHolds(db);
    const base = `${p.type}:${p.key}:WF${p.workflowId}`;
    const cur = db
      .prepare(`SELECT * FROM reservations WHERE workflow_id = ? AND resource_type = ? AND resource_key = ? AND status IN ('held','confirmed','cancel_requested') ORDER BY id DESC LIMIT 1`)
      .get(p.workflowId, p.type, p.key);
    const all = chains(db, occupyingRows(db, p.type, p.key));
    const target = cur && (cur.status === "held" || cur.status === "confirmed") ? rootOf(db, num(cur.id)) : null;
    let otherUsage = 0;
    const conflicts: HoldResult["conflicts"] = [];
    for (const [root, rs] of all) {
      if (root === target) continue;
      otherUsage += chainQty(rs);
      if (rs[0].workflow_id !== p.workflowId) conflicts.push({ workflowId: rs[0].workflow_id, caseNo: rs[0].case_no, quantity: chainQty(rs), status: rs.map((r) => r.status).join("+") });
    }
    const targetRows = target !== null ? (all.get(target) ?? []) : [];
    const sameContent = cur && cur.status === "confirmed" && Number(cur.quantity) === p.quantity && String(cur.unit) === p.unit;
    const targetUsage = sameContent
      ? p.quantity
      : Math.max(p.quantity, ...targetRows.filter((r) => !(cur && r.id === num(cur.id) && cur.status === "held")).map((r) => r.quantity));
    const availableToCase = p.capacity === null ? null : p.capacity - otherUsage;
    const heldOthers = conflicts.reduce((s, x) => s + x.quantity, 0);
    if (availableToCase !== null && targetUsage > availableToCase + 1e-9) {
      if (cur && cur.status === "held") {
        db.prepare(`UPDATE reservations SET status = 'released', released_at = ?, release_reason = ?, updated_at = ? WHERE id = ?`).run(
          nowIso(),
          `Không đủ: cần ${p.quantity} ${p.unit}, còn ${availableToCase} sau phần đã chiếm`,
          nowIso(),
          num(cur.id),
        );
      }
      return { status: "conflict", id: null, heldByOthers: heldOthers, availableToCase, conflicts };
    }
    const exp = addHoursIso(p.holdDays * 24);
    if (sameContent) {
      // The confirmed booking already covers exactly this content: it is carried forward into
      // the plan of this revision (mapping + evidence), never edited or re-counted
      if (num(cur!.case_revision) !== p.revision) {
        db.prepare("UPDATE reservations SET case_revision = ?, updated_at = ? WHERE id = ?").run(p.revision, nowIso(), num(cur!.id));
        logReservationEvent(db, {
          reservationId: num(cur!.id), workflowId: p.workflowId, kind: "carry_forward", from: num(cur!.case_revision), to: p.revision, contentSha: shaOfRow(cur!),
          detail: { reason: "Kế hoạch lập lại cần đúng nội dung đã xác nhận", sourceTaskId: p.taskId, externalRef: cur!.external_ref },
        });
      }
      return { status: "held", id: num(cur!.id), heldByOthers: heldOthers, availableToCase, conflicts };
    }
    if (cur && cur.status === "held") {
      // Internal hold (or a pending amendment): no external commitment yet → may be adjusted in place
      db.prepare(`UPDATE reservations SET quantity = ?, unit = ?, capacity = ?, case_revision = ?, source_task_id = ?, expires_at = ?, updated_at = ? WHERE id = ?`).run(
        p.quantity,
        p.unit,
        p.capacity,
        p.revision,
        p.taskId,
        exp,
        nowIso(),
        num(cur.id),
      );
      if (num(cur.case_revision) !== p.revision || Number(cur.quantity) !== p.quantity) {
        logReservationEvent(db, { reservationId: num(cur.id), workflowId: p.workflowId, kind: "update", from: num(cur.case_revision), to: p.revision, contentSha: bookingContentSha({ type: p.type, key: p.key, quantity: p.quantity, unit: p.unit, workflowId: p.workflowId }), detail: { quantity: p.quantity, previous: Number(cur.quantity), sourceTaskId: p.taskId } });
      }
      return { status: "held", id: num(cur.id), heldByOthers: heldOthers, availableToCase, conflicts };
    }
    // New hold, or an amendment of a confirmed booking (the confirmed row is never edited)
    const amendmentOf = cur && cur.status === "confirmed" ? num(cur.id) : null;
    const bk = amendmentOf ? `${base}#amend${amendmentOf}` : db.prepare("SELECT 1 FROM reservations WHERE business_key = ?").get(base) ? `${base}#${nowIso()}` : base;
    const r = db
      .prepare(
        `INSERT INTO reservations (workflow_id, case_revision, resource_type, resource_key, quantity, unit, capacity, status, business_key, source_task_id, created_at, updated_at, expires_at, amendment_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.workflowId, p.revision, p.type, p.key, p.quantity, p.unit, p.capacity, bk, p.taskId, nowIso(), nowIso(), exp, amendmentOf);
    logReservationEvent(db, {
      reservationId: num(r.lastInsertRowid), workflowId: p.workflowId, kind: amendmentOf ? "amend" : "hold", to: p.revision,
      contentSha: bookingContentSha({ type: p.type, key: p.key, quantity: p.quantity, unit: p.unit, workflowId: p.workflowId }),
      detail: { quantity: p.quantity, unit: p.unit, amendmentOf, sourceTaskId: p.taskId, expiresAt: exp },
    });
    if (amendmentOf) {
      db.prepare("UPDATE reservations SET change_note = ?, updated_at = ? WHERE id = ?").run(
        `Kế hoạch rev ${p.revision} cần ${p.quantity} ${p.unit} (đã xác nhận ${cur!.confirmed_quantity ?? cur!.quantity} ${cur!.unit}) — chờ bên ngoài xác nhận bản sửa #${num(r.lastInsertRowid)}`,
        nowIso(),
        amendmentOf,
      );
    }
    return { status: "held", id: num(r.lastInsertRowid), heldByOthers: heldOthers, availableToCase, conflicts };
  });
}

function dropRows(db: Database, where: string, args: unknown[], reason: string): number {
  let n = 0;
  for (const r of db.prepare(`SELECT id, status, workflow_id, case_revision FROM reservations WHERE ${where} AND status IN ('held','confirmed')`).all(...args)) {
    if (r.status === "held") db.prepare("UPDATE reservations SET status = 'released', released_at = ?, release_reason = ?, updated_at = ? WHERE id = ?").run(nowIso(), reason, nowIso(), num(r.id));
    // A confirmed booking is NOT cancelled by changing an internal plan: a cancellation must be requested and recorded
    else db.prepare("UPDATE reservations SET status = 'cancel_requested', change_note = ?, updated_at = ? WHERE id = ?").run(`Yêu cầu hủy với bên ngoài: ${reason}`, nowIso(), num(r.id));
    logReservationEvent(db, { reservationId: num(r.id), workflowId: num(r.workflow_id), kind: r.status === "held" ? "release" : "cancel_request", from: num(r.case_revision), detail: { reason } });
    n++;
  }
  return n;
}

/** This case's plan no longer needs these keys of a type (plan changed). */
export function releaseOtherKeys(db: Database, workflowId: number, type: ResourceType, keep: string[], reason: string): number {
  return tx(db, () => {
    const keys = keep.length ? ` AND resource_key NOT IN (${keep.map(() => "?").join(",")})` : "";
    return dropRows(db, `workflow_id = ? AND resource_type = ?${keys}`, [workflowId, type, ...keep], reason);
  });
}

export function releaseCase(db: Database, workflowId: number, reason: string): number {
  return dropRows(db, "workflow_id = ?", [workflowId], reason);
}

export function contentSha(row: Record<string, unknown>): string {
  return shaOfRow(row);
}

/**
 * A person records that the external owner confirmed EXACTLY this content
 * (resource, quantity, case revision) under an external reference.
 * Checked at the time of the action, in a transaction: idempotency, expiry, current
 * revision (carry-forward only when the plan in force is shown to need the same content),
 * content, unique reference.
 */
export function confirmExternal(
  db: Database,
  p: {
    id: number;
    externalRef: string;
    quantity: number;
    revision: number;
    actor: string;
    idempotencyKey?: string;
    requestHash?: string;
    /** Called inside the transaction when the hold was placed at an earlier revision: return the evidence that the plan in force needs this content, or a reason it does not */
    carryForward?: (row: Record<string, unknown>) => { ok: true; evidence: Record<string, unknown> } | { ok: false; reason: string };
  },
): { duplicate: boolean } {
  // Expiry is a fact of time: record it first (own write), then decide inside the transaction
  expireHolds(db);
  return tx(db, () => {
    if (p.idempotencyKey) {
      const prev = db.prepare("SELECT reservation_id, request_hash FROM reservation_events WHERE idempotency_key = ?").get(p.idempotencyKey);
      if (prev) {
        if (prev.request_hash === p.requestHash && num(prev.reservation_id) === p.id) return { duplicate: true };
        throw new ResourceError(409, "idempotencyKey đã được dùng cho một yêu cầu khác — không ghi xác nhận");
      }
    }
    const row = db.prepare("SELECT * FROM reservations WHERE id = ?").get(p.id);
    if (!row) throw new ResourceError(404, `Không có giữ chỗ #${p.id}`);
    if (row.status === "confirmed" && row.external_ref === p.externalRef && Number(row.confirmed_quantity) === p.quantity && num(row.confirmed_revision) === p.revision) return { duplicate: true };
    // Checked directly against the clock too — never relies on a previous poll
    if ((row.status === "held" && isExpiredAt(row.expires_at)) || row.status === "expired") {
      throw new ResourceError(409, `Giữ chỗ #${p.id} (${row.resource_key}) đã hết hạn lúc ${row.expires_at} — không xác nhận được; lập lại kế hoạch để giữ chỗ mới`);
    }
    if (row.status !== "held") throw new ResourceError(409, `Chỉ xác nhận được chỗ đang giữ (hiện: ${row.status})`);
    if (Number(row.quantity) !== p.quantity) {
      throw new ResourceError(409, `Nội dung đã đổi: giữ chỗ hiện là ${row.quantity} ${row.unit} ở case rev ${row.case_revision} (xác nhận gửi ${p.quantity} ở rev ${p.revision}) — tải lại và xác nhận đúng nội dung`);
    }
    if (num(row.case_revision) !== p.revision) {
      // Hold placed at an earlier revision: only valid if the plan in force still needs this exact content
      const cf = p.carryForward ? p.carryForward(row) : { ok: false as const, reason: "không có kế hoạch hiện hành để đối chiếu" };
      if (!cf.ok) throw new ResourceError(409, `Giữ chỗ #${p.id} lập ở rev ${row.case_revision}, case đang ở rev ${p.revision}: ${cf.reason} — không xác nhận; chờ lập lại kế hoạch`);
      db.prepare("UPDATE reservations SET case_revision = ?, updated_at = ? WHERE id = ?").run(p.revision, nowIso(), p.id);
      logReservationEvent(db, { reservationId: p.id, workflowId: num(row.workflow_id), kind: "carry_forward", from: num(row.case_revision), to: p.revision, contentSha: shaOfRow(row), actor: p.actor, detail: { reason: "Đối chiếu khi xác nhận: kế hoạch hiện hành cần đúng nội dung này", ...cf.evidence } });
    }
    const reused = db
      .prepare(`SELECT id, resource_key, status FROM reservations WHERE resource_type = ? AND external_ref = ? AND id != ? AND status IN ('confirmed','consumed','cancel_requested','superseded')`)
      .get(row.resource_type, p.externalRef, p.id);
    if (reused) throw new ResourceError(409, `Mã xác nhận ${p.externalRef} đã gắn với giữ chỗ #${reused.id} (${reused.resource_key}, ${reused.status}) — không dùng lại cho nội dung khác (tránh đếm trùng)`);
    const sha = shaOfRow(row);
    db.prepare(
      `UPDATE reservations SET status = 'confirmed', external_ref = ?, confirmed_by = ?, confirmed_quantity = ?, confirmed_revision = ?, confirmed_sha = ?, confirmed_at = ?, expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'held'`,
    ).run(p.externalRef, p.actor, p.quantity, p.revision, sha, nowIso(), nowIso(), p.id);
    logReservationEvent(db, { reservationId: p.id, workflowId: num(row.workflow_id), kind: "confirm", to: p.revision, contentSha: sha, actor: p.actor, idempotencyKey: p.idempotencyKey ?? null, requestHash: p.requestHash ?? null, detail: { externalRef: p.externalRef, quantity: p.quantity } });
    if (row.amendment_of !== null && row.amendment_of !== undefined) {
      const ch = db.prepare("UPDATE reservations SET status = 'superseded', change_note = ?, updated_at = ? WHERE id = ? AND status IN ('confirmed','cancel_requested')").run(
        `Thay bằng bản sửa #${p.id} (${p.externalRef}) đã được xác nhận`,
        nowIso(),
        num(row.amendment_of),
      );
      if (num(ch.changes)) logReservationEvent(db, { reservationId: num(row.amendment_of), workflowId: num(row.workflow_id), kind: "supersede", to: p.revision, actor: p.actor, detail: { by: p.id, externalRef: p.externalRef } });
    }
    return { duplicate: false };
  });
}

/** A person records that the external owner cancelled the booking (frees capacity). Retry-safe. */
export function cancelExternal(db: Database, p: { id: number; externalRef: string; actor: string; idempotencyKey?: string; requestHash?: string }): { duplicate: boolean; row: Record<string, unknown> } {
  return tx(db, () => {
    if (p.idempotencyKey) {
      const prev = db.prepare("SELECT reservation_id, request_hash FROM reservation_events WHERE idempotency_key = ?").get(p.idempotencyKey);
      if (prev) {
        if (prev.request_hash === p.requestHash && num(prev.reservation_id) === p.id) return { duplicate: true, row: db.prepare("SELECT * FROM reservations WHERE id = ?").get(p.id)! };
        throw new ResourceError(409, "idempotencyKey đã được dùng cho một yêu cầu khác — không ghi hủy");
      }
    }
    const row = db.prepare("SELECT * FROM reservations WHERE id = ?").get(p.id);
    if (!row) throw new ResourceError(404, `Không có giữ chỗ #${p.id}`);
    if (row.status === "cancelled" && row.cancel_ref === p.externalRef) return { duplicate: true, row };
    if (row.status !== "confirmed" && row.status !== "cancel_requested") throw new ResourceError(409, `Chỉ ghi nhận hủy cho chỗ đã xác nhận (hiện: ${row.status})`);
    db.prepare("UPDATE reservations SET status = 'cancelled', cancel_ref = ?, cancelled_by = ?, cancelled_at = ?, updated_at = ? WHERE id = ?").run(p.externalRef, p.actor, nowIso(), nowIso(), p.id);
    logReservationEvent(db, { reservationId: p.id, workflowId: num(row.workflow_id), kind: "cancel", from: num(row.case_revision), contentSha: shaOfRow(row), actor: p.actor, idempotencyKey: p.idempotencyKey ?? null, requestHash: p.requestHash ?? null, detail: { cancelRef: p.externalRef, externalRef: row.external_ref } });
    return { duplicate: false, row };
  });
}

/** Execution done: confirmed bookings of the case were used. */
export function consumeCase(db: Database, workflowId: number): number {
  const rows = db.prepare("SELECT id, case_revision FROM reservations WHERE workflow_id = ? AND status = 'confirmed'").all(workflowId);
  for (const r of rows) {
    db.prepare("UPDATE reservations SET status = 'consumed', updated_at = ? WHERE id = ?").run(nowIso(), num(r.id));
    logReservationEvent(db, { reservationId: num(r.id), workflowId, kind: "consume", from: num(r.case_revision) });
  }
  return rows.length;
}

// ───────────────────────── plan in force vs. ledger ─────────────────────────

/** One resource the plan in force needs (from the current run of log.plan / fin.check). */
export interface PlanDemand {
  type: ResourceType;
  key: string;
  qty: number;
  unit: string;
  /** Step whose plan needs it (re-planned when the resource no longer stands) */
  step: "log.plan" | "fin.check";
  runId: number;
  /** Date the resource is used (voyage departure / flight date), if any */
  date?: string | null;
}

export type CoverageState = "confirmed" | "held" | "amendment_pending" | "cancel_requested" | "cancelled" | "released" | "expired" | "superseded" | "mismatch" | "missing";

const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/**
 * How the ledger covers one demand of the plan in force. Only this case's rows for this
 * resource key are considered; history that the plan no longer needs is never looked at.
 */
export function coverage(db: Database, workflowId: number, d: PlanDemand, at: string = now().toISOString()): { state: CoverageState; row: Record<string, unknown> | null } {
  const rows = db.prepare("SELECT * FROM reservations WHERE workflow_id = ? AND resource_type = ? AND resource_key = ? ORDER BY id DESC").all(workflowId, d.type, d.key);
  const live = rows.filter((r) => r.status === "confirmed" || r.status === "cancel_requested" || (r.status === "held" && !isExpiredAt(r.expires_at, at)));
  const conf = live.find((r) => r.status === "confirmed" && eq(Number(r.confirmed_quantity ?? r.quantity), d.qty) && String(r.unit) === d.unit);
  if (conf) return { state: "confirmed", row: conf };
  const held = live.find((r) => r.status === "held" && eq(Number(r.quantity), d.qty) && String(r.unit) === d.unit);
  if (held) return { state: held.amendment_of !== null && held.amendment_of !== undefined ? "amendment_pending" : "held", row: held };
  const cr = live.find((r) => r.status === "cancel_requested");
  if (cr) return { state: "cancel_requested", row: cr };
  if (live.length) return { state: "mismatch", row: live[0] };
  const last = rows[0];
  if (!last) return { state: "missing", row: null };
  const st = String(last.status);
  if (st === "held") return { state: "expired", row: last }; // held but past expires_at
  return { state: (["cancelled", "released", "expired", "superseded"].includes(st) ? st : "missing") as CoverageState, row: last };
}

const STATE_TEXT: Record<CoverageState, string> = {
  confirmed: "đã xác nhận",
  held: "đang giữ nội bộ (chưa xác nhận)",
  amendment_pending: "bản điều chỉnh chưa được xác nhận",
  cancel_requested: "đang chờ bên ngoài hủy",
  cancelled: "booking đã bị hủy",
  released: "giữ chỗ đã nhả",
  expired: "giữ chỗ đã hết hạn",
  superseded: "đã bị thay thế, chưa có bản mới",
  mismatch: "số lượng trên sổ khác kế hoạch",
  missing: "không có giữ chỗ/booking nào",
};

export interface PlanProblem {
  demand: PlanDemand;
  state: CoverageState;
  /** "replan": the plan must be redone; "confirm": a person must record the external confirmation */
  action: "replan" | "confirm";
  message: string;
}

/**
 * Check the plan in force against the ledger.
 *  need = "planning": a valid internal hold (or confirmed booking) is enough — commitment gate, Outbox
 *  need = "execution": transport must be CONFIRMED (a pending amendment is not) — readiness gate
 * Dates: a resource used on a date before `today` no longer stands.
 */
export function planProblems(db: Database, workflowId: number, demands: PlanDemand[], need: "planning" | "execution", today: string, at: string = now().toISOString()): PlanProblem[] {
  const out: PlanProblem[] = [];
  for (const d of demands) {
    const label = `${d.type} ${d.key} (${d.qty} ${d.unit})`;
    if (d.date && d.date < today) {
      out.push({ demand: d, state: "expired", action: "replan", message: `${label}: ngày sử dụng ${d.date} đã qua (hôm nay ${today}) — bước ${d.step} lập lại` });
      continue;
    }
    const c = coverage(db, workflowId, d, at);
    const ok = c.state === "confirmed" || ((c.state === "held" || c.state === "amendment_pending") && (need === "planning" || d.type === "budget"));
    if (ok) continue;
    const replan = !["held", "amendment_pending"].includes(c.state);
    const extra = c.row ? ` (#${c.row.id}${c.row.external_ref ? ` ${c.row.external_ref}` : ""}${c.row.expires_at && c.state === "expired" ? ` hết hạn lúc ${c.row.expires_at}` : ""})` : "";
    out.push({
      demand: d,
      state: c.state,
      action: replan ? "replan" : "confirm",
      message: `${label}: ${STATE_TEXT[c.state]}${extra} — ${replan ? `bước ${d.step} lập lại kế hoạch` : "người phụ trách ghi mã xác nhận của bên ngoài"}`,
    });
  }
  return out;
}

/** Resources the plan in force needs, from the current outputs of log.plan / fin.check. */
export function demandsFromFacts(step: "log.plan" | "fin.check", runId: number, facts: Record<string, unknown> | undefined): PlanDemand[] {
  const hs = (facts?.holds as Array<{ type: string; key: string; qty: number; unit: string; date?: string | null }> | undefined) ?? [];
  return hs
    .filter((h) => h.type === "budget" || h.type === "vessel_deck" || h.type === "flight_seats")
    .map((h) => ({ type: h.type as ResourceType, key: String(h.key), qty: Number(h.qty), unit: String(h.unit), step, runId, date: h.date ?? null }));
}

export function caseReservations(db: Database, workflowId: number) {
  return db.prepare("SELECT * FROM reservations WHERE workflow_id = ? ORDER BY id").all(workflowId);
}
