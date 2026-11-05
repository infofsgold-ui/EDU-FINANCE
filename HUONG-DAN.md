# EDU FINANCE 1.0 – Hướng dẫn triển khai

## 1. Đưa code lên Apps Script
```
clasp push
```
Sau đó mở Apps Script Editor → chạy hàm `setupDatabase` (tạo sheet mới: Notifications, Settings và bổ sung cột mới ở cuối các sheet cũ — dữ liệu cũ giữ nguyên).
Muốn xem thử với dữ liệu mẫu: chạy `seedDemoData` trên **một Google Sheet trống** (hàm từ chối chạy nếu đã có trường học).

## 2. Phân quyền (sheet Users hoặc trang Người dùng)
| Vai trò | Phạm vi |
|---|---|
| GROUP_ADMIN – Quản trị hệ thống | Toàn bộ |
| EXECUTIVE – Ban lãnh đạo | Xem dashboard, báo cáo toàn hệ thống |
| FINANCE_MANAGER – Kế toán trưởng | Toàn bộ nghiệp vụ tài chính, mọi trường |
| AUDITOR – Kiểm soát | Chỉ xem, mọi trường |
| PRINCIPAL – Hiệu trưởng | Dashboard trường mình, duyệt chi, quản lý lớp & người dùng của trường |
| SCHOOL_ACCOUNTANT – Kế toán trường | Tính phí, thu tiền, bán hàng, nhập chi, gửi thông báo |
| CASHIER – Thủ quỹ | Thu tiền, bán hàng |
| STOREKEEPER – Thủ kho | Nhập – xuất – chuyển kho, mặt hàng |
| TEACHER – GVCN | Xem học sinh & công nợ lớp mình (Classes.HomeroomTeacher = email hoặc họ tên GV) |
| PARENT – Phụ huynh | Tự nhận diện qua Students.ParentEmail, chỉ thấy con mình + mã QR thanh toán |

## 3. Thông báo học phí
- **Ngân hàng / QR**: trang Cài đặt → chọn ngân hàng, số tài khoản, chủ tài khoản (mặc định hoặc riêng từng trường). QR theo chuẩn VietQR, nội dung chuyển khoản `HP <mã HS> <MMYYYY>` để đối soát.
- **Email**: gửi bằng Gmail của tài khoản chạy script (giới hạn ~100 email/ngày với Gmail thường, ~1.500 với Google Workspace).
- **Zalo OA (ZNS)**: cần OA đã xác thực + ứng dụng Zalo for Developers. Nhập App ID, App Secret, Refresh token và mã mẫu ZNS. Mẫu ZNS đăng ký với tham số:
  `student_name, student_code, class_name, school_name, period, amount, due_date, payment_content, bank_account, invoice_id`.
  Hệ thống tự làm mới access token (refresh token chỉ dùng 1 lần, được lưu lại tự động).
- **SMS**: tích hợp eSMS.vn (API Key, Secret Key, Brandname đã đăng ký). Nội dung SMS không dấu, sửa được mẫu trong Cài đặt.
- Khoá bí mật lưu trong Script Properties, không hiển thị lại trên giao diện.

## 4. Lưu ý triển khai Web App
`appsscript.json` đang để `executeAs: USER_ACCESSING` → mỗi người dùng phải có quyền truy cập Google Sheet dữ liệu.
Phụ huynh/giáo viên không nên được chia sẻ Sheet trực tiếp; nếu dùng cho phụ huynh, nên chuyển sang Google Workspace với
`executeAs: USER_DEPLOYING` + `access: DOMAIN` (cấp tài khoản Workspace cho phụ huynh), hoặc chỉ gửi thông báo qua Email/Zalo/SMS.

