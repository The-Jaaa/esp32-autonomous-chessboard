#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <AccelStepper.h>
#include <Adafruit_NeoPixel.h>
#include <math.h>

#include "offline_embedded_diagnostics.h"
#include "offline_diagnostic_serial.h"
#include "offline_ownership_diagnostics.h"
#include "offline_runtime_diagnostics.h"
#include "offline_interaction_feedback.h"
#include "offline_quiet_motion_hardware.h"
#include "offline_capture_motion_hardware.h"
#include "offline_lane_motion_hardware.h"
#include "mentor_speaker.h"

#if __has_include("firmware_secrets.h")
#include "firmware_secrets.h"
#else
#include "firmware_secrets.example.h"
#endif

#ifndef CHESS_AUDIO_SERVER_HOST
#define CHESS_AUDIO_SERVER_HOST "YOUR_SERVER_IP"
#endif
#ifndef CHESS_AUDIO_SERVER_PORT
#define CHESS_AUDIO_SERVER_PORT 3001
#endif
#ifndef CHESS_AUDIO_BOARD_ID
#define CHESS_AUDIO_BOARD_ID "main-board"
#endif
#ifndef CHESS_AUDIO_TOKEN
#define CHESS_AUDIO_TOKEN "GENERATE_A_PRIVATE_AUDIO_TOKEN"
#endif

const char* WIFI_SSID = CHESS_WIFI_SSID;
const char* WIFI_PASSWORD = CHESS_WIFI_PASSWORD;
const char* SERVER_BASE_URL = CHESS_SERVER_BASE_URL;
const char* AUDIO_SERVER_HOST = CHESS_AUDIO_SERVER_HOST;
const char* AUDIO_BOARD_ID = CHESS_AUDIO_BOARD_ID;
const char* AUDIO_TOKEN = CHESS_AUDIO_TOKEN;

// --- CoreXY Pin Definitions ---
constexpr uint8_t MOTOR_A_STEP_PIN = 42;
constexpr uint8_t MOTOR_A_DIR_PIN  = 41;
constexpr uint8_t MOTOR_B_STEP_PIN = 39;
constexpr uint8_t MOTOR_B_DIR_PIN  = 40;
constexpr uint8_t MAGNET_PIN       = 38;
constexpr uint8_t LIMIT_Y_PIN      = 47;
constexpr uint8_t LIMIT_X_PIN      = 48;

// --- NeoPixel & MUX Pin Definitions ---
#define LED_PIN 8
#define SIG1_PIN 4
#define SIG2_PIN 5
#define SIG3_PIN 6
#define SIG4_PIN 7
#define S0 18
#define S1 17
#define S2 16
#define S3 15

#define NUM_LEDS 256
#define SWITCH_UNPRESSED LOW
#define SWITCH_PRESSED HIGH

constexpr uint8_t SENSOR_DEBOUNCE_SCANS = 4;
constexpr uint32_t SNAPSHOT_MIN_INTERVAL_MS = 120;
constexpr uint32_t POLL_INTERVAL_MS = 180;
constexpr uint32_t WIFI_RETRY_INTERVAL_MS = 10000;

constexpr float FAST_MAX_SPEED = 20000.0f;
constexpr float FAST_ACCEL = 20000.0f;
constexpr float DRAG_MAX_SPEED = 8000.0f;
constexpr float DRAG_ACCEL = 8000.0f;

constexpr int NUDGE_STEP = 300;
constexpr int NUDGE_ATTEMPTS = 8;
constexpr int DRAG_OVERSHOOT_STEPS = 250;
constexpr long HALO_NEIGHBOR_MAX_DELTA = 5200;

AccelStepper motorA(1, MOTOR_A_STEP_PIN, MOTOR_A_DIR_PIN);
AccelStepper motorB(1, MOTOR_B_STEP_PIN, MOTOR_B_DIR_PIN);
Adafruit_NeoPixel strip(NUM_LEDS, LED_PIN, NEO_GRB + NEO_KHZ800);

// Format: {Y, X}. These are raw physical sensor/LED/gantry indexes.
// Chess-square mapping is owned by app/server.js because the board orientation
// and wiring do not match standard chess order.
const long squareCoordinates[64][2] = {
  {3100, 1400}, {2900, 5400}, {2900, 9600}, {2800, 13400}, {2800, 17300}, {2850, 21200}, {2750, 25350}, {2750, 29450},
  {7000, 29350}, {7000, 25350}, {7050, 21450}, {7100, 17600}, {7200, 13600}, {7250, 9550}, {7350, 5425}, {7300, 1375},
  {11150, 1375}, {11100, 5475}, {11100, 9500}, {11100, 13400}, {11150, 17300}, {11100, 21550}, {11000, 25300}, {11000, 29400},
  {14750, 29375}, {14800, 25475}, {14875, 21425}, {14925, 17425}, {14925, 13425}, {14925, 9375}, {14950, 5225}, {15075, 1475},
  {18975, 1425}, {18975, 5275}, {18875, 9225}, {18925, 13225}, {19025, 17625}, {19025, 21475}, {18975, 25275}, {18975, 29475},
  {22850, 29300}, {22900, 25300}, {22900, 21500}, {22950, 17400}, {23050, 13450}, {23025, 9350}, {23025, 5300}, {23075, 1300},
  {27175, 1350}, {27175, 5100}, {27125, 9200}, {27125, 13500}, {27075, 17500}, {27075, 21200}, {27025, 25250}, {26975, 29300},
  {30975, 29300}, {30925, 25300}, {31025, 21325}, {30925, 17325}, {30925, 13275}, {30975, 9275}, {31075, 5475}, {31125, 1425}
};

bool stableOccupancy[64] = {false};
bool candidateOccupancy[64] = {false};
uint8_t candidateCounts[64] = {0};
bool snapshotDirty = true;
uint32_t lastSnapshotPostMs = 0;
uint32_t snapshotSeq = 0;

long currentX = 0;
long currentY = 0;

SemaphoreHandle_t sharedMutex;
String pendingMotionCommandJson;
bool hasPendingMotionCommand = false;
String pendingJobResultJson;
bool hasPendingJobResult = false;
String lastMotionFailedPhase = "";
int lastMotionFailedStep = -1;
constexpr uint8_t LED_COMMAND_QUEUE_CAPACITY = 16;
String pendingLedCommands[LED_COMMAND_QUEUE_CAPACITY];
uint8_t pendingLedCommandHead = 0;
uint8_t pendingLedCommandTail = 0;
uint8_t pendingLedCommandCount = 0;

struct PromotionLedDisplay {
  bool active = false;
  String transactionId;
  String state;
  char displayedPiece = 0;
  char lockedPiece = 0;
  int targetIndex = -1;
  uint8_t choiceIndex = 0;
  uint32_t intervalMs = 2500;
  uint32_t lastChangeMs = 0;
};

PromotionLedDisplay promotionLedDisplay;

#if ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS
struct OfflineQuietHardwareJob {
  std::uint32_t requestId = 0;
  OfflineQuietHardwareJobKind kind = OfflineQuietHardwareJobKind::None;
  offline::QuietMotionProgram program;
};

OfflineQuietHardwareJob pendingOfflineQuietHardwareJob;
bool hasPendingOfflineQuietHardwareJob = false;
OfflineQuietHardwareResult completedOfflineQuietHardwareResult;
bool hasCompletedOfflineQuietHardwareResult = false;
#endif

#if ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS
struct OfflineCaptureHardwareJob {
  std::uint32_t requestId = 0;
  OfflineQuietHardwareJobKind kind = OfflineQuietHardwareJobKind::None;
  offline::CaptureMotionProgram program;
};

OfflineCaptureHardwareJob pendingOfflineCaptureHardwareJob;
bool hasPendingOfflineCaptureHardwareJob = false;
OfflineCaptureHardwareResult completedOfflineCaptureHardwareResult;
bool hasCompletedOfflineCaptureHardwareResult = false;
#endif

#if ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
struct OfflineLaneHardwareJob {
  std::uint32_t requestId = 0;
  OfflineQuietHardwareJobKind kind = OfflineQuietHardwareJobKind::None;
  offline::LaneMotionProgram program;
};

OfflineLaneHardwareJob pendingOfflineLaneHardwareJob;
bool hasPendingOfflineLaneHardwareJob = false;
OfflineLaneHardwareResult completedOfflineLaneHardwareResult;
bool hasCompletedOfflineLaneHardwareResult = false;
#endif

#if ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
volatile bool offlineQuietMagnetAuthorized = false;
volatile bool offlineQuietAbortRequested = false;
#endif

enum LedAnimationMode {
  LED_ANIM_NONE,
  LED_ANIM_CHECKMATE,
  LED_ANIM_DRAW,
  LED_ANIM_STALEMATE
};

LedAnimationMode activeLedAnimation = LED_ANIM_NONE;
uint32_t lastLedAnimationMs = 0;
int ledAnimationKingA = -1;
int ledAnimationKingB = -1;

void scanSensors();
void handleWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info);
void markSnapshotDirty();
bool postSnapshot(bool force);
bool postJson(const String& endpoint, const String& payload, String* responseOut = nullptr);
void applyImmediateLedCommands(const String& response);
void networkTask(void* parameter);
void pollPhysicalCommands();
void executeMotionCommand(const String& commandJson);
void executeDiagnosticCommand(JsonObject command);
bool executeRobotMove(JsonObject command, String& error);
bool executeMotionPlan(JsonObject command, String& error);
bool goToPlanTarget(JsonObject target, bool dragging, String& error, bool overshootBoardDrop = false);
void queueJobResult(const String& id, bool success, const String& error);
void setMotionProfile(bool dragging);
void goToXY(long targetX, long targetY, bool dragging);
void goToSquare(int index, bool dragging);
void goToSquareWithDragOvershoot(int index);
void homeGantry();
bool movePieceBetweenSquares(int fromIndex, int toIndex);
bool movePieceToCoordinate(int fromIndex, long targetX, long targetY);
bool verifySquareState(int index, bool expectedOccupied, uint32_t timeoutMs);
bool nudgeUntilDetected(int targetIndex);
void applyLedCommand(JsonObject command);
bool enqueueLedCommand(JsonObject command);
void serviceLedCommandQueue();
void servicePromotionLedDisplay(uint32_t now);
void applyPromotionLedCommand(JsonObject command);
void setSquareColor(int squareNumber, uint8_t r, uint8_t g, uint8_t b);
void updateLedAnimation();
uint32_t colorWheel(byte position);
void clearBoardLeds();
void setNeighborSquaresColor(int centerIndex, uint8_t r, uint8_t g, uint8_t b);
void applyHumanMoveConfirm(JsonObject command);
void applyCaptureStart(JsonObject step);
void runLedRunway(JsonObject step);
bool enqueueMotionCommand(const String& commandJson);

