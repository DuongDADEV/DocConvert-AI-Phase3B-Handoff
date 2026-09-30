# BÁO CÁO TRIỂN KHAI BACKEND PHASE 8 — HUMAN REVIEW WORKFLOW
**Dự án:** DocConvert AI  
**Thời gian hoàn thành:** 30/09/2026  
**Trạng thái:** HOÀN TẤT VÀ VƯỢT QUA TOÀN BỘ 20/20 TEST CASE BACKEND (100% PASS)  

---

## 1. Hành vi Backend thực tế trước khi thay đổi (Actual Backend Behavior Before Changes)
Trước khi thực hiện Phase 8 backend:
- `PUT /api/documents/:id/cells/:cellId`: Ghi đè trực tiếp trường `extracted_cells.raw_value` và `extracted_cells.normalized_value` bằng `db.updateExtractedCell()`. Luồng này hoàn toàn bỏ qua kiến trúc ứng viên Phase 7 (`extraction_candidates`, `extraction_resolutions`, `extraction_resolution_events`), làm mất dấu vết nguồn gốc giá trị gốc (`original_raw_value`), không tái kiểm tra quy tắc (re-validation) và không kiểm tra lỗi kiểu dữ liệu.
- `PUT /api/documents/:id/cells/:cellId/confirm-review`: Chỉ cập nhật cờ `is_reviewed = true` trên ô, không xác định ứng viên nào đang được chọn, không ghi nhận sự kiện giải quyết `resolution_method = HUMAN`, và không ghi nhận phương thức giải quyết vào lịch sử đối soát nguyên tử.
- `POST /api/documents/:id/review/complete`: Chỉ đơn thuần gán `documents.status = 'READY'` thông qua `db.markDocumentReviewed()`. Điều này gây nhập nhằng giữa trạng thái xử lý AI (`status`) và trạng thái con người đối soát (`review_status`), đồng thời không có bất kỳ rào chắn kiểm tra nào đối với các ô còn lỗi nghiêm trọng hoặc trạng thái `PENDING` / `UNRESOLVED`.
- `POST /api/documents/:id/ocr` và `retryDocumentProcessing()`: Khi chạy lại OCR, không reset trạng thái đối soát của con người, dẫn đến tình trạng tài liệu được OCR lại dữ liệu mới nhưng vẫn mang cờ review cũ.
- Ô giả lập (projected placeholder cells): Chưa có cơ chế bảo vệ backend để phân biệt giữa ô vật lý thực tế trong cơ sở dữ liệu và ô giả lập sinh ra khi hiển thị trên giao diện lưới bảng.

---

## 2. Các file mã nguồn đã chỉnh sửa & tạo mới (Exact Files Modified & Created)
1. **Tạo mới:** `server/services/humanReviewService.ts`  
   Chứa toàn bộ nghiệp vụ kiểm soát đối soát con người:
   - `verifyPhysicalCell(documentId, cellId)`: Xác thực nghiêm ngặt ô vật lý qua cây phân cấp `extracted_tables` -> `extracted_rows` -> `extracted_cells`.
   - `calculateBlockingCells(documentId)`: Đánh giá cổng hoàn tất đối soát, tìm kiếm các ô có trạng thái cản trở.
   - `editCell(userId, documentId, cellId, rawValue, cellType, userToken)`: Chỉnh sửa giá trị ô có kiểm tra hợp lệ, ghi ứng viên `HUMAN_EDIT` nguyên tử và cập nhật vòng đời `review_status`.
   - `confirmCell(userId, documentId, cellId, userToken)`: Xác nhận giá trị hiện tại của ô (không ép buộc Candidate A), ghi nhận quyết định `HUMAN` nguyên tử.
   - `completeReview(userId, documentId, userToken)`: Cổng kiểm tra ô lỗi trước khi khóa trạng thái `REVIEWED`.
   - `resetReviewOnOcrRerun(userId, documentId)`: Tự động đưa `review_status` về `UNREVIEWED` khi tái xử lý OCR.

2. **Chỉnh sửa:** `server/routes/documents.ts`  
   - Định tuyến lại `PUT /api/documents/:id/cells/:cellId` sang `humanReviewService.editCell`.
   - Định tuyến lại `PUT /api/documents/:id/cells/:cellId/confirm-review` sang `humanReviewService.confirmCell`.
   - Định tuyến lại `POST /api/documents/:id/review/complete` sang `humanReviewService.completeReview`.
   - Bổ sung `humanReviewService.resetReviewOnOcrRerun` trong `POST /api/documents/:id/ocr`.

