constexpr std::uint32_t kInteractionSetupStableMs = 500;
constexpr std::uint32_t kInteractionSetupTimeoutMs = 300000;

struct InteractionDiagnosticResult {
  bool homeSucceeded = false;
  bool setupObserved = false;
  bool sideSelected = false;
  bool promotionCompleted = false;
  bool finalOccupancyMatched = false;
  bool recoveryRequired = false;
  bool motorActivity = false;
  bool magnetEverHigh = false;
  bool magnetLow = true;
  std::size_t humanMoves = 0;
  std::size_t robotMoves = 0;
  std::size_t searches = 0;
  std::size_t verifiedPhases = 0;
  std::uint32_t maximumSearchElapsedMs = 0;
  std::uint32_t searchSensorMaxGapMs = 0;
  std::uint32_t searchSensorScans = 0;
  std::uint32_t searchHeartbeatAttempts = 0;
  offline::HumanColor humanColor = offline::HumanColor::White;
  std::string finalFen;
  String error;
};

const char* interactionFixtureName() {
  switch (OFFLINE_INTERACTION_FIXTURE) {
    case 1: return "HumanPromotion";
    case 2: return "RobotPromotion";
    default: return "Standard";
  }
}

void showInteractionFeedback(const offline::OfflineFeedbackInput& input) {
  submitOfflineInteractionFrame(
      offline::OfflineLedRenderer::render(input), input.state, false);
}

void showInteractionStatus(offline::OfflineFeedbackState state) {
  offline::OfflineFeedbackInput input;
  input.state = state;
  showInteractionFeedback(input);
}

void showInteractionDifference(
    offline::OfflineFeedbackState state,
    const offline::OccupancyDiff& difference) {
  offline::OfflineFeedbackInput input;
  input.state = state;
  input.difference = difference;
  showInteractionFeedback(input);
}

void emitInteractionEvent(
    const char* type,
    const char* event,
    const char* message = nullptr) {
  StaticJsonDocument<512> document;
  document["type"] = type;
  document["event"] = event;
  document["fixture"] = interactionFixtureName();
  if (message) document["message"] = message;
  emitDocument(document);
}

bool waitForInteractionSetup(
    const offline::Occupancy& expected,
    std::uint32_t& consumedRevision,
    InteractionDiagnosticResult& diagnostic) {
  const std::uint32_t startedAt = millis();
  std::uint32_t exactSince = 0;
  std::uint32_t lastLoggedRevision = 0;
  showInteractionStatus(offline::OfflineFeedbackState::Wait);

  while (millis() - startedAt < kInteractionSetupTimeoutMs) {
    offline::Occupancy occupancy;
    std::uint32_t revision = 0;
    std::uint32_t changedAtMs = 0;
    if (copySnapshot(occupancy, revision, changedAtMs)) {
      consumedRevision = revision;
      const auto difference = offline::compareOccupancy(expected, occupancy);
      if (difference.empty()) {
        if (exactSince == 0) {
          exactSince = millis();
          showInteractionDifference(offline::OfflineFeedbackState::Setup, difference);
        }
        if (millis() - exactSince >= kInteractionSetupStableMs) {
          diagnostic.setupObserved = true;
          emitInteractionEvent("setup", "stable", "Required setup held for 500 ms.");
          return true;
        }
      } else {
        exactSince = 0;
        showInteractionDifference(offline::OfflineFeedbackState::Setup, difference);
        if (revision != lastLoggedRevision) {
          lastLoggedRevision = revision;
          DynamicJsonDocument event(1024);
          event["type"] = "setup";
          event["event"] = "mismatch";
          addDifference(event.createNestedObject("difference"), difference);
          emitDocument(event);
        }
      }
    }
    vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
  }
  diagnostic.error = "Setup was not completed before the verifier timeout.";
  return false;
}