#if ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
bool offlineRuntimeMagnetIsLow() {
  return digitalRead(MAGNET_PIN) == LOW;
}
#endif

void setup() {
  pinMode(MAGNET_PIN, OUTPUT);
  digitalWrite(MAGNET_PIN, LOW);

  Serial.begin(115200);
  delay(200);

#if ENABLE_OFFLINE_EMBEDDED_DIAGNOSTICS || ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS || \
    ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
  beginOfflineDiagnosticSerial();
#endif

  sharedMutex = xSemaphoreCreateMutex();

  pinMode(LIMIT_X_PIN, INPUT_PULLUP);
  pinMode(LIMIT_Y_PIN, INPUT_PULLUP);

  pinMode(S0, OUTPUT);
  pinMode(S1, OUTPUT);
  pinMode(S2, OUTPUT);
  pinMode(S3, OUTPUT);
  pinMode(SIG1_PIN, INPUT_PULLUP);
  pinMode(SIG2_PIN, INPUT_PULLUP);
  pinMode(SIG3_PIN, INPUT_PULLUP);
  pinMode(SIG4_PIN, INPUT_PULLUP);

  strip.begin();
  strip.setBrightness(40);
  strip.show();

  setMotionProfile(false);

  WiFi.onEvent(handleWifiEvent);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.println("[BOOT] Physical board firmware started.");

  beginOfflineRuntimeDiagnostics();
  beginOfflineOwnershipDiagnostics();
  xTaskCreatePinnedToCore(networkTask, "networkTask", 12288, nullptr, 1, nullptr, 0);
#if !ENABLE_OFFLINE_EMBEDDED_DIAGNOSTICS && !ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS && \
    !ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS && !ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS && \
    !ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS && \
    !ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS && \
    !ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
  MentorSpeakerConfig speakerConfig;
  speakerConfig.host = AUDIO_SERVER_HOST;
  speakerConfig.port = CHESS_AUDIO_SERVER_PORT;
  speakerConfig.boardId = AUDIO_BOARD_ID;
  speakerConfig.token = AUDIO_TOKEN;
  beginMentorSpeaker(speakerConfig);
#endif
  beginOfflineEmbeddedDiagnostics();
}

void handleWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
    Serial.printf(
      "[WIFI] Connected ip=%s rssi=%d\n",
      WiFi.localIP().toString().c_str(),
      WiFi.RSSI()
    );
  } else if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    Serial.printf(
      "[WIFI] Disconnected reason=%u status=%d\n",
      info.wifi_sta_disconnected.reason,
      WiFi.status()
    );
  }
}

void loop() {
  if (offlineEmbeddedDiagnosticsActive() || offlineOwnershipDiagnosticsActive() ||
      offlineRuntimeDiagnosticsActive()) {
#if ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
    if (!offlineQuietMotionMagnetAuthorized()) {
      digitalWrite(MAGNET_PIN, LOW);
    }
#else
    digitalWrite(MAGNET_PIN, LOW);
#endif
  }

  scanSensors();
  serviceLedCommandQueue();
  servicePromotionLedDisplay(millis());
#if ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
  publishOfflineRuntimeStableSnapshot(stableOccupancy, millis());
#endif
#if ENABLE_OFFLINE_PRODUCTION_INTERACTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CONTINUOUS_GAMEPLAY_DIAGNOSTICS
  serviceOfflineInteractionFrame();
#elif ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS || ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || \
    ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
  updateOfflineOwnershipDiagnosticLeds(millis());
#else
  updateLedAnimation();
#endif

#if ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS
  serviceOfflineQuietMotionHardware();
#elif ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS
  serviceOfflineCaptureMotionHardware();
#elif ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
  serviceOfflineLaneMotionHardware();
#endif

  String commandJson;
  bool shouldExecute = false;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(2)) == pdTRUE) {
    if (hasPendingMotionCommand) {
      commandJson = pendingMotionCommandJson;
      pendingMotionCommandJson = "";
      hasPendingMotionCommand = false;
      shouldExecute = true;
    }
    xSemaphoreGive(sharedMutex);
  }

  if (shouldExecute) {
    executeMotionCommand(commandJson);
  }

  delay(2);
}

void networkTask(void* parameter) {
  uint32_t lastPollMs = 0;
  uint32_t lastWifiAttemptMs = 0;

  for (;;) {
    const uint32_t now = millis();

    if (WiFi.status() != WL_CONNECTED && now - lastWifiAttemptMs >= WIFI_RETRY_INTERVAL_MS) {
      lastWifiAttemptMs = now;
      Serial.println("[WIFI] Connecting...");
      WiFi.reconnect();
    }

#if ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS || ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || \
    ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
    runOfflineOwnershipNetworkStep(now);
    vTaskDelay(pdMS_TO_TICKS(25));
    continue;
#endif

    if (WiFi.status() == WL_CONNECTED) {
      String resultJson;
      bool shouldPostResult = false;
      if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(5)) == pdTRUE) {
        if (hasPendingJobResult) {
          resultJson = pendingJobResultJson;
          pendingJobResultJson = "";
          hasPendingJobResult = false;
          shouldPostResult = true;
        }
        xSemaphoreGive(sharedMutex);
      }

      if (shouldPostResult) {
        postJson("/api/physical/job-result", resultJson);
      }

      postSnapshot(false);

      if (now - lastPollMs >= POLL_INTERVAL_MS) {
        lastPollMs = now;
        pollPhysicalCommands();
      }
    }

    vTaskDelay(pdMS_TO_TICKS(25));
  }
}

void scanSensors() {
#if !ENABLE_OFFLINE_EMBEDDED_DIAGNOSTICS && !ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS && \
    !ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS && !ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS && \
    !ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS && \
    !ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS && \
    !ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
  mentorSpeakerRecordSensorScan(millis());
#endif
#if ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS
  static uint32_t previousOwnershipScanMs = 0;
  const uint32_t ownershipScanStartedMs = millis();
  if (previousOwnershipScanMs != 0) {
    const uint32_t gap = ownershipScanStartedMs - previousOwnershipScanMs;
    if (gap > ownershipDiagnosticSensorMaxGapMs) {
      ownershipDiagnosticSensorMaxGapMs = gap;
    }
  }
  previousOwnershipScanMs = ownershipScanStartedMs;
  ownershipDiagnosticSensorScanCount++;
#endif

#if ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
  static uint32_t previousRuntimeScanMs = 0;
  const uint32_t runtimeScanStartedMs = millis();
  if (previousRuntimeScanMs != 0) {
    const uint32_t gap = runtimeScanStartedMs - previousRuntimeScanMs;
    if (gap > offlineRuntimeSensorMaxGapMs) {
      offlineRuntimeSensorMaxGapMs = gap;
    }
#if ENABLE_OFFLINE_PRODUCTION_INTERACTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CONTINUOUS_GAMEPLAY_DIAGNOSTICS
    recordOfflineInteractionSensorGap(gap);
#endif
  }
  previousRuntimeScanMs = runtimeScanStartedMs;
  offlineRuntimeSensorScanCount++;
#endif

#if ENABLE_OFFLINE_EMBEDDED_DIAGNOSTICS
  static uint32_t previousScanMs = 0;
  const uint32_t scanStartedMs = millis();
  if (previousScanMs != 0) {
    const uint32_t gap = scanStartedMs - previousScanMs;
    if (gap > offlineDiagnosticSensorMaxGapMs) {
      offlineDiagnosticSensorMaxGapMs = gap;
    }
  }
  previousScanMs = scanStartedMs;
  offlineDiagnosticSensorScanCount++;
#endif

  for (int channel = 0; channel < 16; channel++) {
    digitalWrite(S0, bitRead(channel, 0));
    digitalWrite(S1, bitRead(channel, 1));
    digitalWrite(S2, bitRead(channel, 2));
    digitalWrite(S3, bitRead(channel, 3));
    delayMicroseconds(10);

    const bool readings[4] = {
      digitalRead(SIG1_PIN) == LOW,
      digitalRead(SIG2_PIN) == LOW,
      digitalRead(SIG3_PIN) == LOW,
      digitalRead(SIG4_PIN) == LOW
    };

    for (int mux = 0; mux < 4; mux++) {
      const int index = channel + mux * 16;
      const bool reading = readings[mux];

      if (candidateOccupancy[index] != reading) {
        candidateOccupancy[index] = reading;
        candidateCounts[index] = 1;
      } else if (candidateCounts[index] < SENSOR_DEBOUNCE_SCANS) {
        candidateCounts[index]++;
      }

      if (candidateCounts[index] >= SENSOR_DEBOUNCE_SCANS && stableOccupancy[index] != reading) {
        stableOccupancy[index] = reading;
        markSnapshotDirty();
      }
    }
  }
}

void markSnapshotDirty() {
  snapshotDirty = true;
}

bool postSnapshot(bool force) {
  const uint32_t now = millis();
  if (!force && (!snapshotDirty || now - lastSnapshotPostMs < SNAPSHOT_MIN_INTERVAL_MS)) {
    return false;
  }

  StaticJsonDocument<1536> doc;
  doc["seq"] = snapshotSeq++;
  doc["stable"] = true;
  doc["source"] = "esp32";
  JsonArray occupancy = doc.createNestedArray("occupancy");
  for (int i = 0; i < 64; i++) {
    occupancy.add(stableOccupancy[i]);
  }
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(2)) == pdTRUE) {
    if (promotionLedDisplay.active) {
      JsonObject promotion = doc.createNestedObject("promotionDisplay");
      promotion["transactionId"] = promotionLedDisplay.transactionId;
      promotion["state"] = promotionLedDisplay.state;
      if (promotionLedDisplay.displayedPiece) {
        char piece[2] = {promotionLedDisplay.displayedPiece, '\0'};
        promotion["displayedPiece"] = piece;
      }
    }
    xSemaphoreGive(sharedMutex);
  }

  String payload;
  serializeJson(doc, payload);

  String response;
  if (postJson("/api/physical/snapshot", payload, &response)) {
    applyImmediateLedCommands(response);
    snapshotDirty = false;
    lastSnapshotPostMs = now;
    return true;
  }

  return false;
}

void applyImmediateLedCommands(const String& response) {
  if (response.length() == 0) return;

  DynamicJsonDocument doc(12288);
  DeserializationError err = deserializeJson(doc, response);
  if (err) {
    Serial.printf("[JSON] snapshot response parse failed: %s\n", err.c_str());
    return;
  }

  JsonArray commands = doc["immediateCommands"].as<JsonArray>();
  if (commands.isNull()) return;

  for (JsonObject command : commands) {
    const char* type = command["type"] | "";
    if (strcmp(type, "led") == 0) {
      enqueueLedCommand(command);
    }
  }
}