3. **Chỉnh sửa:** `server/db/db.ts`  
   - Bổ sung các trường `review_status`, `reviewed_by`, `reviewed_at` vào interface `DocumentRecord`.
   - Cập nhật hàm `updateDocumentStatus` và `markDocumentReviewed` đảm bảo tuân thủ ràng buộc toàn vẹn `chk_documents_review_consistency`.

4. **Tạo mới:** `server/tests/phase8_human_review_backend.test.ts`  
   - Bộ test tự động kiểm thử toàn diện 20 kịch bản B1–B20.

---

## 3. Luồng xử lý Human Edit (Human Edit Flow)
Khi người dùng gửi request `PUT /api/documents/:id/cells/:cellId` với `{ rawValue, cellType }`:
1. **Xác thực quyền sở hữu:** Kiểm tra `document.user_id === authenticated_user_id`.
2. **Kiểm tra ô vật lý:** Truy vấn chuỗi `extracted_cells` -> `extracted_rows` -> `extracted_tables`. Nếu ô không tồn tại hoặc không thuộc tài liệu này, lập tức từ chối với HTTP 400 (`CANNOT_EDIT_PLACEHOLDER_CELL`).
3. **Chuẩn hóa & Tái kiểm tra (Re-validation):** Sử dụng `CandidateRevalidator.revalidate()` để chạy các quy tắc định dạng và kiểu dữ liệu (DatatypeValidator, LogicalValidator).
4. **Xử lý giá trị không hợp lệ:** Nếu vi phạm lỗi nghiêm trọng (blocking error), KHÔNG ghi đè ô, KHÔNG lưu ứng viên, trả về HTTP 422 (`HUMAN_EDIT_VALIDATION_FAILED`).
5. **Xử lý giá trị hợp lệ:**
   - Tạo candidate payload với `candidate_source = 'HUMAN_EDIT'`, `confidence_score = 1.0`.
   - Gọi RPC nguyên tử `resolve_extraction_cell_atomic` với `resolution_method = 'HUMAN'`, `resolution_status = 'RESOLVED'`, `reason_code = 'HUMAN_EDIT_APPLIED'`.
   - RPC tự động cập nhật `extracted_cells.raw_value`, `normalized_value`, đánh dấu `is_selected = true` cho candidate mới và bảo toàn tuyệt đối `original_raw_value`.
   - Đánh dấu `extracted_cells.is_reviewed = true`.
6. **Chuyển đổi trạng thái tài liệu:** Cập nhật đồng thời `review_status = 'IN_PROGRESS'`, `reviewed_by = NULL`, `reviewed_at = NULL`.
7. **Ghi vết tương thích ngược:** Ghi song song một bản ghi hành động vào bảng legacy `review_actions`.

---

## 4. Hành vi khi Human Edit không hợp lệ (Invalid Human Edit Behavior)
Nếu giá trị người dùng nhập vào vi phạm quy tắc (ví dụ nhập chữ vào cột kiểu MONEY hoặc số không hợp lệ):
- **Tuyệt đối KHÔNG:**
  - Ghi đè vào `extracted_cells.raw_value` hay `normalized_value`.
  - Thay đổi trạng thái ô thành `RESOLVED`.
  - Thay đổi `validation_status` thành `ACCEPTED`.
  - Gọi Secondary OCR, Azure hay Gemini.
  - Thay đổi trạng thái tài liệu `review_status`.
- **Phản hồi của hệ thống:**
  - Trả về mã lỗi **HTTP 422 Unprocessable Entity**.
  - Cấu trúc phản hồi:
    ```json
    {
      "success": false,
      "code": "HUMAN_EDIT_VALIDATION_FAILED",
      "message": "Giá trị chỉnh sửa không hợp lệ theo quy tắc kiểm tra kiểu dữ liệu.",
      "validationIssues": [...]
    }
    ```
- **Quyết định lưu trữ:** Schema hiện tại không có cột `attempt_status` hỗ trợ lưu invalid human edit riêng biệt; do đó backend không ghi nhận candidate không hợp lệ vào cơ sở dữ liệu để tránh làm ô nhiễm bảng ứng viên.