bool selectInteractionSide(
    const offline::Occupancy& setup,
    std::uint32_t& consumedRevision,
    InteractionDiagnosticResult& diagnostic) {
  offline::OfflineSideSelector selector;
  if (!selector.begin(setup, millis())) {
    diagnostic.error = "The side selector could not be armed.";
    return false;
  }
  showInteractionStatus(offline::OfflineFeedbackState::SideSelection);
  emitInteractionEvent("side-selection", "armed");

  for (;;) {
    offline::Occupancy occupancy;
    std::uint32_t revision = 0;
    std::uint32_t changedAtMs = 0;
    if (!copySnapshot(occupancy, revision, changedAtMs)) {
      vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
      continue;
    }
    consumedRevision = revision;
    const auto update = selector.processSnapshot(millis(), occupancy);
    if (update.state == offline::OfflineSideSelectionState::SyncWarning) {
      showInteractionDifference(
          offline::OfflineFeedbackState::SyncWarning, update.difference);
    } else if (update.state == offline::OfflineSideSelectionState::HoldingChoice ||
               update.state == offline::OfflineSideSelectionState::RestoringSetup) {
      offline::OfflineFeedbackInput input;
      input.state = offline::OfflineFeedbackState::SideSelected;
      input.selectedColor = update.candidate ? update.candidate : update.selected;
      showInteractionFeedback(input);
    } else if (update.state == offline::OfflineSideSelectionState::AwaitingChoice) {
      showInteractionStatus(offline::OfflineFeedbackState::SideSelection);
    }

    if (update.event != offline::OfflineSideSelectionEvent::None) {
      DynamicJsonDocument event(768);
      event["type"] = "side-selection";
      event["event"] = offline::offlineSideSelectionEventName(update.event);
      event["state"] = offline::offlineSideSelectionStateName(update.state);
      if (update.candidate) {
        event["candidate"] = *update.candidate == offline::HumanColor::White
            ? "white" : "black";
      }
      if (update.selected) {
        event["selected"] = *update.selected == offline::HumanColor::White
            ? "white" : "black";
      }
      event["message"] = update.message.c_str();
      emitDocument(event);
    }

    if (update.state == offline::OfflineSideSelectionState::Complete &&
        update.selected) {
      diagnostic.humanColor = *update.selected;
      diagnostic.sideSelected = true;
      offline::OfflineFeedbackInput selected;
      selected.state = offline::OfflineFeedbackState::SideSelected;
      selected.selectedColor = update.selected;
      showInteractionFeedback(selected);
      vTaskDelay(pdMS_TO_TICKS(750));
      showInteractionStatus(offline::OfflineFeedbackState::HumanReady);
      return true;
    }
    if (update.state == offline::OfflineSideSelectionState::Error) {
      diagnostic.error = update.message.c_str();
      return false;
    }
    vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
  }
}

void showHumanInteraction(const offline::OfflineRuntimeUpdate& update) {
  if (!update.coordinatorResult ||
      !update.coordinatorResult->physicalResult) return;
  offline::OfflineFeedbackInput input;
  input.state = offline::OfflineFeedbackState::HumanInteraction;
  input.highlights = update.coordinatorResult->physicalResult->highlights;
  showInteractionFeedback(input);
}

