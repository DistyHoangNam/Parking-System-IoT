/*
 * Smart Parking - ESP32 client (kết nối ra VPS qua wss)
 *
 * Thư viện (Library Manager):
 *   - WebSockets          (Markus Sattler / Links2004)
 *   - ArduinoJson         (bản 7.x)
 *   - LiquidCrystal_I2C
 *   - ESP32Servo
 *
 * ESP32 chỉ làm 3 việc:
 *   1) 3 IR slot điều khiển LED (sáng khi có xe hoặc khi ô được đặt/sử dụng từ web); gửi trạng thái 2 cổng lên VPS mỗi 5 giây
 *   2) Nhận lệnh {"t":"open","gate":"entry|exit"} từ VPS, mở servo, trả ack
 *   3) Đóng cổng khi xe đã đi qua. Mất kết nối thì cổng KHÔNG tự mở.
 * Mã đặt chỗ, thời gian, tiền do VPS quyết định.
 */
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <ESP32Servo.h>
#include <Preferences.h>
#include <esp_system.h>
#include <time.h>
#include "config.h"


// ---------- Pins ----------
const uint8_t SLOT_IR[3]  = {13, 16, 14};
const uint8_t SLOT_LED[3] = {25, 26, 27};
const uint8_t ENTRY_IR = 32, ENTRY_SERVO = 33;
const uint8_t EXIT_IR  = 34, EXIT_SERVO  = 18;
const uint8_t LCD_SDA = 21, LCD_SCL = 22;

// ---------- Config ----------
#define TOTAL_SLOTS      3
#define SERVO_OPEN       90
#define SERVO_CLOSED     0
#define ENTRY_CLOSE_MS   2000     // chờ sau khi xe rời IR cổng vào
#define EXIT_CLOSE_MS    500      // chờ sau khi xe rời IR cổng ra
#define SIMULATED_EXIT_OPEN_MS 2000 // mở ít nhất 2 giây khi bấm thanh toán mô phỏng
#define WAIT_LOST_MS     500      // xe biến mất quá thời gian này thì huỷ "đang chờ"
#define STATE_RESEND_MS  5000     // gửi lại trạng thái định kỳ (heartbeat)
#define LOOP_MS          50
#define WIFI_CONNECT_MS  30000
#define WIFI_RETRY_MS    30000
#define WIFI_LOG_MS      5000
#define SLOT_STABLE_MS   500
#define GATE_STABLE_MS   100

struct StableInput {
  bool stable = false, candidate = false, initialized = false;
  uint32_t since = 0;
  bool sample(bool raw, uint32_t now, uint32_t interval) {
    if (!initialized || raw != candidate) {
      initialized = true; candidate = raw; since = now;
    }
    if (stable != candidate && now - since >= interval) stable = candidate;
    return stable;
  }
};

// ---------- Gates ----------
enum GateState : uint8_t { G_IDLE, G_WAIT_CODE, G_OPEN };
struct Gate {
  uint8_t   irPin;
  bool      isEntry;
  uint32_t  closeDelay;
  Servo     servo;
  GateState st = G_IDLE;
  uint32_t  clearSince = 0;
  bool      cmdOpen = false;
  bool      simulatedOpen = false;
  uint32_t  openedAt = 0;
  long      cmdId = 0;
  char      operationId[37] = "";
  StableInput ir;
  char      msg1[17] = "", msg2[17] = "";
};
Gate entryGate, exitGate;

// ---------- Globals ----------
LiquidCrystal_I2C lcd27(0x27, 16, 2), lcd3f(0x3F, 16, 2);
LiquidCrystal_I2C* lcd = nullptr;
char lcdLines[2][17] = {};
WebSocketsClient wsc;
bool homeDirty = true;
bool wsUp = false;
char lastState[192] = "";
uint32_t lastSent = 0;
bool stateSent = false;
char authHeader[160];
bool wifiConfigured = false;
bool wifiWasConnected = false;
Preferences exitStore;
bool exitStoreReady = false;
String exitOperation = "", exitStage = ""; // active | done | acknowledged
String appliedResetId = "";
bool exitRecovered = false;
uint32_t lastExitEvent = 0;

