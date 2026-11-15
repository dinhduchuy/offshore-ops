# Offshore Ops: hệ thống phối hợp AI agent liên phòng ban (MVP)

Quy trình xuyên phòng ban của một doanh nghiệp khai thác dầu khí offshore:

> Tiếp nhận DPR → phát hiện bất thường → đánh giá kỹ thuật → đề xuất công việc → mua sắm & hậu cần → kiểm tra ngân sách → trình người có thẩm quyền.

Văn phòng 3D chỉ phản ánh tiến trình. Trạng thái công việc do bộ điều phối workflow quyết định và được lưu trong SQLite.

**Truy cập:** <http://localhost:3000/ops> (trang `/` vẫn là văn phòng chung Offshore Ops).

---

## 1. Phần tái sử dụng và phần xây mới

| Tái sử dụng từ Diorama | Xây mới |
|---|---|
| Engine: mặt bằng, đồ thị cửa, tìm đường BFS, so khớp phòng; thêm `rooms[].doors` | Package `@diorama/ops` (`packages/ops`): SQLite, nhập liệu, phát hiện bất thường, workflow, 7 agent, cổng phê duyệt, truy vết |
| Event hub + SSE (`/api/ingest/stream`): sự kiện workflow được đẩy vào kênh này để điều khiển 3D | Mặt bằng 10 phòng `templates/oil-gas-ops` (sinh bằng `oilgas/generate_ops_layout.py`) |
| LiveView 3D: di chuyển, huy hiệu ✋, feed; thêm click agent, khôi phục vị trí, chống trùng eventId | Trang `/ops`: bảng workflow, inspector, truy vết, phê duyệt, dữ liệu, outbox, nhật ký |
| Adapter LLM của Copilot (`@diorama/plugins/copilot`: Anthropic, OpenAI-compatible, Ollama, CLI) | Lớp bảo vệ LLM (`packages/ops/src/llm.ts`), xử lý tài liệu không tin cậy (`untrusted.ts`) |

## 2. Chạy hệ thống

Yêu cầu: **Node.js ≥ 22.13** (dùng `node:sqlite` có sẵn, không cần cài thư viện native; khớp `engines` và CI) và Python 3 (chỉ để sinh lại dữ liệu mẫu hoặc mặt bằng).

```bash
npm install
cd packages/app && npx next dev -p 3000      # khởi động; bộ chạy task tự bật theo server
```

Mở <http://localhost:3000/ops>, vào tab **Dữ liệu**, bấm **Nạp bộ cơ sở**.

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `OPS_DB_PATH` | `~/.diorama/ops.db` | File SQLite |
| `OPS_HOME` | `<repo>/oilgas` | Thư mục chứa `ops-config.json`, `demo-users.json`, `sample-data/` |
| `OPS_LLM` | (tắt) | *Cách cũ.* `1` = yêu cầu xử lý có LLM bằng LLM đã cấu hình trong Copilot. Chỉ dùng khi **chưa** lưu cấu hình Claude API trên `/ops` (mục 7a); đổi cách này cần khởi động lại |
| `OPS_LLM_BASE_URL` | `https://api.anthropic.com` | Tùy chọn, chỉ phía server: proxy doanh nghiệp hoặc mock cục bộ khi kiểm thử |
| `OPS_OPERATING_MODE` | `demo` | `production` = chỉ chấp nhận danh tính doanh nghiệp. Chưa tích hợp SSO nên ở chế độ này **mọi phê duyệt bị chặn** |
| `OPS_SESSION_SECRET` | ngẫu nhiên mỗi lần chạy | Khóa ký cookie danh tính demo (phiên demo mất khi khởi động lại nếu không đặt) |

**Các biến môi trường trên được đọc khi server khởi động — đổi biến phải khởi động lại server.** Riêng cấu hình Claude API lưu từ giao diện `/ops` áp dụng ngay, không cần khởi động lại (mục 7a).

Ngưỡng và quy tắc nằm trong `oilgas/ops-config.json` (ngưỡng giảm %, số ngày liên tiếp, cách tính baseline, tuổi tối đa của thử giếng, số chào giá tối thiểu, vai trò người duyệt, độ trễ demo).

**Ngôn ngữ giao diện / Interface language:**

- Nút **VI | EN** nằm trên thanh trên cùng của mọi trang (/, Dashboard, wizard, /ops). Lựa chọn lưu trong trình duyệt (`offshore-ops.lang`); nếu storage bị chặn thì giữ trong phiên. Đổi ngôn ngữ chỉ đổi cách hiển thị: không gửi request ghi, không đổi quyền, ID, số liệu hay hồ sơ đã duyệt, không gọi LLM, và không làm mất bản nháp, lựa chọn hay trace đang mở.
- Giờ hiển thị theo **giờ nghiệp vụ** (`calendar.timeZone`, mặc định Asia/Ho_Chi_Minh), độc lập với ngôn ngữ. Ngày nghiệp vụ (YYYY-MM-DD) không bao giờ bị lệch ngày. Tiền luôn ghi rõ mã (USD…). Payload gửi server luôn là số/ISO gốc.
- Thông báo lỗi: server trả `code` + `params` + `requestId` cạnh văn bản gốc. Giao diện EN dựng câu theo mã; giao diện VI hiển thị nguyên văn server. Nguyên văn và mã yêu cầu nằm trong "Chi tiết hỗ trợ". Không suy đoán ý nghĩa từ chuỗi.
- **Nội dung nghiệp vụ** (tóm tắt, kết luận, hồ sơ do agent tạo) giữ bản gốc tiếng Việt, gắn `lang="vi"`. Trong trace một tài liệu hoặc lần chạy, nút **Bản dịch tiếng Anh / English translation** gọi Claude API theo yêu cầu (có phí, chỉ khi người bấm). Bản dịch lưu riêng (bảng `translations`) và gắn sha256/phiên bản của bản gốc. Bản dịch:
  - được cache theo (hash nguồn, ngôn ngữ đích);
  - được kiểm số liệu/mã tham chiếu;
  - hiện nhãn "Bản dịch máy — chưa được chuyên gia kiểm tra" cho tới khi một người có vai trò `permissions.translationReview` đánh dấu đã kiểm tra;
  - bị báo **stale** khi bản gốc đổi.
  
  Quyết định duyệt luôn áp dụng cho bản gốc (packageSha không đổi). Không có Claude API thì giao diện báo "chưa có bản dịch" và giữ bản gốc.
- Ngôn ngữ đầu ra của phần diễn giải LLM là cấu hình server `runtime.llm.outputLanguage` (`vi`|`en`, mặc định `vi`), được snapshot vào mỗi lần chạy. Nó không lấy theo ngôn ngữ người xem.
- Tên phòng: phòng mẫu Offshore Ops có `displayNames {vi, en}`. Phòng người dùng tự đặt tên giữ nguyên tên đã đặt ở mọi ngôn ngữ. `label` (khóa kỹ thuật) không bao giờ bị dịch.