## 5. Chính sách giá / hỗ trợ học phí (Danh mục → Chính sách giá / hỗ trợ)
| Nhóm | Cách áp dụng |
|---|---|
| Toàn trường / theo cấp, khối, lớp | Tự áp dụng cho mọi học sinh khớp phạm vi |
| Anh chị em ruột | Tự áp dụng từ con thứ N (nhận diện theo SĐT hoặc email phụ huynh, xếp theo ngày sinh) |
| Đóng trước 1 học kỳ / 1 năm học | Ghi danh học sinh đã đóng trước |
| Con cán bộ, giáo viên, nhân viên | Ghi danh học sinh (ghi chú tên/bộ phận phụ huynh) |
| Hỗ trợ từng học sinh / Chính sách khác | Ghi danh từng học sinh |

- Giảm theo % hoặc số tiền cố định, chọn khoản phí được giảm, giới hạn mức giảm tối đa, thời gian hiệu lực.
- **Cộng dồn**: chính sách “được cộng dồn” cộng với nhau; chính sách “không cộng dồn” không gộp — học sinh hưởng mức có lợi nhất.
- **Duyệt**: chính sách do Kế toán trường tạo/sửa chỉ có hiệu lực sau khi Hiệu trưởng hoặc Kế toán trưởng duyệt. Chính sách “Mọi trường” chỉ cấp tập đoàn được tạo.
- Tên chính sách được ghi trên từng dòng phí của hóa đơn và trong email thông báo phụ huynh.
- **Tờ trình gốc** (PDF/ảnh/Word ≤ 10 MB) được lưu vào thư mục Google Drive
  Config.gs → `APP.DRIVE.DOCUMENTS_FOLDER_ID` (thư mục con “Tờ trình chính sách”).
  Người tải lên cần có **quyền chỉnh sửa** thư mục này.
- Chính sách đã áp dụng cho các kỳ đã phát hành không bị thay đổi; sửa/ngừng chính sách chỉ ảnh hưởng các kỳ tính phí sau.

## 6. Bổ sung bản 1.1
- **Tính học phí nhiều tháng**: chọn nhiều tháng (hoặc nút Học kỳ 1 / Học kỳ 2 / Cả năm). Mỗi học sinh × mỗi tháng = 1 hóa đơn (chống trùng theo tháng, báo cáo theo tháng vẫn đúng).
- **Thông báo phí**: chọn nhiều tháng → mỗi học sinh nhận **một** thông báo liệt kê đủ các tháng, nội dung chuyển khoản dạng `HP <mã HS> 01-032027`.
- **Chính sách cho từng học sinh**: chọn ngay trong form Thêm/Sửa học sinh; lọc danh sách học sinh theo chính sách.
- **Danh mục**: sửa / ngừng trường, lớp, khoản phí, bảng giá.
- **Kho**: nút “+ Tạo kho”, “+ Thêm mặt hàng”; danh sách mặt hàng và kho có thể sửa / ngừng.
- Sửa lỗi: giá theo cấp học (THCS/THPT) nay áp dụng đúng cho trường liên cấp.

## 7. Tiền ăn bán trú (phương án A: thu trước – quyết toán cuối tháng – trừ tháng sau)
Trang **Tiền ăn** (menu Kế toán):
1. **Đầu tháng – Thiết lập tháng**: chọn khoản phí tiền ăn (cách tính “Theo ngày”, đơn giá suất trong Bảng giá), số ngày ăn dự kiến,
   quy định trừ (hạn báo nghỉ; nghỉ không báo có được trừ không).
2. **Đăng ký ăn**: tích/bỏ từng học sinh, sửa số ngày riêng (VD vào học giữa tháng). Tháng sau mặc định giữ như tháng trước.
   → Tính học phí: tiền ăn tạm tính = số ngày dự kiến × đơn giá (sau chính sách giảm nếu có).
3. **Trong/cuối tháng – Ngày nghỉ**: nhập “Nghỉ có báo”, “Nghỉ không báo” (hoặc **Dán từ Excel**: Mã HS ⇥ Nghỉ có báo ⇥ Nghỉ không báo).
   GVCN cũng nhập được cho lớp mình.
