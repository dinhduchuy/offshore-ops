# Offshore Operator HQ: trực quan hóa 3D AI Agents liên phòng ban

> **Hệ thống phối hợp AI agent đầy đủ (workflow, dữ liệu, phê duyệt, truy vết):** xem [OPS_GUIDE.md](OPS_GUIDE.md) — trang <http://localhost:3000/ops>. Tài liệu dưới đây mô tả bản demo mô phỏng ban đầu.

Văn phòng 3D của một công ty điều hành dầu khí, chạy trên Diorama. Có 6 zone chức năng và 5 AI Agent. Các agent di chuyển giữa các phòng theo sự kiện gửi tới `POST /api/ingest`.

| Thành phần | File |
|---|---|
| Preset mặt bằng (đã sinh sẵn) | `templates/oil-gas-operator/diorama.config.json` |
| Script sinh mặt bằng (sửa ở đây rồi chạy lại) | `oilgas/generate_layout.py` |
| Script nạp preset vào app | `oilgas/load_office_preset.py` |
| Script mô phỏng sự cố WHP-02 | `oilgas/simulate_offshore_workflow.py` |
| Test tự động cho mặt bằng | `packages/cli/src/oilGasTemplate.test.ts` |

---

## 1. Vận hành nhanh

```bash
cd "3D Phòng Ban"

# (lần đầu) cài dependencies
npm install
python3 -m venv oilgas/.venv && oilgas/.venv/bin/pip install -r oilgas/requirements.txt

# 1) chạy Diorama ở http://localhost:3000 (để terminal này chạy nền)
cd packages/app && npx next dev -p 3000

# 2) ở terminal khác: nạp preset mặt bằng, rồi mở/tải lại http://localhost:3000
oilgas/.venv/bin/python oilgas/load_office_preset.py

# 3) chạy kịch bản WHP-02 (thời gian thực ~2 phút 10 giây; trình duyệt phải đang mở trang)
oilgas/.venv/bin/python oilgas/simulate_offshore_workflow.py
```

Các tùy chọn của script mô phỏng:

| Lệnh | Tác dụng |
|---|---|
| `--speed 0.5` | Nhanh gấp đôi (`0` = gửi liền, không chờ agent đi bộ) |
| `--stage 3` | Chỉ chạy một giai đoạn (1–5) |
| `--batch` | Gửi mỗi giai đoạn thành 1 request dạng mảng |
| `--dry-run` | Chỉ in payload JSON, không gửi |
| `--url http://host:3000` | Đổi địa chỉ server (hoặc đặt biến môi trường `DIORAMA_URL`) |

Mã thoát: `0` nghĩa là mọi sự kiện được nhận (HTTP 200). `1` nghĩa là có lỗi HTTP hoặc lỗi kết nối. `2` nghĩa là mặt bằng chưa được nạp.

**Lưu ý khi xem:**
- Các sự kiện chỉ hiện lên những trình duyệt đang mở trang lúc sự kiện tới. Server không lưu lại lịch sử, nên hãy mở trang trước rồi mới chạy script.
- Sau khi nạp preset phải tải lại trang (F5).
- Muốn quay về văn phòng cũ, chạy `load_office_preset.py --restore oilgas/backups/<file>.json`.

---

## 2. Mặt bằng

```
    x=0        4        7        10      (đơn vị: ô lưới; 1 ô = 3.6 đơn vị 3D)
  y=0 +--------+--------+--------+
      |  OPS   |  SUB   |  G&G   |      cửa ở tường Nam
  y=3 +---D----+---D----+---D----+
      |       HÀNH LANG TRUNG TÂM       6 cửa, trùng khớp với cửa từng phòng
  y=4 +--D-----+----D------+--D--+
      |  ACC   |  WAR ROOM  | CON |      cửa ở tường Bắc
  y=7 +--------+------------+-----+
```

