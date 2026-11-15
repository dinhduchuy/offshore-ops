import { toWorld } from "./geometry";

const DEFAULT_FLOOR_COLOR = "#1a1a2e";
const WALL_HEIGHT = 2.5;
const _WALL_THICKNESS = 0.08;
const DOOR_WIDTH = 1.2;
const DOOR_HEIGHT = 2.2;
const SCALE = 0.018;

export interface RoomRect {
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
  glassWalls?: boolean;
}

export interface DoorConfig {
  x: number;
  y: number;
  facing: number; // 0=north, 90=east, 180=south, 270=west
}

export interface FloorGeometry {
  position: [number, number, number];
  width: number;
  depth: number;
  color: string;
}

export interface WallSegment {
  position: [number, number, number];
  width: number;
  height: number;
  rotation: number;
  glass: boolean;
}

export interface DoorGeometry {
  position: [number, number, number];
  width: number;
  height: number;
}

export function generateFloor(room: RoomRect): FloorGeometry {
  const centerCx = room.x + room.w / 2;
  const centerCy = room.y + room.h / 2;
  const [wx, wy, wz] = toWorld(centerCx, centerCy);

  return {
    position: [wx, wy, wz],
    width: room.w * SCALE,
    depth: room.h * SCALE,
    color: room.color ?? DEFAULT_FLOOR_COLOR,
  };
}

export function generateWalls(room: RoomRect, doors: DoorConfig[]): WallSegment[] {
  const glass = room.glassWalls ?? false;
  const segments: WallSegment[] = [];

  // Four sides: north (top), south (bottom), west (left), east (right)
  const sides = [
    { cx: room.x + room.w / 2, cy: room.y, len: room.w, rot: 0, facing: 0 },                  // north
    { cx: room.x + room.w / 2, cy: room.y + room.h, len: room.w, rot: 0, facing: 180 },        // south
    { cx: room.x, cy: room.y + room.h / 2, len: room.h, rot: Math.PI / 2, facing: 270 },       // west
    { cx: room.x + room.w, cy: room.y + room.h / 2, len: room.h, rot: Math.PI / 2, facing: 90 }, // east
  ];

  for (const side of sides) {
    const sideDoors = doors.filter((d) => d.facing === side.facing);

    if (sideDoors.length === 0) {
      const [wx, , wz] = toWorld(side.cx, side.cy);
      segments.push({
        position: [wx, WALL_HEIGHT / 2, wz],
        width: side.len * SCALE,
        height: WALL_HEIGHT,
        rotation: side.rot,
        glass,
      });
    } else {
      // Split the wall around every door on this side. Doors are sorted along
      // the wall and solid segments are emitted for the gaps between them, so
      // a side with several doors gets one opening per door (not overlapping
      // left/right halves that would re-cover the other doors).
      const isHorizontal = side.facing === 0 || side.facing === 180;
      const halfDoorCanvas = (DOOR_WIDTH / SCALE) / 2;
      const origin = isHorizontal ? room.x : room.y;
      const openings = sideDoors
        .map((door) => (isHorizontal ? door.x : door.y) - origin)
        .sort((a, b) => a - b);

      let cursor = 0;
      const pushSegment = (from: number, to: number) => {
        const len = to - from;
        if (len <= 1) return;
        const mid = origin + from + len / 2;
        const [wx, , wz] = isHorizontal ? toWorld(mid, side.cy) : toWorld(side.cx, mid);
        segments.push({
          position: [wx, WALL_HEIGHT / 2, wz],
          width: len * SCALE,
          height: WALL_HEIGHT,
          rotation: side.rot,
          glass,
        });
      };
      for (const offset of openings) {
        pushSegment(cursor, offset - halfDoorCanvas);
        cursor = Math.max(cursor, offset + halfDoorCanvas);
      }
      pushSegment(cursor, side.len);
    }
  }

  return segments;
}

export function generateDoor(door: DoorConfig): DoorGeometry {
  const [wx, , wz] = toWorld(door.x, door.y);
  return {
    position: [wx, DOOR_HEIGHT / 2, wz],
    width: DOOR_WIDTH,
    height: DOOR_HEIGHT,
  };
}