## 3. Quy trình và điều kiện (workflow v2)

Luồng: **Tiếp nhận DPR → kiểm tra dữ liệu → phân loại case → đánh giá sơ bộ (kỹ thuật / bảo dưỡng / HSE) → chọn phương án → phê duyệt phạm vi → khảo giá & kế hoạch → ngân sách & nguồn lực → phê duyệt cam kết → kiểm tra sẵn sàng → ghi nhận thực hiện → đánh giá hiệu quả → đóng case.**

| # | Bước | Ai giữ việc | Mở khi / bỏ qua khi |
|---|---|---|---|
| 1 | Tiếp nhận DPR, kiểm tra dữ liệu & phân loại | Operations AI | Case mở khi DPR vượt ngưỡng (**hoặc** nghi suy giảm nhưng chưa đủ dữ liệu). Phân loại: *bổ sung dữ liệu* / *cần đánh giá* / *không cần hành động* |
| 2a–2c | Đánh giá kỹ thuật · đối chiếu bảo dưỡng · rà soát HSE **sơ bộ** | Prod/Subsurface · Maintenance · HSE | Chỉ khi phân loại = cần đánh giá; ngược lại **bỏ qua có lý do** |
| 3 | Chọn phương án & nhánh | Operations AI | Nhánh: *không cần hành động*, *tiếp tục theo dõi*, *công việc nội bộ*, *cần khảo giá/mua sắm*; kèm tiêu chí nghiệm thu từng hoạt động |
| 4 | **Phê duyệt phạm vi** | 👤 Trưởng phòng KT khai thác | |
| 5a | Khảo giá & dự toán (RFQ nháp) | Contracts AI | Chỉ nhánh cần mua sắm. RFQ được gửi xin giá ngay khi phạm vi đã duyệt — **không phải cam kết** |
| 5b | Nhu cầu & kế hoạch hậu cần | Logistics AI | Chỉ khi cần vận chuyển người/hàng; giữ chỗ nội bộ boong tàu/ghế bay |
| 6 | Ngân sách & nguồn lực | Finance AI | Bỏ qua khi không phát sinh chi phí; giữ chỗ nội bộ ngân sách |
| 7 | Hồ sơ trình duyệt cam kết (danh sách điều kiện) | Operations AI | |
| 8 | **Phê duyệt cam kết chi** (vai trò theo ma trận thẩm quyền) | 👤 người có thẩm quyền | Duyệt → case "đã duyệt cam kết" — **chưa phải hoàn thành** |
| 9 | Bản nháp PR / đặt chỗ / work request | Operations AI | Mỗi bản nháp cần đúng mức duyệt (bảng dưới) và duyệt gửi riêng |
| 10 | Kiểm tra sẵn sàng tại ngày thực hiện | HSE AI | Hiệu lực hồ sơ HSE trên phạm vi đã chốt, giữ chỗ còn hiệu lực, độ mới dữ liệu |
| 11 | **Xác nhận sẵn sàng huy động** | 👤 OIM / đầu mối offshore | Phải tự xác nhận PTW (do người có thẩm quyền cấp), hồ sơ nhân sự, đặt chỗ, thời tiết |
| 12 | Ghi nhận thực hiện | Người phụ trách (Operations ghi nhận) | Chỉ tính bản ghi có người xác nhận; chờ tới ngày/đơn vị thực hiện |
| 13 | Đánh giá hiệu quả theo tiêu chí | Prod/Subsurface AI | Chẩn đoán: có dữ liệu/kết quả. Bảo dưỡng: phục hồi ≥ `closure.recoveryShareMin` trên ≥ `closure.observationDays` ngày DPR sau thực hiện |
| 14 | **Đóng case** (kết luận & bài học) | 👤 Trưởng phòng KT khai thác | Chưa đạt → không đóng được; trả về đánh giá kỹ thuật để mở vòng chẩn đoán mới (cùng case, revision mới) |

**Trạng thái task:** Chờ · Đang chạy · Thiếu dữ liệu · Đang chờ (*nguồn lực / đơn vị khác / tới ngày*) · Chờ duyệt · Hoàn tất · **Bỏ qua (có lý do)** · Lỗi (hệ thống) · Hủy. Mỗi task có người giữ việc, hạn (`sla` trong cấu hình) và cờ **quá hạn**.

**Trạng thái case:** đang xử lý → *đã duyệt cam kết* (vẫn đang thực hiện) → **đã đóng**; hoặc bị từ chối.

**Điều kiện theo hành động** (chính sách có version trong `policy`; bộ đi kèm là **MẪU**, không phải chính sách doanh nghiệp):

| Hành động | Cần | Điều kiện chặn (không miễn trừ) | Có thể miễn trừ (ai) |
|---|---|---|---|
| Dự toán sơ bộ, RFQ | Phạm vi đã duyệt | — | — |
| PR (đề nghị mua), đặt chỗ | Cam kết đã duyệt | Tổng chi phí đầy đủ; AFE; vận chuyển khả thi; giữ chỗ không xung đột; phạm vi còn hiệu lực | Thiếu chào giá (`quotes_min` — Asset Manager); vượt ngân sách (`over_budget` — Phó TGĐ/TGĐ) |
| Huy động / thực hiện | Xác nhận sẵn sàng | Hồ sơ HSE còn hiệu lực tại ngày thực hiện | Người duyệt phải tự xác nhận PTW, nhân sự, đặt chỗ, thời tiết |
| Đóng case | Đánh giá hiệu quả | Có bản ghi thực hiện được xác nhận; đạt tiêu chí | Kỹ sư xác nhận phần hiệu quả quy cho công việc |
| PO, đặt tàu thật, cấp phép, điều khiển thiết bị | — | **Hệ thống không làm** | — |

Ngoại lệ được ghi trong quyết định (`waivers_json`), cần lý do. Duyệt giá trị chi **không** có nghĩa ngân sách đã được bổ sung.

**Revision & tác động dữ liệu:**
- Mỗi case có *snapshot đầu vào* theo revision. Snapshot gồm:
  - giàn/giếng (`platform/well`), kỳ dữ liệu, mốc đánh giá, tuổi dữ liệu;
  - định nghĩa `oil_rate`, phiên bản quy tắc/chính sách, giả lập/thực;
  - dấu vân tay từng dataset, phát hiện ban đầu và đánh giá mới nhất.
- Khi dữ liệu mới về, hệ thống so dấu vân tay **chỉ trên các dòng thuộc case**:
  - Bước bị ảnh hưởng và các bước phía sau bị đánh dấu stale, case tăng revision và chạy lại đúng nhánh.
  - Hồ sơ và bản nháp Outbox của revision cũ không còn duyệt được; quyết định cũ được giữ làm audit.
  - Dữ liệu của giếng hoặc giàn khác không chạy lại case này.
