constexpr std::uint32_t kContinuousSetupTimeoutMs = 300000;
constexpr std::size_t kContinuousAcceptanceTurns = 12;

struct ContinuousGameplayResult {
  bool homeSucceeded = false;
  bool setupObserved = false;
  bool sideSelected = false;
  bool checkpointReached = false;
  bool terminalResetCompleted = false;
  bool handoffBoundary = false;
  bool recoveryRequired = false;
  bool motorActivity = false;
  bool magnetEverHigh = false;
  bool magnetLow = true;
  std::size_t sessionCount = 0;
  std::size_t completedTurns = 0;
  std::size_t humanMoves = 0;
  std::size_t robotMoves = 0;
  std::size_t searches = 0;
  std::size_t verifiedPhases = 0;
  std::uint32_t maximumSearchElapsedMs = 0;
  std::uint32_t maximumSearchSensorGapMs = 0;
  std::uint32_t generation = 0;
  std::string finalFen;
  std::vector<std::string> occupiedGraveyards;
  String error;
};

const char* continuousFixtureName() {
  return OFFLINE_CONTINUOUS_FIXTURE == 1 ? "TerminalReset" : "Standard";
}

void emitContinuousEvent(
    const char* type,
    const char* event,
    const ContinuousGameplayResult& diagnostic,
    const char* message = nullptr) {
  DynamicJsonDocument document(1536);
  document["type"] = type;
  document["event"] = event;
  document["fixture"] = continuousFixtureName();
  document["generation"] = diagnostic.generation;
  document["completedTurns"] = diagnostic.completedTurns;
  document["humanMoves"] = diagnostic.humanMoves;
  document["robotMoves"] = diagnostic.robotMoves;
  if (message) document["message"] = message;
  emitDocument(document);
}

std::string continuousKingSquare(
    const offline::OfflineGame& game, const std::string& king) {
  for (const auto& square : game.occupiedSquares()) {
    if (game.pieceAt(square) == king) return square;
  }
  return {};
}

void showContinuousPositionFeedback(const offline::OfflineGame& game) {
  const auto status = game.status();
  offline::OfflineFeedbackInput feedback;
  if (status.outcome == offline::GameOutcome::Checkmate) {
    feedback.state = offline::OfflineFeedbackState::Checkmate;
    const std::string whiteKing = continuousKingSquare(game, "K");
    const std::string blackKing = continuousKingSquare(game, "k");
    if (game.sideToMove() == 'w') {
      feedback.losingKingSquare = whiteKing;
      feedback.winningKingSquare = blackKing;
    } else {
      feedback.losingKingSquare = blackKing;
      feedback.winningKingSquare = whiteKing;
    }
  } else if (status.outcome != offline::GameOutcome::Ongoing) {
    feedback.state = offline::OfflineFeedbackState::Draw;
  } else if (status.inCheck) {
    feedback.state = offline::OfflineFeedbackState::Check;
    feedback.checkedKingSquare = continuousKingSquare(
        game, game.sideToMove() == 'w' ? "K" : "k");
  } else {
    feedback.state = offline::OfflineFeedbackState::Success;
  }
  showInteractionFeedback(feedback);
}