// Biến lưu trạng thái các ô từ server phục vụ việc sáng LED khi đặt chỗ
int8_t currentSlotStates[TOTAL_SLOTS] = {0, 0, 0};

// Persist one complete record atomically before acting on the exit servo.
bool persistExit(const String& operation, const char* stage) {
  if (!exitStoreReady) return false;
  JsonDocument record;
  record["operationId"] = operation;
  record["stage"] = stage;
  record["resetId"] = appliedResetId;
  String json;
  serializeJson(record, json);
  if (exitStore.putString("record", json) != json.length()) {
    Serial.println("[EXIT] NVS write failed; keeping ticket pending");
    return false;
  }
  exitOperation = operation; exitStage = stage;
  return true;
}

void loadExit() {
  exitStoreReady = exitStore.begin("parking-exit", false);
  if (!exitStoreReady) return;
  String json = exitStore.getString("record", "");
  if (json.isEmpty()) return;
  JsonDocument record;
  if (deserializeJson(record, json)) { exitStoreReady = false; return; }
  exitOperation = record["operationId"] | "";
  exitStage = record["stage"] | "";
  appliedResetId = record["resetId"] | "";
  if (exitOperation.isEmpty() && exitStage.isEmpty() && appliedResetId.length() == 32) return;
  if (exitOperation.length() != 36 || (exitStage != "active" && exitStage != "done" && exitStage != "acknowledged")) {
    exitStoreReady = false; return;
  }
  exitRecovered = exitStage == "active";
  if (exitRecovered) Serial.println("[EXIT] Unfinished operation recovered; wait for retry with car at IR");
}

void sendExitComplete(bool force = false) {
  if (!wsUp || !wsc.isConnected() || exitStage != "done") return;
  if (!force && millis() - lastExitEvent < STATE_RESEND_MS) return;
  JsonDocument event;
  event["t"] = "exit_complete"; event["operationId"] = exitOperation;
  String json; serializeJson(event, json);
  if (wsc.sendTXT(json)) lastExitEvent = millis();
}
uint32_t lastWifiTry = 0, lastWifiLog = 0;

// ---------- LCD ----------
void lcdPrint(const char* a, const char* b) {
  if (!lcd) return;
  const char* lines[] = {a, b};
  for (int row = 0; row < 2; ++row) {
    char line[17];
    snprintf(line, sizeof(line), "%-16.16s", lines[row]);
    if (strcmp(line, lcdLines[row]) == 0) continue;
    lcd->setCursor(0, row); lcd->print(line);
    strcpy(lcdLines[row], line);
  }
}

void setupLCD() {
  if (!Wire.begin(LCD_SDA, LCD_SCL, 100000)) {
    Serial.println("[LCD] I2C initialization failed; continuing without LCD");
    return;
  }
  Wire.setTimeOut(50);
  bool found27 = false, found3f = false;
  Serial.println("[I2C] Scan on SDA=21 SCL=22, 100 kHz");
  for (uint8_t addr = 1; addr < 127; ++addr) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("[I2C] Device at 0x%02X\n", addr);
      found27 |= addr == 0x27; found3f |= addr == 0x3F;
    }
  }
  lcd = found27 ? &lcd27 : found3f ? &lcd3f : nullptr;
  if (!lcd) {
    Serial.println("[LCD] No response at 0x27/0x3F; check wiring and power. Continuing without LCD.");
    return;
  }
  lcd->init();
  Wire.setClock(100000); Wire.setTimeOut(50);
  lcd->backlight(); lcd->clear();
  lcdPrint("Smart Parking", "LCD OK");
  Serial.printf("[LCD] Initialized candidate at 0x%02X; confirm LCD OK on screen\n", found27 ? 0x27 : 0x3F);
  delay(1000);
}

void showHome() {
  if (!wsUp) { lcdPrint("Smart Parking", "Server offline"); }
  else lcdPrint("Smart Parking", "Server online");
  homeDirty = false;
}

