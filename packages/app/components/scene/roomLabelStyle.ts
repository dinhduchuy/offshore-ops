import type React from "react";

/**
 * Room name labels — one place for their size/contrast/placement so the
 * generic office, the builder and /ops stay consistent.
 *
 * Size is 1.5× the previous 14px/600. Labels sit above the BACK wall of the
 * room (−z, away from the default camera) instead of the room center, so they
 * do not cover people or desks; they wrap instead of being cut off.
 */
export const ROOM_LABEL = {
  fontSize: 21,
  fontWeight: 750,
  /** world units above the wall top — high enough that a label never hides someone walking through a back-wall door */
  liftAboveWall: 0.8,
  /** world units inside the back wall */
  insetFromBackWall: 0.2,
  /**
   * Zoom behaviour: like drei's distanceFactor=10 (labels grow when you zoom
   * in), but clamped so the name stays readable on the whole-office view.
   */
  distanceFactor: 10,
  /** never smaller than this on screen (px font) — overview stays readable */
  minScreenPx: 13,
  /** never larger than this (px font) when zoomed in close */
  maxScreenPx: 32,
  /** px of max width per grid cell of room width (clamped) */
  pxPerCell: 100,
  minWidthPx: 140,
  maxWidthPx: 400,
} as const;

export function roomLabelStyle(accent: string, roomCells: number): React.CSSProperties {
  const maxWidth = Math.max(ROOM_LABEL.minWidthPx, Math.min(ROOM_LABEL.maxWidthPx, roomCells * ROOM_LABEL.pxPerCell));
  return {
    color: "#f8fafc",
    fontSize: ROOM_LABEL.fontSize,
    fontWeight: ROOM_LABEL.fontWeight,
    lineHeight: 1.15,
    letterSpacing: "0.01em",
    textAlign: "center",
    // wrap long Vietnamese names at spaces; never truncate
    whiteSpace: "normal",
    overflowWrap: "break-word",
    width: "max-content",
    maxWidth,
    padding: "3px 10px 4px",
    borderRadius: 6,
    background: "rgba(8, 12, 20, 0.78)",
    border: `1.5px solid ${accent}`,
    boxShadow: `0 0 10px ${accent}55`,
    textShadow: "0 1px 2px rgba(0,0,0,0.9)",
    userSelect: "none",
  };
}
