#include <WiFi.h>

// NHAP TEN WIFI VA MAT KHAU THAT VAO HAI DONG NAY, SAU DO SAVE VA UPLOAD.
const char* WIFI_SSID = "TEN_WIFI_CUA_BAN";
const char* WIFI_PASSWORD = "MAT_KHAU_WIFI_CUA_BAN";

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== WIFI CONNECTION TEST ===");
  Serial.printf("Build: %s %s\n", __DATE__, __TIME__);
  Serial.printf("WiFi can ket noi: [%s]\n", WIFI_SSID);

  if (strcmp(WIFI_SSID, "TEN_WIFI_CUA_BAN") == 0 ||
      strcmp(WIFI_PASSWORD, "MAT_KHAU_WIFI_CUA_BAN") == 0) {
    Serial.println("Chua nhap WiFi/mat khau. Sua hai dong dau, Save va Upload lai.");
    return;
  }

  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
    if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
      Serial.printf("\nWiFi ngat ket noi, reason=%u\n",
                    static_cast<unsigned>(info.wifi_sta_disconnected.reason));
    } else if (event == ARDUINO_EVENT_WIFI_STA_CONNECTED) {
      Serial.println("\nDa ket noi diem phat, dang cho IP...");
    }
  });
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);

  Serial.println("Scanning...");
  int n = WiFi.scanNetworks();
  if (n < 0) {
    Serial.printf("Quet that bai: %d\n", n);
  } else {
    Serial.printf("Tim thay %d mang:\n", n);
    for (int i = 0; i < n; ++i) {
      Serial.printf("%d: %s (%ld dBm)%s%s\n", i + 1,
                    WiFi.SSID(i).c_str(), static_cast<long>(WiFi.RSSI(i)),
                    WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "" : " *",
                    WiFi.SSID(i) == WIFI_SSID ? " <-- MANG CAN KET NOI" : "");
    }
  }
  WiFi.scanDelete();

  Serial.println("Dang ket noi WiFi, cho toi da 30 giay...");
  uint32_t started = millis();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED && millis() - started < 30000) {
    Serial.print('.');
    delay(500);
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("KET NOI WIFI THANH CONG!");
    Serial.print("IP: "); Serial.println(WiFi.localIP());
    Serial.print("Gateway: "); Serial.println(WiFi.gatewayIP());
    Serial.printf("RSSI: %ld dBm\n", static_cast<long>(WiFi.RSSI()));
  } else {
    Serial.printf("KET NOI THAT BAI! status=%d\n", static_cast<int>(WiFi.status()));
    Serial.println("Xem reason o tren. Dang dung thu ket noi; nhan EN/RESET de thu lai.");
    WiFi.disconnect(false, false);
  }
}

void loop() {
  delay(5000);
  Serial.printf("Trang thai hien tai: %s (status=%d)\n",
                WiFi.status() == WL_CONNECTED ? "DA KET NOI" : "CHUA KET NOI",
                static_cast<int>(WiFi.status()));
}
