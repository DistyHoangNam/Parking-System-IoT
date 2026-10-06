/* Wi-Fi-only diagnostic. No LCD, servo, or WebSocket initialization. */
#include <Arduino.h>
#include <WiFi.h>
#include <cstring>
#include "shared_config.h"

constexpr uint32_t CONNECT_TIMEOUT_MS = 30000;
constexpr uint32_t STATUS_INTERVAL_MS = 2000;

const char* statusName(wl_status_t status) {
  switch (status) {
    case WL_IDLE_STATUS: return "IDLE";
    case WL_NO_SSID_AVAIL: return "NO_SSID_AVAILABLE";
    case WL_SCAN_COMPLETED: return "SCAN_COMPLETED";
    case WL_CONNECTED: return "CONNECTED";
    case WL_CONNECT_FAILED: return "CONNECT_FAILED";
    case WL_CONNECTION_LOST: return "CONNECTION_LOST";
    case WL_DISCONNECTED: return "DISCONNECTED";
    default: return "UNKNOWN";
  }
}

const char* securityName(wifi_auth_mode_t mode) {
  switch (mode) {
    case WIFI_AUTH_OPEN: return "OPEN";
    case WIFI_AUTH_WEP: return "WEP";
    case WIFI_AUTH_WPA_PSK: return "WPA_PSK";
    case WIFI_AUTH_WPA2_PSK: return "WPA2_PSK";
    case WIFI_AUTH_WPA_WPA2_PSK: return "WPA_WPA2_PSK";
    case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2_ENTERPRISE";
    case WIFI_AUTH_WPA3_PSK: return "WPA3_PSK";
    case WIFI_AUTH_WPA2_WPA3_PSK: return "WPA2_WPA3_PSK";
    default: return "OTHER (see numeric auth value)";
  }
}

// Event callbacks run on another task. Only print; do not mutate loop state.
void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
      Serial.println("[EVENT] AP_CONNECTED: associated; waiting for DHCP/IP.");
      break;
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      Serial.println("[EVENT] GOT_IP: DHCP/IP ready.");
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      Serial.printf("[EVENT] DISCONNECTED reason=%u\n",
                    static_cast<unsigned>(info.wifi_sta_disconnected.reason));
      break;
    case ARDUINO_EVENT_WIFI_STA_LOST_IP:
      Serial.println("[EVENT] LOST_IP");
      break;
    default:
      break;
  }
}

void printStatus(uint32_t elapsed) {
  wl_status_t status = WiFi.status();
  Serial.printf("[STATUS] elapsed=%lu ms status=%d (%s)\n",
                static_cast<unsigned long>(elapsed),
                static_cast<int>(status), statusName(status));
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("=== BAIXE_WIFI_DIAGNOSTIC_V1 ===");
  Serial.printf("[BUILD] %s %s\n", __DATE__, __TIME__);
  Serial.printf("[CONFIG] %s\n", DIAGNOSTIC_CONFIG_PATH);
  Serial.printf("[TARGET] SSID=\"%s\" length=%u\n", WIFI_SSID,
                static_cast<unsigned>(strlen(WIFI_SSID)));
  Serial.println("[INFO] Password and device token are never printed.");

  if (strcmp(WIFI_SSID, "YOUR_WIFI") == 0 ||
      strcmp(WIFI_PASS, "YOUR_PASSWORD") == 0 || strlen(WIFI_SSID) == 0) {
    Serial.println("[STOP] Empty SSID or placeholder credentials. Edit the original parking_client/config.h, save and upload again.");
    return;
  }

  WiFi.onEvent(onWiFiEvent);
  if (!WiFi.mode(WIFI_STA)) {
    Serial.println("[STOP] Failed to enable Wi-Fi station mode.");
    return;
  }
  WiFi.setAutoReconnect(false);
  // Do not erase stored credentials. Disconnect any existing session before scan.
  WiFi.disconnect(false, false);
  delay(200);
  Serial.println("[SCAN] Scanning nearby networks, including hidden networks...");
  int count = WiFi.scanNetworks(false, true);
  bool found = false;
  if (count < 0) {
    Serial.printf("[SCAN] Failed, result=%d. Connection will still be attempted.\n", count);
  } else {
    Serial.printf("[SCAN] Found %d networks.\n", count);
    for (int i = 0; i < count; ++i) {
      String ssid = WiFi.SSID(i);
      bool target = ssid == WIFI_SSID;
      found = found || target;
      wifi_auth_mode_t auth = WiFi.encryptionType(i);
      Serial.printf("[SCAN] %s SSID=\"%s\" RSSI=%ld dBm channel=%ld security=%s auth=%d\n",
                    target ? "TARGET" : "      ", ssid.c_str(),
                    static_cast<long>(WiFi.RSSI(i)),
                    static_cast<long>(WiFi.channel(i)),
                    securityName(auth), static_cast<int>(auth));
    }
    Serial.printf("[SCAN] Target visible: %s\n", found ? "YES" : "NO");
    if (!found) {
      Serial.println("[HINT] Target absent or hidden: check exact SSID, hotspot band and signal.");
    }
  }
  WiFi.scanDelete();

  Serial.println("[CONNECT] Starting one 30-second connection window; automatic reconnect disabled.");
  uint32_t started = millis();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t lastStatus = started;
  printStatus(millis() - started);
  while (WiFi.status() != WL_CONNECTED && millis() - started < CONNECT_TIMEOUT_MS) {
    uint32_t now = millis();
    if (now - lastStatus >= STATUS_INTERVAL_MS) {
      printStatus(now - started);
      lastStatus = now;
    }
    delay(50);
  }
  printStatus(millis() - started);
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[RESULT] FAIL: no IP within 30 seconds. Preserve event reason codes above.");
    Serial.println("[HINT] AP_CONNECTED without GOT_IP suggests a DHCP/IP issue.");
    Serial.println("[INFO] Stopping connection; a following disconnect event may be caused by this stop.");
    WiFi.disconnect(false, false);
    Serial.println("[DONE] No further retries. Press EN/RESET to run again.");
    return;
  }

  Serial.println("[RESULT] WIFI_OK");
  Serial.print("[IP] "); Serial.println(WiFi.localIP());
  Serial.print("[GATEWAY] "); Serial.println(WiFi.gatewayIP());
  Serial.print("[DNS_SERVER] "); Serial.println(WiFi.dnsIP());
  Serial.printf("[RSSI] %ld dBm\n", static_cast<long>(WiFi.RSSI()));
  Serial.printf("[DNS] Resolving %s...\n", SERVER_HOST);
  IPAddress address;
  if (WiFi.hostByName(SERVER_HOST, address) == 1) {
    Serial.print("[DNS] OK: "); Serial.println(address);
  } else {
    Serial.println("[DNS] FAIL: Wi-Fi has an IP, but server hostname resolution failed.");
  }
  Serial.println("[DONE] Wi-Fi and DNS only; this sketch does not connect to the parking backend.");
}

void loop() {
  delay(1000);  // Keep logs available. No application retries or peripheral activity.
}