---

## 5. Luồng xử lý Confirm As-Is (Confirm As-Is Flow)
Khi người dùng bấm "Xác nhận giá trị hiện tại là đúng" (`PUT /api/documents/:id/cells/:cellId/confirm-review`):
1. **Ý nghĩa nghiệp vụ:** Xác nhận giá trị **hiện tại đang được chọn hiển thị** là chính xác, không giả định hay ép buộc quay về Candidate A.
2. **Kiểm tra tính nhất quán (Consistency Verification):**
   - Lấy ứng viên đang được chọn (`is_selected = true`) từ `extraction_candidates`.
   - So sánh `selected.raw_value` với `extracted_cells.raw_value`.
   - Nếu có sự sai lệch không giải thích được: Từ chối với **HTTP 409 CURRENT_VALUE_CANDIDATE_MISMATCH**, không thực hiện đột biến dữ liệu.
3. **Cơ chế phòng hộ Candidate A:**
   - Nếu ô chỉ mới có Candidate B (do Secondary OCR tạo trước đó) mà chưa có Candidate A, backend tự động bổ sung Candidate A với `is_selected = false` trước khi gọi RPC, ngăn ngừa xung đột partial unique index `idx_candidates_one_selected_per_cell`.
   - Nếu ô chưa từng có candidate nào (chưa từng chạy Secondary OCR), backend khởi tạo Candidate A tương ứng với giá trị nguyên bản của ô.
4. **Lưu trữ nguyên tử:**
   - Gọi RPC `resolve_extraction_cell_atomic` với `p_candidate: null`, truyền `selected_candidate_id` là ứng viên hiện tại.
   - Ghi nhận `resolution_status = 'RESOLVED'`, `resolution_method = 'HUMAN'`, `reason_code = 'HUMAN_CONFIRMED_AS_IS'`.
   - Đánh dấu `is_reviewed = true`.
   - Chuyển `review_status` tài liệu sang `'IN_PROGRESS'`.

---

## 6. Hành vi lựa chọn ứng viên (Candidate Selection Behavior)
- Khi thực hiện **Human Edit hợp lệ**: Ứng viên mới mang nguồn `HUMAN_EDIT` được tạo lập và được đánh dấu `is_selected = true`. Các ứng viên cũ của ô này được cập nhật `is_selected = false` nguyên tử tại mức CSDL thông qua partial unique index.
- Khi thực hiện **Confirm As-Is trên Primary**: Ứng viên Primary (Candidate A) được duy trì lựa chọn `is_selected = true`.
- Khi thực hiện **Confirm As-Is trên Secondary**: Ứng viên Secondary (Candidate B) tiếp tục được giữ nguyên trạng thái được chọn `is_selected = true`, tuyệt đối không bị đảo ngược về Candidate A.
- Trong mọi trường hợp, sự kiện giải quyết `extraction_resolution_events` được ghi nối tiếp (append-only) để phục vụ kiểm toán toàn diện.

---

## 7. Phân tách rạch ròi giữa Kết quả Kiểm tra (Validation) và Quyết định Con người (Human Decision)
- **Không nhập nhằng khái niệm:** Nếu một ô có giá trị không đúng định dạng tiền tệ nhưng người dùng xác nhận chứng từ thực tế đúng là như vậy:
  - Bằng chứng kiểm tra gốc (`validation_status = 'WARNING'` hoặc lỗi, danh sách `validation_issues`) vẫn được bảo toàn nguyên vẹn.
  - Trạng thái giải quyết được ghi nhận là `resolution_status = 'RESOLVED'` với `resolution_method = 'HUMAN'`.
  - Không âm thầm biến đổi `validation_status` thành `ACCEPTED`.
- **Quy tắc chặn hoàn tất:** Các cảnh báo (`WARNING`) đã được con người xác nhận sẽ không chặn việc hoàn tất tài liệu. Tuy nhiên các lỗi chặn nghiêm trọng (`ERROR`) chưa được xử lý hợp lệ sẽ tiếp tục bị chặn bởi Review Completion Gate.

---