// ---------- Wi-Fi ----------
void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    Serial.printf("[WiFi] DISCONNECTED reason=%u\n",
                  static_cast<unsigned>(info.wifi_sta_disconnected.reason));
  } else if (event == ARDUINO_EVENT_WIFI_STA_CONNECTED) {
    Serial.println("[WiFi] AP connected, waiting for IP...");
  } else if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
    Serial.println("[WiFi] GOT_IP");
  }
}

void printWiFiConnected() {
  Serial.println("[WiFi] CONNECTED");
  Serial.print("[WiFi] IP: "); Serial.println(WiFi.localIP());
  Serial.print("[WiFi] Gateway: "); Serial.println(WiFi.gatewayIP());
  Serial.printf("[WiFi] RSSI: %ld dBm\n", static_cast<long>(WiFi.RSSI()));
}

void connectWiFi() {
  Serial.printf("[WiFi] Target SSID: [%s]\n", WIFI_SSID);
  if (strlen(WIFI_SSID) == 0 || strcmp(WIFI_SSID, "YOUR_WIFI") == 0 ||
      strcmp(WIFI_PASS, "YOUR_PASSWORD") == 0) {
    Serial.println("[WiFi] STOP: edit WIFI_SSID/WIFI_PASS in config.h, save and upload again.");
    lcdPrint("WiFi config", "Edit config.h");
    return;
  }

  WiFi.onEvent(onWiFiEvent);
  if (!WiFi.mode(WIFI_STA)) {
    Serial.println("[WiFi] STOP: station mode could not start.");
    lcdPrint("WiFi init failed", "Check Serial");
    return;
  }
  WiFi.setAutoReconnect(false);
  wifiConfigured = true;
  Serial.println("[WiFi] Scanning...");
  int n = WiFi.scanNetworks();
  if (n < 0) {
    Serial.printf("[WiFi] Scan failed: %d; still attempting connection.\n", n);
  } else {
    Serial.printf("[WiFi] Found %d networks:\n", n);
    for (int i = 0; i < n; ++i) {
      Serial.printf("[WiFi] %d: %s (%ld dBm)%s%s\n", i + 1,
                    WiFi.SSID(i).c_str(), static_cast<long>(WiFi.RSSI(i)),
                    WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "" : " *",
                    WiFi.SSID(i) == WIFI_SSID ? " <-- TARGET" : "");
    }
  }
  WiFi.scanDelete();

  lcdPrint("Smart Parking", "Connecting WiFi");
  Serial.println("[WiFi] Connecting, waiting up to 30 seconds...");
  uint32_t started = millis();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED && millis() - started < WIFI_CONNECT_MS) {
    Serial.print('.');
    delay(500);
  }
  Serial.println();
  wifiWasConnected = WiFi.status() == WL_CONNECTED;
  if (wifiWasConnected) {
    printWiFiConnected();
    lcdPrint("WiFi connected", WiFi.localIP().toString().c_str());
  } else {
    Serial.printf("[WiFi] Connection timeout, status=%d; retry every 30 seconds.\n",
                  static_cast<int>(WiFi.status()));
    lcdPrint("WiFi failed", "Retrying...");
  }
  lastWifiTry = lastWifiLog = millis();
}

void updateWiFi() {
  if (!wifiConfigured) return;
  uint32_t now = millis();
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected != wifiWasConnected) {
    wifiWasConnected = connected;
    homeDirty = true;
    if (connected) {
      printWiFiConnected();
    } else {
      Serial.println("[WiFi] Connection lost; waiting before retry.");
      wsUp = false;
      wsc.disconnect();
      lastWifiTry = now;
    }
  }
  if (!connected && now - lastWifiTry >= WIFI_RETRY_MS) {
    lastWifiTry = now;
    Serial.printf("[WiFi] Retrying SSID [%s]...\n", WIFI_SSID);
    WiFi.reconnect();
  }
  if (now - lastWifiLog >= WIFI_LOG_MS) {
    lastWifiLog = now;
    Serial.printf("[STATUS] WiFi=%s (status=%d), WebSocket=%s\n",
                  connected ? "CONNECTED" : "DISCONNECTED",
                  static_cast<int>(WiFi.status()), wsUp ? "CONNECTED" : "DISCONNECTED");
    if (stateSent) {
      Serial.printf("[STATE] Last successful send %lu ms ago (local transport only)\n",
                    static_cast<unsigned long>(now - lastSent));
    }
  }
}

