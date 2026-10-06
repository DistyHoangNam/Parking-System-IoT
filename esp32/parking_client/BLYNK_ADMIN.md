# Blynk Admin — Smart Parking

**Tạm ngừng:** sketch hiện tại là `PARKING_CLIENT_V9_WEB_ONLY`, không include
hoặc khởi chạy Blynk. Nội dung dưới đây là hướng dẫn bản trước. Reset hiện
thực hiện qua `/api/admin/reset` trên VPS với `ADMIN_TOKEN`; xem README gốc.
Vé và dữ liệu NVS vẫn giữ khi nạp lại. Bản Blynk trước khi clean nằm tại
`.build/backups/parking_client_blynk_v8.ino`.

Dashboard gọn: 3 ô trạng thái chỗ đỗ, 4 nút servo, 2 trạng thái cổng,
1 dòng phản hồi, bộ chọn phạm vi và 2 nút reset. Chỗ đỗ lấy từ **vé trong MySQL**, giống website,
không lấy từ 3 IR slot. `EXIT_PENDING` vẫn hiển thị “Đang sử dụng”.

## 1. Kết nối thiết bị

1. Trong Blynk Console, tạo Template `Smart Parking Admin`, Hardware **ESP32**,
   Connection **WiFi**, rồi tạo Device từ template đó.
2. Trong `blynk_config.h`, điền `BLYNK_TEMPLATE_ID`, `BLYNK_TEMPLATE_NAME` và
   `BLYNK_AUTH_TOKEN` lấy từ Template/Device. Token để trống thì phần Blynk không
   chạy; website và cổng tự động vẫn chạy. Giữ WiFi/VPS trong `config.h` hiện có.
3. Cài thư viện **Blynk** trong Arduino Library Manager, cùng các thư viện đã
   dùng trước đây. Bản kiểm thử dùng ESP32 core 2.0.17 và Blynk 1.3.5.
4. Cập nhật backend và website, nạp firmware mới; Serial phải hiện
   `PARKING_CLIENT_V7_MYSQL_SLOT_RESET`. Không nạp binary trong `.build/blynk-check`:
   đó là bản kiểm thử với token giả. Build/nạp từ `esp32/parking_client` sau khi
   điền cấu hình thật.

Blynk dùng SSL và task riêng. Firmware quản lý WiFi hiện có qua `Blynk.config`,
không gọi `Blynk.begin` để tạo một vòng chờ WiFi khác. Thời gian NTP được đồng bộ
cho kiểm tra chứng chỉ TLS. Bản code được gửi cập nhật telemetry V4–V9 mỗi
2 giây. Không `syncVirtual` các
pin lệnh khi reconnect, nên giá trị nút cũ không tự mở cổng hoặc reset lại.