bool handleInteractionHumanPromotion(
    offline::OfflineReadOnlyRuntime& runtime,
    const offline::HumanPromotionRequest& request,
    std::uint32_t& consumedRevision,
    InteractionDiagnosticResult& diagnostic) {
  offline::OfflineHumanPromotionSelector selector;
  if (!selector.begin(request, millis())) {
    diagnostic.error = "The human promotion selector could not be armed.";
    return false;
  }
  offline::OfflineFeedbackInput prompt;
  prompt.state = offline::OfflineFeedbackState::PromotionPrompt;
  prompt.promotionSquare = request.target;
  showInteractionFeedback(prompt);
  emitInteractionEvent("promotion", "human-awaiting-removal");

  for (;;) {
    offline::Occupancy occupancy;
    std::uint32_t revision = 0;
    std::uint32_t changedAtMs = 0;
    if (!copySnapshot(occupancy, revision, changedAtMs)) {
      vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
      continue;
    }
    offline::HumanPromotionSelectionUpdate update;
    if (revision != consumedRevision) {
      consumedRevision = revision;
      update = selector.processSnapshot(millis(), occupancy);
    } else {
      update = selector.tick(millis());
    }

    if (update.state == offline::HumanPromotionSelectionState::Cycling ||
        update.state == offline::HumanPromotionSelectionState::ConfirmingPlacement) {
      offline::OfflineFeedbackInput choice;
      choice.state = offline::OfflineFeedbackState::PromotionChoice;
      choice.promotionSquare = request.target;
      choice.promotionChoice = update.displayedChoice;
      showInteractionFeedback(choice);
    } else if (update.state == offline::HumanPromotionSelectionState::SyncWarning) {
      showInteractionDifference(
          offline::OfflineFeedbackState::SyncWarning, update.difference);
    }

    if (update.event != offline::HumanPromotionSelectionEvent::None) {
      DynamicJsonDocument event(768);
      event["type"] = "promotion";
      event["actor"] = "human";
      event["event"] = offline::humanPromotionSelectionEventName(update.event);
      event["state"] = offline::humanPromotionSelectionStateName(update.state);
      event["displayedPiece"] = String(update.displayedChoice);
      event["message"] = update.message.c_str();
      emitDocument(event);
    }

    if (update.state == offline::HumanPromotionSelectionState::Complete &&
        update.confirmedChoice) {
      const auto confirmed = runtime.confirmHumanPromotion(*update.confirmedChoice);
      emitRuntimeUpdate(confirmed, millis());
      if (confirmed.event != offline::OfflineRuntimeEvent::HumanPromotionConfirmed) {
        diagnostic.error = confirmed.message.c_str();
        return false;
      }
      diagnostic.humanMoves++;
      diagnostic.promotionCompleted = true;
      return true;
    }
    if (update.state == offline::HumanPromotionSelectionState::Cancelled) {
      const auto cancelled = runtime.processStableSnapshot(millis(), occupancy);
      emitRuntimeUpdate(cancelled, millis());
      diagnostic.error = "Human promotion was cancelled; the bounded fixture has stopped.";
      return false;
    }
    if (update.state == offline::HumanPromotionSelectionState::Error) {
      diagnostic.error = update.message.c_str();
      return false;
    }
    vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
  }
}

bool executeInteractionOpponent(
    offline::OfflineReadOnlyRuntime& runtime,
    offline::OfflinePhaseExecutionAdapter& adapter,
    std::uint32_t& consumedRevision,
    InteractionDiagnosticResult& diagnostic) {
  const auto transaction = runtime.coordinator().pendingMotionTransaction();
  if (transaction) {
    offline::OfflineFeedbackInput path;
    path.state = offline::OfflineFeedbackState::RobotExecuting;
    for (const auto& phase : transaction->motion.phases) {
      if (phase.transfer) {
        path.robotPathSquares.insert(
            path.robotPathSquares.end(),
            phase.transfer->compressedPathSquares.begin(),
            phase.transfer->compressedPathSquares.end());
      }
    }
    showInteractionFeedback(path);
  }

  const bool promotionMove = transaction &&
      !transaction->motion.move.promotion.empty();
  UnifiedTurnDiagnosticResult execution;
  execution.homeSucceeded = true;
  if (!executeUnifiedOpponentTurn(runtime, adapter, execution, consumedRevision)) {
    diagnostic.error = execution.error;
    diagnostic.recoveryRequired = execution.recoveryRequired;
    showInteractionStatus(offline::OfflineFeedbackState::Error);
    return false;
  }
  diagnostic.robotMoves++;
  diagnostic.verifiedPhases += execution.verifiedPhaseCount;
  diagnostic.motorActivity = diagnostic.motorActivity || execution.motorActivity;
  diagnostic.magnetEverHigh =
      diagnostic.magnetEverHigh || execution.magnetEverHigh;
  diagnostic.magnetLow = execution.magnetLow;
  if (promotionMove) {
    diagnostic.promotionCompleted = true;
  }
  return true;
}

