#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <AccelStepper.h>
#include <Adafruit_NeoPixel.h>
#include <math.h>

#include "offline_embedded_diagnostics.h"
#include "offline_ownership_diagnostics.h"
#include "offline_runtime_diagnostics.h"

#if __has_include("firmware_secrets.h")
#include "firmware_secrets.h"
#else
#include "firmware_secrets.example.h"
#endif

const char* WIFI_SSID = CHESS_WIFI_SSID;
const char* WIFI_PASSWORD = CHESS_WIFI_PASSWORD;
const char* SERVER_BASE_URL = CHESS_SERVER_BASE_URL;

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
constexpr uint32_t WIFI_RETRY_INTERVAL_MS = 3000;

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
void setSquareColor(int squareNumber, uint8_t r, uint8_t g, uint8_t b);
void updateLedAnimation();
uint32_t colorWheel(byte position);
void clearBoardLeds();
void setNeighborSquaresColor(int centerIndex, uint8_t r, uint8_t g, uint8_t b);
void applyHumanMoveConfirm(JsonObject command);
void applyCaptureStart(JsonObject step);
void runLedRunway(JsonObject step);
bool enqueueMotionCommand(const String& commandJson);

#if ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS
bool offlineRuntimeMagnetIsLow() {
  return digitalRead(MAGNET_PIN) == LOW;
}
#endif

void setup() {
  pinMode(MAGNET_PIN, OUTPUT);
  digitalWrite(MAGNET_PIN, LOW);

  Serial.begin(115200);
  delay(200);

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

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  beginOfflineRuntimeDiagnostics();
  beginOfflineOwnershipDiagnostics();
  xTaskCreatePinnedToCore(networkTask, "networkTask", 12288, nullptr, 1, nullptr, 0);

  Serial.println("[BOOT] Physical board firmware started.");
  beginOfflineEmbeddedDiagnostics();
}

void loop() {
  if (offlineEmbeddedDiagnosticsActive() || offlineOwnershipDiagnosticsActive() ||
      offlineRuntimeDiagnosticsActive()) {
    digitalWrite(MAGNET_PIN, LOW);
  }

  scanSensors();
#if ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS
  publishOfflineRuntimeStableSnapshot(stableOccupancy, millis());
#endif
#if ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS || ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || \
    ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS
  updateOfflineOwnershipDiagnosticLeds(millis());
#else
  updateLedAnimation();
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
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }

#if ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS || ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || \
    ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS
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

#if ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS
  static uint32_t previousRuntimeScanMs = 0;
  const uint32_t runtimeScanStartedMs = millis();
  if (previousRuntimeScanMs != 0) {
    const uint32_t gap = runtimeScanStartedMs - previousRuntimeScanMs;
    if (gap > offlineRuntimeSensorMaxGapMs) {
      offlineRuntimeSensorMaxGapMs = gap;
    }
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
      applyLedCommand(command);
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
      applyLedCommand(command);
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

void applyLedCommand(JsonObject command) {
  const char* mode = command["mode"] | "";
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
