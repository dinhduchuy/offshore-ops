#!/usr/bin/env python3
"""
Mô phỏng luồng phối hợp AI Agents liên phòng ban — sự cố giếng khai thác WHP-02.

Gửi HTTP POST tới endpoint /api/ingest của Diorama (protocol v1) để các agent
trong văn phòng 3D di chuyển giữa các zone và hiển thị hoạt động theo 5 giai đoạn:

  1. Operations              — DPR phát hiện WHP-02 giảm 18% lưu lượng, Water Cut tăng → cảnh báo tại zone_ops
  2. Ops + Subsurface + G&G  — họp tại zone_war_room, chốt Matrix Acidizing (Skin factor cao)
  3. Subsurface → Contract   — bàn giao SOW, kiểm tra đơn giá hợp đồng khung dịch vụ giếng
  4. Contract → Accounting   — dự toán $245,000, kiểm tra AFE-2026-INT-09 & Cost Recovery
  5. Accounting → Operations — báo cáo hoàn tất, phát lệnh huy động thiết bị ra giàn

Cách dùng:
    python oilgas/simulate_offshore_workflow.py                  # chạy thời gian thực (~3 phút)
    python oilgas/simulate_offshore_workflow.py --speed 0        # gửi liền, không chờ (kiểm thử nhanh)
    python oilgas/simulate_offshore_workflow.py --stage 3        # chỉ chạy giai đoạn 3
    python oilgas/simulate_offshore_workflow.py --dry-run        # in payload, không gửi
    python oilgas/simulate_offshore_workflow.py --batch          # gửi mỗi giai đoạn thành 1 request mảng

Biến môi trường: DIORAMA_URL (mặc định http://localhost:3000)

Mã thoát: 0 = mọi request được chấp nhận (HTTP 200, ok=true); 1 = có lỗi HTTP/kết nối; 2 = mặt bằng chưa nạp.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

try:
    import requests
except ImportError:  # pragma: no cover
    sys.exit("Thiếu thư viện 'requests' — chạy: pip install -r oilgas/requirements.txt")

DEFAULT_URL = os.environ.get("DIORAMA_URL", "http://localhost:3000")

ZONES = ["zone_ops", "zone_subsurface", "zone_gg", "zone_contract", "zone_accounting", "zone_war_room"]
AGENT_HOME = {
    "agent_ops_lead": "zone_ops",
    "agent_reservoir_eng": "zone_subsurface",
    "agent_geologist": "zone_gg",
    "agent_contract_spec": "zone_contract",
    "agent_cost_controller": "zone_accounting",
}

# ── Ước lượng thời gian đi bộ (khớp mặt bằng templates/oil-gas-operator) ──
# Tâm phòng và cửa ra hành lang, đơn vị ô lưới; 1 ô = 3.6 đơn vị 3D; tốc độ đi 2.5 đơn vị/giây.
_ROOM = {  # zone: (tâm x, tâm y, cửa x, cửa y)
    "zone_ops": (2.0, 1.5, 2.0, 3.0),
    "zone_subsurface": (5.5, 1.5, 5.5, 3.0),
    "zone_gg": (8.5, 1.5, 8.5, 3.0),
    "zone_accounting": (1.5, 5.5, 1.5, 4.0),
    "zone_war_room": (5.0, 5.5, 5.0, 4.0),
    "zone_contract": (8.5, 5.5, 8.5, 4.0),
}
GRID_WORLD, WALK_SPEED, WALK_MARGIN_S = 3.6, 2.5, 2.0


def walk_seconds(src: str, dst: str) -> float:
    if src == dst:
        return 0.0
    sx, sy, sdx, sdy = _ROOM[src]
    tx, ty, tdx, tdy = _ROOM[dst]
    cells = math.dist((sx, sy), (sdx, sdy)) + math.dist((sdx, sdy), (tdx, tdy)) + math.dist((tdx, tdy), (tx, ty))
    return cells * GRID_WORLD / WALK_SPEED + WALK_MARGIN_S


INCIDENT_ID = "INC-WHP02-" + datetime.now().strftime("%Y%m%d")
WORKFLOW = "WHP-02 Production Loss → Matrix Acidizing"


@dataclass
class Step:
    agent: str
    type: str
    room: str
    label: str
    payload: dict = field(default_factory=dict)
    pause: float = 3.0  # giây chờ sau bước này (ngoài thời gian đi bộ)


@dataclass
class Stage:
    number: int
    title: str
    steps: list[Step]


def build_stages() -> list[Stage]:
    dpr = {"report_date": datetime.now().strftime("%Y-%m-%d"), "field": "Block 15-1 / WHP", "wells_online": 14,
           "total_oil_bopd": 9850}
    return [
        Stage(1, "Operations — phát hiện suy giảm sản lượng WHP-02", [
            Step("agent_ops_lead", "report.intake", "zone_ops",
                 "tiếp nhận DPR ngày — 14 giếng online, tổng 9,850 bopd", {"dpr": dpr}),
            Step("agent_ops_lead", "anomaly.detected", "zone_ops",
                 "phát hiện WHP-02: lưu lượng 1,420 → 1,164 bopd (−18%), Water Cut 22% → 31%",
                 {"well": "WHP-02", "oil_rate_bopd": {"baseline": 1420, "current": 1164, "change_pct": -18.0},
                  "water_cut_pct": {"baseline": 22, "current": 31}, "thp_psi": {"baseline": 685, "current": 612}}),
            Step("agent_ops_lead", "attention.requested", "zone_ops",
                 "⚠ CẢNH BÁO WHP-02: −18% lưu lượng, Water Cut tăng — cần họp kỹ thuật khẩn",
                 {"severity": "high", "well": "WHP-02"}, pause=6),
        ]),
        Stage(2, "Ops + Subsurface + G&G — hội ý kỹ thuật tại War Room", [
            Step("agent_ops_lead", "session.started", "zone_war_room",
                 "triệu tập & chủ trì họp kỹ thuật khẩn WHP-02", {"meeting": "Technical Peer Review"}, pause=0.5),
            Step("agent_reservoir_eng", "session.joined", "zone_war_room",
                 "tham gia họp WHP-02 (mang theo kết quả PTA/Nodal)", pause=0.5),
            Step("agent_geologist", "session.joined", "zone_war_room",
                 "tham gia họp WHP-02 (mang theo bản đồ cấu trúc & log giếng)", pause=1),
            Step("agent_ops_lead", "document.presented", "zone_war_room",
                 "trình bày xu hướng sản lượng 30 ngày & lịch sử can thiệp WHP-02", pause=5),
            Step("agent_reservoir_eng", "review.analysis", "zone_war_room",
                 "phân tích PTA/Nodal: Skin factor S = +12 → nhiễm bẩn vùng cận đáy giếng",
                 {"skin_factor": 12, "permeability_md": 85, "pi_drop_pct": 35}, pause=5),
            Step("agent_geologist", "review.peer", "zone_war_room",
                 "peer review: vỉa cát kết Miocene ổn định, không có dấu hiệu water coning → loại trừ nguyên nhân địa chất",
                 {"formation": "Miocene sandstone", "coning_risk": "low"}, pause=5),
            Step("agent_ops_lead", "council.decision", "zone_war_room",
                 "CHỐT phương án: Matrix Acidizing (HCl 15% / HF 1.5%), kỳ vọng phục hồi +250 bopd",
                 {"decision": "Matrix Acidizing", "treatment": "HCl 15% + HF 1.5% (mud acid)",
                  "expected_gain_bopd": 250}, pause=5),
            Step("agent_geologist", "task.completed", "zone_gg", "quay về phòng G&G", pause=0.5),
            Step("agent_ops_lead", "task.completed", "zone_ops", "quay về phòng Operations theo dõi giếng", pause=1),
        ]),
        Stage(3, "Subsurface → Contract Management — bàn giao SOW", [
            Step("agent_reservoir_eng", "message.sent", "zone_contract",
                 "mang Scope of Work sang Contract Management", pause=1),
            Step("agent_reservoir_eng", "document.handover", "zone_contract",
                 "bàn giao SOW-WHP02-ACID-01: 120 bbl acid, Coiled Tubing unit, N2 lift",
                 {"sow_id": "SOW-WHP02-ACID-01", "acid_volume_bbl": 120,
                  "equipment": ["Coiled Tubing unit", "Acid pumping spread", "N2 unit"]}, pause=5),
            Step("agent_contract_spec", "review.contract_rates", "zone_contract",
                 "đối chiếu đơn giá Hợp đồng khung dịch vụ giếng FA-WS-2025-03",
                 {"frame_agreement": "FA-WS-2025-03", "rate_check": "within schedule of rates"}, pause=5),
            Step("agent_contract_spec", "estimate.prepared", "zone_contract",
                 "lập dự toán $245,000 (dịch vụ $168k · hóa phẩm $52k · logistics $25k)",
                 {"estimate_usd": 245000, "breakdown_usd": {"services": 168000, "chemicals": 52000, "logistics": 25000}},
                 pause=4),
            Step("agent_reservoir_eng", "task.completed", "zone_subsurface", "quay về phòng Subsurface", pause=1),
        ]),
        Stage(4, "Contract Management → Accounting — kiểm soát ngân sách", [
            Step("agent_contract_spec", "message.sent", "zone_accounting",
                 "chuyển dự toán $245,000 sang Accounting", {"estimate_usd": 245000}, pause=1),
            Step("agent_cost_controller", "review.afe_budget", "zone_accounting",
                 "kiểm tra AFE-2026-INT-09: ngân sách $380,000, đã dùng $96,500 → còn $283,500 ≥ $245,000 ✔",
                 {"afe": "AFE-2026-INT-09", "budget_usd": 380000, "spent_usd": 96500, "available_usd": 283500,
                  "requested_usd": 245000, "sufficient": True}, pause=5),
            Step("agent_cost_controller", "review.cost_recovery", "zone_accounting",
                 "Cost Recovery: chi phí can thiệp giếng thuộc OPEX được thu hồi theo PSC ✔",
                 {"psc_cost_category": "OPEX - Well Intervention", "recoverable": True}, pause=5),
            Step("agent_cost_controller", "verdict.approved", "zone_accounting",
                 "phê duyệt cam kết ngân sách $245,000 theo AFE-2026-INT-09",
                 {"afe": "AFE-2026-INT-09", "approved_usd": 245000}, pause=3),
            Step("agent_contract_spec", "task.completed", "zone_contract", "quay về phòng Contract Management", pause=1),
        ]),
        Stage(5, "Accounting → Operations — phát lệnh huy động", [
            Step("agent_cost_controller", "message.sent", "zone_ops",
                 "mang kết quả phê duyệt AFE sang Operations", pause=1),
            Step("agent_cost_controller", "document.presented", "zone_ops",
                 "báo cáo hoàn tất: AFE đã duyệt, đủ điều kiện Cost Recovery", pause=4),
            Step("agent_ops_lead", "herald.mobilization", "zone_ops",
                 "PHÁT LỆNH huy động CT unit, bơm axit & tàu dịch vụ ra giàn WHP — ETA 48h",
                 {"order": "MOB-WHP02-ACID", "eta_hours": 48, "vessel": "PSV", "approved_usd": 245000}, pause=4),
            Step("agent_ops_lead", "task.completed", "zone_ops",
                 "đóng bước phê duyệt sự cố WHP-02 ✔ — chuyển sang thi công", {"status": "mobilizing"}, pause=1),
            Step("agent_cost_controller", "task.completed", "zone_accounting", "quay về phòng Accounting", pause=1),
        ]),
    ]


def to_event(step: Step, stage: Stage) -> dict:
    """Payload đúng schema IngestEventSchema (packages/engine/src/protocol.ts)."""
    return {
        "v": 1,
        "type": step.type,
        "agent": step.agent,
        "room": step.room,
        "label": step.label,
        "ts": int(time.time() * 1000),
        "payload": {
            "incident_id": INCIDENT_ID,
            "workflow": WORKFLOW,
            "stage": stage.number,
            "stage_title": stage.title,
            **step.payload,
        },
    }


class Client:
    def __init__(self, base_url: str, dry_run: bool):
        self.url = base_url.rstrip("/")
        self.dry_run = dry_run
        self.session = requests.Session()
        self.sent = 0
        self.errors: list[str] = []

    def post(self, body: dict | list) -> bool:
        if self.dry_run:
            print(json.dumps(body, ensure_ascii=False, indent=2))
            self.sent += len(body) if isinstance(body, list) else 1
            return True
        for attempt in range(3):
            try:
                r = self.session.post(f"{self.url}/api/ingest", json=body, timeout=10)
                break
            except requests.RequestException as exc:
                if attempt == 2:
                    self.errors.append(f"kết nối thất bại: {exc}")
                    print(f"    ✗ kết nối thất bại: {exc}")
                    return False
                time.sleep(1.5 * (attempt + 1))
        try:
            data = r.json()
        except ValueError:
            data = {"raw": r.text[:200]}
        if r.status_code != 200 or not data.get("ok"):
            msg = f"HTTP {r.status_code}: {data}"
            self.errors.append(msg)
            print(f"    ✗ {msg}")
            return False
        self.sent += data.get("accepted", 0)
        return True

    def check_layout(self) -> list[str]:
        """Trả về danh sách zone chưa có trong mặt bằng đang nạp (rỗng = OK)."""
        r = self.session.get(f"{self.url}/api/config", timeout=10)
        data = r.json()
        if not data.get("exists"):
            return list(ZONES)
        labels = " | ".join(room.get("label", "") for room in data["config"].get("rooms", [])).lower()
        return [z for z in ZONES if z not in labels]


def run(args) -> int:
    if args.dry_run:
        args.speed = 0  # chỉ in payload — không cần chờ agent di chuyển
    client = Client(args.url, args.dry_run)
    stages = [s for s in build_stages() if args.stage in (None, s.number)]

    if not args.dry_run:
        try:
            missing = client.check_layout()
        except requests.RequestException as exc:
            print(f"✗ Không kết nối được Diorama tại {client.url}: {exc}")
            print("  → Khởi động server: cd packages/app && npx next dev -p 3000")
            return 1
        if missing:
            print(f"✗ Mặt bằng hiện tại thiếu zone: {', '.join(missing)}")
            print("  → Nạp preset trước: python oilgas/load_office_preset.py")
            if not args.force:
                return 2

    print(f"▶ {WORKFLOW}  [{INCIDENT_ID}]  → {client.url}/api/ingest  (speed={args.speed})\n")
    location = dict(AGENT_HOME)
    arrival: dict[str, float] = {}  # agent → thời điểm (monotonic) dự kiến tới phòng đích

    def wait_until(deadline: float) -> None:
        remaining = deadline - time.monotonic()
        if remaining > 0.2:
            print(f"     ⏳ chờ agent di chuyển tới nơi ~{remaining:.0f}s")
            time.sleep(remaining)

    for stage in stages:
        print(f"━━ Giai đoạn {stage.number}: {stage.title}")
        if args.batch:
            events = [to_event(s, stage) for s in stage.steps]
            ok = client.post(events)
            print(f"   {'✓' if ok else '✗'} batch {len(events)} sự kiện")
            if args.speed:
                time.sleep(8 * args.speed)
            continue
        for step in stage.steps:
            if args.speed:
                # Agent phải tới nơi trước khi làm việc tiếp; sự kiện diễn ra TRONG một phòng
                # còn chờ mọi agent đang trên đường tới phòng đó (vd. cuộc họp tại War Room).
                deadline = arrival.get(step.agent, 0.0)
                if step.room == location[step.agent]:
                    deadline = max([deadline] + [arrival.get(a, 0.0) for a, r in location.items() if r == step.room])
                wait_until(deadline)
            ok = client.post(to_event(step, stage))
            mark = "✓" if ok else "✗"
            print(f"   {mark} {step.agent:<22} {step.type:<22} @{step.room:<16} {step.label}")
            walk = walk_seconds(location[step.agent], step.room)
            location[step.agent] = step.room
            if args.speed:
                arrival[step.agent] = time.monotonic() + walk * args.speed
                time.sleep(step.pause * args.speed)
        print()
    if args.speed:
        wait_until(max(arrival.values(), default=0.0))

    print(f"Tổng: {client.sent} sự kiện được chấp nhận, {len(client.errors)} lỗi.")
    return 1 if client.errors else 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=DEFAULT_URL, help=f"Địa chỉ Diorama (mặc định {DEFAULT_URL})")
    ap.add_argument("--speed", type=float, default=1.0,
                    help="Hệ số thời gian chờ: 1 = thời gian thực, 0.5 = nhanh gấp đôi, 0 = không chờ")
    ap.add_argument("--stage", type=int, choices=range(1, 6), help="Chỉ chạy một giai đoạn (1-5)")
    ap.add_argument("--batch", action="store_true", help="Gửi mỗi giai đoạn thành 1 request dạng mảng")
    ap.add_argument("--dry-run", action="store_true", help="Chỉ in payload JSON, không gửi")
    ap.add_argument("--force", action="store_true", help="Vẫn gửi dù mặt bằng chưa có đủ zone")
    sys.stdout.reconfigure(line_buffering=True)  # log hiện ngay cả khi chạy qua pipe / n8n Execute Command
    sys.exit(run(ap.parse_args()))


if __name__ == "__main__":
    main()
