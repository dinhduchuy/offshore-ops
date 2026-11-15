import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  parseConfig,
  buildRoomGraph,
  findRoomPath,
  generateWaypoints,
  findRoomContaining,
  matchRoomIndex,
  resolveSeatRef,
  generateWalls,
  getRoomDoors,
  toWorld,
  ROOM_PRESETS,
  agentFigureDims,
  seatAnchor,
  isSeatingItem,
  resolveRoomFurniture,
  roomDisplayName,
} from "@diorama/engine";

/**
 * Offshore Operator HQ template (templates/oil-gas-operator) — checks that the
 * layout is actually walkable: every zone reachable door-to-door through the
 * corridor, every waypoint segment stays inside a room (no wall clipping),
 * seats resolve, and the zone ids used by the simulator match rooms.
 */
const GRID_UNIT = 200;
const GRID_WORLD = 3.6;

const TEMPLATES = [
  {
    name: "oil-gas-operator",
    rooms: 7,
    zones: ["zone_ops", "zone_subsurface", "zone_gg", "zone_contract", "zone_accounting", "zone_war_room"],
    agents: ["agent_ops_lead", "agent_reservoir_eng", "agent_geologist", "agent_contract_spec", "agent_cost_controller"],
  },
  {
    name: "oil-gas-ops",
    rooms: 10,
    zones: ["zone_ops", "zone_prod_eng", "zone_maint", "zone_hse", "zone_war_room", "zone_contracts", "zone_logistics", "zone_finance", "zone_asset"],
    agents: ["ops_agent", "prodeng_agent", "maint_agent", "hse_agent", "contracts_agent", "logistics_agent", "finance_agent", "eng_lead", "asset_manager", "oim"],
  },
];

