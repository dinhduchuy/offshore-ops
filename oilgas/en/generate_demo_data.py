#!/usr/bin/env python3
"""
Bộ dữ liệu DEMO GIẢ LẬP (SIMULATED) cho clip LinkedIn của Offshore Ops.

    python3 oilgas/en/generate_demo_data.py --lang en [--as-of YYYY-MM-DD] --out oilgas/en/sample-data

Một giàn (SIM-WHP-A), một giếng (A-03, gas lift), một case suy giảm sản lượng.
Mọi ngày được neo theo ngày quay (--as-of, mặc định: hôm nay theo giờ Asia/Ho_Chi_Minh):
DPR kết thúc hôm qua, nên kiểm tra ngày tương lai / độ mới / hiệu lực hồ sơ của ứng dụng
vẫn chạy nguyên vẹn — không nới cấu hình nào.

Thiếu hụt có chủ đích (DUY NHẤT): lần thử giếng gần nhất của A-03 đã cũ (47 ngày > 30 ngày
theo engineering.wellTestMaxAgeDays) → bước đánh giá kỹ thuật dừng ở "Thiếu dữ liệu".
File bổ sung `supplements/SIM_well_test_A-03_<as-of − 1>.csv` giải quyết đúng thiếu hụt đó.

Không lặp lại các lỗi chất lượng cố ý của bộ mẫu kiểm thử (oilgas/sample-data): không dòng
trùng, không sai đơn vị, không cập nhật muộn, không giếng khác, không tài liệu chứa câu lệnh.
Số liệu suy giảm do hệ thống tự tính từ DPR — không có con số kết luận nào viết sẵn ở đây.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# Reuse the writers of the original generator (CSV with the SIMULATED marker line, minimal XLSX)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sample-data"))
import generate_sample_data as base  # noqa: E402

PLATFORM = "SIM-WHP-A"
WELL = "A-03"
DAYS = 21
DECLINE_FROM = 14  # day index of the first decline day
A03 = dict(lift="Gas lift", oil=1480, water=420, gas=1.45, thp=30.5, gl=1.60, choke=62)
DECLINE = [0.04, 0.08, 0.12, 0.155, 0.18, 0.195, 0.205]
GL = {13: 1.55, 14: 1.46, 15: 1.39, 16: 1.33, 17: 1.29, 18: 1.27, 19: 1.25, 20: 1.24}
DPR_HEADER = base.DPR_HEADER
WT_HEADER = ["well", "test_date", "duration_h", "oil_bbl_d", "water_bbl_d", "gas_mmscfd", "thp_bar", "chp_bar", "gl_inj_mmscfd", "choke_pct", "separator", "remarks"]


def today_hcm() -> date:
    return (datetime.now(timezone.utc) + timedelta(hours=7)).date()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--as-of", help="ngày quay (YYYY-MM-DD), mặc định hôm nay giờ Asia/Ho_Chi_Minh")
    ap.add_argument("--out", required=True)
    ap.add_argument("--lang", choices=["vi", "en"], default="vi", help="ngôn ngữ của phần chữ mô tả trong dữ liệu (số liệu, mã, ngày giữ nguyên)")
    a = ap.parse_args()
    L = (lambda vi, en: en) if a.lang == "en" else (lambda vi, en: vi)
    # The marker line flags every file as simulated (parsers.isSimulated); English wording for the EN set
    base.MARK = L(base.MARK, "# SIMULATED — illustrative data, not real figures")
    as_of = date.fromisoformat(a.as_of) if a.as_of else today_hcm()
    end = as_of - timedelta(days=1)          # last DPR day = yesterday
    start = end - timedelta(days=DAYS - 1)
    out = Path(a.out).resolve()
    sup = out / "supplements"
    sup.mkdir(parents=True, exist_ok=True)
    rng = random.Random(20261115)
    noise = lambda v, pct=0.012: v * (1 + rng.uniform(-pct, pct))  # noqa: E731
    D = lambda days: (end + timedelta(days=days)).isoformat()  # noqa: E731  offset from the last DPR day
    w = lambda name, header, rows: base.write_csv(out / name, header, rows)  # noqa: E731

    # ── DPR: 21 days, one well; decline from day 14, gas lift injection falling below setpoint ──
    dpr = []
    for i in range(DAYS):
        d = start + timedelta(days=i)
        k = i - DECLINE_FROM
        frac = DECLINE[k] if k >= 0 else 0
        o = A03["oil"] * (1 - frac)
        wat = A03["water"] + (140 * (k + 1) / 7 if k >= 0 else 0)
        g = A03["gas"] * (1 - frac * 0.8)
        p = A03["thp"] - (2.7 * (k + 1) / 7 if k >= 0 else 0)
        inj = GL.get(i, A03["gl"])
        notes = L("Lưu lượng khí gas lift thấp hơn setpoint, đang theo dõi", "Gas-lift injection below setpoint, under observation") if i == DECLINE_FROM + 2 else ""
        dpr.append([d.isoformat(), PLATFORM, WELL, round(noise(o)), "bbl/d", round(noise(g), 3), "MMscf/d", round(noise(wat)), "bbl/d",
                    24.0, 0.0, round(noise(p, 0.006), 1), "bar", round(noise(inj, 0.01), 3), "MMscf/d", A03["choke"], notes, "daily_volume",
                    f"{d + timedelta(days=1)}T06:30:00Z"])
    dpr_name = f"SIM_dpr_{start}_to_{end}.csv"
    w(dpr_name, DPR_HEADER, dpr)

    w("SIM_well_master.csv", ["well", "platform", "lift_type", "status", "reservoir", "completion_date", "allocation_method"],
      [[WELL, PLATFORM, "Gas lift", "Producing", "SIM-Res-M1", "2019-03-15", "allocated (well test)"]])
    # The deliberate gap: last well test is 47 days older than the last DPR day
    w("SIM_well_test.csv", WT_HEADER, [[WELL, D(-47), 12, 1490, 410, 1.46, 30.6, 66, 1.60, 62, "V-200", L("Ổn định", "Stable")]])

    w("SIM_activity_catalog.csv", ["activity_type", "name", "work_type", "lift_types", "addresses", "discipline", "crew_size", "duration_days", "equipment", "materials", "contract_category", "cost_code"], [
        ["well_test_rerun", L("Thử giếng lặp lại trên bình tách thử", "Repeat well test on the test separator"), "diagnostic", "", "H_MEAS", "Production", 0, 1, "", "", "", "OPX-PRD-WELLTEST"],
        ["slickline_fgs", L("Khảo sát gradient dòng chảy (FGS) bằng slickline", "Flowing gradient survey (FGS) by slickline"), "diagnostic", "Gas lift", "H_GL", "Production", 4, 2, "SLICKLINE-UNIT;PRESSURE-GAUGE-KIT", "SL-CONSUMABLES-KIT:1", "slickline", "OPX-WS-DIAG"],
        ["water_sampling", L("Lấy mẫu nước phân tích độ mặn/ion", "Water sampling for salinity / ion analysis"), "diagnostic", "", "H_WATER", "Production", 0, 1, "", "WATER-SAMPLE-KIT:2", "lab_analysis", "OPX-PRD-LAB"],
        ["pbu_survey", L("Khảo sát khôi phục áp suất (PBU) & phân tích PTA", "Pressure build-up (PBU) survey & PTA"), "diagnostic", "", "H_SKIN", "Reservoir", 4, 4, "SLICKLINE-UNIT;MEMORY-GAUGES", "SL-CONSUMABLES-KIT:1", "slickline", "OPX-WS-DIAG"],
        ["gl_fcv_inspection", L("Kiểm tra & hiệu chỉnh van điều khiển khí gas lift bề mặt (FCV)", "Inspect & recalibrate the surface gas-lift flow control valve (FCV)"), "maintenance", "Gas lift", "H_GL", "Maintenance", 0, 1, "", "FCV-TRIM-KIT-2IN:1", "", "OPX-MNT-TOPS"],
    ])
    w("SIM_maintenance_history.csv", ["wo_no", "well", "equipment_tag", "system", "wo_type", "description", "status", "raised_date", "due_date", "closed_date"], [
        ["WO-23990", WELL, "GLV-A03-1850", "Gas lift", "CM", L("Thay van gas lift độ sâu 1,850 m", "Replace gas-lift valve at 1,850 m"), "Closed", D(-470), D(-447), D(-452)],
        ["WO-24811", WELL, "FCV-A03-GL", "Gas lift", "PM", L("Hiệu chỉnh van điều khiển khí gas lift FCV-A03", "Recalibrate gas-lift control valve FCV-A03"), "Overdue", D(-57), D(-22), ""],
        ["WO-24890", "", "K-100", "Gas compression", "CM", L("Máy nén khí gas lift K-100 trip 2h, khởi động lại", "Gas-lift compressor K-100 tripped for 2 h, restarted"), "Closed", D(-7), D(-7), D(-7)],
    ])
    w("SIM_spare_parts.csv", ["part_no", "description", "system", "qty_offshore", "qty_onshore", "lead_time_days", "weight_t", "deck_m2"], [
        ["FCV-TRIM-KIT-2IN", L("Bộ trim van FCV 2 inch", "2-inch FCV trim kit"), "Gas lift", 0, 1, 21, 0.04, 0.2],
        ["SL-CONSUMABLES-KIT", L("Bộ vật tư tiêu hao slickline (dây, seal, dụng cụ)", "Slickline consumables kit (wire, seals, tools)"), "Well services", 0, 0, 10, 0.3, 1.0],
        ["WATER-SAMPLE-KIT", L("Bộ chai lấy mẫu nước", "Water sample bottle kit"), "Production", 6, 10, 5, 0.01, 0.1],
    ])
    # HSE register: all current (the only gap of the demo is the well test)
    w("SIM_hse_documents.csv", ["doc_id", "title", "doc_type", "activity_type", "scope", "status", "valid_from", "valid_to"], [
        ["HSE-RA-0412", L("Đánh giá rủi ro công tác slickline trên WHP-A (rev.2)", "Risk assessment — slickline work on WHP-A (rev.2)"), "risk_assessment", "slickline_fgs", PLATFORM, "Approved", D(-30), D(350)],
        ["HSE-JSA-1102", L("JSA công tác slickline", "JSA — slickline work"), "jsa", "slickline_fgs", PLATFORM, "Approved", D(-60), D(140)],
        ["HSE-RA-0419", L("Đánh giá rủi ro khảo sát PBU", "Risk assessment — PBU survey"), "risk_assessment", "pbu_survey", PLATFORM, "Approved", D(-60), D(230)],
        ["HSE-JSA-1150", L("JSA lấy mẫu chất lưu", "JSA — fluid sampling"), "jsa", "water_sampling", PLATFORM, "Approved", D(-60), D(80)],
        ["HSE-RA-0501", L("Đánh giá rủi ro bảo dưỡng van bề mặt", "Risk assessment — surface valve maintenance"), "risk_assessment", "gl_fcv_inspection", PLATFORM, "Approved", D(-60), D(200)],
        ["HSE-JSA-1201", L("JSA bảo dưỡng van điều khiển khí", "JSA — gas control valve maintenance"), "jsa", "gl_fcv_inspection", PLATFORM, "Approved", D(-30), D(200)],
        ["HSE-ISO-0333", L("Kế hoạch cô lập FCV gas lift", "Isolation plan — gas-lift FCV"), "isolation_plan", "gl_fcv_inspection", PLATFORM, "Approved", D(-60), D(80)],
        ["HSE-SIM-0077", L("Kế hoạch SIMOPS can thiệp giếng trên WHP-A", "SIMOPS plan — well intervention on WHP-A"), "simops_plan", "", PLATFORM, "Approved", D(-30), D(140)],
        ["WBS-A03-2025", L("Sơ đồ barrier giếng A-03", "Well barrier schematic A-03"), "well_barrier_schematic", "", WELL, "Approved", D(-300), D(50)],
        ["HSE-JSA-0900", L("JSA thử giếng", "JSA — well test"), "jsa", "well_test_rerun", PLATFORM, "Approved", D(-60), D(110)],
    ])
    w("SIM_permit_matrix.csv", ["activity_type", "permit_type", "required_documents"], [
        ["slickline_fgs", L("Giấy phép can thiệp giếng (Well intervention PTW)", "Well intervention PTW"), "risk_assessment;jsa;well_barrier_schematic;simops_plan"],
        ["pbu_survey", L("Giấy phép can thiệp giếng (Well intervention PTW)", "Well intervention PTW"), "risk_assessment;jsa;well_barrier_schematic;simops_plan"],
        ["water_sampling", L("Giấy phép công việc nguội (Cold work PTW)", "Cold work PTW"), "jsa"],
        ["gl_fcv_inspection", L("Giấy phép công việc nguội + chứng nhận cô lập", "Cold work PTW + isolation certificate"), "risk_assessment;jsa;isolation_plan"],
        ["well_test_rerun", L("Giấy phép công việc nguội (Cold work PTW)", "Cold work PTW"), "jsa"],
    ])
    w("SIM_contracts.csv", ["contract_no", "vendor", "scope_categories", "valid_from", "valid_to", "ceiling_usd", "committed_usd"], [
        ["SIM-C-2024-017", "SIM Wireline Services Co.", "slickline;wireline", "2024-03-01", D(470), 2400000, 1985000],
        ["SIM-C-2025-044", "SIM Lab Analytics", "lab_analysis", "2025-01-01", D(410), 150000, 61000],
    ])
    w("SIM_rate_sheet.csv", ["contract_no", "item_code", "description", "unit", "rate_usd", "applies_to"], [
        ["SIM-C-2024-017", "SL-01", L("Slickline unit & crew (4 người)", "Slickline unit & crew (4 people)"), "day", 6200, "slickline_fgs"],
        ["SIM-C-2024-017", "SL-02", "Mob/demob slickline spread", "lump sum", 8500, "slickline_fgs"],
        ["SIM-C-2024-017", "SL-03", L("Thuê bộ đo áp suất/nhiệt độ", "Pressure/temperature gauge rental"), "day", 450, "slickline_fgs"],
        ["SIM-C-2024-017", "SL-04", L("Xử lý dữ liệu & báo cáo FGS", "FGS data processing & report"), "job", 2200, "slickline_fgs"],
        ["SIM-C-2024-017", "SL-11", "Memory gauges PBU", "day", 900, "pbu_survey"],
        ["SIM-C-2025-044", "LB-01", L("Phân tích nước (2 mẫu: độ mặn, ion)", "Water analysis (2 samples: salinity, ions)"), "job", 760, "water_sampling"],
    ])
    # One quote of the two required (procurement.minQuotes = 2): after scope approval the contracts
    # agent drafts an RFQ for a second quote — a normal procurement step (waivable at the commitment
    # gate), not a blocking data gap. It is what scene 5 of the clip shows.
    w("SIM_quotes.csv", ["rfq_ref", "part_no", "vendor", "unit_price_usd", "qty", "lead_time_days", "valid_to", "document_ref"], [
        ["RFQ-2026-118", "SL-CONSUMABLES-KIT", "SIM Supply Co. A", 6800, 1, 10, D(47), ""],
    ])
    w("SIM_cost_estimates.csv", ["item", "unit", "estimate_usd", "basis"], [
        ["SL-CONSUMABLES-KIT", "kit", 7500, L("Giá mua lần trước + 5% (giả lập)", "Last purchase price + 5% (simulated)")],
        ["vessel_deck_m2", "m²", 450, L("Đơn giá phân bổ boong PSV bình quân (ước tính nội bộ giả lập)", "Average allocated PSV deck rate (simulated internal estimate)")],
        ["helicopter_seat_roundtrip", L("ghế", "seat"), 2900, L("Giá ghế trực thăng khứ hồi bình quân (giả lập)", "Average round-trip helicopter seat price (simulated)")],
    ])
    w("SIM_equipment_catalog.csv", ["item", "description", "weight_t", "deck_m2"], [
        ["SLICKLINE-UNIT", L("Cụm thiết bị slickline (tời, cột, BOP)", "Slickline spread (winch, mast, BOP)"), 7.5, 14.0],
        ["PRESSURE-GAUGE-KIT", L("Bộ đồng hồ áp suất/nhiệt độ", "Pressure/temperature gauge kit"), 0.2, 0.5],
        ["MEMORY-GAUGES", "Memory gauges PBU", 0.15, 0.5],
    ])
    # Transport + weather, relative to the last DPR day (same offsets as the reference sample set)
    voyages, d, n = [], end + timedelta(days=5), 1101
    while d <= end + timedelta(days=110):
        voyages.append([f"V-{n}", "SIM Ocean Star", d.isoformat(), PLATFORM, 30, 10, "Scheduled"])
        n += 1
        d += timedelta(days=4 if n % 2 else 3)
    w("SIM_vessel_schedule.csv", ["voyage_id", "vessel", "depart_date", "destination", "deck_m2_free", "max_lift_t", "status"], voyages)
    w("SIM_flight_schedule.csv", ["flight_id", "flight_date", "destination", "seats_free"],
      [[f"HL-{k + 1:04d}", (end + timedelta(days=3 + k)).isoformat(), PLATFORM, 6] for k in range(105)])
    wx = []
    for i in range(34):
        dd = end + timedelta(days=1 + i)
        wx.append([dd.isoformat(), PLATFORM, round(rng.uniform(1.0, 2.1), 1), round(rng.uniform(10, 26)), f"{as_of}T00:00:00Z"])
    w("SIM_weather_forecast.csv", ["forecast_date", "location", "hs_m", "wind_kn", "issued_at"], wx)
    w("SIM_logistics_limits.csv", ["parameter", "value", "unit", "note"], [
        ["max_hs_vessel_m", 2.5, "m", L("Giới hạn sóng cho PSV cập giàn", "Wave limit for PSV alongside")],
        ["max_hs_crane_m", 2.5, "m", L("Giới hạn sóng cho cẩu hàng", "Wave limit for crane lifts")],
        ["max_wind_heli_kn", 35, "kn", L("Giới hạn gió cho trực thăng", "Wind limit for helicopters")],
        ["pob_max", 80, L("người", "persons"), L("Sức chứa POB tối đa", "Maximum POB")],
        ["pob_current", 74, L("người", "persons"), L("POB hiện tại", "Current POB")],
    ])
    base.write_xlsx(out / "SIM_budget_FY2026.xlsx", ["cost_code", "description", "period", "budget_usd", "actual_usd", "committed_usd", "afe_required", "afe_no"], [
        ["OPX-WS-DIAG", L("Dịch vụ giếng — chẩn đoán", "Well services — diagnostics"), "FY2026", 600000, 452300, 106500, "no", ""],
        ["OPX-PRD-LAB", L("Phân tích phòng thí nghiệm", "Laboratory analysis"), "FY2026", 80000, 52100, 9000, "no", ""],
        ["OPX-LOG-MAR", L("Hậu cần hàng hải & hàng không", "Marine & aviation logistics"), "FY2026", 1200000, 1010000, 120000, "no", ""],
        ["OPX-MNT-TOPS", L("Bảo dưỡng thiết bị bề mặt", "Topsides maintenance"), "FY2026", 300000, 211000, 30000, "no", ""],
        ["OPX-PRD-WELLTEST", L("Thử giếng", "Well testing"), "FY2026", 50000, 21000, 0, "no", ""],
    ])
    w("SIM_authority_matrix.csv", ["role", "max_usd", "scope"], [
        ["OIM", 25000, L("Chi phí vận hành phát sinh", "Incidental operating costs")],
        ["Asset Manager", 250000, L("OPEX trong ngân sách", "OPEX within budget")],
        ["Phó Tổng Giám đốc", 1000000, "OPEX/CAPEX"],
        ["Tổng Giám đốc", 5000000, L("Mọi khoản chi", "All spend")],
    ])

    # ── The one supplement: a fresh well test (dated the last DPR day — never in the future) ──
    wt_name = f"supplements/SIM_well_test_{WELL}_{end}.csv"
    w(wt_name, WT_HEADER, [[WELL, end.isoformat(), 12, 1172, 548, 1.18, 27.9, 61, 1.24, 62, "V-200", L("Thử giếng sau suy giảm; lưu lượng gas lift thấp hơn setpoint 1.60", "Test after the decline; gas-lift rate below the 1.60 setpoint")]])

    base_files = ["SIM_well_master.csv", "SIM_activity_catalog.csv", "SIM_maintenance_history.csv", "SIM_spare_parts.csv",
                  "SIM_hse_documents.csv", "SIM_permit_matrix.csv", "SIM_contracts.csv", "SIM_rate_sheet.csv", "SIM_quotes.csv",
                  "SIM_cost_estimates.csv", "SIM_equipment_catalog.csv", "SIM_vessel_schedule.csv", "SIM_flight_schedule.csv",
                  "SIM_weather_forecast.csv", "SIM_logistics_limits.csv", "SIM_budget_FY2026.xlsx", "SIM_authority_matrix.csv",
                  "SIM_well_test.csv", dpr_name]
    manifest = {
        "simulated": True,
        "description": L(f"Bộ dữ liệu DEMO GIẢ LẬP — giàn {PLATFORM}, giếng {WELL}, một case suy giảm sản lượng (ngày quay {as_of}).", f"SIMULATED DEMO data set — platform {PLATFORM}, well {WELL}, one production-decline case (recording date {as_of})."),
        "language": a.lang,
        "asOf": as_of.isoformat(),
        "dprPeriod": {"from": start.isoformat(), "to": end.isoformat()},
        "deliberateGap": {"what": L("Thử giếng A-03 gần nhất đã cũ", "Latest A-03 well test is too old"), "date": D(-47), "maxAgeDays": 30, "resolvedBy": wt_name},
        "expectedProcurementStep": L("Chỉ 1/2 báo giá cho SL-CONSUMABLES-KIT → sau khi duyệt phạm vi, RFQ nháp xin thêm chào giá (không chặn luồng)", "Only 1 of 2 quotes for SL-CONSUMABLES-KIT → after scope approval, a draft RFQ asks for another quote (not blocking)"),
        "base": base_files,
        "supplements": [wt_name],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Đã sinh bộ dữ liệu DEMO GIẢ LẬP tại {out} (as-of {as_of}, DPR {start} → {end})")


if __name__ == "__main__":
    main()
