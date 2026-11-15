"use client";

import React from "react";
import { useLang, type Lang } from "./i18n";
import { apiErrorFromBody, toApiError } from "@/lib/i18n/errors";
import { translateDynamic } from "@/lib/i18n/core";
import { useI18n } from "@/components/I18nProvider";

export type Ref = { kind: string; id: number | string };

/** Colors per status code; labels come from the catalog (status.<code>). */
export const STATUS: Record<string, { color: string }> = {
  pending: { color: "#94a3b8" },
  running: { color: "#60a5fa" },
  missing_data: { color: "#f59e0b" },
  awaiting_approval: { color: "#c084fc" },
  done: { color: "#22c55e" },
  error: { color: "#ef4444" },
  cancelled: { color: "#64748b" },
  open: { color: "#60a5fa" },
  approved: { color: "#a3e635" },
  rejected: { color: "#ef4444" },
  draft: { color: "#f59e0b" },
  approved_to_send: { color: "#22c55e" },
  sent: { color: "#22c55e" },
  skipped: { color: "#64748b" },
  waiting: { color: "#38bdf8" },
  closed: { color: "#22c55e" },
  superseded: { color: "#64748b" },
  held: { color: "#f59e0b" },
  confirmed: { color: "#22c55e" },
  released: { color: "#64748b" },
  expired: { color: "#ef4444" },
  cancel_requested: { color: "#f59e0b" },
  consumed: { color: "#64748b" },
};

export const BASIS: Record<string, { color: string }> = {
  observed: { color: "#38bdf8" },
  calculated: { color: "#22c55e" },
  hypothesis: { color: "#f59e0b" },
  check: { color: "#a78bfa" },
};
export const basisLabel = (basis: string, lang: Lang) => translateDynamic(lang, `basis.${basis}`) ?? basis;

/** Status label in the active language (unknown codes are shown as the code). */
export function statusLabel(status: string, lang: Lang): string {
  return translateDynamic(lang, `status.${status}`) ?? status;
}

export function Badge({ color, children, title }: { color: string; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 7px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        color,
        background: `${color}1f`,
        border: `1px solid ${color}55`,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const { lang } = useLang();
  const color = STATUS[status]?.color ?? "#94a3b8";
  return (
    <Badge color={color}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: color }} className={status === "running" ? "dio-pulse" : undefined} />
      {statusLabel(status, lang)}
    </Badge>
  );
}

export function ModeBadge({ mode }: { mode: string | null }) {
  const { t } = useLang();
  if (!mode) return null;
  if (mode === "llm") return <Badge color="#38bdf8" title={t("Kết luận vẫn do quy tắc tính; LLM chỉ thêm diễn giải/nhận định chưa xác minh", "Conclusions are still computed by rules; the LLM only adds unverified interpretation")}>{t("Quy tắc + LLM hỗ trợ", "Rules + LLM assist")}</Badge>;
  if (mode === "human") return <Badge color="#fde68a">{t("Người quyết định", "Human decision")}</Badge>;
  return <Badge color="#94a3b8" title={t("Kết quả từ quy tắc xác định trên dữ liệu đầu vào; không gọi LLM", "Result from deterministic rules on the input data; no LLM call")}>{t("Quy tắc xác định", "Deterministic rules")}</Badge>;
}

export function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section style={{ marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <h4 style={{ margin: 0, fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-2)", fontWeight: 650 }}>{title}</h4>
        {right}
      </div>
      {children}
    </section>
  );
}

export function RefChip({ label, refv, onOpen, color = "#8bacd4" }: { label: string; refv: Ref; onOpen: (r: Ref) => void; color?: string }) {
  const { t } = useI18n();
  return (
    <button
      onClick={() => onOpen(refv)}
      title={`${t("common.open")} ${refv.kind} ${refv.id}`}
      aria-label={`${t("common.open")} ${refv.kind} ${refv.id}`}
      style={{
        border: `1px solid ${color}55`,
        background: `${color}14`,
        color,
        borderRadius: 4,
        fontSize: 11,
        padding: "0 5px",
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
      }}
    >
      {label}
    </button>
  );
}

export const btn: React.CSSProperties = {
  padding: "5px 10px",
  fontSize: 12,
  borderRadius: 5,
  border: "1px solid var(--border-strong)",
  background: "var(--surface-2)",
  color: "var(--ink)",
  cursor: "pointer",
};
export const btnPrimary: React.CSSProperties = { ...btn, background: "var(--accent)", color: "var(--accent-ink)", border: "1px solid var(--accent)" };
export const input: React.CSSProperties = {
  width: "100%",
  padding: "5px 8px",
  fontSize: 12,
  borderRadius: 5,
  border: "1px solid var(--border-strong)",
  background: "var(--bg)",
  color: "var(--ink)",
};
export const card: React.CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--surface-2)",
  borderRadius: 6,
  padding: 8,
};

/**
 * Fetch JSON. Failures throw ApiError: kind "network" (fetch rejected), or kind "http" with the
 * server's stable code/params/requestId and its original text. Render with <ErrorMessage>.
 */
export async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw toApiError(e);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data as { ok?: boolean }).ok === false) throw apiErrorFromBody(res.status, data);
  return data as T;
}

export function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  return api<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

// ── Minimal, safe markdown renderer (no HTML injection: builds React nodes) ──

function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={`${key}-${i++}`}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={`${key}-${i++}`} style={{ fontFamily: "var(--font-mono)", fontSize: "0.92em" }}>{tok.slice(1, -1)}</code>);
    else out.push(<em key={`${key}-${i++}`}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        const cells = lines[i].slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
        if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div key={k++} style={{ overflowX: "auto", margin: "6px 0" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 11, width: "100%" }}>
            <thead>
              <tr>{head?.map((h, j) => <th key={j} style={{ textAlign: "left", borderBottom: "1px solid var(--border-strong)", padding: "3px 6px", color: "var(--ink-2)" }}>{inline(h, `h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci} style={{ borderBottom: "1px solid var(--border)", padding: "3px 6px", verticalAlign: "top" }}>{inline(c, `c${ri}${ci}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (line.startsWith("#")) {
      const level = line.match(/^#+/)![0].length;
      blocks.push(<div key={k++} style={{ fontWeight: 700, fontSize: level === 1 ? 15 : level === 2 ? 13 : 12, margin: "10px 0 4px" }}>{inline(line.replace(/^#+\s*/, ""), `t${k}`)}</div>);
    } else if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) items.push(lines[i++].slice(2));
      blocks.push(<ul key={k++} style={{ margin: "4px 0", paddingLeft: 18 }}>{items.map((it, j) => <li key={j}>{inline(it, `l${k}${j}`)}</li>)}</ul>);
      continue;
    } else if (line.startsWith(">")) {
      blocks.push(<div key={k++} style={{ borderLeft: "3px solid #f59e0b", padding: "2px 8px", color: "var(--ink-2)", margin: "6px 0" }}>{inline(line.replace(/^>\s*/, ""), `q${k}`)}</div>);
    } else if (line.trim() === "---") {
      blocks.push(<hr key={k++} style={{ border: 0, borderTop: "1px solid var(--border)" }} />);
    } else if (line.trim()) {
      blocks.push(<p key={k++} style={{ margin: "4px 0" }}>{inline(line, `p${k}`)}</p>);
    }
    i++;
  }
  return <div style={{ fontSize: 12, lineHeight: 1.5 }}>{blocks}</div>;
}
