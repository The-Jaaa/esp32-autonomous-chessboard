constexpr std::uint32_t kUnifiedTurnSettleMs = 500;
constexpr std::uint32_t kUnifiedTurnSettleTimeoutMs = 10000;
constexpr std::uint32_t kUnifiedPromotionTimeoutMs = 180000;
constexpr std::size_t kUnifiedTargetTurns = 3;

struct UnifiedTurnDiagnosticResult {
  bool homeSucceeded = false;
  bool programsCompiled = true;
  bool primitiveOrderValid = true;
  bool finalOccupancyMatched = false;
  bool allTurnBoundariesOpened = false;
  bool retryExhausted = false;
  bool recoveryRequired = false;
  bool humanPromotionRejectedClearly = false;
  bool motorActivity = false;
  bool magnetEverHigh = false;
  bool magnetLow = true;
  std::size_t humanMoveCount = 1;
  std::size_t opponentMoveCount = 0;
  std::size_t turnBoundaryCount = 0;
  std::size_t verifiedPhaseCount = 0;
  std::size_t retryCount = 0;
  std::size_t graveyardTransitionCount = 0;
  std::size_t promotionCount = 0;
  std::size_t searchCount = 1;
  std::uint32_t searchSensorScans = 0;
  std::uint32_t searchHeartbeatAttempts = 0;
  std::uint32_t maximumSearchElapsedMs = 0;
  std::string committedFen;
  std::string actualOccupancy;
  std::string expectedOccupancy;
  String error;
};

const char* promotionPieceName(char piece) {
  switch (piece) {
    case 'q': return "queen";
    case 'r': return "rook";
    case 'b': return "bishop";
    case 'n': return "knight";
  }
  return "unknown";
}

void emitUnifiedTurnReady(
    const offline::OfflineReadOnlyRuntime& runtime,
    std::size_t turnNumber) {
  DynamicJsonDocument document(4096);
  document["type"] = "turn-ready";
  document["turn"] = turnNumber;
  document["color"] = "white";
  document["fen"] = runtime.coordinator().physical().game().fen().c_str();
  addStrings(
      document.createNestedArray("legalMoves"),
      runtime.coordinator().physical().game().legalMovesUci());
  document["message"] = turnNumber == 1
      ? "Play g1f3 for the first acceptance move."
      : "Play one legal quiet White move after the robot is fully settled.";
  emitDocument(document);
}

void emitUnifiedCompilerResult(const offline::UnifiedMotionProgram& compiled) {
  DynamicJsonDocument document(1024);
  document["type"] = "compiler";
  document["status"] = offline::unifiedMotionCompileStatusName(compiled.status);
  document["compiler"] = offline::unifiedMotionCompilerKindName(compiled.compiler);
  document["sourceStatus"] = compiled.sourceStatus.c_str();
  document["message"] = compiled.blockedReason.c_str();
  document["move"] = compiled.program.moveUci.c_str();
  document["phaseKind"] = offline::motionPhaseKindName(compiled.program.phaseKind);
  document["routeMode"] = offline::externalRouteModeName(compiled.program.routeMode);
  document["routeCost"] = compiled.program.routeCost;
  document["transactionId"] = compiled.program.token.transactionId;
  document["phaseIndex"] = compiled.program.token.phaseIndex;
  document["attempt"] = compiled.program.token.attempt;
  emitDocument(document);
}