4. **Cuối tháng – Chốt tiền ăn**: tính tiền được trừ = số ngày được trừ × đơn giá **thực thu** trên hóa đơn tháng đó; tháng bị khóa.
5. **Tính học phí tháng sau**: tự có dòng “Hoàn tiền ăn Tx (n ngày nghỉ có báo)” số âm trên hóa đơn và trong thông báo gửi phụ huynh.
   Khoản không trừ được (HS nghỉ học…) hiện ở mục 3 để “Đã hoàn tiền” (tiền mặt/chuyển khoản).
- Mở lại tháng đã chốt chỉ được khi chưa có khoản hoàn nào được trừ/hoàn.
- Cần chạy lại `setupDatabase` một lần để tạo sheet `MealMonths`, `MealRecords`.

## 8. Đăng nhập riêng & Cổng phụ huynh (bản 2.0)
**Chế độ triển khai:** `appsscript.json` → Execute as: **Me** · Who has access: **Anyone**. Google không còn cho biết người truy cập,
nên mọi người đăng nhập bằng tài khoản của hệ thống (sheet `Credentials`, mật khẩu băm + salt, khóa 15 phút sau 5 lần sai).
- **Lần đầu (quản trị):** mở web app → tab **Cán bộ** → “Quên mật khẩu / Lần đầu đăng nhập” → nhập email → nhận mật khẩu tạm qua email → đặt mật khẩu mới.
- **Cán bộ khác:** Người dùng → nút **Gửi mật khẩu** (hoặc tự bấm “Quên mật khẩu” với email đã được cấp quyền).
- **Phụ huynh:** Người dùng → **Tài khoản phụ huynh** → chọn học sinh, kênh (Email/SMS/Zalo) → **Cấp tài khoản**.
  Tên đăng nhập = **mã học sinh** (trùng mã giữa các trường thì thêm hậu tố mã trường); mật khẩu tạm; lần đầu bắt buộc đổi.
  Mẫu ZNS gửi tài khoản: tham số `student_name, student_code, username, password, url, school_name`.
- **Trang phụ huynh:** thông báo & khoản cần nộp (QR), học phí theo năm học / học kỳ / tháng (từng khoản, đồ đã mua, thanh toán),
  đăng ký suất ăn tháng này/tháng sau (khóa khi trường đã phát hành học phí tháng đó), đăng ký mua đồ dùng.
- **Đơn mua của phụ huynh:** trang Bán hàng → “Đơn đăng ký mua của phụ huynh” → Xác nhận (tạo hóa đơn + xuất kho, ghi nợ/thu ngay) hoặc Từ chối.
- **Lưu ý:** email gửi từ Gmail info.fsgold@gmail.com (giới hạn ~100 email/ngày với Gmail thường) → cấp tài khoản số lượng lớn nên dùng SMS/Zalo
  hoặc chia nhiều ngày. Báo cáo “Xuất Google Sheets” được tạo trong Drive của chủ sở hữu và tự chia sẻ cho cán bộ xuất báo cáo.
- `setupDatabase` / `seedDemoData` chỉ chạy được từ Apps Script Editor bởi chủ sở hữu.

## 9. Thư mục Google Drive (Config.gs → APP.DRIVE)
| Khóa | Thư mục | Dùng cho |
|---|---|---|
| `DOCUMENTS_FOLDER_ID` | `1YRxLHJo1bV1um6FJo8AqhYGu0NlAJUUv` | Tờ trình chính sách (thư mục con “Tờ trình chính sách”), báo cáo xuất Google Sheets (“Báo cáo”) |
| `PRODUCT_IMAGES_FOLDER_ID` | `1eh688FzXeOQ2kE68wY5jvfLdlkQASVom` | Ảnh hàng hóa (Kho hàng → Mặt hàng → Sửa / Thêm → Ảnh) |
- Đổi thư mục: sửa trong Config.gs, hoặc đặt Script Property cùng tên (không cần sửa code). Kiểm tra kết nối ở trang **Cài đặt**.
- Ảnh hàng hóa được đặt chia sẻ “Bất kỳ ai có đường liên kết – chỉ xem” để phụ huynh (không đăng nhập Google) xem được trong cửa hàng.