- Sau khi phạm vi đã duyệt:
  - Ngày DPR mới là dữ liệu theo dõi, chỉ dùng cho bước đánh giá hiệu quả.
  - Chỉ sửa dữ liệu trong kỳ đã đánh giá mới mở lại phần đánh giá.
  - Hồ sơ HSE, tồn kho và tài liệu tác động lên bước khảo giá/sẵn sàng, không mở lại phạm vi.
- Agent đọc dữ liệu bị đổi trong lúc đang chạy thì kết quả bị loại và tự chạy lại.

**Nguồn lực dùng chung:** sổ giữ chỗ (`reservations`) cho ngân sách, chỗ boong tàu và ghế bay.
- Giữ chỗ chạy trong transaction, theo khóa nghiệp vụ; retry hay khởi động lại không tạo chỗ giữ trùng.
- Case khác đã giữ thì hiện xung đột kèm mã case.
- Giữ chỗ hết hạn sau `policy.holdDays`, được nhả khi case đóng hoặc bị từ chối.
- "Giữ chỗ nội bộ" khác với "đã xác nhận" (người phụ trách ghi mã xác nhận của bên ngoài).

**Bàn giao (`handoffs`):** mỗi bàn giao lưu:
- bước/agent giao và nhận;
- hồ sơ kèm phiên bản và sha256;
- yêu cầu, tiêu chí tiếp nhận, hạn;
- trạng thái (đã giao / đã nhận / trả lại / thay thế), phản hồi và lý do trả lại.

**Hàng đợi:** tối đa `runtime.maxConcurrentPerAgent` task chạy cùng lúc cho mỗi agent (và `runtime.llm.maxConcurrent` lời gọi LLM), xếp theo ưu tiên case (P1–P3, ước tính theo sản lượng mất). Tab **Việc cần làm** liệt kê mọi việc chờ người/đơn vị, quá hạn lên đầu. Không gửi thông báo ra ngoài.

### Agent làm gì (đều suy ra từ dữ liệu đầu vào)

- **Operations:**
  - Kiểm tra DPR theo `platform/well`: ngày tương lai bị loại khi nhập, mốc và độ mới dữ liệu, định nghĩa `oil_rate`.
  - Chỉ quy đổi theo giờ chạy khi `rate_basis = daily_volume`; với `operating_rate` thì dùng nguyên giá trị. Khi chưa rõ định nghĩa, ngày có downtime không được đánh giá.
  - Tính baseline và mức giảm, rồi phân loại case. **Không kết luận nguyên nhân** từ ngưỡng giảm.
  - Đăng ký case, ghi nhận kết quả thực hiện do người xác nhận.
- **Prod/Subsurface:** tách dữ kiện, tính toán, giả thuyết và dữ liệu còn thiếu. Giả thuyết được đánh giá bằng ngưỡng cấu hình: gas lift, nước xâm nhập, sai số đo/phân bổ, choke. Giả thuyết tổn thương vùng cận đáy giếng **luôn là "chưa đủ dữ liệu"** nếu không có PTA. Chỉ đề xuất **thu thập dữ liệu/chẩn đoán**, và chỉ soạn SOW khi đủ cơ sở.
- **Maintenance:** work order quá hạn hoặc mở liên quan (so với thời điểm bắt đầu suy giảm), tồn kho ngoài giàn/kho bờ, dự thảo work request.
- **HSE:** đối chiếu ma trận giấy phép với sổ tài liệu (hiệu lực, trạng thái). **Không cấp phép**; mọi điểm thiếu được ghi là cần người phụ trách xác nhận.
- **Contracts:** đối chiếu hợp đồng còn hiệu lực và rate sheet, trần hợp đồng, số chào giá tối thiểu. Tách **giá có chứng từ** với **giá ước tính**. Chỉ tạo bản nháp RFQ/PR.
- **Logistics:** nhu cầu người và hàng (khối lượng, diện tích boong, kiện nặng nhất), chọn chuyến tàu theo boong, cẩu và sóng; chọn chuyến bay theo chỗ trống và gió; kiểm tra POB. **Không điều tàu**.
- **Finance:** khả dụng = ngân sách − thực chi − cam kết, sau đề xuất, AFE, cấp duyệt theo ma trận. **Không kết luận thu hồi chi phí PSC** khi thiếu điều khoản và xác nhận.

## 4. Truy vết (tiêu chí nghiệm thu chính)

Mỗi kết luận có nhãn **Quan sát / Tính toán / Giả thuyết / Đối chiếu** và các chip bằng chứng `E1, E2…`. Bấm vào chip để đi theo chuỗi:

```
Kết luận → phép tính (công thức + từng đầu vào) → dòng dữ liệu (giá trị chuẩn hóa + giá trị gốc + số dòng trong file)
        → import (tên file, sha256, thời điểm, cảnh báo chất lượng, cờ GIẢ LẬP)
Trạng thái chờ duyệt → hồ sơ vX (sha256) → lần chạy tạo ra hồ sơ → đầu vào của lần chạy → …
Quyết định → người quyết định, vai trò, thời gian, nội dung, bước trả về, phiên bản hồ sơ, khóa chống trùng
```

Mọi sự kiện có `eventId, workflowId, taskId, agentId, ts, source`, xem ở tab **Nhật ký**. Mỗi lần chạy lưu đầu vào đã dùng, "dấu vân tay" đầu vào, đầu ra, lỗi, và các lần gọi LLM (prompt + response).

## 5. Kiểm thử các trường hợp

Tự động: `npx vitest run packages/ops packages/cli`.
- `acceptance.v2.test.ts`: 8 tình huống nghiệm thu của workflow v2, cùng test migration và test bàn giao; đồng hồ ghim cố định, DB riêng.
- Các test end-to-end chạy toàn bộ luồng trên dữ liệu giả lập.
- `governance.test.ts`: phiên bản hồ sơ, danh tính, outbox, ngoại lệ.
- `llm.test.ts`: các ca đối kháng với LLM.

Thủ công trên giao diện (sau khi **Nạp bộ cơ sở**):