| Zone | Nhãn phòng | Agent | Bố trí |
|---|---|---|---|
| `zone_ops` | Phòng Operations | `agent_ops_lead` | Video wall 4 màn hình (sản lượng, áp suất WHP, Water Cut/GOR, SCADA alarms), bàn trưởng ca 3 màn hình, 4 bàn kỹ sư vận hành, tủ SCADA |
| `zone_subsurface` | Phòng Subsurface | `agent_reservoir_eng` | Màn hình mô phỏng vỉa, mô hình vỉa 3D (hologram), 2 workstation |
| `zone_gg` | Phòng G&G Exploration | `agent_geologist` | Màn hình minh giải địa chấn, bàn mẫu lõi (core table), tủ bản đồ |
| `zone_contract` | Phòng Contract Management | `agent_contract_spec` | Bảng theo dõi PSC và gói thầu, tủ hồ sơ |
| `zone_accounting` | Phòng Accounting | `agent_cost_controller` | Dashboard AFE và Cost Recovery, tủ hồ sơ |
| `zone_war_room` | Phòng họp kỹ thuật | (dùng chung) | Bàn họp lớn 8 ghế, màn trình chiếu Peer Review, whiteboard, bảng KPI |

**Cách tránh xuyên tường.** Engine của Diorama tìm đường theo đồ thị cửa (BFS). Hai phòng chỉ được nối với nhau khi hai cửa của chúng trùng tọa độ. Mỗi zone có một cửa trùng với một cửa của hành lang, nên lộ trình luôn là: chỗ ngồi → cửa phòng → hành lang → cửa phòng đích → ghế trống. Test `oilGasTemplate.test.ts` lấy mẫu dọc mọi lộ trình giữa các zone và xác nhận không điểm nào nằm ngoài phòng. Test cũng kiểm tra rằng tường có khe hở đúng tại mọi cửa.

**Sửa mặt bằng.** Sửa `oilgas/generate_layout.py`, chạy `python3 oilgas/generate_layout.py` để sinh lại template, chạy `npm test` để kiểm tra, rồi nạp lại bằng `load_office_preset.py`. Script tự tính lại tọa độ nội thất theo kích thước thật của model GLB.

### Thay đổi engine đi kèm

Để mặt bằng này hoạt động, có 3 thay đổi nhỏ trong mã nguồn Diorama, đều đã có test:

1. Thêm trường **`rooms[].doors`** (tùy chọn) trong config. Trường này khai báo cửa riêng cho từng phòng, ghi đè cửa mặc định của preset. Trước đây mỗi preset chỉ có một cửa cố định, nên các phòng hầu như không bao giờ nối được với nhau và agent đi thẳng xuyên tường.
2. `generateWalls` khoét đúng khe cửa khi **một cạnh tường có nhiều cửa**, như tường hành lang có 3 cửa mỗi bên.
3. Khi agent **đang đi** mà nhận sự kiện mới có `room` khác, agent đổi hướng ngay. Trước đây sự kiện đó bị bỏ qua.

Trình chỉnh sửa (Builder, nút "Redesign office") giữ nguyên `doors` khi lưu. Nếu kéo hoặc đổi kích thước phòng trong Builder, cửa có thể lệch khỏi cửa hành lang. Khi đó nên sinh lại mặt bằng bằng script.

---

## 3. Kịch bản sự cố WHP-02 (27 sự kiện, 5 giai đoạn)