void emitInteractionSummary(const InteractionDiagnosticResult& diagnostic) {
  const std::size_t internalFree =
      heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t largestInternal =
      heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t psramFree = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  const std::size_t stackHeadroom = uxTaskGetStackHighWaterMark(nullptr);
  const bool standard = OFFLINE_INTERACTION_FIXTURE == 0;
  const bool expectedCounts = standard
      ? (diagnostic.humanMoves == 1 &&
         diagnostic.robotMoves ==
             (diagnostic.humanColor == offline::HumanColor::White ? 1U : 2U))
      : (OFFLINE_INTERACTION_FIXTURE == 1
             ? diagnostic.humanMoves == 1 && diagnostic.robotMoves == 0
             : diagnostic.humanMoves == 1 && diagnostic.robotMoves == 1);

  emitCheck("bounded-home", diagnostic.homeSucceeded);
  emitCheck("setup-stable", diagnostic.setupObserved);
  emitCheck("side-selection", !standard || diagnostic.sideSelected);
  emitCheck("bounded-move-counts", expectedCounts);
  emitCheck(
      "promotion-completed",
      standard || diagnostic.promotionCompleted);
  emitCheck("final-occupancy", diagnostic.finalOccupancyMatched);
  emitCheck("no-unresolved-recovery", !diagnostic.recoveryRequired);
  emitCheck("magnet-low", diagnostic.magnetLow && offlineRuntimeMagnetIsLow());
  emitCheck("internal-heap-threshold", internalFree >= kMinimumInternalHeapBytes);
  emitCheck(
      "largest-internal-block-threshold",
      largestInternal >= kMinimumLargestInternalBlockBytes);
  emitCheck("psram-threshold", psramFree >= kMinimumFreePsramBytes);
  emitCheck("stack-threshold", stackHeadroom >= kMinimumStackHeadroomBytes);
  emitCheck(
      "sensor-gap-threshold",
      offlineRuntimeSensorMaxGapMs < kMaximumSensorGapMs);
  emitCheck(
      "search-deadline",
      diagnostic.maximumSearchElapsedMs <= 3000U + kSearchOverrunAllowanceMs);

  DynamicJsonDocument summary(2048);
  summary["type"] = "summary";
  summary["pass"] = overallPass;
  summary["fixture"] = interactionFixtureName();
  summary["humanColor"] = diagnostic.humanColor == offline::HumanColor::White
      ? "white" : "black";
  summary["homeSucceeded"] = diagnostic.homeSucceeded;
  summary["humanMoveCount"] = diagnostic.humanMoves;
  summary["robotMoveCount"] = diagnostic.robotMoves;
  summary["searchCount"] = diagnostic.searches;
  summary["verifiedPhaseCount"] = diagnostic.verifiedPhases;
  summary["promotionCompleted"] = diagnostic.promotionCompleted;
  summary["finalOccupancyMatched"] = diagnostic.finalOccupancyMatched;
  summary["finalFen"] = diagnostic.finalFen.c_str();
  summary["motorActivity"] = diagnostic.motorActivity;
  summary["magnetEverHigh"] = diagnostic.magnetEverHigh;
  summary["magnetLow"] = offlineRuntimeMagnetIsLow();
  summary["sensorMaxGapMs"] = offlineRuntimeSensorMaxGapMs;
  summary["searchSensorMaxGapMs"] = diagnostic.searchSensorMaxGapMs;
  summary["recordedSensorMaxGapMs"] =
      offlineInteractionMaximumRecordedSensorGapMs();
  summary["sensorMaxGapStage"] = static_cast<std::uint8_t>(
      offlineInteractionMaximumSensorGapStage());
  summary["ledShowMaxUs"] = offlineInteractionMaximumShowUs();
  summary["maximumSearchElapsedMs"] = diagnostic.maximumSearchElapsedMs;
  summary["internalFree"] = internalFree;
  summary["largestInternal"] = largestInternal;
  summary["psramFree"] = psramFree;
  summary["stackHeadroom"] = stackHeadroom;
  summary["error"] = diagnostic.error;
  emitDocument(summary);
}

void completeInteractionDiagnostic(
    offline::OfflineReadOnlyRuntime& runtime,
    InteractionDiagnosticResult& diagnostic) {
  offline::Occupancy actual;
  std::uint32_t finalRevision = 0;
  std::uint32_t finalChangedAt = 0;
  copySnapshot(actual, finalRevision, finalChangedAt);
  diagnostic.finalOccupancyMatched =
      actual == runtime.coordinator().physical().committedOccupancy();
  diagnostic.finalFen = runtime.coordinator().physical().game().fen();
  diagnostic.magnetLow = offlineRuntimeMagnetIsLow();
  const auto status = runtime.coordinator().physical().game().status();
  showInteractionStatus(
      status.outcome == offline::GameOutcome::Checkmate
          ? offline::OfflineFeedbackState::Checkmate
      : status.outcome != offline::GameOutcome::Ongoing
          ? offline::OfflineFeedbackState::Draw
      : status.inCheck ? offline::OfflineFeedbackState::Check
                       : offline::OfflineFeedbackState::Success);
  emitInteractionSummary(diagnostic);
}