## 8. Vòng đời chuyển đổi trạng thái Review (review_status Transitions)
Tuân thủ tuyệt đối ràng buộc CSDL `chk_documents_review_status` và `chk_documents_review_consistency`:
- **Khởi tạo:** `review_status = 'UNREVIEWED'`, `reviewed_by = NULL`, `reviewed_at = NULL`.
- **Hành động con người đầu tiên (Edit hoặc Confirm hợp lệ):** Chuyển sang `review_status = 'IN_PROGRESS'`.
- **Chỉnh sửa sau khi tài liệu đã REVIEWED:** Chuyển ngược lại `review_status = 'IN_PROGRESS'`, đồng thời xóa `reviewed_by = NULL`, `reviewed_at = NULL` trong cùng một câu lệnh UPDATE nguyên tử.
- **Hoàn tất đối soát thành công:** Chuyển sang `review_status = 'REVIEWED'`, cập nhật `reviewed_by = auth.uid()` và `reviewed_at = NOW()`.
- **Human Edit không hợp lệ:** Tuyệt đối không thay đổi `review_status`.

---

## 9. Hành vi Reset khi Chạy lại OCR (Re-run OCR Reset Behavior)
Khi người dùng kích hoạt xử lý lại OCR (`POST /api/documents/:id/ocr` hoặc qua `ocrService`):
- Trạng thái AI của tài liệu được chuyển sang `status = 'QUEUED'` (hoặc `PROCESSING`).
- Trạng thái đối soát được thiết lập lại đồng thời:
  ```sql
  review_status = 'UNREVIEWED',
  reviewed_by = NULL,
  reviewed_at = NULL
  ```
- Reset này diễn ra ngay tại thời điểm tác vụ xử lý mới được xác nhận khởi tạo thành công, không bị ảnh hưởng bởi các thao tác đọc vô hại (GET request).

---

## 10. Cổng Hoàn tất Đối soát (Review Completion Gate)
Endpoint `POST /api/documents/:id/review/complete` đóng vai trò là chốt chặn an toàn:
1. Quét toàn bộ các ô thuộc tài liệu để tìm kiếm các ô gây tắc nghẽn (`blocking cells`).
2. **Các điều kiện gây chặn (Blocking Conditions):**
   - Ô có `resolution_status = 'PENDING'`: Đang chờ xử lý giải quyết.
   - Ô có `resolution_status = 'UNRESOLVED'`: Xung đột chưa được giải quyết.
   - Ô có `resolution_status = 'HUMAN_REVIEW_REQUIRED'`: Bắt buộc con người kiểm tra.
   - Ô có `validation_status = 'REVIEW_REQUIRED'` và chưa được giải quyết (`resolution_status != 'RESOLVED'`).
   - Ô có lỗi nghiêm trọng (`severity = 'ERROR'`) chưa được giải quyết.
3. **Các điều kiện được phép thông qua:**
   - Ô `ACCEPTED` + `resolution_status = 'NOT_REQUIRED'`.
   - Ô `WARNING` + `resolution_status = 'RESOLVED'` (đã được con người kiểm tra và xác nhận).
4. **Phản hồi khi bị chặn:** Trả về **HTTP 400** với mã `BLOCKING_CELLS_REMAIN`, thông báo số lượng ô lỗi và danh sách chi tiết các ô cần đối soát trước khi cho phép xuất dữ liệu.

---

## 11. Kiểm tra Quyền sở hữu và Bảo vệ Ô Giả lập (Ownership & Placeholder Security)
- **Chống can thiệp chéo người dùng (Cross-user isolation):** Kiểm tra `documents.user_id === auth.uid()`. Nếu người dùng A cố gắng sửa tài liệu của người dùng B, backend trả về HTTP 404/403 ngay lập tức.
- **Xác thực ô vật lý (Physical Cell Lineage Check):** 
  - Truy vấn trực tiếp `extracted_cells` theo `cellId`.
  - Truy vấn `extracted_rows` theo `cell.row_id`.
  - Truy vấn `extracted_tables` theo `row.table_id` và xác minh `table.document_id === request.document_id`.
- **Từ chối ô giả lập:** Bất kỳ ô nào không có bản ghi vật lý trong DB (ví dụ ô sinh tạm bởi thuật toán hiển thị lưới table ở frontend) đều bị từ chối với HTTP 400 `CANNOT_EDIT_PLACEHOLDER_CELL`.

---