bool validateUnifiedPrimitiveOrder(
    const offline::CaptureMotionProgram& program) {
  if (!program.success() || program.primitives.size() < 5 ||
      program.primitives.front().kind !=
          offline::CaptureMotionPrimitiveKind::TravelBoard ||
      program.primitives[1].kind !=
          offline::CaptureMotionPrimitiveKind::Pickup ||
      program.primitives[program.primitives.size() - 2].kind !=
          offline::CaptureMotionPrimitiveKind::Drop ||
      program.primitives.back().kind !=
          offline::CaptureMotionPrimitiveKind::Verify) {
    return false;
  }

  std::size_t coordinateDrags = 0;
  std::size_t boardOvershoots = 0;
  for (std::size_t index = 2; index + 2 < program.primitives.size(); ++index) {
    const auto& primitive = program.primitives[index];
    if (primitive.kind == offline::CaptureMotionPrimitiveKind::DragCoordinate) {
      coordinateDrags++;
      if (primitive.finalBoardDrop) return false;
    } else if (primitive.kind == offline::CaptureMotionPrimitiveKind::DragBoard) {
      if (primitive.finalBoardDrop) boardOvershoots++;
    } else {
      return false;
    }
  }

  if (program.phaseKind == offline::MotionPhaseKind::CapturedRemoval) {
    return coordinateDrags >= 1 && boardOvershoots == 0;
  }
  return boardOvershoots == 1 &&
         program.primitives[program.primitives.size() - 3].finalBoardDrop;
}

bool ownershipStillAllowsUnified(String& error) {
  OfflineOwnershipDiagnosticSnapshot ownership;
  if (!copyOfflineOwnershipDiagnosticSnapshot(ownership) || !ownership.valid) {
    return true;
  }
  if (ownership.handoffRequired ||
      ownership.state == offline::OwnershipState::ReconnectPending) {
    error = "Server handoff became pending during the unified diagnostic.";
    return false;
  }
  if (ownership.state == offline::OwnershipState::RecoveryRequired ||
      !ownership.allowOfflineControl) {
    error = "Offline ownership was lost during the unified diagnostic.";
    return false;
  }
  return true;
}

bool latestSnapshot(
    offline::Occupancy& occupancy,
    std::uint32_t& revision,
    String& error) {
  std::uint32_t changedAtMs = 0;
  if (!copySnapshot(occupancy, revision, changedAtMs)) {
    error = "No stable sensor snapshot is available.";
    return false;
  }
  (void)changedAtMs;
  return true;
}

bool waitForUnifiedTurnBoundary(
    const offline::Occupancy& expected,
    std::uint32_t& consumedRevision,
    offline::Occupancy& actual,
    String& error) {
  const std::uint32_t startedAt = millis();
  std::uint32_t exactSince = 0;
  while (millis() - startedAt < kUnifiedTurnSettleTimeoutMs) {
    std::uint32_t revision = 0;
    std::uint32_t changedAtMs = 0;
    if (copySnapshot(actual, revision, changedAtMs)) {
      consumedRevision = revision;
      if (actual == expected) {
        if (exactSince == 0) exactSince = millis();
        if (millis() - exactSince >= kUnifiedTurnSettleMs) return true;
      } else {
        exactSince = 0;
      }
    }
    if (!ownershipStillAllowsUnified(error)) return false;
    vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
  }
  error = "The committed board did not remain exact for 500 ms.";
  return false;
}