| Trường hợp | Cách làm | Kết quả mong đợi |
|---|---|---|
| **Dữ liệu thiếu / lỗi chất lượng** | Xem import DPR ở tab Dữ liệu | 1 dòng trùng bị bỏ, quy đổi m³/d→bbl/d, thiếu khí A-05 28/10, cập nhật muộn A-01 03/11. A-06 giảm 25% do downtime nên không lập case |
| | Mở case → "Đánh giá kỹ thuật khai thác" | **Thiếu dữ liệu**: thử giếng A-03 đã 44 ngày, không soạn SOW. Bước tổng hợp lập "Yêu cầu bổ sung dữ liệu" |
| | Nạp `SIM_well_test_A-03_2026-11-11.csv` | Nhánh kỹ thuật tự chạy lại, phương án được tổng hợp, chờ duyệt kỹ thuật |
| **Sự kiện trùng** | Nạp lại bộ cơ sở; gửi 2 lần cùng `idempotencyKey` vào `/api/ops/decisions` | Import báo "trùng nội dung", không thêm dòng hay case. Quyết định gửi lại y hệt trả `duplicate: true`; dùng lại khóa cho nội dung khác bị từ chối (409) |
| | Nạp `SIM_dpr_revision_2026-11-12.csv` | 2 xung đột: dòng mới hơn (A-03) thay thế; dòng cũ hơn (A-05) không thay thế |
| **Agent lỗi** | Tab Dữ liệu → Công cụ kiểm thử → chọn agent → "Gây lỗi 1 lần", rồi để agent đó chạy | Task chuyển **Lỗi** kèm thông báo, các bước sau không chạy. Bấm "Chạy lại" thì thành công ở lần chạy 2, lịch sử vẫn giữ |
| **Khởi động lại** | Tắt server (Ctrl+C / kill) khi có task "Đang chạy", rồi chạy lại | Nhật ký có `system.recovered` / `task.recovered`; task chạy lại; tải lại trang thấy đúng tiến trình, vị trí agent và huy hiệu ✋ |
| **Hồ sơ bị trả lại** | Duyệt phạm vi → chờ tới "Phê duyệt cam kết chi" → Yêu cầu bổ sung, trả về "proc.prep", lý do "cần 2 chào giá" | Case lên rev 2; bước khảo giá chuyển **Thiếu dữ liệu** (chưa có dữ liệu mới), hậu cần giữ nguyên |
| | Nạp `SIM_quotes_SupplyB.csv` | Khảo giá, tài chính và hồ sơ chạy lại; RFQ của revision cũ chuyển "thay bằng bản mới". Hồ sơ mới có sha256 mới, điều kiện chào giá đạt |
| **Duyệt cam kết khi thiếu chào giá** | Ở cổng cam kết, bấm Duyệt khi điều kiện chào giá chưa đạt | Bị từ chối; chỉ duyệt được khi Asset Manager tích "Ghi ngoại lệ" và ghi lý do |
| **Sẵn sàng** | Sau duyệt cam kết | Kiểm tra sẵn sàng **thiếu dữ liệu**: hồ sơ rủi ro slickline hết hạn trước ngày thực hiện, chưa có SIMOPS, JSA FCV ở trạng thái nháp. Nạp `SIM_hse_simops_update.csv` (và JSA được duyệt) thì mở cổng OIM |
| **Tài liệu có câu lệnh độc hại** | Mở import `SIM_quote_SupplyA_RFQ-2026-118.txt` | Bị gắn cờ "yêu cầu phê duyệt ngay…". HSE và Contracts ghi cảnh báo; không trạng thái hay quyền nào thay đổi |

Khi duyệt trên UI, chọn danh tính demo có đúng vai trò:
- `Demo · Trưởng phòng Kỹ thuật khai thác`: duyệt phạm vi và đóng case.
- `Demo · Asset Manager`: cổng cam kết và Outbox.
- `Demo · OIM`: xác nhận sẵn sàng. `Demo · Kỹ sư khai thác` không có quyền duyệt, dùng để thử trường hợp bị từ chối. Nếu gọi API trực tiếp, trước hết phải `POST /api/ops/session {"userId": "demo.asset"}` để nhận cookie, sau đó gửi quyết định kèm `packageSha`.

## 6. Nhập dữ liệu thực

> **Từ workflow v2:**
> - **DPR** nên có cột `rate_basis`: `daily_volume` là sản lượng theo ngày lịch, `operating_rate` là lưu lượng khi vận hành. Thiếu cột này thì áp dụng `detection.rateBasis` (mặc định `unspecified`): ngày có downtime không được đánh giá và case rơi vào nhánh bổ sung dữ liệu.
> - **Ngày tương lai bị loại** khi nhập ở các trường `report_date`, `test_date`, `completed_date`. "Hôm nay" là ngày nghiệp vụ theo múi giờ `calendar.timeZone` trong `ops-config.json` (mẫu: `Asia/Ho_Chi_Minh`; mặc định `UTC`), không theo giờ máy chủ.
> - **Hồ sơ HSE** có thêm cột tùy chọn `valid_from`; hiệu lực tính theo cả ngày `valid_to`.
> - **Thử giếng** nên có `platform` khi tên giếng trùng giữa các giàn; dòng không ghi giàn sẽ không được dùng.
> - **Phạm vi giàn/giếng khớp chính xác** (cắt khoảng trắng, không phân biệt hoa thường), không khớp chuỗi con: `A-03` ≠ `A-030`, `SIM-WHP-A` ≠ `SIM-WHP-AB`. Cột `scope` (hse_documents), `location` (thời tiết), `destination` (tàu/bay) có thể liệt kê nhiều mã, phân tách bằng `;` `,` `|`; scope dạng `GIÀN/GIẾNG` cũng được.
> - **Dòng không có giàn** (thử giếng, work order, tài liệu HSE không ghi scope) chỉ áp dụng theo quy tắc khai báo `scope.rowsWithoutPlatform` trong `ops-config.json`: `single_platform` (mặc định — chỉ khi dữ liệu chỉ có một giàn), `exclude`, hoặc mã giàn cụ thể (cấu hình mẫu: `SIM-WHP-A`). Tên giếng trùng giữa các giàn **không bao giờ** được tự gán từ dòng không có giàn. `maintenance_history` có thêm cột tùy chọn `platform`.
> - **Dữ liệu dùng chung được theo dõi theo mã**: báo giá theo `part_no`, đơn giá ước tính/thiết bị theo `item`, hợp đồng theo `scope_categories`, rate sheet theo `contract_no`, ngân sách theo `cost_code`, tồn kho theo `part_no`, ma trận giấy phép/danh mục hoạt động theo `activity_type`. Nhập dữ liệu cho mã X chỉ làm lại các bước đã dùng X; mã Y không ảnh hưởng. Lý do lập lại trong revision ghi rõ mã, ví dụ `quotes{part_no=SL-CONSUMABLES-KIT}`.
> - **Quyền nhập theo loại dữ liệu** (`permissions.importByDataset`; mặc định `permissions.importDefault`): ví dụ ngân sách/ma trận thẩm quyền/PSC chỉ Asset Manager. Giới hạn `limits.importMaxBytes` (10 MB) và `limits.importMaxRows` (50.000 dòng); vượt thì 413/400, không ghi gì.
> - **Dataset mới `work_execution`** dùng để ghi nhận thực hiện, gồm `platform, well, activity_type, case_no?, status (done/partial/not_done), completed_date, findings, result_ref, confirmed_by, confirmed_role`. Chỉ dòng có `confirmed_by` mới được tính. Có thể nhập trên giao diện: bước "Ghi nhận thực hiện" → form, người xác nhận là danh tính phía server.