// adminControl in the protocol indicates durable reset support for the VPS API.
// ---------- Gửi trạng thái ----------
const char* gateName(const Gate& g) { return g.st == G_WAIT_CODE ? "wait" : g.st == G_OPEN ? "open" : "idle"; }

void sendState(bool force = false) {
  if (!wsUp || !wsc.isConnected()) return;
  char buf[192];
  int length = snprintf(buf, sizeof(buf), "{\"t\":\"state\",\"entry\":\"%s\",\"exit\":\"%s\",\"exitComplete\":%s,\"adminControl\":%s,\"slotReset\":true,\"simulatedCheckout\":true}",
                        gateName(entryGate), gateName(exitGate), exitStoreReady ? "true" : "false", exitStoreReady ? "true" : "false");
  if (length < 0 || static_cast<size_t>(length) >= sizeof(buf)) {
    Serial.println("[STATE] ERROR: JSON formatting failed or buffer too small");
    return;
  }
  uint32_t now = millis();
  if (force || !stateSent || strcmp(buf, lastState) != 0 || now - lastSent >= STATE_RESEND_MS) {
    if (wsc.sendTXT(buf, static_cast<size_t>(length))) {
      strcpy(lastState, buf);
      lastSent = millis();
      stateSent = true;
      Serial.printf("[STATE] TX OK bytes=%d\n", length);
    } else {
      Serial.println("[STATE] TX FAILED: reconnecting WebSocket");
      wsUp = false;
      homeDirty = true;
      wsc.disconnect();
    }
  }
}

// ---------- Cảm biến & cổng (Đã cập nhật LED sáng khi có xe HOẶC được đặt chỗ) ----------
// LEDs and gate servos are owned by the main loop; no application spinlocks.
void updateSlotLeds() {
  static StableInput inputs[TOTAL_SLOTS];
  const uint32_t now = millis();
  for (int i = 0; i < TOTAL_SLOTS; ++i) {
    const bool occupied = inputs[i].sample(digitalRead(SLOT_IR[i]) == LOW, now, SLOT_STABLE_MS);
    digitalWrite(SLOT_LED[i], occupied || currentSlotStates[i] > 0 ? HIGH : LOW);
  }
}

void sendAck(long id, bool ok, const char* operationId = "", const char* reason = "") {
  char buf[224];
  int length = snprintf(buf, sizeof(buf), "{\"t\":\"ack\",\"id\":%ld,\"ok\":%s,\"operationId\":\"%s\",\"reason\":\"%s\"}", id, ok ? "true" : "false", operationId, reason);
  if (length < 0 || static_cast<size_t>(length) >= sizeof(buf)) {
    Serial.printf("[ACK] Formatting failed id=%ld\n", id); return;
  }
  if (!wsUp || !wsc.sendTXT(buf, static_cast<size_t>(length))) {
    Serial.printf("[ACK] Failed id=%ld\n", id);
    return;
  }
  Serial.printf("[ACK] id=%ld ok=%s reason=%s\n", id, ok ? "true" : "false", reason);
}

void closeGate(Gate& g, bool recordPassage = true) {
  Serial.printf("[SERVO] gate=%s action=CLOSE pin=%u attached=%d heap=%u\n",
    g.isEntry ? "entry" : "exit", static_cast<unsigned>(g.isEntry ? ENTRY_SERVO : EXIT_SERVO),
    g.servo.attached(), static_cast<unsigned>(ESP.getFreeHeap()));
  g.servo.write(SERVO_CLOSED);
  g.st = G_IDLE; g.clearSince = 0; homeDirty = true;
  if (recordPassage && !g.isEntry && !exitRecovered && exitStage == "active" && exitOperation == g.operationId) {
    if (persistExit(exitOperation, "done")) sendExitComplete(true);
  }
}