## 10. Bản 2.8
- **Lưu ngầm:** khi lưu chỉ hiện nhãn nhỏ “Đang lưu…” phía trên, không che màn hình; bộ lọc (trường, lớp…) giữ nguyên sau khi lưu; chặn bấm lưu 2 lần.
- **Tính phí theo ngày học thực tế:**
  - Hồ sơ học sinh có **Ngày nghỉ học / chuyển trường**. Học sinh nghỉ/chuyển giữa tháng vẫn được tính phí tháng đó đến ngày nghỉ; tháng sau không tính.
  - Học sinh vào học / nghỉ giữa tháng: phí tháng = đơn giá × (ngày học thực tế / ngày học của tháng); phí theo ngày = số ngày học thực tế.
  - “Số ngày tính phí theo ngày” để trống = tự đếm ngày học của tháng theo lịch trường.
  - Cài đặt → **Số ngày học/tuần** (5 hoặc 6) và **Ngày nghỉ lễ** (VD `20/11/2026, 01/01/2027`).
- **Phụ huynh báo nghỉ ăn:** Trang phụ huynh → Đăng ký suất ăn → *Báo nghỉ ăn của con* (từ ngày – đến ngày, lý do; báo trước giờ hạn mới được trừ).
  GVCN / kế toán: trang **Tiền ăn** → *Báo nghỉ của phụ huynh* → tích chọn → **Xác nhận / Từ chối** → bảng ngày nghỉ tự cập nhật.
  Chốt tháng sẽ cảnh báo nếu còn ngày báo nghỉ chưa xác nhận.
- **Kho:** báo cáo Nhập – Xuất – Tồn tách cột **Nhập mua / Chuyển đến / Xuất bán / Chuyển đi / Điều chỉnh**; lịch sử phiếu kho ghi **+/−**; thêm **bộ lọc theo kho**.

## 11. Bản 2.9 – Phân lớp giáo viên, thông báo, chat
- **Hiệu trưởng / quản trị tạo tài khoản giáo viên:** Người dùng → + Thêm người dùng → vai trò *Giáo viên chủ nhiệm* → tích **Chủ nhiệm / Giảng dạy** từng lớp
  → (tuỳ chọn) *Gửi mật khẩu đăng nhập tới email*. Danh sách người dùng hiện lớp của từng giáo viên ("Chưa phân lớp" nếu chưa gán).
  Danh mục → Lớp học → Sửa: chọn GVCN từ danh sách tài khoản giáo viên; GV giảng dạy nhập email.
- **Chuông thông báo** (tự cập nhật mỗi phút): GV – phụ huynh báo nghỉ chờ xác nhận, chưa được phân lớp; kế toán – đơn mua chờ duyệt;
  lãnh đạo – chính sách / khoản chi chờ duyệt, công nợ quá hạn; thủ kho – hàng dưới ngưỡng; phụ huynh – học phí cần nộp, đơn mua được duyệt/từ chối;
  mọi người – tin nhắn chưa đọc. Bấm vào thông báo để mở đúng trang.
- **Chat** (nút tròn góc phải dưới): nhắn tin 1–1 theo quyền:
  Ban quản lý (Admin, Ban lãnh đạo, Kế toán trưởng, Kiểm soát, Hiệu trưởng) ↔ nhau và ↔ cán bộ trường mình;
  Cán bộ trường (Kế toán, Thủ quỹ, Thủ kho, Giáo viên) ↔ nhau cùng trường; Phụ huynh ↔ giáo viên đang dạy lớp của con.
  Tin nhắn lưu ở sheet `ChatMessages`.

