#!/usr/bin/env python3
"""
Nạp preset mặt bằng "Offshore Operator HQ" vào Diorama đang chạy.

    python oilgas/load_office_preset.py                 # nạp templates/oil-gas-operator/diorama.config.json
    python oilgas/load_office_preset.py --restore FILE  # khôi phục một bản sao lưu

Preset được ghi qua API POST /api/config (Diorama lưu vào ~/.diorama/config.json).
Nếu đang có cấu hình khác, bản cũ được sao lưu vào oilgas/backups/ trước khi ghi đè.
Sau khi nạp: tải lại trang http://localhost:3000 trên trình duyệt.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

try:
    import requests
except ImportError:  # pragma: no cover
    sys.exit("Thiếu thư viện 'requests' — chạy: pip install -r oilgas/requirements.txt")

ROOT = Path(__file__).resolve().parent.parent
PRESET = ROOT / "templates" / "oil-gas-operator" / "diorama.config.json"
BACKUP_DIR = Path(__file__).resolve().parent / "backups"
DEFAULT_URL = os.environ.get("DIORAMA_URL", "http://localhost:3000")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--preset", default=str(PRESET), help="File cấu hình cần nạp")
    ap.add_argument("--restore", metavar="FILE", help="Nạp lại một bản sao lưu thay vì preset")
    args = ap.parse_args()
    base = args.url.rstrip("/")
    source = Path(args.restore or args.preset)
    new_config = json.loads(source.read_text(encoding="utf-8"))

    try:
        current = requests.get(f"{base}/api/config", timeout=10).json()
    except requests.RequestException as exc:
        print(f"✗ Không kết nối được Diorama tại {base}: {exc}")
        return 1

    if current.get("exists") and current["config"] != new_config:
        BACKUP_DIR.mkdir(exist_ok=True)
        backup = BACKUP_DIR / f"config-{datetime.now():%Y%m%d-%H%M%S}.json"
        backup.write_text(json.dumps(current["config"], indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"• Đã sao lưu cấu hình cũ \"{current['config'].get('name')}\" → {backup}")

    r = requests.post(f"{base}/api/config", json=new_config, timeout=10)
    if r.status_code != 200 or not r.json().get("ok"):
        print(f"✗ Nạp thất bại: HTTP {r.status_code} {r.text[:200]}")
        return 1

    rooms = new_config.get("rooms", [])
    print(f"✓ Đã nạp \"{new_config.get('name')}\" — {len(rooms)} phòng, {len(new_config.get('agents', {}))} agent")
    for room in rooms:
        print(f"   - {room['label']}")
    print(f"→ Tải lại {base} trên trình duyệt để xem mặt bằng mới.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