bool handleUnifiedPromotion(
    offline::OfflineReadOnlyRuntime& runtime,
    offline::OfflinePhaseExecutionAdapter& adapter,
    UnifiedTurnDiagnosticResult& diagnostic,
    std::uint32_t& consumedRevision) {
  const auto state = runtime.coordinator().currentState();
  if (!state.opponentPlan || state.opponentPlan->move.promotion.size() != 1) {
    diagnostic.error = "Promotion pending without valid move metadata.";
    return false;
  }
  const offline::MoveInfo& move = state.opponentPlan->move;
  const char piece = move.promotion.front();
  const offline::Occupancy expected = state.opponentPlan->expectedOccupancy;
  const bool white = move.from.size() == 2 && move.from[1] == '7';

  offline::OfflinePromotionReplacementGate replacement;
  auto replacementUpdate = replacement.arm(move.to, piece, expected);
  if (replacementUpdate.state == offline::PromotionReplacementState::Error) {
    diagnostic.error = replacementUpdate.message.c_str();
    return false;
  }

  DynamicJsonDocument prompt(768);
  prompt["type"] = "promotion-required";
  prompt["color"] = white ? "white" : "black";
  prompt["piece"] = promotionPieceName(piece);
  prompt["promotion"] = String(piece);
  prompt["square"] = move.to.c_str();
  String message = "Replace the ";
  message += white ? "White" : "Black";
  message += " pawn on ";
  message += move.to.c_str();
  message += " with a ";
  message += white ? "White " : "Black ";
  message += promotionPieceName(piece);
  message += ".";
  prompt["message"] = message;
  emitDocument(prompt);

  const std::uint32_t startedAt = millis();
  while (millis() - startedAt < kUnifiedPromotionTimeoutMs) {
    offline::Occupancy occupancy;
    std::uint32_t revision = 0;
    std::uint32_t changedAtMs = 0;
    if (!copySnapshot(occupancy, revision, changedAtMs) ||
        revision == consumedRevision) {
      vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
      continue;
    }
    (void)changedAtMs;
    consumedRevision = revision;
    replacementUpdate = replacement.processSnapshot(occupancy);

    DynamicJsonDocument event(1536);
    event["type"] = "promotion-replacement";
    event["state"] = offline::promotionReplacementStateName(replacementUpdate.state);
    event["event"] = offline::promotionReplacementEventName(replacementUpdate.event);
    event["square"] = move.to.c_str();
    event["piece"] = promotionPieceName(piece);
    event["promotion"] = String(piece);
    event["occupancy"] = occupancyHex(occupancy).c_str();
    event["message"] = replacementUpdate.message.c_str();
    emitDocument(event);

    if (replacementUpdate.event != offline::PromotionReplacementEvent::None ||
        adapter.state() == offline::OfflinePhaseExecutionState::RecoveryRequired) {
      const auto update = adapter.processPromotionSnapshot(occupancy);
      emitExecutionUpdate(update);
    }
    if (replacement.state() == offline::PromotionReplacementState::ReadyToConfirm &&
        adapter.state() == offline::OfflinePhaseExecutionState::PromotionPending) {
      replacement.confirm(piece, occupancy);
      const auto update = adapter.confirmPromotion(piece, occupancy);
      emitExecutionUpdate(update);
      if (adapter.state() == offline::OfflinePhaseExecutionState::Complete ||
          adapter.state() == offline::OfflinePhaseExecutionState::GameOver) {
        diagnostic.promotionCount++;
        return true;
      }
    }
    if (!ownershipStillAllowsUnified(diagnostic.error)) return false;
    vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
  }
  diagnostic.error = "Promotion replacement timed out after 180 seconds.";
  return false;
}

