"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentActivity } from "@diorama/engine";
import { useI18n } from "@/components/I18nProvider";
import { eventText, type EventMsg } from "@/lib/i18n/events";

export interface FeedEntry {
  id: string;
  /** Original text (shown when there is no message key, and in Vietnamese for server events) */
  label: string;
  /** Message key + params rendered at display time — switching language updates old entries too */
  msg?: EventMsg;
  /** Prefix (agent name) for server messages */
  agentName?: string;
  /** Server event labels are Vietnamese; generic 3D activity labels are built from keys */
  labelLang?: string;
  agentColor: string;
  timestamp: number;
  activity: AgentActivity;
  /** Attention event — the agent is waiting on the user (amber dot). */
  attention?: boolean;
}

interface ActivityFeedProps {
  entries: FeedEntry[];
}

export function ActivityFeed({ entries }: ActivityFeedProps) {
  const { t, fmt, locale } = useI18n();
  const text = (e: FeedEntry): { text: string; lang?: string } => {
    // Generic activity → always from keys; server event → Vietnamese original unless another locale has a key
    if (e.msg && (e.msg.key === "ev.generic" || locale !== (e.labelLang ?? "vi"))) {
      const s = eventText(e.msg, locale);
      if (s) return { text: e.msg.key === "ev.generic" ? s : `${e.agentName ? `${e.agentName} ` : ""}${s}` };
    }
    return { text: e.label, lang: e.labelLang && e.labelLang !== locale ? e.labelLang : undefined };
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(Date.now());

  // Update relative timestamps every second
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length]);

  if (entries.length === 0) return null;

  return (
    <div
      className="dio-card"
      style={{
        position: "absolute",
        bottom: 12,
        left: 12,
        zIndex: 10,
        width: 340,
        maxHeight: 280,
        background: "color-mix(in oklab, var(--surface) 85%, transparent)",
        backdropFilter: "blur(8px)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "8px 12px",
          fontSize: 11,
          fontWeight: 550,
          letterSpacing: "0.02em",
          color: "var(--ink-2)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {t("feed.title")}
      </div>

      {/* Scrollable entries */}
      <div
        ref={scrollRef}
        style={{
          overflowY: "auto",
          padding: "6px 0",
          flex: 1,
          minHeight: 0,
        }}
      >
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="dio-mono"
            style={{
              padding: "4px 12px",
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              fontSize: 11,
              lineHeight: 1.4,
            }}
          >
            {/* Agent color dot — amber for attention events */}
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: entry.attention ? "var(--warn)" : entry.agentColor,
                marginTop: 4,
                flexShrink: 0,
                boxShadow: entry.attention ? "none" : `0 0 4px ${entry.agentColor}40`,
              }}
            />
            {/* Label */}
            <span style={{ color: "var(--ink-2)", flex: 1 }} lang={text(entry).lang}>
              {text(entry).text}
            </span>
            {/* Timestamp */}
            <span
              style={{
                color: "var(--ink-3)",
                fontSize: 10,
                flexShrink: 0,
                marginTop: 1,
              }}
            >
              {fmt.relative(entry.timestamp, tick)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