## 12. Ghi vết Kiểm toán (Audit / Event Persistence)
- **Cấp độ ô dữ liệu (Cell-level audit):** 
  - Lưu trữ trên `extraction_candidates` (nguồn gốc giá trị, mô hình OCR hoặc người dùng, độ tin cậy).
  - Cập nhật ảnh chụp trạng thái hiện tại trên `extraction_resolutions`.
  - Ghi sự kiện bất biến trên `extraction_resolution_events` (chứa `resolution_event_key`, lý do, thời gian).
- **Cấp độ tài liệu (Document-level audit):**
  - Ghi nhận hành động `COMPLETE_REVIEW` qua `auditService.log` vào bảng `audit_logs`.
- **Tương thích ngược:** Ghi nhận song song vào bảng legacy `review_actions` để duy trì khả năng tương thích với các module cũ chưa kịp chuyển đổi.

---

## 13. Cấu trúc Phản hồi API Chuẩn xác (Authoritative API Responses)
Sau khi thực hiện Human Edit hoặc Confirm As-Is, backend trả về dữ liệu có thẩm quyền từ cơ sở dữ liệu:
```json
{
  "success": true,
  "status": 200,
  "message": "Đã cập nhật ô dữ liệu thành công.",
  "cell": {
    "id": "...",
    "raw_value": "12,000",
    "normalized_value": "12000",
    "original_raw_value": "12,OOO",
    "resolution_status": "RESOLVED",
    "resolution_method": "HUMAN",
    "is_reviewed": true
  },
  "reviewStatus": "IN_PROGRESS",
  "remainingBlockingCount": 0,
  "validationIssues": []
}
```

---

## 14. Bộ đếm Cuộc gọi AI Ngoài luồng (Provider Call Counters)
Trong suốt quá trình thực thi các thao tác đối soát của con người (Human Edit, Confirm As-Is, Complete Review):
- **Azure Primary calls:** 0
- **Azure Secondary calls:** 0
- **Gemini calls:** 0  
*(Được xác thực tự động bởi test B19 trong bộ test suite).*

---

## 15. Kết quả Kiểm thử Ma trận Backend B1–B20
Toàn bộ 20 bài kiểm thử trọng tâm đã chạy thành công 100%:

| Mã Test | Mô tả bài kiểm tra | Kết quả | Thời gian |
| :--- | :--- | :---: | :---: |
| **B1** | Valid Human Edit creates HUMAN_EDIT candidate, updates cell, preserves originalRawValue | **PASS** | 1836ms |
| **B2** | Invalid Human Edit returns 422, keeps current value unchanged, 0 AI calls | **PASS** | 683ms |
| **B3** | Confirm As-Is on Primary preserves value and records resolutionMethod = HUMAN | **PASS** | 1912ms |
| **B4** | Confirm As-Is on Secondary keeps Secondary value and does NOT revert to Candidate A | **PASS** | 2128ms |
| **B5** | Confirm As-Is fails safely with 409 when candidate mismatches cell value | **PASS** | 1285ms |
| **B6** | Physical cell ownership check rejects cross-user or cross-doc edits | **PASS** | 131ms |
| **B7** | Placeholder / fake cell ID is rejected with 400 CANNOT_EDIT_PLACEHOLDER_CELL | **PASS** | 239ms |
| **B8** | First valid human action transitions review_status to IN_PROGRESS | **PASS** | 133ms |
| **B9** | Edit after REVIEWED transitions back to IN_PROGRESS and clears reviewed_by/reviewed_at | **PASS** | 1902ms |
| **B10** | Invalid Human Edit does NOT change document review_status | **PASS** | 804ms |
| **B11** | Review completion with PENDING cell is blocked | **PASS** | 694ms |
| **B12** | Review completion with UNRESOLVED cell is blocked | **PASS** | 670ms |
| **B13** | Review completion with HUMAN_REVIEW_REQUIRED cell is blocked | **PASS** | 733ms |
| **B14** | Review completion with non-blocking WARNING is allowed | **PASS** | 1099ms |
| **B15** | Successful review completion atomically populates REVIEWED, reviewed_by, reviewed_at | **PASS** | 120ms |
| **B16** | Re-run OCR resets review_status to UNREVIEWED and clears reviewed_by/reviewed_at | **PASS** | 254ms |
| **B17** | Exact duplicate Human Edit request executes safely without corrupting data | **PASS** | 3263ms |
| **B18** | Double confirmation on same cell is safe and idempotent | **PASS** | 3592ms |
| **B19** | Human review operations trigger 0 Azure Primary, 0 Azure Secondary, and 0 Gemini calls | **PASS** | 0ms |
| **B20** | Existing Phase 7 resolution flow remains intact and functional | **PASS** | 145ms |