bool executeUnifiedOpponentTurn(
    offline::OfflineReadOnlyRuntime& runtime,
    offline::OfflinePhaseExecutionAdapter& adapter,
    UnifiedTurnDiagnosticResult& diagnostic,
    std::uint32_t& consumedRevision) {
  auto update = adapter.begin();
  emitExecutionUpdate(update);
  if (update.state != offline::OfflinePhaseExecutionState::PhaseReady ||
      !update.request) {
    diagnostic.error = "The unified adapter did not issue its first phase.";
    return false;
  }

  std::uint32_t hardwareRequestId =
      100 + static_cast<std::uint32_t>(diagnostic.opponentMoveCount * 32);
  for (std::size_t guard = 0; guard < 32; ++guard) {
    if ((adapter.state() == offline::OfflinePhaseExecutionState::PhaseReady ||
         adapter.state() == offline::OfflinePhaseExecutionState::RetryReady) &&
        adapter.currentRequest()) {
      const auto request = *adapter.currentRequest();
      const auto compiled = offline::OfflineUnifiedMotionCompiler{}.compile(request);
      emitUnifiedCompilerResult(compiled);
      emitCaptureProgram(compiled.program, "unified-program");
      const bool orderValid = validateUnifiedPrimitiveOrder(compiled.program);
      diagnostic.programsCompiled = diagnostic.programsCompiled && compiled.success();
      diagnostic.primitiveOrderValid =
          diagnostic.primitiveOrderValid && orderValid;
      if (!compiled.success() || !orderValid) {
        diagnostic.error = compiled.blockedReason.c_str();
        return false;
      }
      if (!offline::unifiedMotionAttemptAllowed(request.token)) {
        diagnostic.retryExhausted = true;
        diagnostic.error = "The unified phase retry limit was exhausted.";
        return false;
      }

      offline::Occupancy beforeMotion;
      std::uint32_t beforeRevision = 0;
      if (!latestSnapshot(beforeMotion, beforeRevision, diagnostic.error) ||
          beforeMotion != request.phase.expectedBefore) {
        diagnostic.recoveryRequired = true;
        diagnostic.actualOccupancy = occupancyHex(beforeMotion);
        diagnostic.expectedOccupancy = occupancyHex(request.phase.expectedBefore);
        if (diagnostic.error.length() == 0) {
          diagnostic.error = "Sensor occupancy changed before the phase pickup.";
        }
        return false;
      }
      consumedRevision = beforeRevision;

      update = adapter.takeCurrentRequest();
      emitExecutionUpdate(update);
      if (update.state != offline::OfflinePhaseExecutionState::AwaitingReport) {
        diagnostic.error = "The adapter did not accept the unified hardware request.";
        return false;
      }

      const std::uint32_t requestId = hardwareRequestId++;
      if (!queueOfflineCaptureProgram(requestId, compiled.program)) {
        diagnostic.error = "Could not queue the unified hardware program.";
        return false;
      }
      OfflineCaptureHardwareResult hardware;
      if (!waitForCaptureHardwareResult(requestId, 120000, hardware)) {
        abortOfflineCaptureMotionHardware();
        diagnostic.error = "Unified hardware execution timed out after 120 seconds.";
        return false;
      }
      emitCaptureHardwareResult(hardware, "unified-phase");
      diagnostic.motorActivity = diagnostic.motorActivity || hardware.motorActivity;
      diagnostic.magnetEverHigh =
          diagnostic.magnetEverHigh || hardware.magnetEverHigh;
      diagnostic.magnetLow = hardware.magnetLow;
      diagnostic.actualOccupancy = occupancyHex(hardware.observedOccupancy);
      diagnostic.expectedOccupancy = occupancyHex(compiled.program.expectedAfter);

      const offline::OfflinePhaseExecutionReport report{
          request.token, hardware.success, hardware.observedOccupancy};
      emitPhaseReport(report, hardware.success ? "real-success" : "real-failure");
      update = adapter.submitReport(report);
      emitExecutionUpdate(update);

      if (hardware.success &&
          hardware.observedOccupancy == request.phase.expectedAfter) {
        diagnostic.verifiedPhaseCount++;
        if (request.phase.kind == offline::MotionPhaseKind::CapturedRemoval) {
          const auto transaction = runtime.coordinator().pendingMotionTransaction();
          if (transaction &&
              transaction->graveyardState == offline::GraveyardSlotState::Occupied) {
            diagnostic.graveyardTransitionCount++;
          }
        }
      } else if (!hardware.success &&
                 hardware.observedOccupancy == request.phase.expectedBefore &&
                 request.token.attempt == 1 &&
                 update.state == offline::OfflinePhaseExecutionState::RetryReady) {
        diagnostic.retryCount++;
        continue;
      } else {
        diagnostic.recoveryRequired = true;
        if (hardware.error.length() > 0) diagnostic.error = hardware.error;
        if (diagnostic.error.length() == 0) {
          diagnostic.error = "Unified phase occupancy did not match its checkpoint.";
        }
        return false;
      }
      continue;
    }

    if (adapter.state() == offline::OfflinePhaseExecutionState::PromotionPending) {
      return handleUnifiedPromotion(
          runtime, adapter, diagnostic, consumedRevision);
    }
    if (adapter.state() == offline::OfflinePhaseExecutionState::Complete ||
        adapter.state() == offline::OfflinePhaseExecutionState::GameOver) {
      return true;
    }
    diagnostic.recoveryRequired =
        adapter.state() == offline::OfflinePhaseExecutionState::RecoveryRequired;
    diagnostic.error = "Unified phase execution stopped in an unsupported state.";
    return false;
  }
  diagnostic.error = "Unified phase execution exceeded its guard limit.";
  return false;
}