bool postJson(const String& endpoint, const String& payload, String* responseOut) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  http.begin(String(SERVER_BASE_URL) + endpoint);
  http.addHeader("Content-Type", "application/json");
  const int code = http.POST(payload);
  const String response = http.getString();
  http.end();

  if (responseOut) *responseOut = response;

  if (code >= 200 && code < 300) {
    return true;
  }

  Serial.printf("[HTTP] POST %s failed: %d %s\n", endpoint.c_str(), code, response.c_str());
  return false;
}

void pollPhysicalCommands() {
  HTTPClient http;
  http.begin(String(SERVER_BASE_URL) + "/api/physical/poll");
  const int code = http.GET();
  const String response = http.getString();
  http.end();

  if (code < 200 || code >= 300) {
    Serial.printf("[HTTP] poll failed: %d\n", code);
    return;
  }

  DynamicJsonDocument doc(24576);
  DeserializationError err = deserializeJson(doc, response);
  if (err) {
    Serial.printf("[JSON] poll parse failed: %s\n", err.c_str());
    return;
  }

#if ENABLE_OFFLINE_EMBEDDED_DIAGNOSTICS
  offlineDiagnosticSuccessfulPollCount++;
#endif

  JsonArray commands = doc["commands"].as<JsonArray>();
  for (JsonObject command : commands) {
    const char* type = command["type"] | "";

    if (strcmp(type, "led") == 0) {
      enqueueLedCommand(command);
    } else if (strcmp(type, "request-snapshot") == 0) {
      markSnapshotDirty();
      postSnapshot(true);
    } else if (strcmp(type, "diagnostic") == 0) {
      const char* action = command["action"] | "";
      if (strcmp(action, "magnet") == 0) {
        const int val = command["val"] | 0;
        digitalWrite(
            MAGNET_PIN,
            (offlineEmbeddedDiagnosticsActive() || offlineOwnershipDiagnosticsActive())
                ? LOW
                : (val ? HIGH : LOW));
        markSnapshotDirty();
      } else {
        String commandJson;
        serializeJson(command, commandJson);
        if (!enqueueMotionCommand(commandJson)) {
          const String id = command["id"] | "unknown";
          queueJobResult(id, false, "ESP32 motion queue is busy.");
        }
      }
    } else if (strcmp(type, "home") == 0 || strcmp(type, "move") == 0) {
      String commandJson;
      serializeJson(command, commandJson);
      if (!enqueueMotionCommand(commandJson)) {
        const String id = command["id"] | "unknown";
        queueJobResult(id, false, "ESP32 motion queue is busy.");
      }
    }
  }
}

bool enqueueMotionCommand(const String& commandJson) {
  if (offlineEmbeddedDiagnosticsActive() || offlineOwnershipDiagnosticsActive() ||
      offlineRuntimeDiagnosticsActive()) {
    (void)commandJson;
    digitalWrite(MAGNET_PIN, LOW);
    return false;
  }

  bool queued = false;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    if (!hasPendingMotionCommand) {
      pendingMotionCommandJson = commandJson;
      hasPendingMotionCommand = true;
      queued = true;
    }
    xSemaphoreGive(sharedMutex);
  }
  return queued;
}

void executeMotionCommand(const String& commandJson) {
  if (offlineEmbeddedDiagnosticsActive() || offlineOwnershipDiagnosticsActive() ||
      offlineRuntimeDiagnosticsActive()) {
    (void)commandJson;
    digitalWrite(MAGNET_PIN, LOW);
    return;
  }

  DynamicJsonDocument doc(24576);
  DeserializationError err = deserializeJson(doc, commandJson);
  if (err) {
    Serial.printf("[JSON] motion command parse failed: %s\n", err.c_str());
    return;
  }

  JsonObject command = doc.as<JsonObject>();
  const char* type = command["type"] | "";
  const String id = command["id"] | "unknown";

  if (strcmp(type, "home") == 0) {
    homeGantry();
    markSnapshotDirty();
    return;
  }

  if (strcmp(type, "diagnostic") == 0) {
    executeDiagnosticCommand(command);
    markSnapshotDirty();
    return;
  }

  if (strcmp(type, "move") == 0) {
    String error;
    lastMotionFailedPhase = "";
    lastMotionFailedStep = -1;
    const bool ok = executeRobotMove(command, error);
    queueJobResult(id, ok, error);
    markSnapshotDirty();
  }
}

void executeDiagnosticCommand(JsonObject command) {
  const char* action = command["action"] | "";

  if (strcmp(action, "magnet") == 0) {
    const int val = command["val"] | 0;
    digitalWrite(MAGNET_PIN, val ? HIGH : LOW);
    return;
  }

  if (strcmp(action, "xy") == 0) {
    const long x = command["x"] | currentX;
    const long y = command["y"] | currentY;
    const bool dragging = command["dragging"] | false;
    goToXY(x, y, dragging);
    return;
  }

  if (strcmp(action, "square") == 0) {
    const int index = command["index"] | -1;
    const bool dragging = command["dragging"] | false;
    goToSquare(index, dragging);
  }
}

bool goToPlanTarget(JsonObject target, bool dragging, String& error, bool overshootBoardDrop) {
  if (target.isNull()) {
    error = "Motion plan step is missing a target.";
    return false;
  }

  if (target["index"].is<int>()) {
    const int index = target["index"] | -1;
    if (index < 0 || index >= 64) {
      error = "Motion plan target has an invalid square index.";
      return false;
    }
    if (dragging && overshootBoardDrop) {
      goToSquareWithDragOvershoot(index);
    } else {
      goToSquare(index, dragging);
    }
    return true;
  }

  if (target["x"].is<long>() && target["y"].is<long>()) {
    const long x = target["x"] | currentX;
    const long y = target["y"] | currentY;
    goToXY(x, y, dragging);
    return true;
  }

  error = "Motion plan target needs either index or x/y coordinates.";
  return false;
}

bool executeMotionPlan(JsonObject command, String& error) {
  JsonArray plan = command["plan"].as<JsonArray>();
  if (plan.isNull() || plan.size() == 0) {
    error = "Motion plan is empty.";
    return false;
  }

  int stepIndex = 0;
  for (JsonObject step : plan) {
    const char* action = step["action"] | "";
    const char* phase = step["phase"] | action;
    lastMotionFailedPhase = String(phase);
    lastMotionFailedStep = stepIndex;

    if (strcmp(action, "travel") == 0) {
      digitalWrite(MAGNET_PIN, LOW);
      JsonObject target = step["to"].as<JsonObject>();
      if (!goToPlanTarget(target, false, error)) return false;
      stepIndex++;
      continue;
    }

    if (strcmp(action, "pickup") == 0) {
      digitalWrite(MAGNET_PIN, HIGH);
      delay(160);
      stepIndex++;
      continue;
    }

    if (strcmp(action, "drag") == 0) {
      digitalWrite(MAGNET_PIN, HIGH);
      JsonObject target = step["to"].as<JsonObject>();
      JsonObject nextStep = plan[stepIndex + 1].as<JsonObject>();
      const char* nextAction = nextStep["action"] | "";
      const bool finalBoardDrop = strcmp(nextAction, "drop") == 0 && target["index"].is<int>();
      if (!goToPlanTarget(target, true, error, finalBoardDrop)) return false;
      stepIndex++;
      continue;
    }

    if (strcmp(action, "drop") == 0) {
      digitalWrite(MAGNET_PIN, LOW);
      delay(80);
      const int nudgeTargetIndex = step["nudgeTargetIndex"] | -1;
      if (nudgeTargetIndex >= 0 && nudgeTargetIndex < 64 && !nudgeUntilDetected(nudgeTargetIndex)) {
        error = "Drop verification failed after nudge attempts.";
        return false;
      }
      stepIndex++;
      continue;
    }

    if (strcmp(action, "verify") == 0) {
      const int sourceEmpty = step["sourceEmpty"] | -1;
      const int targetOccupied = step["targetOccupied"] | -1;

      if (sourceEmpty >= 0 && sourceEmpty < 64 && !verifySquareState(sourceEmpty, false, 700)) {
        error = "Motion plan source square did not become empty.";
        return false;
      }

      if (targetOccupied >= 0 && targetOccupied < 64 && !verifySquareState(targetOccupied, true, 700)) {
        if (!nudgeUntilDetected(targetOccupied)) {
          error = "Motion plan target square did not become occupied.";
          return false;
        }
      }
      stepIndex++;
      continue;
    }

    if (strcmp(action, "led-capture-start") == 0) {
      applyCaptureStart(step);
      stepIndex++;
      continue;
    }

    if (strcmp(action, "led-runway") == 0) {
      runLedRunway(step);
      stepIndex++;
      continue;
    }

    error = "Motion plan contains an unknown step action.";
    return false;
  }

  lastMotionFailedPhase = "";
  lastMotionFailedStep = -1;
  return true;
}

bool executeRobotMove(JsonObject command, String& error) {
  if (command["plan"].is<JsonArray>()) {
    return executeMotionPlan(command, error);
  }

  const int fromIndex = command["fromIndex"] | -1;
  const int toIndex = command["toIndex"] | -1;
  const bool capture = command["capture"] | false;

  if (fromIndex < 0 || fromIndex >= 64 || toIndex < 0 || toIndex >= 64) {
    error = "Invalid source or target index.";
    return false;
  }

  if (command["castleRookMove"].is<JsonObject>()) {
    if (!movePieceBetweenSquares(fromIndex, toIndex)) {
      error = "Failed to move castling king.";
      return false;
    }

    JsonObject rook = command["castleRookMove"];
    const int rookFrom = rook["fromIndex"] | -1;
    const int rookTo = rook["toIndex"] | -1;
    if (!movePieceBetweenSquares(rookFrom, rookTo)) {
      error = "Failed to move castling rook.";
      return false;
    }
    return true;
  }

  if (capture) {
    const int stagingIndex = command["stagingIndex"] | -1;
    const int capturedIndex = command["capturedIndex"] | -1;
    JsonObject graveyardSlot = command["graveyardSlot"];

    if (stagingIndex < 0 || stagingIndex >= 64 || capturedIndex < 0 || capturedIndex >= 64 || graveyardSlot.isNull()) {
      error = "Capture command missing staging, captured index, or graveyard slot.";
      return false;
    }

    if (!movePieceBetweenSquares(fromIndex, stagingIndex)) {
      error = "Failed to stage attacking piece.";
      return false;
    }

    const long graveyardX = graveyardSlot["x"] | 0;
    const long graveyardY = graveyardSlot["y"] | 0;
    if (!movePieceToCoordinate(capturedIndex, graveyardX, graveyardY)) {
      error = "Failed to remove captured piece.";
      return false;
    }

    if (!movePieceBetweenSquares(stagingIndex, toIndex)) {
      error = "Failed to place attacking piece on capture square.";
      return false;
    }
    return true;
  }

  if (!movePieceBetweenSquares(fromIndex, toIndex)) {
    error = "Failed to execute normal move.";
    return false;
  }

  return true;
}