## 12. Bản 3.0 – Chat phân quyền theo trường, tài khoản phụ trách nhiều trường
- **Chat theo trường:** cán bộ chỉ chat với người có chung trường. Giáo viên thấy Hiệu trưởng / người phụ trách trường mình,
  kế toán – thủ quỹ – thủ kho – giáo viên cùng trường, và phụ huynh các lớp mình dạy.
- **Trường phụ trách thêm** (Người dùng → Sửa → tích các trường):
  - Vai trò cấp trường (Hiệu trưởng, Kế toán, Thủ quỹ, Thủ kho, Giáo viên): được xem dữ liệu, phân lớp và chat với các trường đó.
  - Vai trò toàn hệ thống (Ban lãnh đạo, Kế toán trưởng, Kiểm soát): là “người phụ trách” các trường được tích → hiện trong chat của cán bộ các trường đó.
    Chưa tích trường nào → chỉ liên lạc tuyến quản lý (với nhau và với Hiệu trưởng), không hiện với cán bộ trường.
- Quản trị hệ thống chat được với mọi cán bộ (hỗ trợ).

## 13. Bản 3.1 – Một phụ huynh, nhiều con
- Anh chị em = học sinh có **chung email hoặc chung SĐT phụ huynh** trong hồ sơ.
- Cấp tài khoản cho con thứ 2 trở đi → **không tạo tài khoản mới**, gắn vào **tài khoản cấp lần đầu** của phụ huynh; email báo phụ huynh
  (mật khẩu giữ nguyên). Phụ huynh đăng nhập bằng **mã của bất kỳ con nào**.
- Trang phụ huynh hiện **“Các con của tôi”**: tên, lớp, số tiền cần nộp của từng con; bấm để xem chi tiết. Chat thấy giáo viên của tất cả các con.
- Tài khoản đã cấp riêng từ trước: Người dùng → Tài khoản phụ huynh → **Gộp tài khoản anh chị em** (xem trước → gộp; giữ tài khoản cấp lần đầu, khóa các tài khoản còn lại).
- “Gửi lại email tài khoản” cho 1 con sẽ đặt lại mật khẩu của **tài khoản chung** (áp dụng cho tất cả các con).

## 14. Tài khoản ngân hàng thu tiền (nhiều tài khoản / trường)
- **Cài đặt → Tài khoản ngân hàng thu tiền → + Thêm tài khoản**: chọn *Áp dụng cho* (một trường, hoặc "Dùng chung mọi trường" – chỉ tài khoản cấp hệ thống), ngân hàng, số TK, chủ TK (không dấu), *Dùng để thu*: Mọi khoản / Học phí & bán trú / Bán hàng.
- Mỗi trường + mục đích có **1 tài khoản mặc định**. Mã QR tự chọn theo thứ tự: TK của trường đúng mục đích → TK của trường "Mọi khoản" → TK dùng chung → cấu hình cũ.
- Trang **Thông báo**: nếu trường có từ 2 tài khoản, ô "TK nhận" xuất hiện để chọn tài khoản in lên thông báo / QR cho đợt gửi đó.
- Tài khoản cũ (cấu hình BANK_* trước đây) được tự chuyển sang danh sách mới ở lần mở Cài đặt đầu tiên.

## 15. Chính sách anh chị em (SIBLING) – nguyên tắc áp dụng
- Anh chị em được nhận diện theo **SĐT phụ huynh** (thiếu SĐT thì theo email), chỉ tính học sinh đang học.
- Thứ tự con xếp theo **ngày sinh: con lớn nhất = con thứ 1**.
- *Áp dụng cho*: "Tất cả các con (khi gia đình có từ 2 con)" hoặc "Từ con thứ N trở đi" (mặc định từ con thứ 2 – con lớn không được giảm).
- *Tính anh chị em*: "Chỉ học cùng trường" (mặc định) hoặc "Học trong mọi trường của hệ thống".
- Mở chi tiết chính sách để xem danh sách gia đình, thứ tự từng con và ai được giảm.
- (v3.3) Tài khoản phụ huynh **tự thấy tất cả các con đang học** có cùng SĐT/email phụ huynh, kể cả con mới nhập học chưa được cấp/gắn tài khoản. Phụ huynh có thể đăng nhập bằng mã của bất kỳ con nào.