bool waitForUnifiedPlan(
    offline::OfflineReadOnlyRuntime& runtime,
    offline::OfflineEngine& engine,
    UnifiedTurnDiagnosticResult& diagnostic,
    std::uint32_t& consumedRevision) {
  emitUnifiedTurnReady(runtime, diagnostic.humanMoveCount + 1);
  for (;;) {
    offline::Occupancy occupancy;
    std::uint32_t revision = 0;
    std::uint32_t changedAtMs = 0;
    OfflineOwnershipDiagnosticSnapshot ownership;
    if (!copySnapshot(occupancy, revision, changedAtMs) ||
        !copyOfflineOwnershipDiagnosticSnapshot(ownership)) {
      vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
      continue;
    }
    (void)changedAtMs;

    auto update = runtime.applyOwnershipDecision(
        millis(), ownershipDecision(ownership), occupancy);
    emitRuntimeUpdate(update, millis());
    if (update.phase == offline::OfflineRuntimePhase::HandoffPending ||
        update.phase == offline::OfflineRuntimePhase::Error) {
      diagnostic.error = update.message.c_str();
      return false;
    }

    if (revision != consumedRevision) {
      consumedRevision = revision;
      update = runtime.processStableSnapshot(millis(), occupancy);
      emitRuntimeUpdate(update, millis());
      if (update.event == offline::OfflineRuntimeEvent::HumanMoveAccepted) {
        diagnostic.humanMoveCount++;
      }
      if (update.phase == offline::OfflineRuntimePhase::Error) {
        diagnostic.humanPromotionRejectedClearly =
            update.coordinatorResult &&
            update.coordinatorResult->phase ==
                offline::OfflineTurnPhase::HumanPromotionPending;
        if (diagnostic.humanPromotionRejectedClearly) {
          StaticJsonDocument<512> warning;
          warning["type"] = "human-promotion-unsupported";
          warning["message"] =
              "Human promotion selection is not enabled in this diagnostic; restore the pre-move board.";
          emitDocument(warning);
        }
        diagnostic.error = update.message.c_str();
        return false;
      }
      if (update.phase == offline::OfflineRuntimePhase::SyncWarning) {
        diagnostic.recoveryRequired = true;
        diagnostic.error = update.message.c_str();
        return false;
      }
    }

    const auto request = runtime.pendingEngineRequest();
    if (request) {
      const std::uint32_t scansBefore = offlineRuntimeSensorScanCount;
      const std::uint32_t heartbeatsBefore = ownershipDiagnosticHeartbeatAttempts;
      offlineRuntimeSensorMaxGapMs = 0;
      const auto result = engine.searchFen(request->fen, request->limits);
      const std::uint32_t scans = offlineRuntimeSensorScanCount - scansBefore;
      const std::uint32_t heartbeats =
          ownershipDiagnosticHeartbeatAttempts - heartbeatsBefore;
      diagnostic.searchCount++;
      diagnostic.searchSensorScans += scans;
      diagnostic.searchHeartbeatAttempts += heartbeats;
      diagnostic.maximumSearchElapsedMs =
          std::max(diagnostic.maximumSearchElapsedMs, result.elapsedMs);
      emitSearch(*request, result, scans, heartbeats);

      std::uint32_t latestRevision = revision;
      std::uint32_t latestChangedAtMs = 0;
      if (copySnapshot(occupancy, latestRevision, latestChangedAtMs)) {
        consumedRevision = latestRevision;
      }
      update = runtime.submitEngineResult(request->generation, result, occupancy);
      emitRuntimeUpdate(update, millis());
      if (update.phase != offline::OfflineRuntimePhase::PlanReady) {
        diagnostic.recoveryRequired =
            update.phase == offline::OfflineRuntimePhase::SyncWarning;
        diagnostic.error = update.message.c_str();
        return false;
      }
      emitMotionPlan(runtime);
      return true;
    }
    vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
  }
}