void updateGate(Gate& g) {
  uint32_t now = millis();
  bool rawCar = digitalRead(g.irPin) == LOW;
  bool car = g.ir.sample(rawCar, now, GATE_STABLE_MS);

  if (g.cmdOpen) {                       
    g.cmdOpen = false;
    const bool simulatedExit = !g.isEntry && g.simulatedOpen;
    if (!wsUp || !wsc.isConnected() ||
        (!simulatedExit && (g.st != G_WAIT_CODE || !car || !rawCar)) ||
        (simulatedExit && g.st == G_OPEN)) {
      sendAck(g.cmdId, false, g.operationId,
        !wsUp || !wsc.isConnected() ? "CONNECTION_LOST" : simulatedExit ? "GATE_ALREADY_OPEN" : "IR_REQUIRED");
      return;
    }
    if (!g.isEntry) {
      if (!persistExit(String(g.operationId), "active")) { sendAck(g.cmdId, false, g.operationId, "NVS_WRITE_FAILED"); return; }
      exitRecovered = false;
    }
    Serial.printf("[SERVO] gate=%s action=OPEN pin=%u attached=%d heap=%u\n",
      g.isEntry ? "entry" : "exit", static_cast<unsigned>(g.isEntry ? ENTRY_SERVO : EXIT_SERVO),
      g.servo.attached(), static_cast<unsigned>(ESP.getFreeHeap()));
    g.servo.write(SERVO_OPEN);
    g.st = G_OPEN; g.clearSince = 0; g.openedAt = now;
    sendAck(g.cmdId, true, g.operationId);  
    lcdPrint(g.msg1, g.msg2);
    return;
  }

  switch (g.st) {
    case G_IDLE:
      if (car) {
        g.st = G_WAIT_CODE; g.clearSince = 0;
        if (!wsUp)           lcdPrint("System offline", "Call staff");
        else if (g.isEntry)  lcdPrint("Enter Code on App", "Waiting for code");
        else                 lcdPrint("Checkout on App", "");
      }
      break;

    case G_WAIT_CODE:
      if (car) g.clearSince = 0;
      else if (!g.clearSince) g.clearSince = now;
      else if (now - g.clearSince >= WAIT_LOST_MS) { g.st = G_IDLE; g.clearSince = 0; homeDirty = true; }
      break;

    case G_OPEN:
      if (!g.isEntry && g.simulatedOpen && now - g.openedAt < SIMULATED_EXIT_OPEN_MS) break;
      if (car || rawCar) g.clearSince = 0;
      else if (!g.clearSince) g.clearSince = now;
      else if (now - g.clearSince >= g.closeDelay) closeGate(g);
      break;
  }
}

void receiveParkingState(JsonDocument& doc) {
  JsonArray slots = doc["slots"].as<JsonArray>();
  if (slots.size() != TOTAL_SLOTS) return;
  int8_t states[3]; int free = 0;
  for (int i = 0; i < 3; ++i) {
    const char* value = slots[i] | "";
    states[i] = !strcmp(value, "free") ? 0 : !strcmp(value, "reserved") ? 1 : !strcmp(value, "busy") ? 2 : -1;
    if (states[i] < 0) return;
    if (states[i] == 0) ++free;
  }
  if (doc["free"].as<int>() != free) return;
  
  for (int i = 0; i < TOTAL_SLOTS; ++i) currentSlotStates[i] = states[i];

  const char* resetId = doc["resetId"] | "";
  if (strlen(resetId) != 32 || !exitStoreReady) return;
  for (size_t i = 0; i < 32; ++i) if (!isxdigit(static_cast<unsigned char>(resetId[i]))) return;
  const bool resetAll = doc["resetSlot"].isNull();
  if (!resetAll && (!doc["resetSlot"].is<int>() || doc["resetSlot"].as<int>() < 1 ||
      doc["resetSlot"].as<int>() > TOTAL_SLOTS)) return;
  if (appliedResetId != resetId) {
    if (digitalRead(ENTRY_IR) == LOW || digitalRead(EXIT_IR) == LOW || entryGate.st == G_OPEN || exitGate.st == G_OPEN ||
        entryGate.cmdOpen || exitGate.cmdOpen) {
      Serial.println("Reset dang cho: don IR va dong cong"); return;
    }
    JsonDocument record;
    const bool clearExit = resetAll || exitOperation == (doc["resetExitOperation"] | "");
    record["operationId"] = clearExit ? "" : exitOperation.c_str();
    record["stage"] = clearExit ? "" : exitStage.c_str(); record["resetId"] = resetId;
    String json; serializeJson(record, json);
    if (exitStore.putString("record", json) != json.length()) {
      Serial.println("Loi NVS: chua dong bo reset"); return;
    }
    appliedResetId = resetId;
    if (clearExit) {
      exitOperation = ""; exitStage = ""; exitRecovered = false;
      exitGate.operationId[0] = '\0';
    }
    entryGate.operationId[0] = '\0';
    closeGate(entryGate, false); closeGate(exitGate, false);
    Serial.println(resetAll ? "Da reset toan bai: ma cu vo hieu" : "Da reset slot: cac slot khac giu nguyen");
  }
  JsonDocument ack;
  ack["t"] = "admin_reset_ack"; ack["requestId"] = appliedResetId;
  String json; serializeJson(ack, json); wsc.sendTXT(json);
}