void queueJobResult(const String& id, bool success, const String& error) {
  StaticJsonDocument<1536> doc;
  doc["id"] = id;
  doc["success"] = success;
  if (!success) doc["error"] = error;
  if (!success && lastMotionFailedPhase.length() > 0) doc["failedPhase"] = lastMotionFailedPhase;
  if (!success && lastMotionFailedStep >= 0) doc["failedStep"] = lastMotionFailedStep;
  JsonArray occupancy = doc.createNestedArray("occupancy");
  for (int i = 0; i < 64; i++) {
    occupancy.add(stableOccupancy[i]);
  }

  String payload;
  serializeJson(doc, payload);

  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    pendingJobResultJson = payload;
    hasPendingJobResult = true;
    xSemaphoreGive(sharedMutex);
  }
}

void setMotionProfile(bool dragging) {
  motorA.setMaxSpeed(dragging ? DRAG_MAX_SPEED : FAST_MAX_SPEED);
  motorA.setAcceleration(dragging ? DRAG_ACCEL : FAST_ACCEL);
  motorB.setMaxSpeed(dragging ? DRAG_MAX_SPEED : FAST_MAX_SPEED);
  motorB.setAcceleration(dragging ? DRAG_ACCEL : FAST_ACCEL);
}

void goToXY(long targetX, long targetY, bool dragging) {
  setMotionProfile(dragging);

  const long targetA = -targetX + targetY;
  const long targetB = targetX + targetY;

  motorA.moveTo(targetA);
  motorB.moveTo(targetB);

  uint32_t lastScanMs = 0;
  while (motorA.distanceToGo() != 0 || motorB.distanceToGo() != 0) {
    motorA.run();
    motorB.run();

    if (millis() - lastScanMs >= 4) {
      lastScanMs = millis();
      scanSensors();
      yield();
    }
  }

  currentX = targetX;
  currentY = targetY;
}

void goToSquare(int index, bool dragging) {
  if (index < 0 || index >= 64) return;
  goToXY(squareCoordinates[index][1], squareCoordinates[index][0], dragging);
}

void goToSquareWithDragOvershoot(int index) {
  if (index < 0 || index >= 64) return;

  const long targetX = squareCoordinates[index][1];
  const long targetY = squareCoordinates[index][0];
  const float dx = float(targetX - currentX);
  const float dy = float(targetY - currentY);
  const float distance = sqrtf(dx * dx + dy * dy);

  if (distance < 1.0f) {
    goToXY(targetX, targetY, true);
    return;
  }

  const long overshootX = targetX + lroundf((dx / distance) * DRAG_OVERSHOOT_STEPS);
  const long overshootY = targetY + lroundf((dy / distance) * DRAG_OVERSHOOT_STEPS);
  goToXY(overshootX, overshootY, true);
}