void emitContinuousSummary(const ContinuousGameplayResult& diagnostic) {
  const std::size_t internalFree =
      heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t largestInternal =
      heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t psramFree = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  const std::size_t stackHeadroom = uxTaskGetStackHighWaterMark(nullptr);
  const bool fixtureComplete = OFFLINE_CONTINUOUS_FIXTURE == 0
      ? diagnostic.checkpointReached
      : diagnostic.terminalResetCompleted;

  emitCheck("bounded-home", diagnostic.homeSucceeded);
  emitCheck("setup-stable", diagnostic.setupObserved);
  emitCheck("side-selection", diagnostic.sideSelected);
  emitCheck("fixture-checkpoint", fixtureComplete || diagnostic.handoffBoundary);
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
      diagnostic.maximumSearchElapsedMs <=
          3000U + kSearchOverrunAllowanceMs);

  DynamicJsonDocument summary(3072);
  summary["type"] = "summary";
  summary["pass"] = overallPass;
  summary["fixture"] = continuousFixtureName();
  summary["generation"] = diagnostic.generation;
  summary["sessionCount"] = diagnostic.sessionCount;
  summary["completedTurns"] = diagnostic.completedTurns;
  summary["humanMoveCount"] = diagnostic.humanMoves;
  summary["robotMoveCount"] = diagnostic.robotMoves;
  summary["searchCount"] = diagnostic.searches;
  summary["verifiedPhaseCount"] = diagnostic.verifiedPhases;
  summary["checkpointReached"] = diagnostic.checkpointReached;
  summary["terminalResetCompleted"] = diagnostic.terminalResetCompleted;
  summary["handoffBoundary"] = diagnostic.handoffBoundary;
  summary["finalFen"] = diagnostic.finalFen.c_str();
  addStrings(summary.createNestedArray("occupiedGraveyards"),
             diagnostic.occupiedGraveyards);
  summary["motorActivity"] = diagnostic.motorActivity;
  summary["magnetEverHigh"] = diagnostic.magnetEverHigh;
  summary["magnetLow"] = offlineRuntimeMagnetIsLow();
  summary["sensorMaxGapMs"] = offlineRuntimeSensorMaxGapMs;
  summary["searchSensorMaxGapMs"] = diagnostic.maximumSearchSensorGapMs;
  summary["recordedSensorMaxGapMs"] =
      offlineInteractionMaximumRecordedSensorGapMs();
  summary["maximumSearchElapsedMs"] = diagnostic.maximumSearchElapsedMs;
  summary["internalFree"] = internalFree;
  summary["largestInternal"] = largestInternal;
  summary["psramFree"] = psramFree;
  summary["stackHeadroom"] = stackHeadroom;
  summary["error"] = diagnostic.error;
  emitDocument(summary);
}

bool waitForContinuousReset(
    offline::OfflineContinuousSessionController& session,
    std::uint32_t& consumedRevision,
    ContinuousGameplayResult& diagnostic) {
  std::uint32_t lastEventRevision = 0;
  for (;;) {
    OfflineOwnershipDiagnosticSnapshot ownership;
    if (copyOfflineOwnershipDiagnosticSnapshot(ownership) && ownership.valid &&
        (ownership.handoffRequired ||
         ownership.state == offline::OwnershipState::ReconnectPending)) {
      diagnostic.handoffBoundary = true;
      showInteractionStatus(offline::OfflineFeedbackState::Wait);
      return false;
    }
    offline::Occupancy occupancy;
    std::uint32_t revision = 0;
    std::uint32_t changedAtMs = 0;
    if (!copySnapshot(occupancy, revision, changedAtMs)) {
      vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
      continue;
    }
    consumedRevision = revision;
    const auto update = session.processSnapshot(millis(), occupancy);
    if (update.state == offline::OfflineContinuousState::ClearGraveyards ||
        update.state == offline::OfflineContinuousState::SetupStabilizing) {
      showInteractionSetupFeedback(
          offline::OfflineFeedbackState::ClearGraveyards,
          session.standardSetup(), occupancy);
    } else if (update.state == offline::OfflineContinuousState::SyncWarning) {
      showInteractionDifference(
          offline::OfflineFeedbackState::SyncWarning, update.difference);
    }
    if (update.event != offline::OfflineContinuousEvent::None &&
        (revision != lastEventRevision ||
         update.event == offline::OfflineContinuousEvent::SetupReady)) {
      lastEventRevision = revision;
      DynamicJsonDocument event(1536);
      event["type"] = "reset";
      event["event"] = offline::offlineContinuousEventName(update.event);
      event["state"] = offline::offlineContinuousStateName(update.state);
      event["generation"] = update.generation;
      event["message"] = update.message.c_str();
      if (!update.difference.empty()) {
        addDifference(event.createNestedObject("difference"), update.difference);
      }
      emitDocument(event);
    }
    if (update.state == offline::OfflineContinuousState::ReadyForSide) {
      diagnostic.setupObserved = true;
      return true;
    }
    if (update.state == offline::OfflineContinuousState::Error) {
      diagnostic.error = update.message.c_str();
      return false;
    }
    vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
  }
}

