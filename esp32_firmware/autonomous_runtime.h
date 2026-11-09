#pragma once
#include "autonomous_guard.h"

char autonomousRunId[40] = "";
AutonomousLiftGuard autonomousGuard;
bool& autonomousRestoring = autonomousGuard.restoring;
bool& autonomousTakeover = autonomousGuard.takeover;
bool& autonomousInterference = autonomousGuard.interference;
bool (&autonomousProtected)[64] = autonomousGuard.protectedSquares;
bool (&autonomousExpected)[64] = autonomousGuard.expected;
uint32_t lastSuccessfulPollMs = 0;
bool homingFault = false;
String autonomousCompletedIds[16];
uint8_t autonomousCompletedCursor = 0;
uint32_t autonomousAcceptedRevision = 0;

// Called while holding sharedMutex, before making a command visible to loop().
bool acceptAutonomousCommand(JsonObject command) {
  JsonObject context = command["autonomous"].as<JsonObject>();
  if (context.isNull()) {
    if (strcmp(command["type"] | "", "home") == 0) {
      autonomousRunId[0] = 0;
      autonomousRestoring = autonomousTakeover = autonomousInterference = false;
      autonomousAcceptedRevision = 0;
    }
    return true;
  }
  const char* run = context["runId"] | "";
  const bool home = strcmp(command["type"] | "", "home") == 0;
  if (!run[0]) return false;
  if (strcmp(run, autonomousRunId) != 0) {
    if (!home) return false;
    strlcpy(autonomousRunId, run, sizeof(autonomousRunId));
    autonomousTakeover = autonomousInterference = false;
    autonomousAcceptedRevision = 0;
  }
  const bool reconcile = strcmp(command["type"] | "", "autonomous-reconcile") == 0;
  if ((autonomousTakeover || autonomousInterference) && !home && !reconcile) return false;
  const uint32_t revision = context["revision"] | 0;
  if (revision <= autonomousAcceptedRevision) return false;
  autonomousAcceptedRevision = revision;
  if(reconcile) return true; // Baseline changes only after execution validates the correction.
  autonomousRestoring = context["restoring"] | false;
  memset(autonomousProtected, 0, sizeof(autonomousProtected));
  for (JsonVariant index : context["protectedSquares"].as<JsonArray>()) {
    const int i = index.as<int>();
    if (i >= 0 && i < 64) autonomousProtected[i] = true;
  }
  JsonArray expected = context["expectedOccupancy"].as<JsonArray>();
  for (int i = 0; i < 64; i++) autonomousExpected[i] = expected.size() == 64 ? expected[i].as<bool>() : stableOccupancy[i];
  return true;
}

void detectAutonomousLift() {
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(1)) != pdTRUE) return;
  autonomousGuard.observe(stableOccupancy);
  xSemaphoreGive(sharedMutex);
}
