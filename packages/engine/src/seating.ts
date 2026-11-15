import type { RoomConfig } from "./config";
import type { FurnitureItem } from "./roomPresets";
import { getFurniture } from "./roomPresets";

/**
 * Seating helpers shared by the wizard (seat dropdown), the live view
 * (auto-seating), and the builder. All pure functions.
 *
 * Seat references are strings of the form "room-label::furniture-index",
 * where the index points into the room's *resolved* furniture list
 * (see resolveRoomFurniture).
 */

const SEATING_KEYWORDS = ["chair", "couch", "sofa", "stool", "lounge", "bench", "seat"];

/**
 * The furniture a room actually renders with: explicit room.furniture when
 * present, otherwise the preset+theme defaults. Room3D and LiveView already
 * follow this rule — every seat computation must use the same resolution.
 */
export function resolveRoomFurniture(
  room: Pick<RoomConfig, "preset" | "furniture">,
  themeId: string,
): FurnitureItem[] {
  if (room.furniture && room.furniture.length > 0) return room.furniture;
  return getFurniture(room.preset, themeId);
}

/**
 * True when a furniture item can be sat on. Checks the label AND the GLB
 * model filename — preset furniture (chairRing/deskRow) carries no label,
 * only a glbPath like ".../chair.glb".
 */
export function isSeatingItem(item: FurnitureItem): boolean {
  const label = (item.label ?? "").toLowerCase();
  const glbName = (item.glbPath ?? "").split("/").pop()?.toLowerCase() ?? "";
  return SEATING_KEYWORDS.some((k) => label.includes(k) || glbName.includes(k));
}

/** Human-readable name for a furniture item (falls back to the GLB filename). */
export function furnitureDisplayName(item: FurnitureItem, index: number): string {
  if (item.label) return item.label;
  const glbName = (item.glbPath ?? "").split("/").pop()?.replace(/\.glb$/i, "");
  if (glbName) {
    const pretty = glbName.replace(/[-_]+/g, " ");
    return pretty.charAt(0).toUpperCase() + pretty.slice(1);
  }
  return `Item ${index + 1}`;
}

export interface SeatOption {
  room: string;
  label: string;
  value: string;
}

/** Build the seat dropdown options grouped by room, over resolved furniture. */
export function buildSeatOptions(rooms: RoomConfig[], themeId: string): SeatOption[] {
  const options: SeatOption[] = [];
  for (const room of rooms) {
    const furniture = resolveRoomFurniture(room, themeId);
    let seatNum = 0;
    furniture.forEach((item, i) => {
      if (!isSeatingItem(item)) return;
      seatNum++;
      options.push({
        room: room.label,
        label: `${room.label} > ${furnitureDisplayName(item, i)} ${seatNum}`,
        value: `${room.label}::${i}`,
      });
    });
  }
  return options;
}

export interface ResolvedSeat {
  roomIndex: number;
  furnitureIndex: number;
  item: FurnitureItem;
}

/**
 * Resolve a "room-label::index" seat reference against the config rooms.
 * Returns null when the room or furniture index doesn't exist, or the
 * referenced item is not seating.
 */
export function resolveSeatRef(
  rooms: RoomConfig[],
  themeId: string,
  seatRef: string,
): ResolvedSeat | null {
  const sep = seatRef.lastIndexOf("::");
  if (sep <= 0) return null;
  const roomLabel = seatRef.slice(0, sep);
  const furnitureIndex = Number(seatRef.slice(sep + 2));
  if (!Number.isInteger(furnitureIndex) || furnitureIndex < 0) return null;

  const roomIndex = rooms.findIndex((r) => r.label === roomLabel);
  if (roomIndex < 0) return null;

  const furniture = resolveRoomFurniture(rooms[roomIndex], themeId);
  const item = furniture[furnitureIndex];
  if (!item || !isSeatingItem(item)) return null;

  return { roomIndex, furnitureIndex, item };
}

/**
 * Seat geometry of the bundled GLB models, in model units (measured from the
 * Kenney furniture kit). The kit's origin is a CORNER of the model, not its
 * center, so the seat point is offset from `item.position`. `center` is the
 * seat point in the model's local x/z (backrest on −z, sitter faces +z);
 * `seatHeight` is the top of the seat surface.
 */
const GLB_SEATS: Record<string, { center: [number, number]; seatHeight: number }> = {
  "chair.glb": { center: [0.1, -0.08], seatHeight: 0.22 },
  "chairdesk.glb": { center: [0.167, -0.1], seatHeight: 0.32 },
  "stoolbar.glb": { center: [0.133, -0.115], seatHeight: 0.44 },
  "bench.glb": { center: [0.2, -0.08], seatHeight: 0.22 },
  "benchcushion.glb": { center: [0.2, -0.08], seatHeight: 0.24 },
  "loungechair.glb": { center: [0.245, -0.22], seatHeight: 0.25 },
  "loungesofa.glb": { center: [0.49, -0.22], seatHeight: 0.25 },
  "loungesofalong.glb": { center: [0.49, 0.0], seatHeight: 0.25 },
  "loungedesignchair.glb": { center: [0.365, -0.22], seatHeight: 0.22 },
  "loungedesignsofa.glb": { center: [0.56, -0.22], seatHeight: 0.22 },
};

export interface SeatAnchor {
  /** World-space offset from item.position (rotation + scale applied) */
  dx: number;
  dz: number;
  /** Seat surface height above the floor (world units) */
  seatHeight: number;
  /** Rotation the sitter faces (same as the item's y rotation) */
  facing: number;
}

/**
 * Where a person sits on a furniture item, relative to item.position.
 * GLB items use the measured table above; primitive items are centered
 * meshes, so the seat is at the center and the top is size[1] / 2.
 */
export function seatAnchor(item: FurnitureItem): SeatAnchor {
  const rotY = item.rotation ? item.rotation[1] : 0;
  const glbName = (item.glbPath ?? "").split("/").pop()?.toLowerCase() ?? "";
  const known = item.glbPath ? GLB_SEATS[glbName] : undefined;
  if (known) {
    const scale = item.glbScale ?? 1;
    const lx = known.center[0] * scale;
    const lz = known.center[1] * scale;
    // three.js Y rotation: x' = x·cos + z·sin ; z' = −x·sin + z·cos
    const c = Math.cos(rotY);
    const s = Math.sin(rotY);
    return { dx: lx * c + lz * s, dz: -lx * s + lz * c, seatHeight: known.seatHeight * scale, facing: rotY };
  }
  const h = item.geometry === "sphere" ? item.size[0] : item.size[1] / 2;
  return { dx: 0, dz: 0, seatHeight: Math.max(0, (item.position[1] ?? 0) + h), facing: rotY };
}