void runOfflineContinuousGameplayDiagnostic() {
  ContinuousGameplayResult diagnostic;
  CaptureMotionDiagnosticResult home;
  showInteractionStatus(offline::OfflineFeedbackState::Wait);
  if (!runCaptureHomeGate(home)) {
    diagnostic.error = home.error;
    emitContinuousSummary(diagnostic);
    return;
  }
  diagnostic.homeSucceeded = true;

  constexpr const char* kStandardFen =
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  constexpr const char* kTerminalFen =
      "4k2r/8/8/8/8/8/P3P1P1/4RKR1 w k - 0 1";
  const offline::Occupancy standardSetup = offline::occupancyFromFen(kStandardFen);
  offline::OfflineContinuousSessionController session(standardSetup);
  std::uint32_t consumedRevision = 0;
  bool firstSession = true;

  for (;;) {
    const bool terminalFixtureFirst =
        OFFLINE_CONTINUOUS_FIXTURE == 1 && firstSession;
    const char* initialFen = terminalFixtureFirst ? kTerminalFen : kStandardFen;
    const offline::Occupancy requiredSetup = offline::occupancyFromFen(initialFen);
    InteractionDiagnosticResult interaction;
    interaction.homeSucceeded = true;
    if (!waitForInteractionSetup(requiredSetup, consumedRevision, interaction)) {
      diagnostic.error = interaction.error;
      showInteractionStatus(offline::OfflineFeedbackState::Error);
      emitContinuousSummary(diagnostic);
      return;
    }
    diagnostic.setupObserved = true;

    if (terminalFixtureFirst) {
      interaction.humanColor = offline::HumanColor::White;
    } else if (!selectInteractionSide(
                   requiredSetup, consumedRevision, interaction)) {
      diagnostic.error = interaction.error;
      emitContinuousSummary(diagnostic);
      return;
    }
    diagnostic.sideSelected = true;

    const auto started = session.beginGame(millis());
    if (started.event != offline::OfflineContinuousEvent::GameStarted) {
      diagnostic.error = started.message.c_str();
      emitContinuousSummary(diagnostic);
      return;
    }
    diagnostic.generation = started.generation;
    diagnostic.sessionCount++;
    emitContinuousEvent(
        "session", "started", diagnostic,
        interaction.humanColor == offline::HumanColor::White
            ? "Human White session started." : "Human Black session started.");

    offline::OfflineRuntimeConfig config;
    config.setupStableMs = 500;
    config.initialFen = initialFen;
    config.coordinator.humanColor = interaction.humanColor;
    config.coordinator.searchLimits.timeLimitMs = 3000;
    config.coordinator.searchLimits.maxDepth = 12;
    config.coordinator.externalSlots = offline::defaultExternalSlots();
    offline::OfflineReadOnlyRuntime runtime(config);
    offline::OfflineEngine engine;
    offline::OfflinePhaseExecutionAdapter adapter(runtime);
    std::uint32_t searchedGeneration = 0;
    std::optional<offline::HumanPromotionRequest> humanPromotion;
    bool humanMovePending = false;
    bool sessionEnded = false;

    while (!sessionEnded) {
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
        diagnostic.handoffBoundary = true;
        diagnostic.finalFen = runtime.coordinator().physical().game().fen();
        diagnostic.occupiedGraveyards =
            runtime.coordinator().occupiedGraveyardKeys();
        emitContinuousEvent(
            "ownership", "handoff-boundary", diagnostic,
            "Backend returned; offline play stopped at an exact boundary.");
        emitContinuousSummary(diagnostic);
        return;
      }

      if (revision != consumedRevision) {
        consumedRevision = revision;
        update = runtime.processStableSnapshot(millis(), occupancy);
        emitRuntimeUpdate(update, millis());
        showHumanInteraction(update);
        if (update.event == offline::OfflineRuntimeEvent::HumanMoveAccepted) {
          diagnostic.humanMoves++;
          humanMovePending = true;
          emitContinuousEvent(
              "move", "human-accepted", diagnostic,
              update.acceptedMove ? update.acceptedMove->uci.c_str() : nullptr);
        }
        if (update.humanPromotionRequest) {
          humanPromotion = update.humanPromotionRequest;
        }
      }
      storeSafety(runtime.ownershipSafety(occupancy));

      if (runtime.phase() == offline::OfflineRuntimePhase::HumanTurn) {
        diagnostic.recoveryRequired = false;
        if (runtime.coordinator().physical().phase() ==
            offline::PhysicalPhase::Ready) {
          showInteractionStatus(offline::OfflineFeedbackState::HumanReady);
        }
      } else if (
          runtime.phase() == offline::OfflineRuntimePhase::HumanPromotionPending &&
          humanPromotion) {
        const std::size_t humanBefore = interaction.humanMoves;
        if (!handleInteractionHumanPromotion(
                runtime, *humanPromotion, consumedRevision, interaction)) {
          diagnostic.error = interaction.error;
          diagnostic.recoveryRequired = interaction.recoveryRequired;
          showInteractionStatus(offline::OfflineFeedbackState::Error);
          emitContinuousSummary(diagnostic);
          return;
        }
        if (interaction.humanMoves > humanBefore) {
          diagnostic.humanMoves++;
          humanMovePending = true;
        }
        humanPromotion.reset();
      } else if (runtime.phase() == offline::OfflineRuntimePhase::SyncWarning) {
        diagnostic.recoveryRequired = true;
        showInteractionDifference(
            offline::OfflineFeedbackState::SyncWarning,
            offline::compareOccupancy(
                runtime.coordinator().physical().committedOccupancy(), occupancy));
      }

      const auto request = runtime.pendingEngineRequest();
      if (request && request->generation != searchedGeneration) {
        searchedGeneration = request->generation;
        const std::uint32_t sessionGeneration = diagnostic.generation;
        showInteractionStatus(offline::OfflineFeedbackState::EngineThinking);
        offlineRuntimeSensorMaxGapMs = 0;
        setOfflineInteractionSensorStage(OfflineInteractionSensorStage::Search);
        resetOfflineInteractionSensorTiming();
        const auto result = engine.searchFen(request->fen, request->limits);
        diagnostic.searches++;
        diagnostic.maximumSearchElapsedMs = std::max(
            diagnostic.maximumSearchElapsedMs, result.elapsedMs);
        diagnostic.maximumSearchSensorGapMs = std::max(
            diagnostic.maximumSearchSensorGapMs,
            static_cast<std::uint32_t>(offlineRuntimeSensorMaxGapMs));
        emitSearch(*request, result, 0, 0);
        if (session.validateGeneration(sessionGeneration).event !=
            offline::OfflineContinuousEvent::None) {
          emitContinuousEvent(
              "search", "stale-generation", diagnostic,
              "Search result belonged to an earlier offline session.");
          continue;
        }
        OfflineOwnershipDiagnosticSnapshot latestOwnership;
        if (copyOfflineOwnershipDiagnosticSnapshot(latestOwnership) &&
            latestOwnership.handoffRequired) {
          continue;
        }
        std::uint32_t latestChangedAt = 0;
        copySnapshot(occupancy, consumedRevision, latestChangedAt);
        update = runtime.submitEngineResult(request->generation, result, occupancy);
        emitRuntimeUpdate(update, millis());
      }

      if (runtime.phase() == offline::OfflineRuntimePhase::PlanReady) {
        emitMotionPlan(runtime);
        const std::size_t robotBefore = interaction.robotMoves;
        const std::size_t phasesBefore = interaction.verifiedPhases;
        if (!executeInteractionOpponent(
                runtime, adapter, consumedRevision, interaction)) {
          diagnostic.error = interaction.error;
          diagnostic.recoveryRequired = interaction.recoveryRequired;
          diagnostic.motorActivity =
              diagnostic.motorActivity || interaction.motorActivity;
          diagnostic.magnetEverHigh =
              diagnostic.magnetEverHigh || interaction.magnetEverHigh;
          showInteractionStatus(offline::OfflineFeedbackState::Error);
          emitContinuousSummary(diagnostic);
          return;
        }
        diagnostic.robotMoves += interaction.robotMoves - robotBefore;
        diagnostic.verifiedPhases +=
            interaction.verifiedPhases - phasesBefore;
        diagnostic.motorActivity =
            diagnostic.motorActivity || interaction.motorActivity;
        diagnostic.magnetEverHigh =
            diagnostic.magnetEverHigh || interaction.magnetEverHigh;
        diagnostic.magnetLow = interaction.magnetLow;
        if (humanMovePending) {
          diagnostic.completedTurns++;
          humanMovePending = false;
        }

        if (adapter.state() != offline::OfflinePhaseExecutionState::GameOver) {
          offline::Occupancy actual;
          String boundaryError;
          if (!waitForUnifiedTurnBoundary(
                  runtime.coordinator().physical().committedOccupancy(),
                  consumedRevision, actual, boundaryError)) {
            diagnostic.error = boundaryError;
            diagnostic.recoveryRequired = true;
            emitContinuousSummary(diagnostic);
            return;
          }
          const auto boundary = adapter.openNextHumanTurn(actual);
          emitExecutionUpdate(boundary);
          if (boundary.event !=
                  offline::OfflinePhaseExecutionEvent::HumanTurnOpened &&
              boundary.event != offline::OfflinePhaseExecutionEvent::None) {
            diagnostic.error = boundary.message.c_str();
            diagnostic.recoveryRequired = true;
            emitContinuousSummary(diagnostic);
            return;
          }
          showContinuousPositionFeedback(runtime.coordinator().physical().game());
          if (runtime.coordinator().physical().game().inCheck()) {
            vTaskDelay(pdMS_TO_TICKS(1000));
          }
          showInteractionStatus(offline::OfflineFeedbackState::HumanReady);
          emitContinuousEvent("turn", "boundary-opened", diagnostic);
        }
      }

      const auto status = runtime.coordinator().physical().game().status();
      if (runtime.phase() == offline::OfflineRuntimePhase::GameOver ||
          adapter.state() == offline::OfflinePhaseExecutionState::GameOver ||
          status.outcome != offline::GameOutcome::Ongoing) {
        diagnostic.finalFen = runtime.coordinator().physical().game().fen();
        diagnostic.occupiedGraveyards =
            runtime.coordinator().occupiedGraveyardKeys();
        showContinuousPositionFeedback(runtime.coordinator().physical().game());
        const std::string whiteKing = continuousKingSquare(
            runtime.coordinator().physical().game(), "K");
        const std::string blackKing = continuousKingSquare(
            runtime.coordinator().physical().game(), "k");
        const auto ended = session.enterGameOver(
            millis(), runtime.coordinator().physical().committedOccupancy(),
            whiteKing, blackKing);
        if (ended.event != offline::OfflineContinuousEvent::GameEnded) {
          diagnostic.error = ended.message.c_str();
          emitContinuousSummary(diagnostic);
          return;
        }
        emitContinuousEvent(
            "result", offline::outcomeName(status.outcome), diagnostic);
        sessionEnded = true;
      } else if (OFFLINE_CONTINUOUS_FIXTURE == 0 &&
                 diagnostic.completedTurns >= kContinuousAcceptanceTurns &&
                 runtime.phase() == offline::OfflineRuntimePhase::HumanTurn) {
        diagnostic.checkpointReached = true;
        diagnostic.finalFen = runtime.coordinator().physical().game().fen();
        diagnostic.occupiedGraveyards =
            runtime.coordinator().occupiedGraveyardKeys();
        emitContinuousEvent(
            "checkpoint", "twelve-turns", diagnostic,
            "Twelve complete turns verified; game remains open at HumanTurn.");
        emitContinuousSummary(diagnostic);
        return;
      } else if (OFFLINE_CONTINUOUS_FIXTURE == 1 && !firstSession &&
                 diagnostic.completedTurns >= 1 &&
                 runtime.phase() == offline::OfflineRuntimePhase::HumanTurn) {
        diagnostic.terminalResetCompleted = true;
        diagnostic.checkpointReached = true;
        diagnostic.finalFen = runtime.coordinator().physical().game().fen();
        diagnostic.occupiedGraveyards =
            runtime.coordinator().occupiedGraveyardKeys();
        emitContinuousEvent(
            "checkpoint", "black-session-turn", diagnostic,
            "Fresh Human Black session completed one full turn.");
        emitContinuousSummary(diagnostic);
        return;
      }
      vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
    }

    if (!waitForContinuousReset(session, consumedRevision, diagnostic)) {
      if (diagnostic.handoffBoundary) {
        emitContinuousEvent(
            "ownership", "handoff-boundary", diagnostic,
            "Backend returned while the game was over; offline reset stopped.");
        emitContinuousSummary(diagnostic);
        return;
      }
      showInteractionStatus(offline::OfflineFeedbackState::Error);
      emitContinuousSummary(diagnostic);
      return;
    }
    firstSession = false;
    diagnostic.completedTurns = 0;
    diagnostic.humanMoves = 0;
    diagnostic.robotMoves = 0;
    diagnostic.occupiedGraveyards.clear();
  }
}