UnifiedTurnDiagnosticResult runUnifiedThreeTurns(
    offline::OfflineReadOnlyRuntime& runtime,
    offline::OfflineEngine& engine,
    std::uint32_t initialSearchSensorScans,
    std::uint32_t initialSearchHeartbeatAttempts,
    std::uint32_t initialSearchElapsedMs,
    std::uint32_t& consumedRevision) {
  UnifiedTurnDiagnosticResult diagnostic;
  diagnostic.homeSucceeded = true;
  diagnostic.searchSensorScans = initialSearchSensorScans;
  diagnostic.searchHeartbeatAttempts = initialSearchHeartbeatAttempts;
  diagnostic.maximumSearchElapsedMs = initialSearchElapsedMs;
  offline::OfflinePhaseExecutionAdapter adapter(runtime);

  while (diagnostic.opponentMoveCount < kUnifiedTargetTurns) {
    if (runtime.phase() != offline::OfflineRuntimePhase::PlanReady) {
      diagnostic.error = "Unified execution started without a staged opponent plan.";
      return diagnostic;
    }
    if (!executeUnifiedOpponentTurn(
            runtime, adapter, diagnostic, consumedRevision)) {
      return diagnostic;
    }
    diagnostic.opponentMoveCount++;

    if (adapter.state() == offline::OfflinePhaseExecutionState::GameOver) {
      diagnostic.error = "The diagnostic game ended before three complete turns.";
      return diagnostic;
    }

    const offline::Occupancy expected =
        runtime.coordinator().physical().committedOccupancy();
    offline::Occupancy actual;
    if (!waitForUnifiedTurnBoundary(
            expected, consumedRevision, actual, diagnostic.error)) {
      diagnostic.recoveryRequired = true;
      diagnostic.actualOccupancy = occupancyHex(actual);
      diagnostic.expectedOccupancy = occupancyHex(expected);
      return diagnostic;
    }
    const auto boundary = adapter.openNextHumanTurn(actual);
    emitExecutionUpdate(boundary);
    if (boundary.event != offline::OfflinePhaseExecutionEvent::HumanTurnOpened) {
      diagnostic.error = boundary.message.c_str();
      diagnostic.recoveryRequired = true;
      return diagnostic;
    }
    diagnostic.turnBoundaryCount++;
    diagnostic.actualOccupancy = occupancyHex(actual);
    diagnostic.expectedOccupancy = occupancyHex(expected);
    diagnostic.finalOccupancyMatched = actual == expected;
    diagnostic.committedFen = runtime.coordinator().physical().game().fen();

    if (diagnostic.opponentMoveCount < kUnifiedTargetTurns &&
        !waitForUnifiedPlan(runtime, engine, diagnostic, consumedRevision)) {
      return diagnostic;
    }
  }

  diagnostic.allTurnBoundariesOpened =
      diagnostic.turnBoundaryCount == kUnifiedTargetTurns &&
      runtime.phase() == offline::OfflineRuntimePhase::HumanTurn;
  diagnostic.magnetLow = offlineRuntimeMagnetIsLow();
  return diagnostic;
}