// ---------- Nhận lệnh từ VPS ----------
void handleMessage(uint8_t* payload, size_t length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;
  const char* t = doc["t"] | "";
  if (!strcmp(t, "parking_state")) { receiveParkingState(doc); return; }
  if (strcmp(t, "exit_complete_ack") == 0) {
    const char* operation = doc["operationId"] | "";
    if (exitStage == "done" && exitOperation == operation) persistExit(exitOperation, "acknowledged");
    return;
  }
  if (strcmp(t, "open") != 0) return;

  const char* gate = doc["gate"] | "";
  long id = doc["id"] | 0L;
  Gate* g = !strcmp(gate, "entry") ? &entryGate : !strcmp(gate, "exit") ? &exitGate : nullptr;
  const char* operation = doc["operationId"] | "";
  Serial.printf("[OPEN] id=%ld gate=%s simulate=%s state=%s exitStage=%s\n",
    id, gate, doc["simulate"].as<bool>() ? "true" : "false", g ? gateName(*g) : "invalid", exitStage.c_str());
  if (g && !g->isEntry) {
    bool validOperation = strlen(operation) == 36;
    for (size_t i = 0; validOperation && i < 36; ++i) {
      char c = operation[i];
      validOperation = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || c == '-';
    }
    if (!exitStoreReady || !validOperation) {
      sendAck(id, false, validOperation ? operation : "", !exitStoreReady ? "NVS_UNAVAILABLE" : "INVALID_OPERATION"); return;
    }
    if (exitOperation == operation) {
      if (exitStage == "done" || exitStage == "acknowledged" || (exitStage == "active" && g->st == G_OPEN)) {
        sendAck(id, true, operation); sendExitComplete(true); return;
      }
    } else if (exitStage == "active" || exitStage == "done") {
      sendAck(id, false, operation, "OTHER_EXIT_PENDING"); return;
    }
  }

  const bool simulatedExit = g && !g->isEntry && doc["simulate"].as<bool>();
  const bool gateReady = g && (simulatedExit ? g->st != G_OPEN :
    (g->st == G_WAIT_CODE && g->ir.stable && digitalRead(g->irPin) == LOW));
  if (id > 0 && gateReady && !g->cmdOpen) {
    strlcpy(g->msg1, doc["msg1"] | "Gate Open", sizeof(g->msg1));
    strlcpy(g->msg2, doc["msg2"] | "", sizeof(g->msg2));
    g->cmdOpen = true;
    g->simulatedOpen = simulatedExit;
    g->cmdId = id;
    strlcpy(g->operationId, g->isEntry ? "" : operation, sizeof(g->operationId));
    return;  
  }
  sendAck(id, false, g && !g->isEntry ? operation : "",
    !g || id <= 0 ? "BAD_COMMAND" : g->cmdOpen ? "COMMAND_BUSY" :
    g->st == G_OPEN ? "GATE_ALREADY_OPEN" : "IR_REQUIRED");
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("[WS] connected");
      wsUp = true; homeDirty = true;
      stateSent = false;
      sendState(true);
      sendExitComplete(true);
      break;
    case WStype_DISCONNECTED:
      Serial.println("[WS] disconnected / connection failed (check host, TLS, /device and token)");
      wsUp = false; homeDirty = true;
      stateSent = false;
      entryGate.cmdOpen = false; exitGate.cmdOpen = false;
      break;
    case WStype_TEXT:
      handleMessage(payload, length);
      break;
    default: break;
  }
}