for (const tpl of TEMPLATES) {
const config = parseConfig(JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../templates/${tpl.name}/diorama.config.json`), "utf-8")));
const ZONE_IDS = tpl.zones;
const AGENTS = tpl.agents;

function roomCenter(label: string): [number, number] {
  const r = config.rooms.find((x) => x.label === label)!;
  const [x, , z] = toWorld((r.position[0] + r.size[0] / 2) * GRID_UNIT, (r.position[1] + r.size[1] / 2) * GRID_UNIT);
  return [x, z];
}

describe(`${tpl.name} template`, () => {
  it("has all zones + corridor, no overlaps", () => {
    expect(config.rooms).toHaveLength(tpl.rooms);
    for (let i = 0; i < config.rooms.length; i++) {
      for (let j = i + 1; j < config.rooms.length; j++) {
        const a = config.rooms[i];
        const b = config.rooms[j];
        const overlaps =
          a.position[0] < b.position[0] + b.size[0] &&
          a.position[0] + a.size[0] > b.position[0] &&
          a.position[1] < b.position[1] + b.size[1] &&
          a.position[1] + a.size[1] > b.position[1];
        expect(overlaps, `${a.label} overlaps ${b.label}`).toBe(false);
      }
    }
  });

  it("every zone id matches exactly one room via fuzzy matching", () => {
    for (const id of ZONE_IDS) {
      const idx = matchRoomIndex(config.rooms, id);
      expect(idx, id).toBeGreaterThanOrEqual(0);
      expect(config.rooms[idx].label).toContain(id);
    }
  });

  it("preserves explicit doors and GLB furniture fields through parseConfig", () => {
    for (const room of config.rooms) expect(room.doors?.length).toBeGreaterThan(0);
    const ops = config.rooms[matchRoomIndex(config.rooms, "zone_ops")];
    expect(ops.furniture?.some((f) => f.glbPath?.endsWith("chairDesk.glb"))).toBe(true);
  });

  it("every room is reachable from every other room via doors", () => {
    const graph = buildRoomGraph(config.rooms, ROOM_PRESETS);
    for (const a of config.rooms) {
      for (const b of config.rooms) {
        expect(findRoomPath(graph, a.label, b.label).length, `${a.label} → ${b.label}`).toBeGreaterThan(0);
      }
    }
  });

  it("walking paths between zones never leave the rooms (no wall clipping)", () => {
    const graph = buildRoomGraph(config.rooms, ROOM_PRESETS);
    const zoneLabels = ZONE_IDS.map((id) => config.rooms[matchRoomIndex(config.rooms, id)].label);
    for (const from of zoneLabels) {
      for (const to of zoneLabels) {
        if (from === to) continue;
        const roomPath = findRoomPath(graph, from, to);
        const start = roomCenter(from);
        const end = roomCenter(to);
        const pts: [number, number][] = [start, ...generateWaypoints(graph, roomPath, start, end).map((w) => [w[0], w[2]] as [number, number])];
        // Sample every segment; each sample must lie inside some room
        for (let i = 0; i < pts.length - 1; i++) {
          for (let t = 0; t <= 1; t += 0.05) {
            const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
            const z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
            expect(findRoomContaining(config.rooms, x, z), `${from} → ${to} @ (${x.toFixed(2)}, ${z.toFixed(2)})`).not.toBeNull();
          }
        }
        // Each door crossing happens inside a wall opening of BOTH rooms
        expect(pts.length).toBeGreaterThanOrEqual(5); // start, exit door, corridor door(s), entry door, end
      }
    }
  });

  it("walls have an opening at every door (multi-door corridor included)", () => {
    for (const room of config.rooms) {
      const rect = { x: room.position[0] * GRID_UNIT, y: room.position[1] * GRID_UNIT, w: room.size[0] * GRID_UNIT, h: room.size[1] * GRID_UNIT };
      const doors = getRoomDoors(room).map((d) => ({ x: rect.x + d.rx * rect.w, y: rect.y + d.ry * rect.h, facing: d.facing }));
      const walls = generateWalls(rect, doors);
      for (const door of doors) {
        const [dx, , dz] = toWorld(door.x, door.y);
        const horizontal = door.facing === 0 || door.facing === 180;
        const blocked = walls.some((w) => {
          const wallHorizontal = w.rotation === 0;
          if (wallHorizontal !== horizontal) return false;
          if (horizontal) return Math.abs(w.position[2] - dz) < 0.01 && Math.abs(w.position[0] - dx) < w.width / 2;
          return Math.abs(w.position[0] - dx) < 0.01 && Math.abs(w.position[2] - dz) < w.width / 2;
        });
        expect(blocked, `${room.label} door at (${dx.toFixed(2)}, ${dz.toFixed(2)})`).toBe(false);
      }
    }
  });

  it("all agents have a resolvable seat in their home zone", () => {
    for (const id of AGENTS) {
      const a = config.agents[id];
      expect(a, id).toBeDefined();
      const seat = resolveSeatRef(config.rooms, config.theme, a.seat!);
      expect(seat, `${id} seat ${a.seat}`).not.toBeNull();
    }
  });

  it("people at the configured figure size fit doors and seats (no serious collisions)", () => {
    const dims = agentFigureDims();
    expect(dims.standingHeight).toBeLessThan(2.2); // door height
    expect(2 * dims.footprintRadius).toBeLessThan(1.2 - 0.4); // door width with margin
    for (const room of config.rooms) {
      const hw = (room.size[0] * GRID_WORLD) / 2;
      const hd = (room.size[1] * GRID_WORLD) / 2;
      const seats = resolveRoomFurniture(room, config.theme)
        .filter(isSeatingItem)
        .map((f) => {
          const a = seatAnchor(f);
          return { x: f.position[0] + a.dx, z: f.position[2] + a.dz, h: a.seatHeight, f };
        });
      for (const s of seats) {
        // body stays inside the walls
        expect(Math.abs(s.x) + dims.footprintRadius, `${room.label}: ${s.f.label}`).toBeLessThan(hw);
        expect(Math.abs(s.z) + dims.footprintRadius, `${room.label}: ${s.f.label}`).toBeLessThan(hd);
        expect(s.h).toBeGreaterThan(0.15);
        expect(s.h).toBeLessThan(dims.legLength * 1.3); // shins reach the floor
      }
      for (let i = 0; i < seats.length; i++) {
        for (let j = i + 1; j < seats.length; j++) {
          const d = Math.hypot(seats[i].x - seats[j].x, seats[i].z - seats[j].z);
          expect(d, `${room.label}: seats ${i}/${j} too close for two people`).toBeGreaterThan(2 * dims.footprintRadius);
        }
      }
    }
  });

  it("rooms show a readable name while labels keep their zone ids", () => {
    for (const id of ZONE_IDS) {
      const room = config.rooms[matchRoomIndex(config.rooms, id)];
      expect(room.label).toContain(id); // technical key untouched
      const shown = roomDisplayName(room);
      expect(shown).not.toMatch(/zone_/);
      expect(shown.length).toBeGreaterThan(1);
    }
    if (tpl.name === "oil-gas-ops") {
      const names = Object.fromEntries(ZONE_IDS.map((id) => [id, roomDisplayName(config.rooms[matchRoomIndex(config.rooms, id)])]));
      expect(names).toMatchObject({
        zone_ops: "Điều hành khai thác",
        zone_prod_eng: "Kỹ thuật khai thác",
        zone_maint: "Bảo dưỡng",
        zone_hse: "HSE",
        zone_contracts: "Hợp đồng & Mua sắm",
        zone_logistics: "Hàng hải & Hậu cần",
        zone_finance: "Tài chính",
      });
    }
  });

  it("all furniture sits inside its room", () => {
    for (const room of config.rooms) {
      const hw = (room.size[0] * GRID_WORLD) / 2;
      const hd = (room.size[1] * GRID_WORLD) / 2;
      for (const f of room.furniture ?? []) {
        expect(Math.abs(f.position[0]), `${room.label}: ${f.label}`).toBeLessThan(hw);
        expect(Math.abs(f.position[2]), `${room.label}: ${f.label}`).toBeLessThan(hd);
      }
    }
  });
});
}