void emitUnifiedSummary(const UnifiedTurnDiagnosticResult& diagnostic) {
  const std::size_t internalFree =
      heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t largestInternal =
      heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t psramFree = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  const std::size_t stackHeadroom = uxTaskGetStackHighWaterMark(nullptr);

  emitCheck("bounded-home", diagnostic.homeSucceeded);
  emitCheck("three-human-moves", diagnostic.humanMoveCount == kUnifiedTargetTurns);
  emitCheck("three-opponent-moves", diagnostic.opponentMoveCount == kUnifiedTargetTurns);
  emitCheck("three-turn-boundaries", diagnostic.allTurnBoundariesOpened);
  emitCheck("three-searches", diagnostic.searchCount == kUnifiedTargetTurns);
  emitCheck("programs-compiled", diagnostic.programsCompiled);
  emitCheck("ordered-primitives", diagnostic.primitiveOrderValid);
  emitCheck("real-motor-activity", diagnostic.motorActivity);
  emitCheck("magnet-activated-for-drag", diagnostic.magnetEverHigh);
  emitCheck("magnet-low", diagnostic.magnetLow && offlineRuntimeMagnetIsLow());
  emitCheck("final-occupancy", diagnostic.finalOccupancyMatched);
  emitCheck("retry-limit", !diagnostic.retryExhausted);
  emitCheck("no-unresolved-recovery", !diagnostic.recoveryRequired);
  emitCheck("internal-heap-threshold", internalFree >= kMinimumInternalHeapBytes);
  emitCheck(
      "largest-internal-block-threshold",
      largestInternal >= kMinimumLargestInternalBlockBytes);
  emitCheck("psram-threshold", psramFree >= kMinimumFreePsramBytes);
  emitCheck("stack-threshold", stackHeadroom >= kMinimumStackHeadroomBytes);
  emitCheck(
      "sensor-loop-progress",
      diagnostic.searchSensorScans > 0 &&
          offlineRuntimeSensorMaxGapMs < kMaximumSensorGapMs);
  emitCheck(
      "heartbeat-progress",
      ownershipDiagnosticHeartbeatAttempts > 0 &&
          diagnostic.searchHeartbeatAttempts > 0);
  emitCheck(
      "search-deadline",
      diagnostic.maximumSearchElapsedMs <=
          3000U + kSearchOverrunAllowanceMs);

  DynamicJsonDocument document(3072);
  document["type"] = "summary";
  document["pass"] = overallPass;
  document["homeSucceeded"] = diagnostic.homeSucceeded;
  document["realMotionEnabled"] = true;
  document["commandConsumptionBlocked"] = true;
  document["humanMoveCount"] = diagnostic.humanMoveCount;
  document["opponentMoveCount"] = diagnostic.opponentMoveCount;
  document["turnBoundaryCount"] = diagnostic.turnBoundaryCount;
  document["verifiedPhaseCount"] = diagnostic.verifiedPhaseCount;
  document["searchCount"] = diagnostic.searchCount;
  document["retryCount"] = diagnostic.retryCount;
  document["retryExhausted"] = diagnostic.retryExhausted;
  document["recoveryRequired"] = diagnostic.recoveryRequired;
  document["graveyardTransitionCount"] = diagnostic.graveyardTransitionCount;
  document["promotionCount"] = diagnostic.promotionCount;
  document["humanPromotionRejectedClearly"] =
      diagnostic.humanPromotionRejectedClearly;
  document["motorActivity"] = diagnostic.motorActivity;
  document["magnetEverHigh"] = diagnostic.magnetEverHigh;
  document["magnetLow"] = diagnostic.magnetLow && offlineRuntimeMagnetIsLow();
  document["finalOccupancyMatched"] = diagnostic.finalOccupancyMatched;
  document["humanTurnOpen"] = diagnostic.allTurnBoundariesOpened;
  document["committedFen"] = diagnostic.committedFen.c_str();
  document["actualOccupancy"] = diagnostic.actualOccupancy.c_str();
  document["expectedOccupancy"] = diagnostic.expectedOccupancy.c_str();
  if (diagnostic.error.length() > 0) document["error"] = diagnostic.error;
  document["sensorScans"] = offlineRuntimeSensorScanCount;
  document["sensorMaxGapMs"] = offlineRuntimeSensorMaxGapMs;
  document["searchSensorScans"] = diagnostic.searchSensorScans;
  document["heartbeatAttempts"] = ownershipDiagnosticHeartbeatAttempts;
  document["searchHeartbeatAttempts"] = diagnostic.searchHeartbeatAttempts;
  document["heartbeatMaxElapsedMs"] = ownershipDiagnosticHeartbeatMaxElapsedMs;
  document["maximumSearchElapsedMs"] = diagnostic.maximumSearchElapsedMs;
  document["internalFree"] = internalFree;
  document["largestInternal"] = largestInternal;
  document["psramFree"] = psramFree;
  document["stackHeadroom"] = stackHeadroom;
  document["core"] = xPortGetCoreID();
  document["priority"] = uxTaskPriorityGet(nullptr);
  emitDocument(document);
}