#if ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
namespace {

constexpr std::uint32_t OFFLINE_HOME_AXIS_TIMEOUT_MS = 20000;
constexpr std::uint32_t OFFLINE_HOME_BACKOFF_TIMEOUT_MS = 3000;
constexpr std::uint32_t OFFLINE_QUIET_SETTLE_TIMEOUT_MS = 1500;
constexpr std::uint32_t OFFLINE_GRAVEYARD_STABLE_MS = 500;
constexpr long OFFLINE_HOME_RELEASE_INCREMENT_STEPS = 100;
constexpr long OFFLINE_HOME_MAX_RELEASE_STEPS = 1200;
constexpr long OFFLINE_HOME_FINAL_RELEASE_STEPS = 100;
constexpr long OFFLINE_HOME_APPROACH_STEPS = 1000000;
constexpr float OFFLINE_HOME_MAX_SPEED = 3000.0f;
constexpr float OFFLINE_HOME_ACCEL = 2000.0f;

void setOfflineHomeMotionProfile() {
  motorA.setMaxSpeed(OFFLINE_HOME_MAX_SPEED);
  motorA.setAcceleration(OFFLINE_HOME_ACCEL);
  motorB.setMaxSpeed(OFFLINE_HOME_MAX_SPEED);
  motorB.setAcceleration(OFFLINE_HOME_ACCEL);
}

void copyOfflineQuietOccupancy(offline::Occupancy& occupancy) {
  for (std::size_t index = 0; index < occupancy.size(); ++index) {
    occupancy[index] = stableOccupancy[index];
  }
}

void stopOfflineQuietMotors() {
  const long positionA = motorA.currentPosition();
  const long positionB = motorB.currentPosition();
  motorA.setCurrentPosition(positionA);
  motorB.setCurrentPosition(positionB);
}

bool runOfflineQuietRelative(
    long deltaA,
    long deltaB,
    std::uint32_t timeoutMs,
    bool& motorActivity,
    String& error) {
  motorA.move(deltaA);
  motorB.move(deltaB);
  motorActivity = motorActivity || deltaA != 0 || deltaB != 0;
  const std::uint32_t startedAt = millis();
  std::uint32_t lastScanMs = 0;
  while (motorA.distanceToGo() != 0 || motorB.distanceToGo() != 0) {
    motorA.run();
    motorB.run();
    const std::uint32_t nowMs = millis();
    if (nowMs - lastScanMs >= 4) {
      lastScanMs = nowMs;
      scanSensors();
      yield();
    }
    if (nowMs - startedAt >= timeoutMs) {
      stopOfflineQuietMotors();
      error = "Bounded homing backoff timed out.";
      return false;
    }
  }
  return true;
}

bool approachOfflineQuietLimit(
    uint8_t limitPin,
    long deltaA,
    long deltaB,
    const char* axis,
    bool& motorActivity,
    String& error) {
  motorA.move(deltaA);
  motorB.move(deltaB);
  motorActivity = true;
  const std::uint32_t startedAt = millis();
  std::uint32_t lastScanMs = 0;
  std::uint32_t lastSwitchSampleMs = 0;
  uint8_t pressedSamples = 0;
  while (millis() - startedAt < OFFLINE_HOME_AXIS_TIMEOUT_MS) {
    motorA.run();
    motorB.run();
    const std::uint32_t nowMs = millis();
    if (nowMs - lastSwitchSampleMs >= 2) {
      lastSwitchSampleMs = nowMs;
      if (digitalRead(limitPin) == SWITCH_PRESSED) {
        if (++pressedSamples >= 3) {
          stopOfflineQuietMotors();
          return true;
        }
      } else {
        pressedSamples = 0;
      }
    }
    if (nowMs - lastScanMs >= 4) {
      lastScanMs = nowMs;
      scanSensors();
      yield();
    }
  }
  stopOfflineQuietMotors();
  error = String("Bounded ") + axis + " homing timed out after 20000 ms.";
  return false;
}

bool releaseOfflineQuietLimit(
    uint8_t limitPin,
    long releaseA,
    long releaseB,
    const char* axis,
    bool& motorActivity,
    String& error,
    long& releasedSteps) {
  releasedSteps = 0;
  while (releasedSteps < OFFLINE_HOME_MAX_RELEASE_STEPS) {
    if (!runOfflineQuietRelative(
            releaseA * OFFLINE_HOME_RELEASE_INCREMENT_STEPS,
            releaseB * OFFLINE_HOME_RELEASE_INCREMENT_STEPS,
            OFFLINE_HOME_BACKOFF_TIMEOUT_MS,
            motorActivity,
            error)) {
      return false;
    }
    releasedSteps += OFFLINE_HOME_RELEASE_INCREMENT_STEPS;
    if (digitalRead(limitPin) == SWITCH_UNPRESSED) return true;
  }

  error = String(axis) + " limit switch did not release within " +
          String(OFFLINE_HOME_MAX_RELEASE_STEPS) + " steps.";
  return false;
}

bool homeOfflineQuietAxis(
    uint8_t limitPin,
    long releaseA,
    long releaseB,
    long approachA,
    long approachB,
    const char* axis,
    bool& motorActivity,
    String& error) {
  if (digitalRead(limitPin) == SWITCH_PRESSED) {
    long initialReleaseSteps = 0;
    if (!releaseOfflineQuietLimit(
            limitPin,
            releaseA,
            releaseB,
            axis,
            motorActivity,
            error,
            initialReleaseSteps)) return false;
  }

  if (!approachOfflineQuietLimit(
          limitPin,
          approachA * OFFLINE_HOME_APPROACH_STEPS,
          approachB * OFFLINE_HOME_APPROACH_STEPS,
          axis,
          motorActivity,
          error)) {
    return false;
  }

  long finalReleaseSteps = 0;
  if (!releaseOfflineQuietLimit(
          limitPin,
          releaseA,
          releaseB,
          axis,
          motorActivity,
          error,
          finalReleaseSteps)) return false;

  // Preserve the accepted 100-step logical origin after proving the switch
  // releases. The incremental limit handles normal mechanical hysteresis.
  const long returnSteps = finalReleaseSteps - OFFLINE_HOME_FINAL_RELEASE_STEPS;
  if (returnSteps > 0) {
    if (!runOfflineQuietRelative(
            -releaseA * returnSteps,
            -releaseB * returnSteps,
            OFFLINE_HOME_BACKOFF_TIMEOUT_MS,
            motorActivity,
            error)) {
      return false;
    }
  }
  return true;
}

bool executeOfflineQuietHome(OfflineQuietHardwareResult& result) {
  offlineQuietMagnetAuthorized = false;
  digitalWrite(MAGNET_PIN, LOW);
  setOfflineHomeMotionProfile();
  String error;

  // CoreXY negative X is A positive/B negative; positive X releases it.
  if (!homeOfflineQuietAxis(
          LIMIT_X_PIN, -1, 1, 1, -1, "X", result.motorActivity, error)) {
    result.error = error;
    return false;
  }
  // CoreXY negative Y is A negative/B negative; positive Y releases it.
  if (!homeOfflineQuietAxis(
          LIMIT_Y_PIN, 1, 1, -1, -1, "Y", result.motorActivity, error)) {
    result.error = error;
    return false;
  }

  motorA.setCurrentPosition(0);
  motorB.setCurrentPosition(0);
  currentX = 0;
  currentY = 0;
  result.homed = true;
  return true;
}

bool waitForOfflineQuietOccupancy(
    const offline::Occupancy& expected,
    std::uint32_t timeoutMs,
    std::uint32_t stableMs = 0) {
  const std::uint32_t startedAt = millis();
  std::uint32_t matchingSince = 0;
  while (millis() - startedAt < timeoutMs) {
    scanSensors();
    offline::Occupancy observed;
    copyOfflineQuietOccupancy(observed);
    if (observed == expected) {
      if (stableMs == 0) return true;
      if (matchingSince == 0) matchingSince = millis();
      if (millis() - matchingSince >= stableMs) return true;
    } else {
      matchingSince = 0;
    }
    delay(10);
  }
  return false;
}

void offlineQuietDelayWithSensorScans(std::uint32_t durationMs) {
  const std::uint32_t startedAt = millis();
  while (millis() - startedAt < durationMs) {
    scanSensors();
    delay(4);
  }
}

bool executeOfflineQuietProgram(
    const offline::QuietMotionProgram& program,
    OfflineQuietHardwareResult& result) {
  offline::Occupancy observed;
  scanSensors();
  copyOfflineQuietOccupancy(observed);
  if (!program.success() || observed != program.expectedBefore) {
    result.error = program.success()
                       ? "Observed occupancy does not match the quiet phase before-state."
                       : "The quiet motion program is not executable.";
    return false;
  }

  bool pickedUp = false;
  for (const offline::QuietMotionPrimitive& primitive : program.primitives) {
    if (offlineQuietAbortRequested) {
      result.error = "Quiet motion was aborted by the diagnostic watchdog.";
      return false;
    }
    switch (primitive.kind) {
      case offline::QuietMotionPrimitiveKind::Travel:
        if (primitive.targetRawIndex < 0 || primitive.targetRawIndex >= 64) {
          result.error = "Travel primitive has an invalid board target.";
          return false;
        }
        digitalWrite(MAGNET_PIN, LOW);
        offlineQuietMagnetAuthorized = false;
        result.motorActivity = true;
        goToSquare(primitive.targetRawIndex, false);
        break;
      case offline::QuietMotionPrimitiveKind::Pickup:
        offlineQuietMagnetAuthorized = true;
        digitalWrite(MAGNET_PIN, HIGH);
        result.magnetEverHigh = true;
        pickedUp = true;
        offlineQuietDelayWithSensorScans(160);
        break;
      case offline::QuietMotionPrimitiveKind::Drag:
        if (!pickedUp || primitive.targetRawIndex < 0 ||
            primitive.targetRawIndex >= 64) {
          result.error = "Drag primitive is out of order or has an invalid target.";
          return false;
        }
        offlineQuietMagnetAuthorized = true;
        digitalWrite(MAGNET_PIN, HIGH);
        result.magnetEverHigh = true;
        result.motorActivity = true;
        if (primitive.finalBoardDrop) {
          goToSquareWithDragOvershoot(primitive.targetRawIndex);
        } else {
          goToSquare(primitive.targetRawIndex, true);
        }
        break;
      case offline::QuietMotionPrimitiveKind::Drop:
        digitalWrite(MAGNET_PIN, LOW);
        offlineQuietMagnetAuthorized = false;
        pickedUp = false;
        offlineQuietDelayWithSensorScans(80);
        break;
      case offline::QuietMotionPrimitiveKind::Verify:
        break;
    }
  }

  digitalWrite(MAGNET_PIN, LOW);
  offlineQuietMagnetAuthorized = false;
  if (!waitForOfflineQuietOccupancy(
          program.expectedAfter, OFFLINE_QUIET_SETTLE_TIMEOUT_MS)) {
    result.error = "Final board occupancy did not match the quiet phase after-state.";
    return false;
  }
  return true;
}

#if ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS
bool executeOfflineCaptureProgram(
    const offline::CaptureMotionProgram& program,
    OfflineCaptureHardwareResult& result) {
  offline::Occupancy observed;
  scanSensors();
  copyOfflineQuietOccupancy(observed);
  if (!program.success() || observed != program.expectedBefore) {
    result.error = program.success()
                       ? "Observed occupancy does not match the capture phase before-state."
                       : "The capture motion program is not executable.";
    return false;
  }

  bool pickedUp = false;
  for (const offline::CaptureMotionPrimitive& primitive : program.primitives) {
    if (offlineQuietAbortRequested) {
      result.error = "Capture motion was aborted by the diagnostic watchdog.";
      return false;
    }
    switch (primitive.kind) {
      case offline::CaptureMotionPrimitiveKind::TravelBoard:
#if ENABLE_OFFLINE_PRODUCTION_INTERACTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CONTINUOUS_GAMEPLAY_DIAGNOSTICS
        setOfflineInteractionSensorStage(OfflineInteractionSensorStage::Travel);
#endif
        if (primitive.targetRawIndex < 0 || primitive.targetRawIndex >= 64) {
          result.error = "Capture travel has an invalid board target.";
          return false;
        }
        digitalWrite(MAGNET_PIN, LOW);
        offlineQuietMagnetAuthorized = false;
        result.motorActivity = true;
        goToSquare(primitive.targetRawIndex, false);
        break;
      case offline::CaptureMotionPrimitiveKind::Pickup:
#if ENABLE_OFFLINE_PRODUCTION_INTERACTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CONTINUOUS_GAMEPLAY_DIAGNOSTICS
        setOfflineInteractionSensorStage(OfflineInteractionSensorStage::Pickup);
#endif
        if (pickedUp) {
          result.error = "Capture pickup occurred while a piece was already held.";
          return false;
        }
        offlineQuietMagnetAuthorized = true;
        digitalWrite(MAGNET_PIN, HIGH);
        result.magnetEverHigh = true;
        pickedUp = true;
        offlineQuietDelayWithSensorScans(160);
        break;
      case offline::CaptureMotionPrimitiveKind::DragBoard:
#if ENABLE_OFFLINE_PRODUCTION_INTERACTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CONTINUOUS_GAMEPLAY_DIAGNOSTICS
        setOfflineInteractionSensorStage(OfflineInteractionSensorStage::Drag);
#endif
        if (!pickedUp || primitive.targetRawIndex < 0 ||
            primitive.targetRawIndex >= 64) {
          result.error = "Capture board drag is out of order or invalid.";
          return false;
        }
        offlineQuietMagnetAuthorized = true;
        digitalWrite(MAGNET_PIN, HIGH);
        result.magnetEverHigh = true;
        result.motorActivity = true;
        if (primitive.finalBoardDrop) {
          goToSquareWithDragOvershoot(primitive.targetRawIndex);
        } else {
          goToSquare(primitive.targetRawIndex, true);
        }
        break;
      case offline::CaptureMotionPrimitiveKind::DragCoordinate:
#if ENABLE_OFFLINE_PRODUCTION_INTERACTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CONTINUOUS_GAMEPLAY_DIAGNOSTICS
        setOfflineInteractionSensorStage(OfflineInteractionSensorStage::Drag);
#endif
        if (!pickedUp || !isfinite(primitive.targetX) ||
            !isfinite(primitive.targetY)) {
          result.error = "Capture coordinate drag is out of order or invalid.";
          return false;
        }
        offlineQuietMagnetAuthorized = true;
        digitalWrite(MAGNET_PIN, HIGH);
        result.magnetEverHigh = true;
        result.motorActivity = true;
        goToXY(
            lround(primitive.targetX),
            lround(primitive.targetY),
            true);
        break;
      case offline::CaptureMotionPrimitiveKind::Drop:
#if ENABLE_OFFLINE_PRODUCTION_INTERACTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CONTINUOUS_GAMEPLAY_DIAGNOSTICS
        setOfflineInteractionSensorStage(OfflineInteractionSensorStage::Drop);
#endif
        if (!pickedUp) {
          result.error = "Capture drop occurred without a held piece.";
          return false;
        }
        digitalWrite(MAGNET_PIN, LOW);
        offlineQuietMagnetAuthorized = false;
        pickedUp = false;
        offlineQuietDelayWithSensorScans(80);
        break;
      case offline::CaptureMotionPrimitiveKind::Verify:
#if ENABLE_OFFLINE_PRODUCTION_INTERACTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CONTINUOUS_GAMEPLAY_DIAGNOSTICS
        setOfflineInteractionSensorStage(OfflineInteractionSensorStage::Verify);
#endif
        if (pickedUp) {
          result.error = "Capture verification occurred before drop.";
          return false;
        }
        break;
    }
  }

  digitalWrite(MAGNET_PIN, LOW);
  offlineQuietMagnetAuthorized = false;
  const std::uint32_t requiredStableMs =
      program.phaseKind == offline::MotionPhaseKind::CapturedRemoval
          ? OFFLINE_GRAVEYARD_STABLE_MS
          : 0;
#if ENABLE_OFFLINE_PRODUCTION_INTERACTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CONTINUOUS_GAMEPLAY_DIAGNOSTICS
  setOfflineInteractionSensorStage(OfflineInteractionSensorStage::Settle);
#endif
  if (!waitForOfflineQuietOccupancy(
          program.expectedAfter,
          OFFLINE_QUIET_SETTLE_TIMEOUT_MS,
          requiredStableMs)) {
    result.error = "Board occupancy did not match the capture phase after-state.";
    return false;
  }
  return true;
}
#endif

#if ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
bool executeOfflineLaneProgram(
    const offline::LaneMotionProgram& program,
    OfflineLaneHardwareResult& result) {
  offline::Occupancy observed;
  scanSensors();
  copyOfflineQuietOccupancy(observed);
  if (!program.success() || observed != program.expectedBefore) {
    result.error = program.success()
                       ? "Observed occupancy does not match the lane phase before-state."
                       : "The lane motion program is not executable.";
    return false;
  }

  bool pickedUp = false;
  for (const offline::LaneMotionPrimitive& primitive : program.primitives) {
    if (offlineQuietAbortRequested) {
      result.error = "Lane motion was aborted by the diagnostic watchdog.";
      return false;
    }
    switch (primitive.kind) {
      case offline::LaneMotionPrimitiveKind::TravelBoard:
        if (primitive.targetRawIndex < 0 || primitive.targetRawIndex >= 64) {
          result.error = "Lane travel has an invalid board target.";
          return false;
        }
        digitalWrite(MAGNET_PIN, LOW);
        offlineQuietMagnetAuthorized = false;
        result.motorActivity = true;
        goToSquare(primitive.targetRawIndex, false);
        break;
      case offline::LaneMotionPrimitiveKind::Pickup:
        if (pickedUp) {
          result.error = "Lane pickup occurred while a piece was already held.";
          return false;
        }
        offlineQuietMagnetAuthorized = true;
        digitalWrite(MAGNET_PIN, HIGH);
        result.magnetEverHigh = true;
        pickedUp = true;
        offlineQuietDelayWithSensorScans(160);
        break;
      case offline::LaneMotionPrimitiveKind::DragCoordinate:
        if (!pickedUp || !isfinite(primitive.targetX) ||
            !isfinite(primitive.targetY)) {
          result.error = "Lane coordinate drag is out of order or invalid.";
          return false;
        }
        offlineQuietMagnetAuthorized = true;
        digitalWrite(MAGNET_PIN, HIGH);
        result.magnetEverHigh = true;
        result.motorActivity = true;
        goToXY(lround(primitive.targetX), lround(primitive.targetY), true);
        break;
      case offline::LaneMotionPrimitiveKind::DragBoard:
        if (!pickedUp || primitive.targetRawIndex < 0 ||
            primitive.targetRawIndex >= 64) {
          result.error = "Lane board drag is out of order or invalid.";
          return false;
        }
        offlineQuietMagnetAuthorized = true;
        digitalWrite(MAGNET_PIN, HIGH);
        result.magnetEverHigh = true;
        result.motorActivity = true;
        if (primitive.finalBoardDrop) {
          goToSquareWithDragOvershoot(primitive.targetRawIndex);
        } else {
          goToSquare(primitive.targetRawIndex, true);
        }
        break;
      case offline::LaneMotionPrimitiveKind::Drop:
        if (!pickedUp) {
          result.error = "Lane drop occurred without a held piece.";
          return false;
        }
        digitalWrite(MAGNET_PIN, LOW);
        offlineQuietMagnetAuthorized = false;
        pickedUp = false;
        offlineQuietDelayWithSensorScans(80);
        break;
      case offline::LaneMotionPrimitiveKind::Verify:
        if (pickedUp) {
          result.error = "Lane verification occurred before drop.";
          return false;
        }
        break;
    }
  }

  digitalWrite(MAGNET_PIN, LOW);
  offlineQuietMagnetAuthorized = false;
  if (!waitForOfflineQuietOccupancy(
          program.expectedAfter, OFFLINE_QUIET_SETTLE_TIMEOUT_MS)) {
    result.error = "Board occupancy did not match the lane phase after-state.";
    return false;
  }
  return true;
}
#endif

}  // namespace