## 16. Bản 3.4 – Nhập Excel học sinh / chi phí, chi phí theo khối – lớp
- **Học sinh → Nhập Excel** (hoặc trong form "Thêm học sinh" → "Nhập từ file Excel"):
  1. Bấm **Tải file mẫu Excel**. File có sheet *HocSinh* (điền dữ liệu), *Hướng dẫn* và *Danh mục* (danh sách lớp, chính sách).
  2. Điền đủ các cột như form nhập tay: Trường, Lớp*, Họ và tên*, Mã HS, Giới tính, Ngày sinh, Ngày nhập học, Ngày nghỉ học, Trạng thái, Địa chỉ, Phụ huynh, SĐT, Email, Mật khẩu PH, Gửi email tài khoản, Chính sách, Ghi chú chính sách, Ghi chú.
  3. Chọn file → **Kiểm tra file**: hệ thống báo lỗi/lưu ý từng dòng (lớp không tồn tại, mã trùng, ngày sai, email sai…).
  4. Bấm **Nhập N dòng hợp lệ**. Có email phụ huynh → tạo tài khoản và gửi email như khi thêm tay; có mật khẩu mà "Gửi email tài khoản" = Không → tạo tài khoản, không gửi email.
- **Chi phí**: form ghi khoản chi có thêm **Cấp học / Khối / Lớp** (không bắt buộc; chọn lớp thì khối và cấp tự lấy theo lớp). Danh sách và Báo cáo chi phí có cột Khối / Lớp, lọc được theo cấp học và lớp.
- **Chi phí → Nhập từ Excel**: tải file mẫu (sheet *ChiPhi*), điền Trường, Ngày chi*, Hạng mục, Số tiền*, Nhà cung cấp, Diễn giải, Cấp học, Khối, Lớp → Kiểm tra → Nhập. Khoản chi do người có quyền duyệt nhập sẽ được duyệt luôn, còn lại ở trạng thái chờ duyệt.

## 17. Bản 3.5 – Chuông cảnh báo gửi đúng người xử lý, tự tắt khi đã đọc / xử lý
| Cảnh báo | Người nhận |
|---|---|
| Phụ huynh báo nghỉ chờ xác nhận | GVCN của lớp; Hiệu trưởng nhận thay khi quá 1 ngày hoặc lớp chưa có GVCN |
| Đơn mua của phụ huynh chờ xác nhận | Kế toán trường, Thủ quỹ |
| Công nợ quá hạn (nhắc phí) | Kế toán trường |
| Khoản chi chờ duyệt | Hiệu trưởng (trường mình), Kế toán trưởng |
| Khoản chi bị từ chối | Người lập khoản chi |
| Chính sách chờ duyệt | Hiệu trưởng (chính sách của trường), Kế toán trưởng; chính sách mọi trường: Quản trị + KTT |
| Hàng dưới ngưỡng tồn | Thủ kho |
| Học phí cần nộp, đơn mua đã xử lý, ngày nghỉ bị từ chối | Phụ huynh |
| Tin nhắn chưa đọc | Người nhận tin (tắt khi mở đọc) |

- Trường chưa có Kế toán trường / Thủ quỹ / Hiệu trưởng / Thủ kho → **Kế toán trưởng nhận thay**.
- Bấm vào cảnh báo (hoặc "✓ Đã đọc", "Đánh dấu tất cả đã đọc") → cảnh báo tắt; chỉ hiện lại khi nội dung thay đổi (VD có thêm khoản chờ duyệt, số nợ thay đổi).
- Việc cần xử lý tự biến mất ngay sau khi xử lý xong (duyệt chi, xác nhận nghỉ, xác nhận đơn…), không cần chờ.