- **File:** tab Dữ liệu, hoặc `POST /api/ops/import` (multipart, trường `file`; tùy chọn `datasetType`, `workflowId`). Hỗ trợ CSV, XLSX (sheet đầu), JSON. Loại dữ liệu được nhận diện theo tên cột.
- **PDF / TXT / MD:** lưu làm tài liệu (trích văn bản); không đọc bảng số liệu từ PDF.
- **API (ví dụ n8n):** dùng **token tích hợp** — đặt biến môi trường máy chủ `OPS_INGEST_TOKEN` (≥16 ký tự) và tùy chọn `OPS_INGEST_ROLES` (mặc định `Tích hợp dữ liệu`), gửi `Authorization: Bearer <token>` (hoặc `x-ops-ingest-token`). Token sai → 401 (không rơi về cookie). Credential tích hợp là danh tính `service`: chỉ nhập được các loại dữ liệu vai trò của nó cho phép; **không** duyệt, xác nhận booking hay ghi nhận thực hiện. Không có token thì cần phiên đăng nhập có vai trò phù hợp. Vai trò không bao giờ lấy từ body.

```bash
curl -X POST localhost:3000/api/ops/import -H 'content-type: application/json' -H "authorization: Bearer $OPS_INGEST_TOKEN" -d '{
  "datasetType": "dpr",
  "idempotencyKey": "dpr-WHP-A-2026-11-12",
  "rows": [{"report_date":"2026-11-12","platform":"WHP-A","well":"A-03","oil_rate":1150,"oil_unit":"bbl/d",
            "uptime_h":24,"water_rate":560,"water_unit":"bbl/d","updated_at":"2026-11-13T06:30:00Z"}]
}'
```

| Loại | Nội dung | Cột bắt buộc | Cột tùy chọn | Khóa chống trùng |
|---|---|---|---|---|
| `dpr` | Daily Production Report | report_date, platform, well, oil_rate(+oil_unit), uptime_h, updated_at | gas_rate(+gas_unit), water_rate(+water_unit), downtime_h, thp(+thp_unit), gl_inj(+gl_inj_unit), choke_pct, notes | report_date + platform + well |
| `well_master` | Danh mục giếng | well, platform, lift_type | status, reservoir, completion_date, allocation_method | well |
| `well_test` | Thử giếng | well, test_date, oil_bbl_d | duration_h, water_bbl_d, gas_mmscfd, thp_bar, chp_bar, gl_inj_mmscfd, choke_pct, separator, remarks | well + test_date |
| `maintenance_history` | Work order | wo_no, equipment_tag, system, description, status | well, wo_type, raised_date, due_date, closed_date | wo_no |
| `spare_parts` | Tồn kho | part_no, description | system, qty_offshore, qty_onshore, lead_time_days, weight_t, deck_m2 | part_no |
| `activity_catalog` | Danh mục hoạt động | activity_type, name, work_type | lift_types, addresses, discipline, crew_size, duration_days, equipment, materials, contract_category, cost_code | activity_type |
| `hse_documents` | Sổ tài liệu HSE | doc_id, title, doc_type, status | activity_type, scope, valid_to | doc_id |
| `permit_matrix` | Ma trận giấy phép | activity_type, permit_type, required_documents | — | activity_type + permit_type |
| `contracts` | Hợp đồng | contract_no, vendor, scope_categories | valid_from, valid_to, ceiling_usd, committed_usd | contract_no |
| `rate_sheet` | Đơn giá hợp đồng | contract_no, item_code, description, unit, rate_usd | applies_to | contract_no + item_code |
| `quotes` | Chào giá | rfq_ref, part_no, vendor, unit_price_usd | qty, lead_time_days, valid_to, document_ref | rfq_ref + vendor |
| `cost_estimates` | Đơn giá ước tính | item, estimate_usd, basis | unit | item |
| `equipment_catalog` | Thiết bị thi công | item | description, weight_t, deck_m2 | item |
| `vessel_schedule` | Lịch tàu | voyage_id, vessel, depart_date, destination | deck_m2_free, max_lift_t, status | voyage_id |
| `flight_schedule` | Lịch bay | flight_id, flight_date, destination | seats_free | flight_id |
| `weather_forecast` | Dự báo thời tiết | forecast_date, location | hs_m, wind_kn, issued_at | forecast_date + location |
| `logistics_limits` | Giới hạn vận chuyển | parameter, value | unit, note | parameter |
| `budget` | Ngân sách | cost_code, period, budget_usd, actual_usd, committed_usd | description, afe_required, afe_no | cost_code + period |
| `authority_matrix` | Ma trận thẩm quyền | role, max_usd | scope | role |
| `psc_terms` | Điều khoản PSC | clause, cost_category, recoverable | text, confirmed_by | clause |

**Quy tắc nhập:**
- Đơn vị được quy đổi về chuẩn (bbl/d, MMscf/d, bar) và việc quy đổi được ghi lại.
- Thiếu cột bắt buộc thì loại dòng; thiếu giá trị tùy chọn thì cảnh báo, **không suy diễn**.
- Trùng hoàn toàn thì bỏ qua. Trùng khóa nhưng khác giá trị thì giữ bản có `updated_at` mới hơn và ghi xung đột.
- Cùng nội dung file hoặc cùng `idempotencyKey` thì không nhập lại.
- Dòng mở đầu bằng `# GIẢ LẬP / SIMULATED` (hoặc tên file bắt đầu bằng `SIM_`) sẽ được gắn cờ giả lập.

## 7. Các chế độ — ba trục độc lập

Header trang `/ops` hiển thị riêng từng trục; không có nút "Live/Production".

| Trục | Giá trị | Ý nghĩa |
|---|---|---|
| **Dữ liệu** | chưa có · GIẢ LẬP · thực · HỖN HỢP | Tính trên các dòng đang dùng trong DB. "Hỗn hợp" kèm cảnh báo đỏ — kết quả không được dùng như số liệu thực |
| **Xử lý** | quy tắc xác định · quy tắc + LLM hỗ trợ · ⛔ lỗi cấu hình LLM | Gồm 3 thông tin: *yêu cầu* (rules/llm), *hiệu lực* (rules/llm/blocked), *trạng thái cấu hình* (chưa kiểm chứng → gọi thành công lúc… / lần gọi gần nhất lỗi) |
| **Kết nối** | đang nhận sự kiện · MẤT — đang thử lại | Trạng thái luồng SSE; khi kết nối lại, trang tải lại trạng thái từ DB và đồng bộ vị trí agent |
| Phê duyệt (nhãn riêng) | DEMO · bị chặn (chưa có SSO) | Nguồn danh tính của người duyệt |

Office/Dashboard ở trang `/` chỉ là kiểu hiển thị, không phải chế độ vận hành.

**Chạy từng chế độ**

