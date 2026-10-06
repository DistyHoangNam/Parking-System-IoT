# Chẩn đoán Wi-Fi ESP32

Sketch này chỉ kiểm tra Wi-Fi và DNS. Không chạy servo, LCD, WebSocket hay mở cổng.
Nạp sketch này sẽ tạm thay firmware bãi xe; website vẫn báo ESP32 offline.

## Nạp và lấy log

1. Sửa và **lưu** `../parking_client/config.h`: `WIFI_SSID`, `WIFI_PASS` và
   `SERVER_HOST` của bạn. Không sửa cấu hình trong một bản sketch khác.
   Bản cấu hình hiện có còn `YOUR_WIFI` / `YOUR_PASSWORD`; sketch sẽ báo `[STOP]`
   nếu chưa thay. Không gửi mật khẩu hoặc token khi chia sẻ log.
2. `shared_config.h` dẫn trực tiếp đến cấu hình gốc, không sao chép mật khẩu.
   Đường dẫn tuyệt đối giúp Arduino IDE tìm được file ngay cả khi build trong
   thư mục tạm. Nếu chuyển/đổi tên thư mục dự án, chạy từ thư mục này:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\prepare_config.ps1
   ```

3. Ngắt nguồn, tháo thiết bị ngoài khỏi ESP32, sau đó cấp nguồn chỉ qua USB.
4. Mở `wifi_diagnostic.ino` trong Arduino IDE. Chọn **ESP32 Dev Module**, cổng
   **COM9** (hoặc cổng thực tế của board) và Upload. Dùng ESP32 Arduino core 2.x/3.x.
5. Mở Serial Monitor ở **115200 baud**, nhấn **EN/RESET**, chờ quét mạng và
   kết nối tối đa 30 giây. DNS chạy sau khi nhận IP và có thể cần thêm thời gian.
6. Xác nhận `BAIXE_WIFI_DIAGNOSTIC_V1`, thời gian `[BUILD]`, đường dẫn `[CONFIG]`
   và `[TARGET] SSID` đúng. Sao chép toàn bộ log đến `[DONE]` hoặc `[STOP]`.

Mật khẩu và token không được in. Log chứa SSID, IP và tên mạng lân cận;
có thể che các tên mạng không cần thiết khi chia sẻ.

## Đọc kết quả

| Log | Ý nghĩa / bước tiếp theo |
|---|---|
| `[STOP]` cấu hình mẫu | Sửa cấu hình gốc, lưu rồi nạp lại. |
| `[SCAN] Target visible: NO` | Kiểm tra tên mạng, 2,4 GHz và khoảng cách; SSID ẩn cũng có thể không khớp trong danh sách. Sketch vẫn thử kết nối. |
| `[SCAN] Failed` | Quét thất bại, chưa đủ để kết luận không có mạng; xem kết quả kết nối. |
| `[EVENT] DISCONNECTED reason=...` | Giữ mã số để tra theo phiên bản ESP32 core; không mặc định mọi mã đều là sai mật khẩu. |
| `AP_CONNECTED` nhưng không có `GOT_IP` | Đã kết nối điểm phát; kiểm tra cấp IP/DHCP nếu hết 30 giây. |
| `[RESULT] WIFI_OK` | ESP32 đã nhận IP; xem DNS trước khi thử lại firmware bãi xe. |
| `[DNS] FAIL` | Kiểm tra `SERVER_HOST`, DNS và mạng; đây không phải lỗi xác thực Wi-Fi. |
| Log khởi động lặp lại | Kiểm tra nguồn, cáp USB và reset; giữ toàn bộ log lỗi. |

Sketch tắt tự kết nối lại và dừng lần thử sau 30 giây. Sự kiện ngắt kết nối
ngay sau `[INFO] Stopping connection` có thể do sketch chủ động dừng.
Nhấn EN/RESET để kiểm tra lại, không phải thay đổi mạng liên tục.

## Quay lại bãi xe

Sau khi có `WIFI_OK`, mở và nạp lại `../parking_client/parking_client.ino`
với cùng cấu hình. Nếu bản chẩn đoán chạy nhưng bản bãi xe thất bại, kiểm tra
nguồn và dây nối thiết bị ngoài. Khi có `WiFi OK, IP ...` và `[WS] connected`,
kiểm tra website chuyển xanh. Chỉ nối lại dây khi đã ngắt nguồn.

Tài liệu API: https://docs.espressif.com/projects/arduino-esp32/en/latest/api/wifi.html
