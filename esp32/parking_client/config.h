#pragma once
// KHÔNG đưa file này lên GitHub

// Nhập ĐÚNG tên và mật khẩu đã kết nối thành công trong wifi_connection_test.
// Save config.h rồi Upload lại parking_client.ino; firmware không tự đọc bản test.
#define WIFI_SSID     "YOUR_WIFI"
#define WIFI_PASS     "YOUR_PASSWORD"

// Tên miền VPS (không có https://). Phải khớp domain đã cấp chứng chỉ.
#define SERVER_HOST   "parking.example.com"
#define SERVER_PORT   443
#define SERVER_PATH   "/device"

// Phải GIỐNG HỆT DEVICE_TOKEN trong file .env trên VPS
#define DEVICE_TOKEN  "thay-bang-chuoi-ngau-nhien-dai"

// Bật kiểm tra chứng chỉ máy chủ (khuyến nghị khi chạy thật):
//  1) bỏ comment dòng #define bên dưới
//  2) dán chứng chỉ gốc của CA vào ROOT_CA (Let's Encrypt: ISRG Root X1, tải tại letsencrypt.org/certificates)
// #define USE_ROOT_CA
// const char ROOT_CA[] PROGMEM = R"EOF(
// -----BEGIN CERTIFICATE-----
// ...
// -----END CERTIFICATE-----
// )EOF";