## 18. Bản 3.6 – Hero Banner trang phụ huynh (theo từng trường)
- Menu **Hệ thống → Banner phụ huynh** (Quản trị, Ban lãnh đạo, Kế toán trưởng: mọi trường; Hiệu trưởng: trường mình).
- Chọn trường → tải **ảnh nền** (ảnh học sinh / khuôn viên, ngang 1920×900, ≤ 8 MB, lưu vào thư mục Drive hồ sơ → "Banner trường") → sửa dòng giới thiệu, tiêu đề, tiêu đề nhấn mạnh (vàng nghiêng), mô tả, 2 nút (liên kết website / video), khẩu hiệu, 4 số liệu nổi bật → **Lưu banner**. Khung bên phải xem trước bản máy tính / điện thoại.
- **Banner chung** (chỉ tài khoản cấp hệ thống): áp dụng cho các trường chưa có banner riêng. "Khôi phục mặc định" xóa banner riêng → trường dùng lại banner chung.
- Phụ huynh thấy banner đầu trang ngay khi đăng nhập; có nhiều con học khác trường thì banner đổi theo trường của con đang xem.

## 19. Bản 3.7 – Logo Viet School, ảnh nền mặc định, nền mờ dần trang phụ huynh
- Logo Viet School thay toàn bộ logo cũ: màn hình đăng nhập, thanh menu, Hero Banner, biểu tượng tab trình duyệt, email thông báo học phí và email tài khoản.
- **Ảnh nền mặc định** của Hero Banner: ảnh học sinh trước khuôn viên trường (đã thay logo BV Educational bằng logo Viet School trên tòa nhà và quyển vở). Trường nào chưa tải ảnh riêng sẽ dùng ảnh này; tải ảnh riêng ở **Banner phụ huynh** thì ảnh riêng được ưu tiên.
- Trang phụ huynh: ảnh banner trải rộng làm **nền cả trang**, mờ dần thành xanh nhạt xuống tới chân trang; trên điện thoại ảnh hiển thị thành dải phía trên banner.
- Lần đầu chạy, hệ thống tự tạo 2 tệp trong thư mục Drive hồ sơ → "Banner trường": *Logo Viet School.png* và *Banner mặc định Viet School.jpg* (chia sẻ chỉ xem). Không xóa 2 tệp này.

## 20. Bản 3.8 – Tăng tốc tải dữ liệu
**Nguyên nhân cũ:** mỗi màn hình tốn 150–210 lệnh gọi Google Sheets (mở lại cùng một tệp 26–35 lần, kiểm tra tiêu đề từng bảng), không có bộ nhớ đệm giữa các lần gọi.

**Đã làm:**
- Mở tệp Sheets 1 lần mỗi lượt xử lý; bỏ kiểm tra tiêu đề lặp lại.
- Bộ nhớ đệm chung (CacheService): đọc bảng từ đệm, nén và chia khối. Ghi dữ liệu → bản đệm cũ tự hết hiệu lực ngay.
- Nhớ sẵn kết quả nặng (Tổng quan, tồn kho, cảnh báo), tự tính lại khi dữ liệu đổi.
- Giao diện: hiện ngay dữ liệu lần trước rồi cập nhật ngầm; cảnh báo tải sau; danh sách học sinh mỗi lần 200 dòng ("Xem thêm").
- Ảnh logo/banner không còn nạp ở mỗi lần chạy (chuyển sang AssetLogo.html, AssetBanner.html).

**Lưu ý vận hành:**
- Sửa tay trực tiếp trên Google Sheets: tối đa 30 phút sau mới hiện. Muốn thấy ngay: **Cài đặt → Tốc độ hệ thống → Làm mới dữ liệu**.
- **Cài đặt → Tốc độ hệ thống → Xem số đo**: thời gian xử lý thực tế từng chức năng (dữ liệu giữ tối đa 6 giờ).
- Tùy chọn để lần mở đầu luôn nhanh: Apps Script → Triggers → thêm trình kích hoạt hàm `warmCache`, theo thời gian, mỗi 10 phút.