Tài liệu API: [Virtual Pins](https://docs.blynk.io/en/blynk-library-firmware-api/virtual-pins),
[Configuration](https://docs.blynk.io/en/blynk-library-firmware-api/configuration),
[Connection Management](https://docs.blynk.io/en/blynk-library-firmware-api/connection-management).

## 2. Datastream và widget

Tạo tất cả dưới dạng **Virtual Pin**, không dùng GPIO Datastream.
Các nút có kiểu `Integer`, Min **0**, Max **1**, Default **0**, chế độ **Push**.

| Pin | Tên | Kiểu | Widget |
| --- | --- | --- | --- |
| V0 | Mở cổng vào | Integer 0–1 | Button, Push |
| V1 | Đóng cổng vào | Integer 0–1 | Button, Push |
| V2 | Mở cổng ra | Integer 0–1 | Button, Push |
| V3 | Đóng cổng ra | Integer 0–1 | Button, Push |
| V4 | Chỗ 1 | String | Value Display / Label |
| V5 | Chỗ 2 | String | Value Display / Label |
| V6 | Chỗ 3 | String | Value Display / Label |
| V7 | Servo cổng vào | String | Value Display / Label |
| V8 | Servo cổng ra | String | Value Display / Label |
| V9 | Phản hồi Admin | String | Value Display / Label, chiều rộng lớn |
| V10 | Chuẩn bị reset | Integer 0–1 | Button, Push |
| V11 | Xác nhận reset | Integer 0–1 | Button, Push |
| V12 | Phạm vi reset | Integer 0–3, Default 0 | Numeric Input / Slider, bước 1 |

Đặt V4–V6 trên một hàng nhỏ. Đặt nút mở/đóng theo hai cột Cổng vào / Cổng ra.
Đặt hai nút reset ở hàng cuối, V9 ngay phía trên để thấy kết quả thao tác.
Tạo dashboard web/mobile theo nhu cầu và dùng tài khoản/quyền truy cập Admin.

## 3. Điều khiển servo

- Nút Mở giữ cổng mở cho tới khi admin bấm Đóng. Không thay đổi vé hoặc slot.
- Nút Đóng bị từ chối nếu IR cổng đang thấy xe. Đóng thủ công không phát
  `exit_complete`, không giả lập xe đã checkout.
- Không mở thủ công cổng ra khi còn lượt ra `active`/`done` trong NVS.
  Nếu admin đóng một cổng ra tự động khi IR đã sạch, vé vẫn giữ `EXIT_PENDING`;
  thử lại đúng mã trên website với xe trước IR, hoặc dùng reset khi bãi đã trống.
- Lệnh web đến lúc cổng đang mở thủ công bị từ chối; đóng cổng thủ công để
  quay lại vận hành tự động. Trạng thái V7/V8 phản ánh lệnh servo, không phải
  cảm biến đo góc servo thực tế.
- Nếu backend mất kết nối, V4–V6 báo mất kết nối thay vì báo Trống. Blynk vẫn
  điều khiển servo thủ công khi kết nối Blynk còn hoạt động. Reset cần backend.

## 4. Reset bãi để test

Chọn **V12 = 0** để reset toàn bãi; **1, 2, 3** để reset slot tương ứng.
Chỉ reset khi đã đưa xe ra khỏi phạm vi cần reset. Đóng hai cổng và dọn vùng
IR cổng, sau đó bấm **Chuẩn bị reset (V10)** và **Xác nhận reset (V11)** trong
10 giây. Đổi V12 sau bước chuẩn bị sẽ huỷ bước chuẩn bị, cần bấm V10 lại.
Reconnect Blynk đặt V12 về 0 và bỏ xác nhận đang chờ; không chạy lệnh đã lưu.

Backend huỷ vé `RESERVED`, `PARKED`, `EXIT_PENDING` trong phạm vi đã chọn; mã
cũ của các vé đó mất hiệu lực. Reset slot không đổi vé hoặc phí của slot khác.
Vé được chuyển sang `CANCELLED`, ghi `cancelled_at` và `admin_reset_id`, giữ
thời gian vào/phí và lịch sử. Các vé `COMPLETED`/`EXPIRED`/`CANCELLED` cũ không
bị đổi. Nhật ký `admin_resets` lưu số vé huỷ và thời điểm reset/xác nhận.
Không xoá file database, WiFi, token hoặc flash toàn bộ ESP32.

ESP32 nhận `resetId` từ backend, lưu dấu reset vào NVS, xoá lượt ra thuộc reset,
đóng hai servo và gửi ACK. Khi chưa có ACK, website tạm khoá đặt chỗ/mở cổng.
Mất mạng hoặc backend restart sẽ gửi lại dấu reset. Request trùng không huỷ
các vé mới. Nếu mất phản hồi, firmware thử lại cùng `requestId` và slot, không
tạo reset thứ hai sau timeout. Lượt ra đang chờ của slot khác được giữ trong
NVS, kể cả khi reboot. Website tự bỏ mã đã huỷ khi đồng bộ realtime hoặc mỗi
5 giây. Slot được reset quay về Trống; LED vẫn sáng nếu IR thấy xe, hoặc slot
được đặt/sử dụng từ web, vì vậy không reset khi còn xe thật ở slot đó.

Restart bằng `pm2 restart parking --update-env` hoặc khởi động lại ESP32
**không reset vé**. Blynk gửi yêu cầu qua socket `/device` xác thực bằng
`DEVICE_TOKEN`. Backend cũng có `/api/admin/reset` với `ADMIN_TOKEN` riêng;
xem README tại gốc dự án.

## 5. Kiểm tra trên board

1. Nối Blynk, đối chiếu 3 slot với website khi đặt chỗ/check-in/chờ xe ra.
2. Mở/đóng thủ công từng cổng; thử Đóng khi IR bị che để kiểm tra từ chối.
3. Đang có vé `EXIT_PENDING`: đóng thủ công không được kết thúc vé hoặc trả slot.
4. Ngắt Blynk: website, IR và luồng checkout vẫn hoạt động; nối lại không thực
   thi nút cũ. Ngắt VPS: slot trên Blynk báo mất kết nối.
5. Khi bãi thật trống, tạo vé test rồi reset; mã cũ bị từ chối, tạo vé mới được.
6. Bấm V11 mà chưa V10 hoặc quá 10 giây: không reset.
7. Mất mạng khi reset rồi reconnect/reboot: backend và NVS đồng bộ, vé mới không
   bị huỷ bởi yêu cầu reset cũ.
8. Đặt vé ở slot 1 và 2, chọn V12=1 rồi V10/V11: chỉ vé slot 1 bị huỷ.
   Đăng ký lại slot 1; mã cũ hoặc sự kiện ra cũ không được kết thúc vé mới.
9. Giữ slot 1 ở EXIT_PENDING, đóng cổng và dọn IR, reset slot 2: slot 1 vẫn
   EXIT_PENDING, thử lại checkout dùng cùng operationId và phí.

## 6. Khi Blynk ONLINE rồi OFFLINE

Mở Serial Monitor **115200**, quan sát ít nhất 2 phút. Bản code được gửi dùng
`Blynk.connect(1000)` trong task riêng và thử lại mỗi 10 giây. Log
`[STATUS] WiFi=CONNECTED, WebSocket=CONNECTED` chỉ chứng minh kết nối WiFi/VPS,
chưa chứng minh Blynk còn kết nối. Kiểm tra token, template và thời gian NTP.
Nếu vẫn OFFLINE, gửi log quanh sự kiện để phân biệt heartbeat, TLS, lỗi bộ nhớ,
WiFi hoặc board khởi động lại. Biên dịch thành công chưa xác nhận mạng thực tế.

V4–V9 là **String**: dùng Labeled Value/Label, không dùng LED Widget cho dữ liệu
này. V0–V3 là Button **Push** kiểu Integer 0–1. Widget sai kiểu giải thích việc
không hiện dữ liệu nhưng riêng ảnh màn hình chưa chứng minh nguyên nhân timeout.

[Giới hạn gửi dữ liệu của Blynk](https://docs.blynk.io/en/blynk-library-firmware-api/limitations-and-recommendations).