#if ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS
bool queueOfflineQuietHome(std::uint32_t requestId) {
  bool queued = false;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    if (!hasPendingOfflineQuietHardwareJob &&
        !hasCompletedOfflineQuietHardwareResult) {
      pendingOfflineQuietHardwareJob = {};
      pendingOfflineQuietHardwareJob.requestId = requestId;
      pendingOfflineQuietHardwareJob.kind = OfflineQuietHardwareJobKind::Home;
      offlineQuietAbortRequested = false;
      hasPendingOfflineQuietHardwareJob = true;
      queued = true;
    }
    xSemaphoreGive(sharedMutex);
  }
  return queued;
}

bool queueOfflineQuietProgram(
    std::uint32_t requestId,
    const offline::QuietMotionProgram& program) {
  bool queued = false;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    if (!hasPendingOfflineQuietHardwareJob &&
        !hasCompletedOfflineQuietHardwareResult) {
      pendingOfflineQuietHardwareJob = {};
      pendingOfflineQuietHardwareJob.requestId = requestId;
      pendingOfflineQuietHardwareJob.kind = OfflineQuietHardwareJobKind::Program;
      pendingOfflineQuietHardwareJob.program = program;
      offlineQuietAbortRequested = false;
      hasPendingOfflineQuietHardwareJob = true;
      queued = true;
    }
    xSemaphoreGive(sharedMutex);
  }
  return queued;
}

bool takeOfflineQuietHardwareResult(
    std::uint32_t requestId,
    OfflineQuietHardwareResult& result) {
  bool available = false;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    if (hasCompletedOfflineQuietHardwareResult &&
        completedOfflineQuietHardwareResult.requestId == requestId) {
      result = completedOfflineQuietHardwareResult;
      completedOfflineQuietHardwareResult = {};
      hasCompletedOfflineQuietHardwareResult = false;
      available = true;
    }
    xSemaphoreGive(sharedMutex);
  }
  return available;
}

void serviceOfflineQuietMotionHardware() {
  OfflineQuietHardwareJob job;
  bool hasJob = false;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(2)) == pdTRUE) {
    if (hasPendingOfflineQuietHardwareJob) {
      job = std::move(pendingOfflineQuietHardwareJob);
      pendingOfflineQuietHardwareJob = {};
      hasPendingOfflineQuietHardwareJob = false;
      hasJob = true;
    }
    xSemaphoreGive(sharedMutex);
  }
  if (!hasJob) return;

  OfflineQuietHardwareResult result;
  result.requestId = job.requestId;
  result.kind = job.kind;
  if (job.kind == OfflineQuietHardwareJobKind::Home) {
    result.success = executeOfflineQuietHome(result);
  } else if (job.kind == OfflineQuietHardwareJobKind::Program) {
    result.success = executeOfflineQuietProgram(job.program, result);
  } else {
    result.error = "Unknown quiet-motion hardware job.";
  }

  digitalWrite(MAGNET_PIN, LOW);
  offlineQuietMagnetAuthorized = false;
  scanSensors();
  copyOfflineQuietOccupancy(result.observedOccupancy);
  result.magnetLow = digitalRead(MAGNET_PIN) == LOW;
  result.motorAPosition = motorA.currentPosition();
  result.motorBPosition = motorB.currentPosition();
  result.x = currentX;
  result.y = currentY;

  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    completedOfflineQuietHardwareResult = result;
    hasCompletedOfflineQuietHardwareResult = true;
    xSemaphoreGive(sharedMutex);
  }
}

void abortOfflineQuietMotionHardware() {
  offlineQuietAbortRequested = true;
  offlineQuietMagnetAuthorized = false;
  digitalWrite(MAGNET_PIN, LOW);
}

bool offlineQuietMotionMagnetAuthorized() {
  return offlineQuietMagnetAuthorized;
}
#endif

#if ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS
bool queueOfflineCaptureHome(std::uint32_t requestId) {
  bool queued = false;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    if (!hasPendingOfflineCaptureHardwareJob &&
        !hasCompletedOfflineCaptureHardwareResult) {
      pendingOfflineCaptureHardwareJob = {};
      pendingOfflineCaptureHardwareJob.requestId = requestId;
      pendingOfflineCaptureHardwareJob.kind = OfflineQuietHardwareJobKind::Home;
      offlineQuietAbortRequested = false;
      hasPendingOfflineCaptureHardwareJob = true;
      queued = true;
    }
    xSemaphoreGive(sharedMutex);
  }
  return queued;
}

bool queueOfflineCaptureProgram(
    std::uint32_t requestId,
    const offline::CaptureMotionProgram& program) {
  bool queued = false;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    if (!hasPendingOfflineCaptureHardwareJob &&
        !hasCompletedOfflineCaptureHardwareResult) {
      pendingOfflineCaptureHardwareJob = {};
      pendingOfflineCaptureHardwareJob.requestId = requestId;
      pendingOfflineCaptureHardwareJob.kind = OfflineQuietHardwareJobKind::Program;
      pendingOfflineCaptureHardwareJob.program = program;
      offlineQuietAbortRequested = false;
      hasPendingOfflineCaptureHardwareJob = true;
      queued = true;
    }
    xSemaphoreGive(sharedMutex);
  }
  return queued;
}

bool takeOfflineCaptureHardwareResult(
    std::uint32_t requestId,
    OfflineCaptureHardwareResult& result) {
  bool available = false;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    if (hasCompletedOfflineCaptureHardwareResult &&
        completedOfflineCaptureHardwareResult.requestId == requestId) {
      result = completedOfflineCaptureHardwareResult;
      completedOfflineCaptureHardwareResult = {};
      hasCompletedOfflineCaptureHardwareResult = false;
      available = true;
    }
    xSemaphoreGive(sharedMutex);
  }
  return available;
}

void serviceOfflineCaptureMotionHardware() {
  OfflineCaptureHardwareJob job;
  bool hasJob = false;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(2)) == pdTRUE) {
    if (hasPendingOfflineCaptureHardwareJob) {
      job = std::move(pendingOfflineCaptureHardwareJob);
      pendingOfflineCaptureHardwareJob = {};
      hasPendingOfflineCaptureHardwareJob = false;
      hasJob = true;
    }
    xSemaphoreGive(sharedMutex);
  }
  if (!hasJob) return;

  OfflineCaptureHardwareResult result;
  result.requestId = job.requestId;
  result.kind = job.kind;
  if (job.kind == OfflineQuietHardwareJobKind::Home) {
    result.success = executeOfflineQuietHome(result);
  } else if (job.kind == OfflineQuietHardwareJobKind::Program) {
    result.success = executeOfflineCaptureProgram(job.program, result);
  } else {
    result.error = "Unknown capture-motion hardware job.";
  }

  digitalWrite(MAGNET_PIN, LOW);
  offlineQuietMagnetAuthorized = false;
  scanSensors();
  copyOfflineQuietOccupancy(result.observedOccupancy);
  result.magnetLow = digitalRead(MAGNET_PIN) == LOW;
  result.motorAPosition = motorA.currentPosition();
  result.motorBPosition = motorB.currentPosition();
  result.x = currentX;
  result.y = currentY;

  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    completedOfflineCaptureHardwareResult = result;
    hasCompletedOfflineCaptureHardwareResult = true;
    xSemaphoreGive(sharedMutex);
  }
}

void abortOfflineCaptureMotionHardware() {
  offlineQuietAbortRequested = true;
  offlineQuietMagnetAuthorized = false;
  digitalWrite(MAGNET_PIN, LOW);
}
#endif

#if ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
bool queueOfflineLaneHome(std::uint32_t requestId) {
  bool queued = false;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    if (!hasPendingOfflineLaneHardwareJob &&
        !hasCompletedOfflineLaneHardwareResult) {
      pendingOfflineLaneHardwareJob = {};
      pendingOfflineLaneHardwareJob.requestId = requestId;
      pendingOfflineLaneHardwareJob.kind = OfflineQuietHardwareJobKind::Home;
      offlineQuietAbortRequested = false;
      hasPendingOfflineLaneHardwareJob = true;
      queued = true;
    }
    xSemaphoreGive(sharedMutex);
  }
  return queued;
}

