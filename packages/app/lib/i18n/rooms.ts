import { roomDisplayName } from "@diorama/engine";
import type { Locale } from "./locale";

/**
 * Display names of rooms. `room.label` is the technical key (pathfinding, seats, gateway room
 * matching, restore) and is never translated or replaced.
 *
 * Resolution order:
 *  1. an explicit localized name in the layout (`displayNames[locale]`);
 *  2. a built-in Offshore Ops room whose display name is still the template default →
 *     the catalog name below;
 *  3. otherwise the name the user gave (`displayName`) or the label without its zone id —
 *     custom names are kept as typed, never replaced by a translation guess.
 */
export interface RoomLike {
  label: string;
  displayName?: string;
  displayNames?: Partial<Record<string, string>>;
}

export const BUILTIN_ROOMS: Record<string, { vi: string; en: string; labels?: string[] }> = {
  zone_ops: { vi: "Điều hành khai thác", en: "Operations" },
  zone_prod_eng: { vi: "Kỹ thuật khai thác", en: "Production Engineering" },
  zone_maint: { vi: "Bảo dưỡng", en: "Maintenance & Reliability" },
  zone_hse: { vi: "HSE", en: "HSE" },
  zone_war_room: { vi: "Phòng họp kỹ thuật", en: "Engineering War Room" },
  zone_contracts: { vi: "Hợp đồng & Mua sắm", en: "Contracts & Procurement" },
  zone_logistics: { vi: "Hàng hải & Hậu cần", en: "Marine & Logistics" },
  zone_finance: { vi: "Tài chính", en: "Finance" },
  zone_asset: { vi: "Quản lý tài sản (Asset Manager)", en: "Asset Manager" },
  corridor: { vi: "Hành lang trung tâm", en: "Central Corridor", labels: ["Hành lang trung tâm"] },
};

const norm = (s: string | undefined) => (s ?? "").replace(/[\s\u00a0]+/g, " ").trim().toLowerCase();

/** Built-in room id of a room ("zone_ops" from "Operations · zone_ops"), if any. */
export function builtinRoomId(room: { label: string }): string | undefined {
  const zone = room.label.match(/zone_[a-z0-9_]+/)?.[0];
  if (zone && BUILTIN_ROOMS[zone]) return zone;
  return Object.keys(BUILTIN_ROOMS).find((k) => BUILTIN_ROOMS[k].labels?.some((l) => norm(l) === norm(room.label)));
}

export function localizedRoomName(room: RoomLike, locale: Locale): string {
  const explicit = room.displayNames?.[locale]?.trim();
  if (explicit) return explicit;
  const id = builtinRoomId(room);
  if (id) {
    const b = BUILTIN_ROOMS[id];
    const shown = room.displayName?.trim();
    // Only when the user has not renamed the room (still the template default or unset)
    if (!shown || norm(shown) === norm(b.vi) || norm(shown) === norm(room.displayNames?.vi)) return b[locale];
  }
  return roomDisplayName(room);
}

/** Language of the resolved name: the locale when it comes from a localized source, else unknown. */
export function roomNameLang(room: RoomLike, locale: Locale): string | undefined {
  if (room.displayNames?.[locale]?.trim()) return locale;
  const id = builtinRoomId(room);
  if (id && localizedRoomName(room, locale) === BUILTIN_ROOMS[id][locale]) return locale;
  return undefined;
}
