#!/usr/bin/env python3
"""
Sinh file cấu hình mặt bằng 3D "Offshore Operator HQ" cho Diorama.

    python3 oilgas/generate_layout.py            # ghi templates/oil-gas-operator/diorama.config.json
    python3 oilgas/generate_layout.py --stdout   # in ra màn hình

Hệ tọa độ (theo engine Diorama):
  * Phòng: position/size tính theo Ô LƯỚI (1 ô = 200 px canvas = 3.6 đơn vị 3D).
  * Nội thất: position tính theo ĐƠN VỊ 3D, tương đối so với TÂM phòng.
    Trục x: tây (-) → đông (+); trục z: bắc (-) → nam (+); y: chiều cao.
  * Cửa: rx/ry là tỉ lệ theo chiều rộng/cao của phòng; facing 0=Bắc 90=Đông 180=Nam 270=Tây.
    Hai phòng chỉ thông nhau khi có 2 cửa trùng tọa độ (sai lệch < 1 đơn vị 3D).

Mặt bằng (đơn vị: ô lưới):

    x=0        4        7        10
  y=0 +--------+--------+--------+
      |  OPS   |  SUB   |  G&G   |     hàng trên: cửa ở tường NAM
      |        |        |        |
  y=3 +---D----+---D----+---D----+
      |        HÀNH LANG TRUNG TÂM      (cửa trùng khớp từng phòng)
  y=4 +--D-----+----D------+--D--+
      |  ACC   |  WAR ROOM  | CON |     hàng dưới: cửa ở tường BẮC
      |        |            |     |
  y=7 +--------+------------+-----+

Mọi lối đi đều là phòng → cửa → hành lang → cửa → phòng, nên nhân vật không đi xuyên tường.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

GRID_WORLD = 3.6  # đơn vị 3D trên mỗi ô lưới
KF = "/models/kenney-furniture/"
S = 1.3  # tỉ lệ chung cho model GLB (agent cao ~1.3 đơn vị)

# Bounding box của model GLB ở scale 1 (min, max) — đo trực tiếp từ file .glb.
# Gốc của model Kenney nằm ở GÓC, nên phải bù offset để đặt đúng tâm.
GLB_BOUNDS = {
    "desk":           ((-0.01, 0.0, -0.38), (0.72, 0.38, 0.01)),
    "chairDesk":      ((0.0, 0.0, -0.31), (0.33, 0.61, 0.0)),
    "chair":          ((0.0, 0.0, -0.2), (0.2, 0.47, 0.0)),
    "computerScreen": ((0.0, 0.0, -0.1), (0.39, 0.29, 0.0)),
    "laptop":         ((0.0, 0.0, -0.24), (0.26, 0.16, 0.0)),
    "bookcaseClosed": ((0.0, 0.0, -0.25), (0.4, 0.85, 0.0)),
    "bookcaseOpen":   ((0.0, 0.0, -0.25), (0.4, 0.88, 0.0)),
    "pottedPlant":    ((-0.09, 0.0, -0.1), (0.09, 0.33, 0.1)),
    "lampSquareFloor": ((0.0, 0.0, -0.12), (0.12, 0.86, 0.0)),
    "trashcan":       ((-0.12, 0.0, -0.1), (0.11, 0.43, 0.1)),
}

# Hướng quay (rad, quanh trục Y) để mặt trước của ghế/màn hình nhìn về 4 hướng.
FACE = {"south": 0.0, "west": -math.pi / 2, "north": math.pi, "east": math.pi / 2}


def _r(v: float) -> float:
    return round(v, 3)


def glb(model: str, cx: float, cz: float, face: str = "south", scale: float = S,
        y: float = 0.0, label: str | None = None, color: str = "#2a3a55") -> dict:
    """Đặt model GLB sao cho TÂM bounding box nằm đúng (cx, cz) sau khi xoay."""
    (x0, y0, z0), (x1, y1, z1) = GLB_BOUNDS[model]
    mx, mz = (x0 + x1) / 2 * scale, (z0 + z1) / 2 * scale
    th = FACE[face]
    # Three.js xoay quanh Y: x' = x·cos + z·sin ; z' = -x·sin + z·cos
    ox = mx * math.cos(th) + mz * math.sin(th)
    oz = -mx * math.sin(th) + mz * math.cos(th)
    item = {
        "geometry": "box",
        "size": [_r((x1 - x0) * scale), _r((y1 - y0) * scale), _r((z1 - z0) * scale)],
        "position": [_r(cx - ox), _r(y), _r(cz - oz)],
        "rotation": [0, _r(th), 0],
        "material": {"color": color},
        "glbPath": f"{KF}{model}.glb",
        "glbScale": scale,
    }
    if label:
        item["label"] = label
    return item


def box(label: str, size, pos, color: str, emissive: str | None = None,
        rot_y: float = 0.0, opacity: float | None = None) -> dict:
    """Khối hình học nguyên thủy (màn hình, bảng, tủ rack...) — tâm nằm tại pos."""
    mat = {"color": color}
    if emissive:
        mat["emissive"] = emissive
    if opacity is not None:
        mat["opacity"] = opacity
    item = {"geometry": "box", "size": [_r(v) for v in size], "position": [_r(v) for v in pos],
            "label": label, "material": mat}
    if rot_y:
        item["rotation"] = [0, _r(rot_y), 0]
    return item


DESK_TOP = 0.38 * S  # chiều cao mặt bàn


def workstation(cx: float, cz: float, chair_side: str, monitors: int = 1,
                seat_label: str = "Workstation chair", screen_glow: str | None = None) -> tuple[list, dict]:
    """Bàn + màn hình (+ ghế). chair_side: phía đặt ghế so với bàn ('north'/'south').
    Trả về (danh sách bàn+màn hình, ghế) để caller tự quyết thứ tự ghế."""
    items: list = []
    dz = -0.55 if chair_side == "north" else 0.55
    # Người ngồi nhìn về phía bàn; màn hình quay mặt về phía người ngồi.
    face_user = "south" if chair_side == "north" else "north"
    items.append(glb("desk", cx, cz, face="south", label="Desk", color="#1a2a40"))
    spread = 0.42
    for i in range(monitors):
        mx = cx + (i - (monitors - 1) / 2) * spread
        # Mặt màn hình hướng về phía ghế (ngược hướng nhìn của người ngồi)
        items.append(glb("computerScreen", mx, cz - dz * 0.25, face=chair_side, y=DESK_TOP,
                         label="Monitor", color="#0b1220"))
    chair = glb("chairDesk", cx, cz + dz, face=face_user, label=seat_label, color="#2a3a55")
    return items, chair


def plant(cx, cz):
    return glb("pottedPlant", cx, cz, scale=1.6, label="Plant", color="#2f7d4f")


# ───────────────────────── Phòng ─────────────────────────

ZONES = {
    # key: (label hiển thị, preset, position, size, accent, floorStyle)
    "ops":        ("Phòng Operations · zone_ops",            "workspace", [0, 0], [4, 3], "#22c55e", "grid-tiles"),
    "subsurface": ("Phòng Subsurface · zone_subsurface",     "lab",       [4, 0], [3, 3], "#38bdf8", "grid-tiles"),
    "gg":         ("Phòng G&G Exploration · zone_gg",        "lab",       [7, 0], [3, 3], "#a78bfa", "hex-tiles"),
    "corridor":   ("Hành lang trung tâm",                     "social",    [0, 3], [10, 1], "#64748b", "solid"),
    "accounting": ("Phòng Accounting · zone_accounting",     "private",   [0, 4], [3, 3], "#fb7185", "wood-planks"),
    "war_room":   ("Phòng họp kỹ thuật · zone_war_room",     "meeting",   [3, 4], [4, 3], "#f8fafc", "carpet"),
    "contract":   ("Phòng Contract Management · zone_contract", "private", [7, 4], [3, 3], "#f59e0b", "wood-planks"),
}

TOP_ROW = ("ops", "subsurface", "gg")
BOTTOM_ROW = ("accounting", "war_room", "contract")
CORRIDOR = "corridor"


def door_x(key: str) -> float:
    """Tọa độ x (ô lưới) của cửa phòng = giữa cạnh tường phía hành lang."""
    _, _, pos, size, *_ = ZONES[key]
    return pos[0] + size[0] / 2


def build_doors() -> dict[str, list]:
    doors: dict[str, list] = {}
    cpos, csize = ZONES[CORRIDOR][2], ZONES[CORRIDOR][3]
    corridor_doors = []
    for key in TOP_ROW:
        doors[key] = [{"rx": 0.5, "ry": 1, "facing": 180}]  # tường Nam
        corridor_doors.append({"rx": _r((door_x(key) - cpos[0]) / csize[0]), "ry": 0, "facing": 0})
    for key in BOTTOM_ROW:
        doors[key] = [{"rx": 0.5, "ry": 0, "facing": 0}]  # tường Bắc
        corridor_doors.append({"rx": _r((door_x(key) - cpos[0]) / csize[0]), "ry": 1, "facing": 180})
    doors[CORRIDOR] = corridor_doors
    return doors


def half(key: str) -> tuple[float, float]:
    size = ZONES[key][3]
    return size[0] * GRID_WORLD / 2, size[1] * GRID_WORLD / 2


# Ghế đầu tiên trong danh sách = ghế của agent chủ phòng; ghế thứ 2 = ghế khách
# (agent từ phòng khác ghé qua sẽ tự lấy ghế trống đầu tiên → ghế khách).

def furnish_ops() -> list:
    hw, hd = half("ops")  # 7.2 x 5.4 — cửa ở tường Nam (z=+5.4), lối giữa x≈0 để trống
    wall_z = -hd + 0.15
    items: list = []
    # Ghế: lead (0) + khách (1) + 4 kỹ sư vận hành
    lead_desk, lead_chair = workstation(0, -2.0, "south", monitors=3, seat_label="Ops lead chair")
    visitor = glb("chairDesk", 1.6, -0.9, face="west", label="Visitor chair")
    seats = [lead_chair, visitor]
    rest: list = []
    for sx in (-4.6, 4.6):
        for sz in (-2.2, 1.2):
            desk, chair = workstation(sx, sz, "south", monitors=2, seat_label="Operator chair")
            rest += desk
            seats.append(chair)
    items += seats + lead_desk + rest
    # Video wall giám sát sản lượng (4 màn hình lớn, phát sáng)
    walls = [("Video wall · Sản lượng dầu (bopd)", "#22c55e"),
             ("Video wall · Áp suất đầu giếng WHP", "#38bdf8"),
             ("Video wall · Water Cut / GOR", "#f59e0b"),
             ("Video wall · SCADA alarms", "#ef4444")]
    for i, (lbl, glow) in enumerate(walls):
        items.append(box(lbl, [2.9, 1.5, 0.08], [-4.65 + i * 3.1, 1.55, wall_z], "#05080f", emissive=glow))
    # Tủ SCADA / server
    items.append(box("SCADA server rack", [0.6, 1.8, 0.8], [-hw + 0.5, 0.9, hd - 1.2], "#1f2937", emissive="#22c55e"))
    items.append(box("SCADA server rack", [0.6, 1.8, 0.8], [-hw + 0.5, 0.9, hd - 2.2], "#1f2937", emissive="#22c55e"))
    items += [plant(hw - 0.5, hd - 0.5), plant(-hw + 0.5, -hd + 0.6 + 1.0)]
    return items


def furnish_lab(key: str, title: str, glow: str, extra) -> list:
    hw, hd = half(key)  # 5.4 x 5.4 — cửa Nam
    items: list = []
    desk, chair = workstation(0, -2.2, "south", monitors=3, seat_label="Engineer chair")
    visitor = glb("chairDesk", 1.5, -1.0, face="west", label="Visitor chair")
    desk2, chair2 = workstation(3.4, 1.6, "south", monitors=2, seat_label="Analyst chair")
    items += [chair, visitor, chair2] + desk + desk2
    items.append(box(title, [3.6, 1.7, 0.08], [0, 1.6, -hd + 0.15], "#05080f", emissive=glow))
    items += extra(hw, hd)
    items += [plant(hw - 0.5, -hd + 0.6), plant(-hw + 0.5, hd - 0.5)]
    return items


def subsurface_extra(hw, hd):
    return [
        box("Màn hình mô phỏng vỉa (side)", [0.08, 1.4, 2.6], [-hw + 0.15, 1.5, -1.6], "#05080f", emissive="#0ea5e9"),
        # Mô hình vỉa 3D trên bàn trưng bày
        box("Bàn trưng bày mô hình vỉa", [1.8, 0.5, 1.2], [-2.8, 0.25, 1.8], "#1e293b"),
        box("Mô hình vỉa 3D (hologram)", [1.4, 0.5, 0.9], [-2.8, 0.85, 1.8], "#0ea5e9", emissive="#38bdf8", opacity=0.45),
        glb("bookcaseOpen", hw - 0.4, -1.2, face="west", label="Bookshelf", color="#334155"),
    ]


def gg_extra(hw, hd):
    items = [
        box("Màn hình địa chấn (seismic)", [0.08, 1.4, 2.6], [-hw + 0.15, 1.5, -1.6], "#05080f", emissive="#f97316"),
        box("Bàn mô tả mẫu lõi (core table)", [2.2, 0.55, 0.9], [-2.6, 0.275, 1.9], "#3f3f46"),
    ]
    for i in range(4):  # các ống mẫu lõi trên bàn
        items.append({"geometry": "cylinder", "size": [0.09, 0.8, 0.09],
                      "position": [_r(-3.4 + i * 0.5), 0.6, 1.9], "rotation": [0, 0, _r(math.pi / 2)],
                      "label": "Core sample", "material": {"color": "#a16207", "emissive": "#78350f"}})
    items.append(glb("bookcaseClosed", hw - 0.4, -1.2, face="west", label="Map cabinet", color="#334155"))
    return items


def furnish_office(key: str, board_title: str, glow: str) -> list:
    hw, hd = half(key)  # 5.4 x 5.4 — cửa Bắc (z=-5.4); bàn chính ở nửa Nam, lối giữa trống
    items: list = []
    desk, chair = workstation(0, 2.0, "north", monitors=2, seat_label="Specialist chair")
    visitor = glb("chairDesk", 1.5, 0.9, face="west", label="Visitor chair")
    desk2, chair2 = workstation(-3.4, -1.4, "north", monitors=1, seat_label="Assistant chair")
    items += [chair, visitor, chair2] + desk + desk2
    items.append(box(board_title, [3.4, 1.6, 0.08], [0, 1.6, hd - 0.15], "#05080f", emissive=glow))
    for i in range(3):  # tủ hồ sơ dọc tường Đông
        items.append(glb("bookcaseClosed", hw - 0.4, -1.6 + i * 0.75, face="west",
                         label="File cabinet", color="#3b2f2a"))
    items += [plant(-hw + 0.5, hd - 0.5), plant(hw - 0.5, -hd + 0.6)]
    return items


def furnish_war_room() -> list:
    hw, hd = half("war_room")  # 7.2 x 5.4 — cửa Bắc
    items: list = []
    tz = 1.0  # tâm bàn họp
    # Ghế phía Bắc (gần cửa) xếp trước → 3 agent đầu tiên ngồi hàng này, nhìn về màn trình chiếu
    seats = [glb("chair", x, tz - 1.35, face="south", label="Meeting chair") for x in (-1.6, 0, 1.6)]
    seats += [glb("chair", -2.9, tz, face="east", label="Meeting chair"),
              glb("chair", 2.9, tz, face="west", label="Meeting chair")]
    seats += [glb("chair", x, tz + 1.35, face="north", label="Meeting chair") for x in (-1.6, 0, 1.6)]
    items += seats
    items.append(box("Bàn họp lớn (mặt bàn)", [4.6, 0.08, 1.9], [0, 0.56, tz], "#3b2a1e"))
    items.append(box("Bàn họp lớn (chân)", [3.6, 0.52, 0.7], [0, 0.26, tz], "#2a1d15"))
    items.append(box("Màn hình trình chiếu Peer Review", [4.4, 2.0, 0.08], [0, 1.6, hd - 0.15],
                     "#05080f", emissive="#60a5fa"))
    items.append(box("Whiteboard · Well WHP-02 action plan", [0.08, 1.1, 2.4], [hw - 0.15, 1.4, 0.8], "#f8fafc"))
    items.append(box("Bảng KPI giao ban", [0.08, 1.1, 2.4], [-hw + 0.15, 1.4, 0.8], "#05080f", emissive="#22c55e"))
    items += [plant(-hw + 0.5, -hd + 0.6), plant(hw - 0.5, -hd + 0.6), plant(-hw + 0.5, hd - 0.5), plant(hw - 0.5, hd - 0.5)]
    return items


def furnish_corridor() -> list:
    hw, hd = half(CORRIDOR)  # 18 x 1.8 — chỉ đặt cây/đèn ở 2 đầu hành lang, không có ghế
    return [plant(-hw + 0.5, -hd + 0.5), plant(-hw + 0.5, hd - 0.5),
            plant(hw - 0.5, -hd + 0.5), plant(hw - 0.5, hd - 0.5),
            glb("lampSquareFloor", -hw + 1.3, 0, label="Lamp", color="#ecc94b"),
            glb("lampSquareFloor", hw - 1.3, 0, label="Lamp", color="#ecc94b")]


FURNITURE = {
    "ops": furnish_ops,
    "subsurface": lambda: furnish_lab("subsurface", "Reservoir simulation · Eclipse/Petrel", "#38bdf8", subsurface_extra),
    "gg": lambda: furnish_lab("gg", "Minh giải địa chấn 3D · Seismic cube", "#a78bfa", gg_extra),
    "corridor": furnish_corridor,
    "accounting": lambda: furnish_office("accounting", "AFE & Cost Recovery dashboard", "#fb7185"),
    "war_room": furnish_war_room,
    "contract": lambda: furnish_office("contract", "PSC & Tender tracking board", "#f59e0b"),
}

# ───────────────────────── Agents ─────────────────────────

AGENTS = {
    # agent id: (zone key, màu)
    "agent_ops_lead":        ("ops", "#22c55e"),
    "agent_reservoir_eng":   ("subsurface", "#38bdf8"),
    "agent_geologist":       ("gg", "#a78bfa"),
    "agent_contract_spec":   ("contract", "#f59e0b"),
    "agent_cost_controller": ("accounting", "#fb7185"),
}


def is_seat(item: dict) -> bool:
    keys = ("chair", "couch", "sofa", "stool", "lounge", "bench", "seat")
    text = (item.get("label", "") + item.get("glbPath", "")).lower()
    return any(k in text for k in keys)


def build_config() -> dict:
    doors = build_doors()
    rooms = []
    for key, (label, preset, pos, size, accent, floor) in ZONES.items():
        rooms.append({
            "preset": preset,
            "position": pos,
            "size": size,
            "label": label,
            "colors": {"accent": accent, **({"floor": "#3b4a5f"} if key == CORRIDOR else {})},
            "floorStyle": floor,
            "doors": doors[key],
            "furniture": FURNITURE[key](),
        })
    by_key = {key: room for key, room in zip(ZONES, rooms)}

    agents = {}
    for agent_id, (zone, color) in AGENTS.items():
        room = by_key[zone]
        seat_idx = next(i for i, it in enumerate(room["furniture"]) if is_seat(it))
        agents[agent_id] = {
            "desk": f"zone_{zone}-desk-1",
            "seat": f"{room['label']}::{seat_idx}",
            # Chỉ "đi dạo" trong phòng mình khi rảnh; sự kiện /api/ingest vẫn điều agent đi bất cứ đâu.
            "allowedRooms": [room["label"]],
            "energy": 0.35,
            "color": color,
        }

    return {
        "name": "Offshore Operator HQ — AI Agents",
        "gateway": {"url": "", "token": ""},
        "view": "3d-office",
        "theme": "neon-dark",
        "sources": [{"type": "ingest"}],
        "rooms": rooms,
        "agents": agents,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stdout", action="store_true", help="In JSON ra màn hình thay vì ghi file")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "templates" / "oil-gas-operator" / "diorama.config.json"))
    args = ap.parse_args()
    text = json.dumps(build_config(), indent=2, ensure_ascii=False) + "\n"
    if args.stdout:
        print(text, end="")
        return
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(f"Đã ghi {out}")


if __name__ == "__main__":
    main()