| GĐ | Diễn biến trong 3D | Sự kiện chính |
|---|---|---|
| 1 | `agent_ops_lead` tại Ops nhận DPR và phát hiện WHP-02 giảm 18% lưu lượng (1,420 → 1,164 bopd), Water Cut tăng 22% → 31%. Huy hiệu **✋ cảnh báo** màu hổ phách nhấp nháy | `report.intake`, `anomaly.detected`, `attention.requested` |
| 2 | Ops, Subsurface và G&G đi qua hành lang vào War Room, ngồi hàng ghế đối diện màn trình chiếu, cùng phân tích Skin factor S = +12, rồi chốt Matrix Acidizing | `session.started/joined`, `document.presented`, `review.analysis`, `review.peer`, `council.decision` |
| 3 | `agent_reservoir_eng` sang phòng Contract bàn giao SOW. `agent_contract_spec` đối chiếu đơn giá hợp đồng khung và lập dự toán $245,000 | `message.sent`, `document.handover`, `review.contract_rates`, `estimate.prepared` |
| 4 | `agent_contract_spec` mang dự toán sang Accounting. `agent_cost_controller` kiểm tra AFE-2026-INT-09 và điều kiện Cost Recovery, rồi phê duyệt | `message.sent`, `review.afe_budget`, `review.cost_recovery`, `verdict.approved` |
| 5 | `agent_cost_controller` sang Ops báo cáo. `agent_ops_lead` phát lệnh huy động CT unit, bơm axit và tàu dịch vụ ra giàn | `message.sent`, `document.presented`, `herald.mobilization`, `task.completed` |

Sau mỗi bước công tác, agent tự quay về phòng của mình (sự kiện `task.completed` với `room` là zone nhà). Script ước lượng thời gian đi bộ (tốc độ 2.5 đơn vị/giây) và chờ agent tới nơi rồi mới gửi bước tiếp theo.

---

## 4. Tài liệu tích hợp: `POST /api/ingest` (dùng cho n8n)

Nguồn chuẩn của schema là `packages/engine/src/protocol.ts` (`IngestEventSchema`) và route `packages/app/app/api/ingest/route.ts`.

### Request

```
POST http://localhost:3000/api/ingest
Content-Type: application/json
```

Body có thể là **1 object sự kiện** hoặc **một mảng từ 1 đến 500 sự kiện**.

| Trường | Kiểu | Bắt buộc | Ý nghĩa |
|---|---|---|---|
| `v` | số | ✓ | Phiên bản protocol, **luôn là `1`** |
| `type` | chuỗi (≥1 ký tự) | ✓ | Loại sự kiện, ví dụ `review.afe_budget`. Quyết định icon hoạt động (xem bảng dưới) |
| `agent` | chuỗi (≥1 ký tự) | ✓ | ID agent, ví dụ `agent_ops_lead`. ID chưa có trong config sẽ tự xuất hiện thành nhân vật mới |
| `room` | chuỗi | | Phòng đích. Agent **đi bộ tới đó** và phòng sẽ sáng lên. Dùng zone id (`zone_ops`…), so khớp mờ với nhãn phòng |
| `label` | chuỗi | | Nội dung hiển thị trên Activity feed, dạng "`<agent> <label>`" |
| `ts` | số nguyên dương | | Unix **mili-giây**. Bỏ trống thì lấy thời điểm server nhận |
| `payload` | object | | Dữ liệu nghiệp vụ tùy ý (key là chuỗi). Được chuyển nguyên vẹn tới trình duyệt, nhưng giao diện hiện tại không hiển thị |

Ví dụ thực tế (giai đoạn 4):

```json
{
  "v": 1,
  "type": "review.afe_budget",
  "agent": "agent_cost_controller",
  "room": "zone_accounting",
  "label": "kiểm tra AFE-2026-INT-09: ngân sách $380,000, đã dùng $96,500 → còn $283,500 ≥ $245,000 ✔",
  "ts": 1794445852508,
  "payload": {
    "incident_id": "INC-WHP02-20261112",
    "stage": 4,
    "afe": "AFE-2026-INT-09",
    "budget_usd": 380000,
    "available_usd": 283500,
    "requested_usd": 245000,
    "sufficient": true
  }
}
```

### Response

| HTTP | Body | Khi nào |
|---|---|---|
| `200` | `{"ok": true, "accepted": <số sự kiện>}` | Hợp lệ, đã phát tới các trình duyệt đang mở |
| `400` | `{"ok": false, "error": "invalid JSON"}` | Body không phải JSON |
| `422` | `{"ok": false, "error": "v: Invalid literal value, expected 1"}` | Sai schema. Với mảng, lỗi có dạng `"[3] agent: ..."` (chỉ số phần tử lỗi) |