```bash
cd packages/app
npx next dev -p 3000                                   # quy tắc xác định + phê duyệt DEMO (mặc định)
                                                       # → bật Claude API ngay trên /ops (mục 7a), không cần khởi động lại
OPS_LLM=1 npx next dev -p 3000                         # cách cũ: LLM của Copilot (chỉ khi chưa lưu cấu hình trên /ops)
OPS_OPERATING_MODE=production npx next dev -p 3000     # chặn phê duyệt vì chưa có danh tính doanh nghiệp
```

### 7a. Cấu hình Claude API trên `/ops`

Bấm **⚙ Claude API** (góc phải trên), hoặc bấm vào nhãn "Xử lý" trên header.

1. Chọn danh tính demo (ô NGƯỜI PHÊ DUYỆT). Mọi thay đổi và mọi lần kiểm tra đều ghi người thực hiện vào lịch sử. Ở chế độ `production`, giao diện không cho sửa vì chưa có SSO.
2. Nhập **Anthropic API key** (`sk-ant-…`), chọn **model** và **effort**:
   - Model mặc định là `claude-opus-5-5`. Các lựa chọn khác: `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-2`, hoặc nhập model khác. Danh sách được đối chiếu với tài liệu Anthropic ngày 2026-11-12.
   - Effort mặc định là `medium`.
3. Bấm **Kiểm tra kết nối (miễn phí)**. Hệ thống gọi `GET /v1/models/{model}` và **không tính phí**; nếu chưa lưu thì kiểm tra bằng giá trị đang nhập. Kết quả báo rõ:
   - **thành công**, hoặc model deprecated;
   - **lỗi xác thực** (401);
   - **không có quyền** (403);
   - **sai model hoặc model đã ngừng phục vụ** (404/retired);
   - **giới hạn sử dụng** (429, kèm số giây chờ);
   - **thanh toán/hạn mức tín dụng**;
   - **quá tải** (5xx/529);
   - **không kết nối được** (mạng/DNS/proxy).

   Kèm `request-id` để tra cứu với Anthropic. Kiểm tra miễn phí **không** xác nhận được hạn mức tín dụng; nếu cần xác nhận, dùng nút **Gọi thử 1 lần (có phí)**, có hộp xác nhận trước khi gọi.
4. Tích **Bật xử lý bằng Claude API**, rồi bấm **Lưu cấu hình**. Cấu hình áp dụng **ngay cho task bắt đầu sau đó**, không cần khởi động lại. Task đang chạy giữ cấu hình đã bắt đầu; truy vết của lần chạy ghi "Cấu hình LLM khi bắt đầu" kèm số `rev`.

**Bảo mật key**
- Key chỉ lưu phía server, trong `~/.diorama/ops-llm.json` (quyền 0600, ghi nguyên tử), tách khỏi credentials của Copilot.
- Key không được trả về trình duyệt; giao diện chỉ hiện "đã cấu hình (sk-ant-…ABCD)". Ô nhập được xóa ngay sau khi lưu.
- Key không lưu trong localStorage, không nằm trong log, DB hay Git.
- Để trống ô key khi lưu thì giữ key cũ; nút **Xóa key** xóa key đã lưu.

**Khi có lỗi**
- Bật Claude API mà thiếu key: header đỏ "agent tạm dừng", không tự chuyển sang quy tắc/Demo.
- Một lần gọi lỗi: task chuyển sang **Lỗi**, kèm loại lỗi. Sau khi sửa cấu hình, bấm **Chạy lại** task.
- Claude từ chối trả lời (`refusal`) hoặc câu trả lời bị cắt (`max_tokens`) cũng được tính là lỗi, không dùng kết quả dở dang.

**Header** hiển thị riêng từng thông tin:
- **Xử lý**: quy tắc, hoặc quy tắc + Claude API kèm model.
- **Claude API**: OK lúc…, hoặc LỖI kèm loại lỗi.
- **Dữ liệu**: giả lập/thực.
- **Kết nối**: luồng sự kiện.

**Lịch sử**: mục "Lịch sử gọi LLM" liệt kê từng lần gọi (bảng `llm_calls`) với:
- thời gian, task, model cấu hình và model thực trả lời (khác nhau khi có model dự phòng);
- trạng thái, loại lỗi, HTTP status, `request-id`;
- token vào/ra (lấy từ `usage` của API), thời lượng và số `rev` cấu hình.

Mục "Lịch sử cấu hình & kiểm tra kết nối" (bảng `llm_config_events`) ghi lại các lần lưu và kiểm tra; key không được ghi, chỉ ghi "có key / đổi key".