// ---------- Setup / loop ----------
const char* resetReasonName(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_SW: return "SOFTWARE";
    case ESP_RST_PANIC: return "PANIC";
    case ESP_RST_INT_WDT: return "INT_WATCHDOG";
    case ESP_RST_TASK_WDT: return "TASK_WATCHDOG";
    case ESP_RST_WDT: return "WATCHDOG";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    default: return "OTHER";
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.printf("\n=== PARKING_CLIENT_V9_WEB_ONLY | %s %s ===\n", __DATE__, __TIME__);
  const esp_reset_reason_t reason = esp_reset_reason();
  Serial.printf("[BOOT] resetReason=%s (%d) heap=%u\n", resetReasonName(reason),
    static_cast<int>(reason), static_cast<unsigned>(ESP.getFreeHeap()));
  loadExit();

  for (int i = 0; i < TOTAL_SLOTS; i++) {
    pinMode(SLOT_IR[i], INPUT); pinMode(SLOT_LED[i], OUTPUT); digitalWrite(SLOT_LED[i], LOW);
  }
  pinMode(ENTRY_IR, INPUT);
  pinMode(EXIT_IR, INPUT);

  ESP32PWM::allocateTimer(0); ESP32PWM::allocateTimer(1);
  entryGate.irPin = ENTRY_IR; entryGate.isEntry = true;  entryGate.closeDelay = ENTRY_CLOSE_MS;
  exitGate.irPin  = EXIT_IR;  exitGate.isEntry  = false; exitGate.closeDelay  = EXIT_CLOSE_MS;
  entryGate.servo.setPeriodHertz(50); entryGate.servo.attach(ENTRY_SERVO, 500, 2400);
  exitGate.servo.setPeriodHertz(50);  exitGate.servo.attach(EXIT_SERVO, 500, 2400);
  entryGate.servo.write(SERVO_CLOSED); exitGate.servo.write(SERVO_CLOSED);

  setupLCD();

  connectWiFi();
#ifdef USE_ROOT_CA
  configTime(0, 0, "pool.ntp.org", "time.google.com");
#endif
  delay(1500);

  snprintf(authHeader, sizeof(authHeader), "Authorization: Bearer %s", DEVICE_TOKEN);
  wsc.setExtraHeaders(authHeader);
#ifdef USE_ROOT_CA
  wsc.beginSslWithCA(SERVER_HOST, SERVER_PORT, SERVER_PATH, ROOT_CA);
#else
  wsc.beginSSL(SERVER_HOST, SERVER_PORT, SERVER_PATH);   
#endif
  wsc.onEvent(onWsEvent);
  wsc.setReconnectInterval(3000);
  wsc.enableHeartbeat(15000, 3000, 2);
  Serial.printf("[WS] Target: wss://%s:%u%s\n", SERVER_HOST,
                static_cast<unsigned>(SERVER_PORT), SERVER_PATH);

  homeDirty = true;
}

void loop() {
  updateWiFi();
  if (WiFi.status() == WL_CONNECTED) wsc.loop();

  static uint32_t last = 0;
  uint32_t now = millis();

  if (now - last >= LOOP_MS) {
    last = now;
    updateSlotLeds();
    updateGate(entryGate);
    updateGate(exitGate);
    if (homeDirty && entryGate.st == G_IDLE && exitGate.st == G_IDLE) showHome();
  }
  sendState();
  sendExitComplete();
}