void runOfflineInteractionDiagnostic() {
  InteractionDiagnosticResult diagnostic;
  CaptureMotionDiagnosticResult home;
  showInteractionStatus(offline::OfflineFeedbackState::Wait);
  if (!runCaptureHomeGate(home)) {
    diagnostic.error = home.error;
    emitInteractionSummary(diagnostic);
    return;
  }
  diagnostic.homeSucceeded = true;

  const char* fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  if (OFFLINE_INTERACTION_FIXTURE == 1) {
    fen = "7k/P7/8/8/8/8/8/7K w - - 0 1";
  } else if (OFFLINE_INTERACTION_FIXTURE == 2) {
    fen = "4k3/8/8/8/8/8/p7/4K3 w - - 0 1";
  }
  const offline::Occupancy setup = offline::occupancyFromFen(fen);
  std::uint32_t consumedRevision = 0;
  if (!waitForInteractionSetup(setup, consumedRevision, diagnostic)) {
    showInteractionStatus(offline::OfflineFeedbackState::Error);
    emitInteractionSummary(diagnostic);
    return;
  }

  if (OFFLINE_INTERACTION_FIXTURE == 0) {
    if (!selectInteractionSide(setup, consumedRevision, diagnostic)) {
      emitInteractionSummary(diagnostic);
      return;
    }
  } else {
    diagnostic.humanColor = offline::HumanColor::White;
  }

  offline::OfflineRuntimeConfig config;
  config.setupStableMs = 500;
  config.initialFen = fen;
  config.coordinator.humanColor = diagnostic.humanColor;
  config.coordinator.searchLimits.timeLimitMs = 3000;
  config.coordinator.searchLimits.maxDepth = 12;
  config.coordinator.externalSlots = offline::defaultExternalSlots();
  offline::OfflineReadOnlyRuntime runtime(config);
  offline::OfflineEngine engine;
  offline::OfflinePhaseExecutionAdapter adapter(runtime);
  std::uint32_t searchedGeneration = 0;
  std::optional<offline::HumanPromotionRequest> humanPromotion;

  const std::size_t targetRobotMoves = OFFLINE_INTERACTION_FIXTURE == 0
      ? (diagnostic.humanColor == offline::HumanColor::White ? 1U : 2U)
      : (OFFLINE_INTERACTION_FIXTURE == 2 ? 1U : 0U);

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

    auto update = runtime.applyOwnershipDecision(
        millis(), ownershipDecision(ownership), occupancy);
    if (update.phase == offline::OfflineRuntimePhase::HandoffPending) {
      showInteractionStatus(offline::OfflineFeedbackState::Wait);
      diagnostic.error = "Backend returned; interaction froze at a stable boundary.";
      emitInteractionSummary(diagnostic);
      return;
    }
    if (revision != consumedRevision) {
      consumedRevision = revision;
      update = runtime.processStableSnapshot(millis(), occupancy);
      emitRuntimeUpdate(update, millis());
      showHumanInteraction(update);
      if (update.event == offline::OfflineRuntimeEvent::HumanMoveAccepted) {
        diagnostic.humanMoves++;
      }
      if (update.humanPromotionRequest) humanPromotion = update.humanPromotionRequest;
    }
    storeSafety(runtime.ownershipSafety(occupancy));

    if (runtime.phase() == offline::OfflineRuntimePhase::WaitingForSetup) {
      showInteractionDifference(
          offline::OfflineFeedbackState::Setup,
          offline::compareOccupancy(runtime.expectedSetupOccupancy(), occupancy));
    } else if (runtime.phase() == offline::OfflineRuntimePhase::HumanTurn) {
      diagnostic.recoveryRequired = false;
      // Piece-lift feedback must remain visible until the interpreter returns
      // to its exact ready phase. The runtime remains in HumanTurn while a
      // source is lifted, so checking only the runtime phase erases targets.
      if (runtime.coordinator().physical().phase() ==
          offline::PhysicalPhase::Ready) {
        showInteractionStatus(offline::OfflineFeedbackState::HumanReady);
      }
    } else if (runtime.phase() == offline::OfflineRuntimePhase::HumanPromotionPending &&
               humanPromotion) {
      if (!handleInteractionHumanPromotion(
              runtime, *humanPromotion, consumedRevision, diagnostic)) {
        showInteractionStatus(offline::OfflineFeedbackState::Error);
        emitInteractionSummary(diagnostic);
        return;
      }
      humanPromotion.reset();
    } else if (runtime.phase() == offline::OfflineRuntimePhase::SyncWarning) {
      diagnostic.recoveryRequired = true;
      showInteractionDifference(
          offline::OfflineFeedbackState::SyncWarning,
          offline::compareOccupancy(
              runtime.coordinator().physical().committedOccupancy(), occupancy));
    }

    if (OFFLINE_INTERACTION_FIXTURE == 1 && diagnostic.promotionCompleted) {
      completeInteractionDiagnostic(runtime, diagnostic);
      return;
    }

    const auto request = runtime.pendingEngineRequest();
    if (request && request->generation != searchedGeneration) {
      searchedGeneration = request->generation;
      showInteractionStatus(offline::OfflineFeedbackState::EngineThinking);
      const std::uint32_t scansBefore = offlineRuntimeSensorScanCount;
      const std::uint32_t heartbeatsBefore = ownershipDiagnosticHeartbeatAttempts;
      offlineRuntimeSensorMaxGapMs = 0;
      setOfflineInteractionSensorStage(OfflineInteractionSensorStage::Search);
      resetOfflineInteractionSensorTiming();
      const auto result = engine.searchFen(request->fen, request->limits);
      diagnostic.searchSensorMaxGapMs = offlineRuntimeSensorMaxGapMs;
      diagnostic.searches++;
      diagnostic.maximumSearchElapsedMs =
          std::max(diagnostic.maximumSearchElapsedMs, result.elapsedMs);
      diagnostic.searchSensorScans += offlineRuntimeSensorScanCount - scansBefore;
      diagnostic.searchHeartbeatAttempts +=
          ownershipDiagnosticHeartbeatAttempts - heartbeatsBefore;
      emitSearch(
          *request,
          result,
          offlineRuntimeSensorScanCount - scansBefore,
          ownershipDiagnosticHeartbeatAttempts - heartbeatsBefore);
      std::uint32_t latestChangedAt = 0;
      copySnapshot(occupancy, consumedRevision, latestChangedAt);
      update = runtime.submitEngineResult(request->generation, result, occupancy);
      emitRuntimeUpdate(update, millis());
    }

    if (runtime.phase() == offline::OfflineRuntimePhase::PlanReady) {
      emitMotionPlan(runtime);
      if (!executeInteractionOpponent(
              runtime, adapter, consumedRevision, diagnostic)) {
        emitInteractionSummary(diagnostic);
        return;
      }
      if (adapter.state() != offline::OfflinePhaseExecutionState::GameOver) {
        offline::Occupancy actual;
        String boundaryError;
        if (!waitForUnifiedTurnBoundary(
                runtime.coordinator().physical().committedOccupancy(),
                consumedRevision,
                actual,
                boundaryError)) {
          diagnostic.error = boundaryError;
          diagnostic.recoveryRequired = true;
          emitInteractionSummary(diagnostic);
          return;
        }
        const auto boundary = adapter.openNextHumanTurn(actual);
        emitExecutionUpdate(boundary);
      }
    }

    const bool promotionFixtureDone =
        OFFLINE_INTERACTION_FIXTURE != 0 && diagnostic.promotionCompleted;
    const bool standardDone =
        OFFLINE_INTERACTION_FIXTURE == 0 && diagnostic.humanMoves == 1 &&
        diagnostic.robotMoves == targetRobotMoves;
    if (promotionFixtureDone || standardDone) {
      completeInteractionDiagnostic(runtime, diagnostic);
      return;
    }
    vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
  }
}