bool queueOfflineLaneProgram(
    std::uint32_t requestId,
    const offline::LaneMotionProgram& program) {
  bool queued = false;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    if (!hasPendingOfflineLaneHardwareJob &&
        !hasCompletedOfflineLaneHardwareResult) {
      pendingOfflineLaneHardwareJob = {};
      pendingOfflineLaneHardwareJob.requestId = requestId;
      pendingOfflineLaneHardwareJob.kind = OfflineQuietHardwareJobKind::Program;
      pendingOfflineLaneHardwareJob.program = program;
      offlineQuietAbortRequested = false;
      hasPendingOfflineLaneHardwareJob = true;
      queued = true;
    }
    xSemaphoreGive(sharedMutex);
  }
  return queued;
}

bool takeOfflineLaneHardwareResult(
    std::uint32_t requestId,
    OfflineLaneHardwareResult& result) {
  bool available = false;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    if (hasCompletedOfflineLaneHardwareResult &&
        completedOfflineLaneHardwareResult.requestId == requestId) {
      result = completedOfflineLaneHardwareResult;
      completedOfflineLaneHardwareResult = {};
      hasCompletedOfflineLaneHardwareResult = false;
      available = true;
    }
    xSemaphoreGive(sharedMutex);
  }
  return available;
}

void serviceOfflineLaneMotionHardware() {
  OfflineLaneHardwareJob job;
  bool hasJob = false;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(2)) == pdTRUE) {
    if (hasPendingOfflineLaneHardwareJob) {
      job = std::move(pendingOfflineLaneHardwareJob);
      pendingOfflineLaneHardwareJob = {};
      hasPendingOfflineLaneHardwareJob = false;
      hasJob = true;
    }
    xSemaphoreGive(sharedMutex);
  }
  if (!hasJob) return;

  OfflineLaneHardwareResult result;
  result.requestId = job.requestId;
  result.kind = job.kind;
  if (job.kind == OfflineQuietHardwareJobKind::Home) {
    result.success = executeOfflineQuietHome(result);
  } else if (job.kind == OfflineQuietHardwareJobKind::Program) {
    result.success = executeOfflineLaneProgram(job.program, result);
  } else {
    result.error = "Unknown lane-motion hardware job.";
  }

  digitalWrite(MAGNET_PIN, LOW);
  offlineQuietMagnetAuthorized = false;
  scanSensors();
  copyOfflineQuietOccupancy(result.observedOccupancy);
  result.magnetLow = digitalRead(MAGNET_PIN) == LOW;
  result.motorAPosition = motorA.currentPosition();
  result.motorBPosition = motorB.currentPosition();
  result.x = currentX;
  result.y = currentY;

  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    completedOfflineLaneHardwareResult = result;
    hasCompletedOfflineLaneHardwareResult = true;
    xSemaphoreGive(sharedMutex);
  }
}

void abortOfflineLaneMotionHardware() {
  offlineQuietAbortRequested = true;
  offlineQuietMagnetAuthorized = false;
  digitalWrite(MAGNET_PIN, LOW);
}
#endif

#if ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
bool offlineQuietMotionMagnetAuthorized() {
  return offlineQuietMagnetAuthorized;
}
#endif

#endif

void homeGantry() {
  Serial.println("[MOTION] Homing gantry.");
  setMotionProfile(false);
  digitalWrite(MAGNET_PIN, LOW);

  if (digitalRead(LIMIT_X_PIN) == SWITCH_PRESSED || digitalRead(LIMIT_Y_PIN) == SWITCH_PRESSED) {
    motorA.setCurrentPosition(0);
    motorB.setCurrentPosition(0);
    goToXY(200, 200, false);
  }

  motorA.move(1000000);
  motorB.move(-1000000);
  while (digitalRead(LIMIT_X_PIN) == SWITCH_UNPRESSED) {
    motorA.run();
    motorB.run();
    scanSensors();
    yield();
  }
  motorA.setCurrentPosition(0);
  motorB.setCurrentPosition(0);
  motorA.moveTo(0);
  motorB.moveTo(0);
  goToXY(100, 0, false);

  motorA.move(-1000000);
  motorB.move(-1000000);
  while (digitalRead(LIMIT_Y_PIN) == SWITCH_UNPRESSED) {
    motorA.run();
    motorB.run();
    scanSensors();
    yield();
  }
  motorA.setCurrentPosition(0);
  motorB.setCurrentPosition(0);
  motorA.moveTo(0);
  motorB.moveTo(0);

  goToXY(0, 100, false);
  motorA.setCurrentPosition(0);
  motorB.setCurrentPosition(0);
  currentX = 0;
  currentY = 0;
}

bool movePieceBetweenSquares(int fromIndex, int toIndex) {
  if (fromIndex < 0 || fromIndex >= 64 || toIndex < 0 || toIndex >= 64) return false;

  goToSquare(fromIndex, false);
  digitalWrite(MAGNET_PIN, HIGH);
  delay(160);
  goToSquareWithDragOvershoot(toIndex);
  digitalWrite(MAGNET_PIN, LOW);
  delay(80);

  if (!nudgeUntilDetected(toIndex)) return false;
  return verifySquareState(fromIndex, false, 600) && verifySquareState(toIndex, true, 600);
}

bool movePieceToCoordinate(int fromIndex, long targetX, long targetY) {
  if (fromIndex < 0 || fromIndex >= 64) return false;

  goToSquare(fromIndex, false);
  digitalWrite(MAGNET_PIN, HIGH);
  delay(160);
  goToXY(targetX, targetY, true);
  digitalWrite(MAGNET_PIN, LOW);
  delay(80);

  return verifySquareState(fromIndex, false, 600);
}

bool verifySquareState(int index, bool expectedOccupied, uint32_t timeoutMs) {
  const uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    scanSensors();
    if (stableOccupancy[index] == expectedOccupied) return true;
    delay(20);
  }
  return stableOccupancy[index] == expectedOccupied;
}

bool nudgeUntilDetected(int targetIndex) {
  if (verifySquareState(targetIndex, true, 150)) return true;

  const long centerX = squareCoordinates[targetIndex][1];
  const long centerY = squareCoordinates[targetIndex][0];
  const int offsets[NUDGE_ATTEMPTS][2] = {
    {NUDGE_STEP, 0},
    {NUDGE_STEP * 2, 0},
    {0, NUDGE_STEP},
    {0, NUDGE_STEP * 2},
    {-NUDGE_STEP, 0},
    {-NUDGE_STEP * 2, 0},
    {0, -NUDGE_STEP},
    {0, -NUDGE_STEP * 2}
  };

  for (int i = 0; i < NUDGE_ATTEMPTS; i++) {
    goToXY(centerX + offsets[i][0], centerY + offsets[i][1], false);
    if (verifySquareState(targetIndex, true, 180)) return true;
  }

  goToXY(centerX, centerY, false);
  return verifySquareState(targetIndex, true, 180);
}

bool enqueueLedCommand(JsonObject command) {
  String commandJson;
  serializeJson(command, commandJson);
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(5)) != pdTRUE) return false;
  if (pendingLedCommandCount >= LED_COMMAND_QUEUE_CAPACITY) {
    xSemaphoreGive(sharedMutex);
    Serial.println("[LED] command queue full; command dropped.");
    return false;
  }
  pendingLedCommands[pendingLedCommandTail] = commandJson;
  pendingLedCommandTail = (pendingLedCommandTail + 1) % LED_COMMAND_QUEUE_CAPACITY;
  pendingLedCommandCount++;
  xSemaphoreGive(sharedMutex);
  return true;
}

void serviceLedCommandQueue() {
  String commandJson;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(2)) == pdTRUE) {
    if (pendingLedCommandCount > 0) {
      commandJson = pendingLedCommands[pendingLedCommandHead];
      pendingLedCommands[pendingLedCommandHead] = "";
      pendingLedCommandHead = (pendingLedCommandHead + 1) % LED_COMMAND_QUEUE_CAPACITY;
      pendingLedCommandCount--;
    }
    xSemaphoreGive(sharedMutex);
  }
  if (commandJson.length() == 0) return;
  DynamicJsonDocument doc(12288);
  if (deserializeJson(doc, commandJson)) {
    Serial.println("[LED] queued command parse failed.");
    return;
  }
  applyLedCommand(doc.as<JsonObject>());
}

int promotionMatrixPixelToStrip(int row, int column) {
  if (row < 0 || row >= 16 || column < 0 || column >= 16) return -1;
  const int fileIndex = row / 2;  // A through H.
  const int rank = column / 2 + 1;
  const int rawGroup = 7 - fileIndex;  // H is raw group zero.
  const int rankOffset = (rawGroup % 2 == 0) ? (8 - rank) : (rank - 1);
  const int rawSquare = rawGroup * 8 + rankOffset;
  const int localRow = row % 2;
  const int localColumn = column % 2;
  const int localPosition = localRow * 2 + localColumn;  // TL, TR, BL, BR.
  static const uint8_t offsetsByFile[8][4] = {
    {1, 2, 0, 3},  // A
    {2, 1, 3, 0},  // B
    {0, 3, 1, 2},  // C
    {2, 1, 3, 0},  // D
    {1, 2, 0, 3},  // E
    {2, 1, 3, 0},  // F
    {1, 2, 0, 3},  // G
    {3, 0, 2, 1}   // H
  };
  return rawSquare * 4 + offsetsByFile[fileIndex][localPosition];
}

const uint8_t* promotionGlyph(char piece) {
  static const uint8_t queen[9] = {0x3E, 0x41, 0x41, 0x41, 0x41, 0x49, 0x45, 0x3E, 0x03};
  static const uint8_t rook[9] = {0x7E, 0x41, 0x41, 0x41, 0x7E, 0x48, 0x44, 0x42, 0x41};
  static const uint8_t bishop[9] = {0x7E, 0x41, 0x41, 0x41, 0x7E, 0x41, 0x41, 0x41, 0x7E};
  static const uint8_t knight[9] = {0x41, 0x61, 0x61, 0x51, 0x49, 0x45, 0x43, 0x43, 0x41};
  static const uint8_t pawn[9] = {0x7E, 0x41, 0x41, 0x41, 0x7E, 0x40, 0x40, 0x40, 0x40};
  switch (piece) {
    case 'q': return queen;
    case 'r': return rook;
    case 'b': return bishop;
    case 'n': return knight;
    case 'p': return pawn;
    default: return nullptr;
  }
}

void drawPromotionGlyph(char piece) {
  const uint8_t* glyph = promotionGlyph(piece);
  strip.clear();
  if (!glyph) {
    strip.show();
    return;
  }
  constexpr int top = 3;
  constexpr int left = 4;
  const uint32_t color = strip.Color(180, 80, 255);
  for (int row = 0; row < 9; row++) {
    for (int column = 0; column < 7; column++) {
      if ((glyph[row] & (1U << (6 - column))) == 0) continue;
      const int pixel = promotionMatrixPixelToStrip(top + row, left + column);
      if (pixel >= 0) strip.setPixelColor(pixel, color);
    }
  }
  if (promotionLedDisplay.targetIndex >= 0 && promotionLedDisplay.targetIndex < 64) {
    setSquareColor(promotionLedDisplay.targetIndex, 255, 180, 40);
  }
  strip.show();
}

