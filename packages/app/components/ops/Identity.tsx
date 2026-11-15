"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Badge, input, api, postJson } from "./ui";
import type { SessionInfo } from "./types";
import { useLang, roleName } from "./i18n";

/** Identity status text from the server (Vietnamese) in the chosen language. */
export function detailText(s: SessionInfo, lang: "vi" | "en"): string {
  if (lang !== "en") return s.detail;
  return s.identityProvider === "none"
    ? "Production mode needs an enterprise identity provider (SSO) — NOT integrated yet, so every approval is blocked."
    : "Identity chosen from the server-side internal directory; no enterprise authentication (SSO) is connected. The identity source is stored with every decision.";
}

/**
 * Server-side identity for approvals. In demo mode the user picks an identity
 * from the server's demo directory; the role list always comes from the server.
 */
interface Ctx {
  session: SessionInfo | null;
  choose: (userId: string | null) => Promise<void>;
  reload: () => void;
}
const SessionCtx = createContext<Ctx>({ session: null, choose: async () => {}, reload: () => {} });

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const reload = useCallback(() => {
    api<SessionInfo>("/api/ops/session").then(setSession).catch(() => setSession(null));
  }, []);
  useEffect(reload, [reload]);
  const choose = useCallback(
    async (userId: string | null) => {
      await postJson("/api/ops/session", { userId });
      reload();
    },
    [reload],
  );
  return <SessionCtx.Provider value={{ session, choose, reload }}>{children}</SessionCtx.Provider>;
}

export const useOpsSession = () => useContext(SessionCtx);

/** Compact identity picker + honest demo labelling. */
export function IdentityBar({ requiredRole }: { requiredRole?: string }) {
  const { session, choose } = useOpsSession();
  const { t, lang } = useLang();
  if (!session) return <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{t("Đang tải danh tính…", "Loading identity…")}</div>;
  if (session.identityProvider === "none") {
    return <div style={{ fontSize: 11.5, color: "#ef4444" }}>⛔ {detailText(session, lang)}</div>;
  }
  const id = session.identity;
  const hasRole = !requiredRole || !!id?.roles.some((r) => r.toLowerCase() === requiredRole.toLowerCase());
  return (
    <div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <Badge color="#f59e0b" title={detailText(session, lang)}>{t("NGƯỜI PHÊ DUYỆT", "APPROVER")}</Badge>
        <select style={{ ...input, flex: 1 }} value={id?.userId ?? ""} onChange={(e) => choose(e.target.value || null)}>
          <option value="">{t("— Chọn người phê duyệt —", "— Choose the approver —")}</option>
          {session.users.map((u) => (
            <option key={u.id} value={u.id}>{u.name} · {u.roles.map((r) => roleName(r, lang)).join(", ")}</option>
          ))}
        </select>
      </div>
      <div style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 4 }}>{detailText(session, lang)}</div>
      {id && requiredRole && !hasRole && (
        <div style={{ fontSize: 11.5, color: "#f59e0b", marginTop: 4 }}>{t(`Danh tính hiện tại không có vai trò “${requiredRole}” — server sẽ từ chối.`, `The current identity does not hold the role “${roleName(requiredRole, lang)}” — the server will refuse.`)}</div>
      )}
    </div>
  );
}
