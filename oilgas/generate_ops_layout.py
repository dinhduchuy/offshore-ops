#!/usr/bin/env python3
"""
Sinh mặt bằng 3D cho hệ thống phối hợp AI agent (8 phòng ban + phòng họp + hành lang).

    python3 oilgas/generate_ops_layout.py   # ghi templates/oil-gas-ops/diorama.config.json

    x=0       4        8        12       16   (ô lưới; 1 ô = 3.6 đơn vị 3D)
  y=0 +-------+--------+--------+--------+
      |  OPS  | PROD   | MAINT  |  HSE   |   cửa tường Nam
  y=3 +---D---+---D----+---D----+---D----+
      |            HÀNH LANG TRUNG TÂM    |   9 cửa khớp từng phòng
  y=4 +---D---+--D--+--D--+--D--+---D----+
      | WAR   | CON | LOG | FIN | ASSET  |   cửa tường Bắc
  y=7 +-------+-----+-----+-----+--------+

Zone id trong nhãn phòng khớp với AGENT_DIRECTORY (packages/ops/src/agents/index.ts).
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from generate_layout import GRID_WORLD, glb, box, workstation, plant, is_seat, _r

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "templates" / "oil-gas-ops" / "diorama.config.json"

# key: (label, preset, position, size, accent, floor)
ZONES = {
    "zone_ops":       ("Operations · zone_ops",                 "workspace", [0, 0], [4, 3], "#22c55e", "grid-tiles"),
    "zone_prod_eng":  ("Production/Subsurface · zone_prod_eng", "lab",       [4, 0], [4, 3], "#38bdf8", "grid-tiles"),
    "zone_maint":     ("Maintenance & Reliability · zone_maint", "lab",      [8, 0], [4, 3], "#f97316", "grid-tiles"),
    "zone_hse":       ("HSE · zone_hse",                        "lab",       [12, 0], [4, 3], "#eab308", "hex-tiles"),
    "corridor":       ("Hành lang trung tâm",                   "social",    [0, 3], [16, 1], "#64748b", "solid"),
    "zone_war_room":  ("Phòng họp kỹ thuật · zone_war_room",    "meeting",   [0, 4], [4, 3], "#f8fafc", "carpet"),
    "zone_contracts": ("Contracts & Procurement · zone_contracts", "private", [4, 4], [3, 3], "#a78bfa", "wood-planks"),
    "zone_logistics": ("Marine & Logistics · zone_logistics",   "private",   [7, 4], [3, 3], "#2dd4bf", "wood-planks"),
    "zone_finance":   ("Finance · zone_finance",                "private",   [10, 4], [3, 3], "#fb7185", "wood-planks"),
    "zone_asset":     ("Asset Manager · zone_asset",            "private",   [13, 4], [3, 3], "#fde68a", "wood-planks"),
}
# Tên hiển thị tiếng Việt (chỉ để đọc trên mặt bằng). "label" ở trên GIỮ NGUYÊN vì
# chứa zone_* dùng để ánh xạ phòng ↔ workflow, chỗ ngồi ("label::index") và đường đi.
DISPLAY = {
    "zone_ops": "Điều hành khai thác",
    "zone_prod_eng": "Kỹ thuật khai thác",
    "zone_maint": "Bảo dưỡng",
    "zone_hse": "HSE",
    "corridor": "Hành lang trung tâm",
    "zone_war_room": "Phòng họp kỹ thuật",
    "zone_contracts": "Hợp đồng & Mua sắm",
    "zone_logistics": "Hàng hải & Hậu cần",
    "zone_finance": "Tài chính",
    "zone_asset": "Quản lý tài sản (Asset\u00a0Manager)",  # nbsp: xuống dòng trước "(Asset Manager)"
}
# Tên tiếng Anh tường minh cho giao diện EN (chỉ hiển thị; label/zone id không đổi)
DISPLAY_EN = {
    "zone_ops": "Operations",
    "zone_prod_eng": "Production Engineering",
    "zone_maint": "Maintenance & Reliability",
    "zone_hse": "HSE",
    "corridor": "Central Corridor",
    "zone_war_room": "Engineering War Room",
    "zone_contracts": "Contracts & Procurement",
    "zone_logistics": "Marine & Logistics",
    "zone_finance": "Finance",
    "zone_asset": "Asset Manager",
}
TOP = ["zone_ops", "zone_prod_eng", "zone_maint", "zone_hse"]
BOTTOM = ["zone_war_room", "zone_contracts", "zone_logistics", "zone_finance", "zone_asset"]


def half(key):
    s = ZONES[key][3]
    return s[0] * GRID_WORLD / 2, s[1] * GRID_WORLD / 2


def doors():
    out = {}
    cx0, cw = ZONES["corridor"][2][0], ZONES["corridor"][3][0]
    cor = []
    for k in TOP:
        p, s = ZONES[k][2], ZONES[k][3]
        out[k] = [{"rx": 0.5, "ry": 1, "facing": 180}]
        cor.append({"rx": _r((p[0] + s[0] / 2 - cx0) / cw), "ry": 0, "facing": 0})
    for k in BOTTOM:
        p, s = ZONES[k][2], ZONES[k][3]
        out[k] = [{"rx": 0.5, "ry": 0, "facing": 0}]
        cor.append({"rx": _r((p[0] + s[0] / 2 - cx0) / cw), "ry": 1, "facing": 180})
    out["corridor"] = cor
    return out


def top_room(key, wall_title, glow, desks=2, extra=()):
    """Room with door on the south wall: owner desk centre-north, aisle x≈0 kept clear."""
    hw, hd = half(key)
    d0, c0 = workstation(0, -2.0, "south", monitors=3, seat_label="Owner chair")
    visitor = glb("chairDesk", 1.6, -0.8, face="west", label="Visitor chair")
    seats, items = [c0, visitor], []
    xs = [-4.6, 4.6][:desks]
    for x in xs:
        d, c = workstation(x, -1.6, "south", monitors=2, seat_label="Second chair")
        seats.append(c)
        items += d
    items += d0
    items.append(box(wall_title, [3.6, 1.6, 0.08], [0, 1.6, -hd + 0.15], "#05080f", emissive=glow))
    items += list(extra)
    items += [plant(hw - 0.5, hd - 0.5), plant(-hw + 0.5, hd - 0.5)]
    return seats + items


def bottom_office(key, board_title, glow, visitors=1, extra=()):
    """Office with door on the north wall: desk in the south half, aisle clear."""
    hw, hd = half(key)
    d0, c0 = workstation(0, 2.0, "north", monitors=2, seat_label="Owner chair")
    seats = [c0] + [glb("chairDesk", 1.5 * (1 if i == 0 else -1), 0.9, face="west" if i == 0 else "east", label="Visitor chair") for i in range(visitors)]
    items = d0 + [box(board_title, [3.2, 1.5, 0.08], [0, 1.6, hd - 0.15], "#05080f", emissive=glow)]
    for i in range(3):
        items.append(glb("bookcaseClosed", hw - 0.4, -1.6 + i * 0.75, face="west", label="File cabinet", color="#3b2f2a"))
    items += list(extra)
    items += [plant(-hw + 0.5, hd - 0.5), plant(hw - 0.5, -hd + 0.6)]
    return seats + items


def war_room():
    hw, hd = half("zone_war_room")
    tz = 1.0
    seats = [glb("chair", x, tz - 1.35, face="south", label="Meeting chair") for x in (-1.6, 0, 1.6)]
    seats += [glb("chair", -2.9, tz, face="east", label="Meeting chair"), glb("chair", 2.9, tz, face="west", label="Meeting chair")]
    seats += [glb("chair", x, tz + 1.35, face="north", label="Meeting chair") for x in (-1.6, 0, 1.6)]
    return seats + [
        box("Bàn họp lớn", [4.6, 0.08, 1.9], [0, 0.56, tz], "#3b2a1e"),
        box("Bàn họp (chân)", [3.6, 0.52, 0.7], [0, 0.26, tz], "#2a1d15"),
        box("Màn hình trình chiếu", [4.4, 2.0, 0.08], [0, 1.6, hd - 0.15], "#05080f", emissive="#60a5fa"),
        box("Bảng workflow", [0.08, 1.1, 2.4], [-hw + 0.15, 1.4, 0.8], "#05080f", emissive="#22c55e"),
        plant(-hw + 0.5, -hd + 0.6), plant(hw - 0.5, -hd + 0.6),
    ]


def corridor():
    hw, hd = half("corridor")
    return [plant(-hw + 0.5, -hd + 0.5), plant(-hw + 0.5, hd - 0.5), plant(hw - 0.5, -hd + 0.5), plant(hw - 0.5, hd - 0.5)]


def ops_room():
    hw, hd = half("zone_ops")
    walls = [("Sản lượng dầu (bopd)", "#22c55e"), ("Áp suất đầu giếng", "#38bdf8"), ("Water cut / GOR", "#f59e0b"), ("SCADA alarms", "#ef4444")]
    items = top_room("zone_ops", "Production overview", "#22c55e")
    items = [i for i in items if i.get("label") != "Production overview"]
    for i, (lbl, glow) in enumerate(walls):
        items.append(box(f"Video wall · {lbl}", [2.9, 1.5, 0.08], [-4.65 + i * 3.1, 1.55, -hd + 0.15], "#05080f", emissive=glow))
    items.append(box("SCADA server rack", [0.6, 1.8, 0.8], [-hw + 0.5, 0.9, hd - 1.4], "#1f2937", emissive="#22c55e"))
    return items


FURNISH = {
    "zone_ops": ops_room,
    "zone_prod_eng": lambda: top_room("zone_prod_eng", "Well performance & reservoir model", "#38bdf8",
                                      extra=[box("Mô hình vỉa 3D (hologram)", [1.4, 0.5, 0.9], [-3.0, 0.85, 2.6], "#0ea5e9", emissive="#38bdf8", opacity=0.45),
                                             box("Bàn trưng bày", [1.8, 0.5, 1.2], [-3.0, 0.25, 2.6], "#1e293b")]),
    "zone_maint": lambda: top_room("zone_maint", "CMMS · work orders", "#f97316",
                                   extra=[box("Giá phụ tùng", [0.6, 1.8, 2.4], [6.6, 0.9, 2.2], "#334155"),
                                          box("Bàn thao tác", [2.0, 0.9, 0.8], [-4.6, 0.45, 2.6], "#475569")]),
    "zone_hse": lambda: top_room("zone_hse", "Permit to Work board", "#eab308",
                                 extra=[box("Tủ PPE", [0.6, 1.8, 1.6], [6.6, 0.9, 2.2], "#854d0e", emissive="#eab308")]),
    "corridor": corridor,
    "zone_war_room": war_room,
    "zone_contracts": lambda: bottom_office("zone_contracts", "Contracts & RFQ tracker", "#a78bfa"),
    "zone_logistics": lambda: bottom_office("zone_logistics", "Vessel / flight schedule", "#2dd4bf",
                                            extra=[box("Bản đồ thời tiết", [0.08, 1.2, 2.0], [-half('zone_logistics')[0] + 0.15, 1.5, -1.0], "#05080f", emissive="#38bdf8")]),
    "zone_finance": lambda: bottom_office("zone_finance", "Budget & DoA dashboard", "#fb7185"),
    "zone_asset": lambda: bottom_office("zone_asset", "Decision board", "#fde68a", visitors=2),
}

AGENTS = {
    # agent: (zone, seat label to use (n-th seat in room), color, energy)
    "ops_agent": ("zone_ops", 0, "#22c55e", 0.35),
    "prodeng_agent": ("zone_prod_eng", 0, "#38bdf8", 0.35),
    "eng_lead": ("zone_prod_eng", 2, "#e2e8f0", 0.15),
    "maint_agent": ("zone_maint", 0, "#f97316", 0.35),
    "hse_agent": ("zone_hse", 0, "#eab308", 0.35),
    "contracts_agent": ("zone_contracts", 0, "#a78bfa", 0.35),
    "logistics_agent": ("zone_logistics", 0, "#2dd4bf", 0.35),
    "finance_agent": ("zone_finance", 0, "#fb7185", 0.35),
    "asset_manager": ("zone_asset", 0, "#fde68a", 0.15),
    "oim": ("zone_ops", 2, "#cbd5e1", 0.15),  # đầu mối offshore xác nhận sẵn sàng (không cấp PTW trong hệ thống)
}


def main():
    ds = doors()
    rooms = []
    for key, (label, preset, pos, size, accent, floor) in ZONES.items():
        colors = {"accent": accent}
        if key == "corridor":
            colors["floor"] = "#3b4a5f"
        rooms.append({"preset": preset, "position": pos, "size": size, "label": label, "displayName": DISPLAY[key],
                      "displayNames": {"vi": DISPLAY[key], "en": DISPLAY_EN[key]}, "colors": colors,
                      "floorStyle": floor, "doors": ds[key], "furniture": FURNISH[key]()})
    by = dict(zip(ZONES, rooms))
    agents = {}
    for aid, (zone, nth, color, energy) in AGENTS.items():
        room = by[zone]
        seat_idx = [i for i, it in enumerate(room["furniture"]) if is_seat(it)][nth]
        agents[aid] = {"desk": f"{zone}-desk-1", "seat": f"{room['label']}::{seat_idx}", "allowedRooms": [room["label"]], "energy": energy, "color": color}
    cfg = {"name": "Offshore Ops — AI Agent Coordination", "gateway": {"url": "", "token": ""}, "view": "3d-office",
           "theme": "neon-dark", "sources": [{"type": "ingest"}], "rooms": rooms, "agents": agents}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Đã ghi {OUT}")


if __name__ == "__main__":
    main()