Khi gửi mảng, nếu **một phần tử sai thì cả lô bị từ chối** và không sự kiện nào được nhận.

### `type` quyết định hành vi hiển thị

So khớp chuỗi con, theo thứ tự ưu tiên (`packages/engine/src/activityState.ts`):

| Chứa chuỗi | Icon | Gợi ý dùng |
|---|---|---|
| `test`, `execution` | 🔬 testing | chạy mô phỏng, kiểm thử |
| `review`, `intake` | 🔍 reviewing | rà soát, tiếp nhận báo cáo |
| `synthesis`, `document`, `scenario` | 📊 presenting | trình bày, bàn giao tài liệu |
| `message`, `herald`, `verdict` | 📡 sending | gửi, chuyển giao, phê duyệt, phát lệnh |
| `council`, `session` | 💬 talking | họp, thảo luận |
| `attention.requested` | ✋ huy hiệu hổ phách | **cảnh báo cần người xử lý**. Tự tắt khi agent đó gửi bất kỳ sự kiện nào khác, hoặc khi gửi `attention.resolved` |
| (không khớp) | theo preset phòng | phòng họp → 💬, phòng làm việc → ⌨️, phòng thí nghiệm → 🔬 |

Icon hoạt động tự tắt sau 8 giây.

### Cấu hình node **HTTP Request** trong n8n

- **Method:** `POST`
- **URL:** `http://localhost:3000/api/ingest`
  - Nếu n8n chạy trong Docker trên cùng máy: dùng `http://host.docker.internal:3000/api/ingest`.
  - Nếu n8n ở máy khác trong mạng LAN: dùng IP của máy này, ví dụ `http://192.168.x.x:3000/api/ingest`. `next dev` đã lắng nghe trên mọi interface.
- **Send Body:** bật. **Body Content Type:** `JSON`. **Specify Body:** `Using JSON`.
- **JSON** (dùng expression để lấy dữ liệu từ node trước):

```json
{
  "v": 1,
  "type": "anomaly.detected",
  "agent": "agent_ops_lead",
  "room": "zone_ops",
  "label": "phát hiện {{ $json.well }}: lưu lượng {{ $json.change_pct }}%",
  "ts": {{ Date.now() }},
  "payload": {
    "well": "{{ $json.well }}",
    "oil_rate_bopd": {{ $json.oil_rate }},
    "water_cut_pct": {{ $json.water_cut }}
  }
}
```

- **Options → Response:** giữ mặc định (JSON). Nhánh xử lý lỗi kiểm tra `{{ $json.ok }} === true`.
- Muốn agent "đi" giữa các phòng thì giữa hai node gửi sự kiện nên đặt node **Wait** khoảng 8–16 giây. Khoảng chờ này tương ứng thời gian đi bộ, xem bảng dưới. Nếu gửi liền, agent vẫn đổi hướng đúng nhưng các hoạt động sẽ chồng lên nhau.

Thời gian đi bộ ước tính giữa các zone, tính cả 2 giây dự phòng (`walk_seconds()` trong script):

| Từ \ Tới | ops | subsurface | gg | war_room | contract | accounting |
|---|---|---|---|---|---|---|
| ops | – | 11s | 16s | 11s | 16s | 8s |
| subsurface | 11s | – | 11s | 8s | 11s | 12s |
| gg | 16s | 11s | – | 12s | 8s | 17s |
| contract | 16s | 11s | 8s | 11s | – | 16s |

### Bảo mật

`/api/ingest` và `/api/config` **không có xác thực**. Chỉ nên chạy trong mạng nội bộ. Không mở cổng 3000 ra Internet. Nếu cần truy cập từ xa, đặt reverse proxy có xác thực phía trước.