**Tham số gửi API**:
- `anthropic-version: 2026-10-21`.
- Không gửi `temperature`; không gửi `thinking`, vì model hiện tại tự dùng adaptive thinking.
- `output_config.effort`; `max_tokens = runtime.llm.maxTokens`, mặc định 16000 vì phần thinking cũng tính vào giới hạn này.
- Tùy chọn **model dự phòng khi từ chối** (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`), bật mặc định. Nếu tổ chức chưa được dùng beta này, API trả 400 về header `anthropic-beta`; khi đó bỏ tích tùy chọn.

Claude chỉ viết diễn giải và nhận định dựa trên dữ liệu và bằng chứng được cung cấp. Phép tính, điều kiện workflow và quyền phê duyệt vẫn ở backend (xem "LLM — kiểm tra được gì").

### Danh tính người duyệt

- **Vai trò luôn do server quyết định**, không lấy từ chuỗi trong request (các trường `actorName`/`actorRole` trong body bị bỏ qua).
- **Chế độ `demo`:** chọn danh tính trong danh mục `oilgas/demo-users.json` qua ô chọn "NGƯỜI PHÊ DUYỆT". Server lưu lựa chọn trong cookie httpOnly có ký HMAC; cookie giả mạo bị từ chối (401). Đây **không phải xác thực doanh nghiệp**: ai truy cập được `/ops` đều chọn được mọi danh tính demo. Mỗi quyết định lưu `actor_id`, `identity_source = demo` và được gắn nhãn [DEMO].
- **Chế độ `production`:** lõi từ chối mọi danh tính không phải `enterprise`. Hiện chưa có nhà cung cấp danh tính doanh nghiệp, nên phê duyệt bị chặn hoàn toàn (401 ở API, nhãn đỏ trên UI).

**Quyền thao tác (kiểm tra ở lõi, không chỉ ở route):** mọi thao tác ghi đều cần danh tính phía server và vai trò trong `ops-config.json → permissions`; bị từ chối thì trả 401/403 và **không ghi gì**; thao tác được phép ghi vào bảng `audit_log` (không chứa secret; bảng này không bị xóa khi reset).

| Thao tác | Vai trò mặc định | Ghi chú |
|---|---|---|
| Reset / gây lỗi giả lập | Quản trị hệ thống | Chỉ chế độ demo; production không có đường reset |
| Nạp dữ liệu mẫu | Kỹ sư, Trưởng phòng KT, OIM, Asset Manager, Quản trị, Tích hợp | Chỉ chế độ demo |
| Nhập dữ liệu | theo loại dữ liệu (xem §6) | phiên người dùng hoặc token tích hợp |
| Cấu hình Claude API | Quản trị hệ thống, Asset Manager | production: sửa file + khởi động lại |
| Chạy lại task lỗi | các vai trò nghiệp vụ, Quản trị, Tích hợp | |
| Ghi nhận thực hiện | OIM, Kỹ sư, Trưởng phòng KT, Giám sát giếng | chỉ người, không service |
| Xác nhận / ghi hủy booking | tàu, bay: Marine coordinator, OIM · ngân sách: Asset Manager | chỉ người; kiểm tra trạng thái case, số lượng, revision |
| Duyệt cổng / duyệt gửi | theo `approvals` và ma trận thẩm quyền | chỉ người (demo/doanh nghiệp) — credential `service` bị từ chối ở lõi dù có vai trò, ở mọi chế độ |

**Giữ chỗ và booking bên ngoài:**
- `held` (giữ nội bộ, có hạn) → người phụ trách ghi mã booking → `confirmed`. Xác nhận gắn với **đúng số lượng** và **revision hiện hành của case**; form của revision cũ bị từ chối (409). Hết hạn kiểm tra ngay khi bấm: giữ chỗ còn hiệu lực **trước** `expires_at`, đúng thời điểm `expires_at` là đã hết hạn. Mã booking không dùng lại được cho giữ chỗ khác cùng loại. Gửi kèm `idempotencyKey` để bấm lại/khởi động lại không ghi trùng (cùng khóa khác nội dung → 409).
- **Carry-forward giữa các revision:** giữ chỗ lập ở revision cũ chỉ được xác nhận ở revision mới khi **kế hoạch hiện hành** (bước `log.plan`/`fin.check` đã xong ở revision này) cần đúng loại, mã, số lượng, đơn vị đó; nếu kế hoạch đang lập lại hoặc cần nội dung khác → 409, không ghi mã ngoài. Booking đã xác nhận mà kế hoạch lập lại cần đúng nội dung cũ được ánh xạ sang revision mới (không tạo bản sửa, không đếm trùng). Mọi lần chuyển tiếp đều lưu trong `reservation_events` (revision cũ → mới, hash nội dung, lần chạy kế hoạch làm căn cứ).
- Kế hoạch đổi số lượng (vd 10 → 70 m²) **không thừa hưởng** xác nhận cũ: tạo dòng **điều chỉnh** (`amendment_of`) ở trạng thái `held`, cần mã xác nhận mới; booking cũ vẫn `confirmed` và vẫn chiếm chỗ cho đến khi điều chỉnh được xác nhận (khi đó bản cũ → `superseded`). Một chuỗi booking chỉ tính phần lớn nhất, không cộng hai lần.
- Bỏ một booking đã xác nhận khỏi kế hoạch → `cancel_requested` (vẫn chiếm chỗ). Chỉ khi người phụ trách ghi **mã hủy** của bên ngoài ("Ghi đã hủy") mới → `cancelled` và nhả chỗ. Hệ thống không tự hủy booking.
- Ghi hủy một booking mà **kế hoạch hiện hành còn cần** → ngay lập tức bước sở hữu (`log.plan` hoặc `fin.check`) và mọi bước sau (hồ sơ, cổng, bản nháp Outbox) thành stale, revision mới ghi lý do; kế hoạch tự lập lại và giữ chỗ thay thế nếu còn chỗ. Booking lịch sử đã hủy/nhả mà kế hoạch không còn cần thì không chặn case.
- Ghi xác nhận khi bước sẵn sàng đã có kết quả → hồ sơ sẵn sàng được dựng lại (không tăng revision) để cổng thấy booking mới; xác nhận đến giữa lúc bước đó đang chạy thì lần chạy bị loại và chạy lại (sổ giữ chỗ là đầu vào có fingerprint).
- Thực hiện xong → booking đã xác nhận → `consumed`.
- **Kiểm tra lại khi quyết định** (trong cùng giao dịch ghi): đối chiếu **nhu cầu của kế hoạch hiện hành** với sổ giữ chỗ — không chỉ "có gì hết hạn". Không còn đúng thì trả **409** nêu tài nguyên và bước xử lý, không ghi quyết định, đưa nhánh liên quan về lập lại, tăng revision và ghi lý do.

| Cổng / thao tác | Mỗi tài nguyên kế hoạch cần phải ở trạng thái | Kiểm tra thêm lúc bấm |
|---|---|---|
| Duyệt cam kết (`gate.asset`) | giữ nội bộ còn hạn **hoặc** đã xác nhận (bản điều chỉnh chưa xác nhận vẫn đủ cho lập kế hoạch) | ngày dùng tàu/bay chưa qua; dữ liệu đầu vào hồ sơ chưa đổi |
| Duyệt gửi PR / yêu cầu đặt tàu (Outbox) | như duyệt cam kết | bản nháp đúng revision hiện hành |
| Duyệt sẵn sàng (`gate.readiness`) | tàu/bay **đã xác nhận** đúng số lượng (bản điều chỉnh chưa xác nhận **không** đủ); ngân sách: giữ hoặc xác nhận | ngày thực hiện chưa qua; từng hồ sơ HSE đã dùng vẫn `Approved` và hiệu lực tại ngày thực hiện (`valid_from` ≤ ngày ≤ `valid_to`); dự báo thời tiết ngày thực hiện có và trong giới hạn `logistics_limits` |
| Ghi thực hiện | booking đã xác nhận → `consumed` khi bước thực hiện xong | — |

Trạng thái gây chặn: `cancel_requested`, `cancelled`, `released`, `expired`, không có dòng nào, hoặc số lượng trên sổ khác kế hoạch. Các điều kiện readiness `transport_holds_valid`, `transport_booked`, `weather_in_limits` là **kiểm tra bằng dữ liệu, không miễn trừ được**; ô tick chỉ dành cho việc chỉ người làm được (PTW theo quy trình giàn, chứng chỉ nhân sự, xem dự báo mới nhất, danh sách người ra giàn). Kế hoạch hậu cần lập trước khi có sổ giữ chỗ (DB cũ) hiển thị `transport_booked` chưa đạt kèm hướng dẫn "Yêu cầu bổ sung → log.plan".

**Quyết định ở cổng duyệt:**
- `packageSha` là **bắt buộc** (tùy chọn kèm `packageVersion`). Thiếu, sai hoặc là hồ sơ cũ thì bị từ chối mà không thay đổi task/workflow.
- `idempotencyKey` gắn với nội dung yêu cầu: gửi lại đúng yêu cầu thì nhận `duplicate: true`; dùng lại khóa cho nội dung khác thì bị từ chối (409).

**Outbox (duyệt gửi từng bản nháp):** cần đủ 4 điều kiện:
- Danh tính có vai trò trong `approvals.outboxRoles` hoặc vai trò người duyệt cuối của case.
- Case đã được duyệt.
- Bản nháp đúng `docId` và `docSha256` đã xem.
- Câu lệnh cập nhật thực sự thay đổi bản ghi.

Nếu cập nhật không thành công, hệ thống không báo "đã duyệt". **Chưa có adapter gửi ra ngoài.**

### LLM — kiểm tra được gì và không được gì

- Kết luận, trạng thái task và mọi phép tính **luôn do quy tắc** tạo ra. Nội dung LLM nằm trong khối riêng gắn nhãn **"CHƯA XÁC MINH NGỮ NGHĨA"**, không trộn vào danh sách kết luận.
- **Bốn bước kiểm tra tự động:**
  1. Mỗi nhận định phải trích dẫn mã bằng chứng tồn tại.
  2. Mọi con số và ngày trong nhận định phải xuất hiện trong chính bằng chứng được trích dẫn.
  3. Không được tuyên bố đã phê duyệt, đã cấp phép hay đã gửi. Câu như vậy bị cắt khỏi phần diễn giải; nhận định như vậy bị loại.
  4. Không được khẳng định giả thuyết mà quy tắc đánh giá "chưa đủ dữ liệu" hoặc "không ủng hộ", và không được phủ nhận dữ liệu bắt buộc còn thiếu.

  Nội dung bị loại vẫn được lưu kèm lý do để kiểm tra lại.
- **Giới hạn:** các kiểm tra này chỉ chứng minh *có liên kết* và *không mâu thuẫn ở mức bề mặt*. Mã bằng chứng hợp lệ **không** chứng minh nhận định đúng. Một suy luận sai về nghĩa nhưng dùng đúng con số vẫn có thể lọt qua; người đọc phải tự kiểm tra.
- **Khi thiếu credentials hoặc cấu hình sai:** chế độ hiệu lực là `blocked`, agent tạm dừng kèm lý do, và việc nhập dữ liệu vẫn hoạt động. **Khi một lần gọi LLM lỗi:** task chuyển sang trạng thái lỗi và trạng thái cấu hình thành "lần gọi gần nhất lỗi".
- **Tài liệu tải lên** được đưa vào prompt trong khối `<untrusted_document>`; câu dạng mệnh lệnh bị gắn cờ. Mọi prompt và response đều được lưu trong `llm_calls`.
- **Chưa kiểm chứng với Claude API thật**: chỉ mới test bằng client giả lập và mock HTTP cục bộ (`OPS_LLM_BASE_URL`). Lần dùng đầu tiên nên bấm "Kiểm tra kết nối (miễn phí)", rồi "Gọi thử 1 lần (có phí)".

## 8. Giới hạn của MVP

- **Chưa có tích hợp CMMS/ERP/đặt chỗ:**
  - Work request, PR và đặt chỗ chỉ là bản nháp.
  - Xác nhận đặt chỗ được ghi tay, kèm mã của bên ngoài.
  - Kết quả thực hiện do người phụ trách ghi nhận.
- **Phân tích tác động:** dữ liệu dùng chung được theo dõi theo mã (§6). Các bước chọn ứng viên từ toàn bộ danh mục (vd đánh giá kỹ thuật đọc cả `activity_catalog`, ma trận thẩm quyền, PSC) vẫn phụ thuộc cả dataset — đổi bất kỳ dòng nào ở đó sẽ làm lại bước đó, có chủ ý.
- **Ưu tiên case** ước tính theo sản lượng mất (baseline × % giảm); chưa tính giá trị kinh tế hay rủi ro HSE.

- **Chưa có danh tính doanh nghiệp (SSO) — "chưa cấu hình".** Phê duyệt chỉ chạy ở chế độ DEMO; chế độ `production` chặn phê duyệt và mọi thao tác của danh tính demo. Mọi API ghi đều kiểm tra danh tính và vai trò, nhưng danh tính demo do người dùng tự chọn, nên **vẫn không mở cổng 3000 ra ngoài**. Nhập dữ liệu tự động dùng token tích hợp (`OPS_INGEST_TOKEN`).
- **Outbox chưa có kênh gửi tự động.** "Duyệt gửi" chỉ ghi nhận phê duyệt; việc gửi làm thủ công.
- **Bộ chạy task là một tiến trình trong server Next.js.** Chạy nhiều instance cần thêm khóa phân tán.
- **Ngày huy động tính từ ngày duyệt thực tế.** Lịch tàu, lịch bay, thời tiết giả lập kéo tới 02/2027 (thời tiết tới giữa 12/2026); quá các mốc đó, agent sẽ báo "chưa có chuyến/dự báo" — đúng với dữ liệu.
- **Ngưỡng và danh mục hoạt động là cấu hình mẫu**, cần chuyên gia của doanh nghiệp hiệu chỉnh trước khi dùng thực.

## 9. Văn phòng 3D: kích thước nhân sự và tên phòng

- **Kích thước nhân sự**:
  - Chỉnh một tham số duy nhất `AGENT_FIGURE_SCALE` (mặc định 1.5) trong `packages/engine/src/agentFigure.ts`. Thân, đầu, chân, độ cao ngồi và vị trí nhãn đều suy ra từ tham số này.
  - Ở mức 1.5: đứng cao ≈ 1,84 (cửa cao 2,2), thân rộng 0,45 (cửa rộng 1,2). Test kiểm tra mọi chỗ ngồi trong các template và preset: người không chạm tường và hai người không chồng nhau.
- **Chỗ ngồi**: mô hình ghế GLB có gốc toạ độ ở góc, nên điểm ngồi và độ cao mặt ghế lấy từ bảng đo `seatAnchor()` trong `packages/engine/src/seating.ts`.
- **Tên phòng**:
  - Hiển thị từ `displayName` (template `oil-gas-ops`), hoặc nhãn bỏ hậu tố `· zone_*`.
  - **`label` giữ nguyên**, vì nó chứa `zone_*` dùng cho ánh xạ workflow, chỗ ngồi `label::index` và đường đi.
  - Nhãn đặt trên tường sau của phòng để không che người và bàn ghế.
  - Cỡ chữ 21px đậm, nền tối viền màu phòng; tự xuống dòng, không bị cắt.
  - Khi xem toàn cảnh, chữ không nhỏ hơn 13px. Tham số nằm trong `packages/app/components/scene/roomLabelStyle.ts`.

## 10. Sinh lại dữ liệu và mặt bằng

```bash
python3 oilgas/sample-data/generate_sample_data.py   # bộ dữ liệu GIẢ LẬP (seed cố định)
python3 oilgas/generate_ops_layout.py                 # mặt bằng 3D 10 phòng (tên hiển thị tiếng Việt: dict DISPLAY)
npm test                                              # kiểm tra lại (mặt bằng đi được, luồng end-to-end)
```
