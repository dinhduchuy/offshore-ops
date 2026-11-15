import { describe, it, expect } from "vitest";
import { AGENT_FIGURE_SCALE, agentFigureDims, agentPose } from "./agentFigure";
import { seatAnchor } from "./seating";
import { roomDisplayName } from "./roomMatch";
import { updateAgentState, createAgentState } from "./agentState";
import type { FurnitureItem } from "./roomPresets";

describe("agent figure proportions", () => {
  it("one scale parameter drives every dimension (1.5× the original)", () => {
    expect(AGENT_FIGURE_SCALE).toBe(1.5);
    const one = agentFigureDims(1);
    const big = agentFigureDims();
    for (const k of ["legLength", "torsoRadius", "torsoHeight", "headRadius", "standingHeight", "labelGap"] as const) {
      expect(big[k]).toBeCloseTo(one[k] * 1.5, 6);
    }
    expect(big.standingHeight).toBeGreaterThan(1.7);
    expect(big.standingHeight).toBeLessThan(2.2); // fits under doors
  });

  it("standing: feet on the floor; seated: hips on the seat; label always above the head", () => {
    const d = agentFigureDims();
    const stand = agentPose(d, false, null);
    expect(stand.hipY).toBeCloseTo(d.legLength); // legs span 0 → hip
    expect(stand.torsoY - d.torsoHeight / 2).toBeCloseTo(stand.hipY);
    expect(stand.topY).toBeCloseTo(d.standingHeight);
    const sit = agentPose(d, true, 0.416);
    expect(sit.hipY).toBeCloseTo(0.416);
    expect(sit.topY).toBeLessThan(stand.topY + 0.2);
    expect(sit.labelY).toBeGreaterThan(sit.topY);
    expect(stand.labelY).toBeGreaterThan(stand.topY);
  });
});

describe("seat anchors", () => {
  const glb = (name: string, rotY: number, scale = 1.3): FurnitureItem =>
    ({ geometry: "box", size: [0.3, 0.7, 0.3], position: [1, 0, 2], rotation: [0, rotY, 0], material: { color: "#000" }, glbPath: `/models/kenney-furniture/${name}`, glbScale: scale }) as FurnitureItem;

  it("offsets from the GLB corner origin to the seat, rotated and scaled", () => {
    const a = seatAnchor(glb("chairDesk.glb", 0));
    expect(a.dx).toBeCloseTo(0.167 * 1.3);
    expect(a.dz).toBeCloseTo(-0.1 * 1.3);
    expect(a.seatHeight).toBeCloseTo(0.32 * 1.3);
    const r = seatAnchor(glb("chairDesk.glb", Math.PI));
    expect(r.dx).toBeCloseTo(-0.167 * 1.3);
    expect(r.dz).toBeCloseTo(0.1 * 1.3);
    expect(r.facing).toBeCloseTo(Math.PI);
  });

  it("primitive seats are centered; height is the top of the mesh", () => {
    const a = seatAnchor({ geometry: "box", size: [0.35, 0.6, 0.35], position: [0, 0, 0], material: { color: "#000" } } as FurnitureItem);
    expect(a).toMatchObject({ dx: 0, dz: 0 });
    expect(a.seatHeight).toBeCloseTo(0.3);
  });

  it("SIT stores the seat height; STAND clears it", () => {
    let s = createAgentState({ x: 0, z: 0 });
    s = updateAgentState(s, { type: "SIT", seatRotation: 1, seatHeight: 0.4 });
    expect(s).toMatchObject({ mode: "seated", seatRotation: 1, seatHeight: 0.4 });
    s = updateAgentState(s, { type: "STAND" });
    expect(s.seatHeight).toBeNull();
  });
});

describe("room display names", () => {
  it("prefers displayName and hides a trailing technical zone id otherwise", () => {
    expect(roomDisplayName({ label: "Operations · zone_ops", displayName: "Điều hành khai thác" })).toBe("Điều hành khai thác");
    expect(roomDisplayName({ label: "Phòng Subsurface · zone_subsurface" })).toBe("Phòng Subsurface");
    expect(roomDisplayName({ label: "Meeting Room" })).toBe("Meeting Room");
    expect(roomDisplayName({ label: "zone_ops" })).toBe("zone_ops");
  });
});

import { ROOM_PRESETS, getFurniture } from "./roomPresets";
import { isSeatingItem } from "./seating";

describe("built-in room presets (generic office) at the configured figure size", () => {
  it("no two seats are closer than two bodies, for every preset × theme", () => {
    const d = agentFigureDims();
    for (const preset of ROOM_PRESETS) {
      for (const theme of ["neon-dark", "warm-office", "cyberpunk", "minimal"]) {
        const seats = getFurniture(preset.id, theme)
          .filter(isSeatingItem)
          .map((f) => ({ x: f.position[0] + seatAnchor(f).dx, z: f.position[2] + seatAnchor(f).dz }));
        for (let i = 0; i < seats.length; i++)
          for (let j = i + 1; j < seats.length; j++)
            expect(Math.hypot(seats[i].x - seats[j].x, seats[i].z - seats[j].z), `${preset.id}/${theme} ${i}-${j}`).toBeGreaterThan(2 * d.footprintRadius);
      }
    }
  });
});
