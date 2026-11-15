/**
 * Agent figure proportions — the single place that sizes people in the 3D
 * office (shared by the generic office `/` and `/ops`). Everything derives
 * from AGENT_FIGURE_SCALE; geometry components must not hard-code sizes.
 *
 * Scale 1.5 (vs the original figure): standing height ≈ 1.84 world units,
 * under the 2.2 door height and 2.5 wall height; body width 0.45 fits the
 * 1.2-wide doors. Seats are 1.2+ apart in the bundled layouts.
 */
export const AGENT_FIGURE_SCALE = 1.5;

/** Base proportions at scale 1 (world units). */
const BASE = {
  legLength: 0.36,
  legRadius: 0.055,
  legSpread: 0.075,
  torsoRadius: 0.15,
  /** Cylinder part of the torso capsule (total torso height = length + 2·radius) */
  torsoLength: 0.38,
  headRadius: 0.12,
  /** Seated: thigh length (horizontal, forward) */
  thighLength: 0.26,
  badgeRadius: 0.04,
  /** Gap between head top and the name/activity label */
  labelGap: 0.25,
  /** Idle sway/lean amplitude multiplier stays 1 — motion is relative */
};

export interface AgentFigureDims {
  scale: number;
  legLength: number;
  legRadius: number;
  legSpread: number;
  torsoRadius: number;
  torsoLength: number;
  torsoHeight: number;
  headRadius: number;
  thighLength: number;
  badgeRadius: number;
  labelGap: number;
  /** Standing height (feet on the floor → top of head) */
  standingHeight: number;
  /** Footprint radius used for spacing checks */
  footprintRadius: number;
}

export function agentFigureDims(scale: number = AGENT_FIGURE_SCALE): AgentFigureDims {
  const s = (v: number) => v * scale;
  const torsoHeight = s(BASE.torsoLength + 2 * BASE.torsoRadius);
  const headRadius = s(BASE.headRadius);
  const headLift = headRadius * 0.55; // head sits slightly into the torso top
  return {
    scale,
    legLength: s(BASE.legLength),
    legRadius: s(BASE.legRadius),
    legSpread: s(BASE.legSpread),
    torsoRadius: s(BASE.torsoRadius),
    torsoLength: s(BASE.torsoLength),
    torsoHeight,
    headRadius,
    thighLength: s(BASE.thighLength),
    badgeRadius: s(BASE.badgeRadius),
    labelGap: s(BASE.labelGap),
    standingHeight: s(BASE.legLength) + torsoHeight + headLift + headRadius,
    footprintRadius: s(BASE.torsoRadius),
  };
}

export interface AgentPose {
  /** y of the torso bottom (hips) */
  hipY: number;
  /** torso capsule center y */
  torsoY: number;
  headY: number;
  /** y of the top of the head */
  topY: number;
  /** y for the name/activity label */
  labelY: number;
  /** chest badge y */
  badgeY: number;
}

/**
 * Vertical layout. Standing: feet on the floor (y = 0). Seated: hips on the
 * seat surface (`seatHeight`, world units), shins reach the floor.
 */
export function agentPose(dims: AgentFigureDims, seated: boolean, seatHeight: number | null | undefined): AgentPose {
  const hipY = seated ? Math.max(0, seatHeight ?? dims.legLength) : dims.legLength;
  const torsoY = hipY + dims.torsoHeight / 2;
  const headY = hipY + dims.torsoHeight + dims.headRadius * 0.55;
  const topY = headY + dims.headRadius;
  return { hipY, torsoY, headY, topY, labelY: topY + dims.labelGap, badgeY: hipY + dims.torsoHeight * 0.7 };
}