void applyPromotionLedCommand(JsonObject command) {
  // Promotion instructions must take priority over a running game-over animation.
  activeLedAnimation = LED_ANIM_NONE;
  ledAnimationKingA = -1;
  ledAnimationKingB = -1;

  const char* state = command["state"] | "clear";
  const char* transactionId = command["transactionId"] | "";
  const char* pieceText = command["piece"] | "";
  const char piece = pieceText[0] ? static_cast<char>(tolower(pieceText[0])) : 0;

  if (strcmp(state, "clear") == 0) {
    promotionLedDisplay = PromotionLedDisplay{};
    strip.clear();
    strip.show();
    markSnapshotDirty();
    return;
  }

  promotionLedDisplay.active = true;
  promotionLedDisplay.transactionId = transactionId;
  promotionLedDisplay.state = state;
  promotionLedDisplay.targetIndex = command["targetIndex"] | -1;
  promotionLedDisplay.intervalMs = command["intervalMs"] | 2500;
  promotionLedDisplay.lastChangeMs = millis();
  promotionLedDisplay.choiceIndex = 0;
  promotionLedDisplay.lockedPiece = piece;
  if (strcmp(state, "cycle") == 0) {
    promotionLedDisplay.displayedPiece = 'q';
  } else if (strcmp(state, "pawn") == 0) {
    promotionLedDisplay.displayedPiece = 'p';
  } else if (piece) {
    promotionLedDisplay.displayedPiece = piece;
  } else {
    promotionLedDisplay.displayedPiece = 'p';
  }
  drawPromotionGlyph(promotionLedDisplay.displayedPiece);
  markSnapshotDirty();
}

void servicePromotionLedDisplay(uint32_t now) {
  if (!promotionLedDisplay.active || promotionLedDisplay.state != "cycle") return;
  if (now - promotionLedDisplay.lastChangeMs < promotionLedDisplay.intervalMs) return;
  static const char choices[4] = {'q', 'r', 'b', 'n'};
  promotionLedDisplay.choiceIndex = (promotionLedDisplay.choiceIndex + 1) % 4;
  promotionLedDisplay.displayedPiece = choices[promotionLedDisplay.choiceIndex];
  promotionLedDisplay.lastChangeMs = now;
  drawPromotionGlyph(promotionLedDisplay.displayedPiece);
  markSnapshotDirty();
}

void applyLedCommand(JsonObject command) {
  const char* mode = command["mode"] | "";
  if (strcmp(mode, "promotion-display") == 0) {
    applyPromotionLedCommand(command);
    return;
  }
  if (promotionLedDisplay.active) {
    promotionLedDisplay = PromotionLedDisplay{};
    markSnapshotDirty();
  }
  activeLedAnimation = LED_ANIM_NONE;
  ledAnimationKingA = -1;
  ledAnimationKingB = -1;

  if (strcmp(mode, "human-move-confirm") == 0) {
    applyHumanMoveConfirm(command);
    return;
  }

  if (strcmp(mode, "led-runway") == 0) {
    JsonArray segments = command["segments"].as<JsonArray>();
    if (!segments.isNull()) {
      for (JsonObject segment : segments) {
        runLedRunway(segment);
      }
    } else {
      runLedRunway(command);
    }
    return;
  }

  if (strcmp(mode, "overlay") != 0) {
    strip.clear();
  }

  JsonArray squares = command["squares"].as<JsonArray>();
  int squareOrdinal = 0;
  for (JsonObject square : squares) {
    const int index = square["index"] | -1;
    if (index < 0 || index >= 64) continue;

    if (squareOrdinal == 0) ledAnimationKingA = index;
    if (squareOrdinal == 1) ledAnimationKingB = index;
    squareOrdinal++;

    JsonObject color = square["color"];
    const uint8_t r = color["r"] | 0;
    const uint8_t g = color["g"] | 0;
    const uint8_t b = color["b"] | 0;
    setSquareColor(index, r, g, b);
  }

  if (strcmp(mode, "celebrate-checkmate") == 0) {
    activeLedAnimation = LED_ANIM_CHECKMATE;
    lastLedAnimationMs = 0;
    updateLedAnimation();
    return;
  }

  if (strcmp(mode, "celebrate-stalemate") == 0) {
    activeLedAnimation = LED_ANIM_STALEMATE;
    lastLedAnimationMs = 0;
    updateLedAnimation();
    return;
  }

  if (strcmp(mode, "celebrate-draw") == 0) {
    activeLedAnimation = LED_ANIM_DRAW;
    lastLedAnimationMs = 0;
    updateLedAnimation();
    return;
  }

  strip.show();
}

void setSquareColor(int squareNumber, uint8_t r, uint8_t g, uint8_t b) {
  const int startingLED = squareNumber * 4;
  for (int i = 0; i < 4; i++) {
    strip.setPixelColor(startingLED + i, strip.Color(r, g, b));
  }
}

void clearBoardLeds() {
  strip.clear();
  strip.show();
}

void setNeighborSquaresColor(int centerIndex, uint8_t r, uint8_t g, uint8_t b) {
  if (centerIndex < 0 || centerIndex >= 64) return;

  const long centerY = squareCoordinates[centerIndex][0];
  const long centerX = squareCoordinates[centerIndex][1];
  for (int index = 0; index < 64; index++) {
    if (index == centerIndex) continue;

    const long dy = labs(squareCoordinates[index][0] - centerY);
    const long dx = labs(squareCoordinates[index][1] - centerX);
    if (dx <= HALO_NEIGHBOR_MAX_DELTA && dy <= HALO_NEIGHBOR_MAX_DELTA) {
      setSquareColor(index, r, g, b);
    }
  }
}

void applyHumanMoveConfirm(JsonObject command) {
  const int targetIndex = command["targetIndex"] | -1;
  const int flashes = command["flashes"] | 2;
  if (targetIndex < 0 || targetIndex >= 64) {
    clearBoardLeds();
    return;
  }

  for (int i = 0; i < flashes; i++) {
    strip.clear();
    setSquareColor(targetIndex, 80, 255, 120);
    strip.show();
    delay(110);
    strip.clear();
    strip.show();
    delay(90);
  }
}

void applyCaptureStart(JsonObject step) {
  strip.clear();

  JsonObject attacker = step["attacker"];
  const int attackerIndex = attacker["index"] | -1;
  if (attackerIndex >= 0 && attackerIndex < 64) {
    setSquareColor(attackerIndex, 80, 130, 255);
  }

  JsonObject captured = step["captured"];
  const int capturedIndex = captured["index"] | -1;
  if (capturedIndex >= 0 && capturedIndex < 64) {
    setSquareColor(capturedIndex, 255, 40, 40);
  }

  strip.show();
  const int holdMs = step["holdMs"] | 1000;
  delay(holdMs);
}

void runLedRunway(JsonObject step) {
  JsonArray squares = step["squares"].as<JsonArray>();
  if (squares.isNull() || squares.size() == 0) return;

  JsonObject color = step["color"];
  const uint8_t r = color["r"] | 80;
  const uint8_t g = color["g"] | 220;
  const uint8_t b = color["b"] | 120;
  const int stepDelayMs = step["stepDelayMs"] | 250;
  const int holdMs = step["holdMs"] | 500;
  const bool clearWhenDone = step["clearWhenDone"] | false;

  strip.clear();
  strip.show();

  for (JsonObject square : squares) {
    const int index = square["index"] | -1;
    if (index < 0 || index >= 64) continue;
    setSquareColor(index, r, g, b);
    strip.show();
    delay(stepDelayMs);
  }

  delay(holdMs);
  if (clearWhenDone) {
    clearBoardLeds();
  }
}

uint32_t colorWheel(byte position) {
  position = 255 - position;
  if (position < 85) {
    return strip.Color(255 - position * 3, 0, position * 3);
  }
  if (position < 170) {
    position -= 85;
    return strip.Color(0, position * 3, 255 - position * 3);
  }
  position -= 170;
  return strip.Color(position * 3, 255 - position * 3, 0);
}

void updateLedAnimation() {
  if (activeLedAnimation == LED_ANIM_NONE) return;

  const uint32_t now = millis();
  if (now - lastLedAnimationMs < 55) return;
  lastLedAnimationMs = now;

  const uint8_t frame = (now / 55) % 255;
  for (int square = 0; square < 64; square++) {
    uint32_t color;
    if (activeLedAnimation == LED_ANIM_CHECKMATE) {
      color = colorWheel((frame * 4 + square * 7) & 255);
    } else if (activeLedAnimation == LED_ANIM_STALEMATE) {
      const bool alternate = ((square + frame / 8) % 2) == 0;
      color = alternate ? strip.Color(150, 80, 255) : strip.Color(255, 180, 40);
    } else {
      const uint8_t pulse = 60 + ((frame % 80) * 2);
      color = strip.Color(pulse, 40, 180);
    }

    const int startingLED = square * 4;
    for (int pixel = 0; pixel < 4; pixel++) {
      strip.setPixelColor(startingLED + pixel, color);
    }
  }

  const bool flashOn = ((now / 220) % 2) == 0;
  if (activeLedAnimation == LED_ANIM_CHECKMATE) {
    if (ledAnimationKingA >= 0) {
      setNeighborSquaresColor(ledAnimationKingA, 120, 0, 0);
    }
    if (ledAnimationKingB >= 0) {
      setNeighborSquaresColor(ledAnimationKingB, 0, 80, 140);
    }
    if (ledAnimationKingA >= 0) {
      setSquareColor(ledAnimationKingA, flashOn ? 255 : 0, 0, 0);
    }
    if (ledAnimationKingB >= 0) {
      setSquareColor(ledAnimationKingB, 0, flashOn ? 255 : 0, flashOn ? 120 : 0);
    }
  } else {
    if (ledAnimationKingA >= 0) {
      setNeighborSquaresColor(ledAnimationKingA, 130, 80, 0);
    }
    if (ledAnimationKingB >= 0) {
      setNeighborSquaresColor(ledAnimationKingB, 95, 40, 145);
    }
    if (ledAnimationKingA >= 0) {
      setSquareColor(ledAnimationKingA, flashOn ? 255 : 0, flashOn ? 210 : 0, 0);
    }
    if (ledAnimationKingB >= 0) {
      setSquareColor(ledAnimationKingB, flashOn ? 170 : 0, flashOn ? 60 : 0, flashOn ? 255 : 0);
    }
  }

  strip.show();
}