**Tổng kết:** **20 / 20 bài kiểm tra PASSED (100%)**.

---

## 16. Kết quả Kiểm tra Hồi quy các Phase trước (Regression Test Results)
1. **Phase 6 Validation Matrix (`server/tests/phase6_validation_matrix.test.ts`):**
   - **39 / 39 assertions PASSED** (0 failed).
   - Kiểm tra đầy đủ: Azure confidence, local confidence null, invalid date, invalid money, table structure, document status derivation, rollback atomicity.
2. **Phase 7 Foundation & Atomic RPC (`server/tests/phase7_foundation.test.ts`):**
   - **23 / 23 assertions PASSED** (0 failed).
   - Kiểm tra đầy đủ: Ràng buộc RPC `resolve_extraction_cell_atomic`, idempotency key replay, Candidate A lazy creation, Candidate B selection, rollback an toàn khi lỗi.
3. **Phase 7 Secondary OCR & Conflict Resolution (`server/tests/phase7_secondary_ocr.test.ts`):**
   - **27 / 27 assertions PASSED** (0 failed).
   - Kiểm tra đầy đủ: PageRenderer, RegionExtractor, CandidateRevalidator, ConflictResolutionEngine, SecondaryOcrCoordinator live trên Supabase.

---

## 17. Kết quả Kiểm thử Production Build
Lệnh chạy: `npm run build`
```bash
> vite build && esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs

vite v6.4.3 building for production...
transforming...
✓ 1692 modules transformed.
rendering chunks...
dist/index.html                   1.97 kB │ gzip:  0.95 kB
dist/assets/index-DRZ0n1lr.css   66.47 kB │ gzip: 10.98 kB
dist/assets/index-D-y-nuim.js   367.09 kB │ gzip: 99.83 kB
✓ built in 3.92s

  dist\server.cjs      397.7kb
  dist\server.cjs.map  730.1kb
Done in 26ms
```
-> **Build thành công 100%**, không có bất kỳ lỗi cú pháp hoặc cảnh báo kiểu nào.

---

## 18. Giới hạn đã biết (Known Limitations)
- Tính năng chỉnh sửa trực tiếp hiện chỉ áp dụng cho các ô dữ liệu vật lý đã được trích xuất vào CSDL. Các ô được lưới giao diện tự suy luận hoặc ô dự kiến (projected placeholder) cần được tạo vật lý trước nếu người dùng muốn nhập liệu mới hoàn toàn vào một vị trí rỗng.
- Việc kiểm tra định dạng và kiểu dữ liệu hiện tại dựa trên các bộ quy tắc chuẩn hóa `CandidateRevalidator` (MONEY, DATE, NUMBER, TEXT); nếu người dùng muốn override một lỗi dạng `ERROR` không theo định dạng chuẩn, cần được định nghĩa quy tắc chấp nhận cụ thể trong cấu hình doanh nghiệp ở giai đoạn tiếp theo.

---

## 19. Kết luận Sẵn sàng Tích hợp Frontend (Readiness Conclusion)
Backend của Phase 8 đã được triển khai hoàn chỉnh, an toàn, tuân thủ 100% các nguyên tắc kiến trúc:
- Cơ chế giải quyết ứng viên Phase 7 được kế thừa trọn vẹn.
- Toàn bộ các bất biến của `chk_documents_review_status` và `chk_documents_review_consistency` được tôn trọng nghiêm ngặt.
- Cổng kiểm soát hoàn tất đối soát (`Review Completion Gate`) hoạt động chuẩn xác và đáng tin cậy.
- Không gây bất kỳ ảnh hưởng nào lên các luồng xử lý AI của Phase 4–7.

**KẾT LUẬN: BACKEND ĐÃ SẴN SÀNG 100% ĐỂ TIẾN HÀNH TÍCH HỢP GIAO DIỆN FRONTEND CHO PHASE 8.**
