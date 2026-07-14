#include "offline_embedded_diagnostics.h"

#if ENABLE_OFFLINE_EMBEDDED_DIAGNOSTICS

#include <OfflineCore.h>

#include <WiFi.h>
#include <esp_heap_caps.h>
#include <esp_memory_utils.h>
#include <esp_rom_sys.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace {

constexpr std::size_t kDiagnosticStackBytes = 49152;
constexpr std::uint32_t kSerialAttachTimeoutMs = 15000;
constexpr std::uint32_t kDiagnosticStartupDelayMs = 3000;
constexpr std::size_t kMinimumInternalHeapBytes = 96 * 1024;
constexpr std::size_t kMinimumLargestInternalBlockBytes = 64 * 1024;
constexpr std::size_t kMinimumFreePsramBytes = 5 * 1024 * 1024;
constexpr std::size_t kMinimumStackHeadroomBytes = 2 * 1024;
constexpr std::uint32_t kMaximumSensorGapMs = 25;
constexpr std::uint32_t kSearchOverrunAllowanceMs = 100;

constexpr const char* kStartFen =
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
constexpr const char* kMiddlegameFen =
    "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 1";

bool overallPass = true;

void emitPhase(const char* name) {
  esp_rom_printf("[OFFLINE_DIAG] {\"type\":\"phase\",\"name\":\"%s\"}\n", name);
}

void emitCheck(const char* name, bool pass) {
  if (!pass) overallPass = false;
  esp_rom_printf(
      "[OFFLINE_DIAG] {\"type\":\"check\",\"name\":\"%s\",\"pass\":%s}\n",
      name,
      pass ? "true" : "false");
}

void emitSearch(const char* name, const offline::SearchResult& result, bool pass) {
  if (!pass) overallPass = false;
  esp_rom_printf(
      "[OFFLINE_DIAG] {\"type\":\"search\",\"name\":\"%s\",\"pass\":%s,"
      "\"move\":\"%s\",\"depth\":%d,\"nodes\":%llu,\"elapsedMs\":%u,"
      "\"stopReason\":\"%s\"}\n",
      name,
      pass ? "true" : "false",
      result.bestMove.c_str(),
      result.completedDepth,
      static_cast<unsigned long long>(result.nodes),
      result.elapsedMs,
      offline::searchStopReasonName(result.stopReason));
}

void emitMemory(
    const char* name,
    std::size_t internalFree,
    std::size_t largestInternal,
    std::size_t minimumInternal,
    std::size_t psramFree,
    std::size_t stackHeadroom) {
  esp_rom_printf(
      "[OFFLINE_DIAG] {\"type\":\"memory\",\"name\":\"%s\","
      "\"internalFree\":%u,\"largestInternal\":%u,\"minimumInternal\":%u,"
      "\"psramFree\":%u,\"stackHeadroom\":%u}\n",
      name,
      static_cast<unsigned>(internalFree),
      static_cast<unsigned>(largestInternal),
      static_cast<unsigned>(minimumInternal),
      static_cast<unsigned>(psramFree),
      static_cast<unsigned>(stackHeadroom));
}

bool legalSearchMove(const char* fen, const offline::SearchResult& result) {
  if (!result.hasMove()) return false;
  offline::OfflineGame game;
  offline::MoveInfo move;
  return game.loadFen(fen) && game.describeLegalMove(result.bestMove, move);
}

bool runRulesSmoke() {
  offline::OfflineGame game;
  const std::string originalFen = game.fen();
  offline::MoveInfo move;
  if (game.legalMovesUci().size() != 20 || !game.applyUci("e2e4", move) || move.san != "e4") {
    return false;
  }
  if (!game.undo() || game.fen() != originalFen) return false;

  if (!game.loadFen("7k/P7/8/8/8/8/8/7K w - - 0 1")) return false;
  if (!game.applyUci("a7a8n", move)) return false;
  return move.promotion == "n";
}

bool runPhysicalSmoke() {
  offline::OfflinePhysicalController controller(offline::HumanColor::White);
  offline::Occupancy occupancy = controller.committedOccupancy();
  const int source = offline::squareToRawIndex("e2");
  const int target = offline::squareToRawIndex("e4");
  if (source < 0 || target < 0 || offline::rawIndexToSquare(56) != "a1") return false;

  occupancy[static_cast<std::size_t>(source)] = false;
  const auto lifted = controller.processSnapshot(occupancy);
  if (lifted.phase != offline::PhysicalPhase::PieceLifted) return false;

  occupancy[static_cast<std::size_t>(target)] = true;
  const auto accepted = controller.processSnapshot(occupancy);
  return accepted.event == offline::PhysicalEvent::MoveAccepted &&
         accepted.acceptedMove.has_value() && accepted.acceptedMove->uci == "e2e4";
}

bool runRouteSmoke() {
  offline::Occupancy occupancy{};
  occupancy[static_cast<std::size_t>(offline::squareToRawIndex("a1"))] = true;

  offline::BoardRouteRequest boardRequest;
  boardRequest.from = "a1";
  boardRequest.to = "a4";
  boardRequest.expectedOccupancy = occupancy;
  const auto boardRoute = offline::OfflineBoardRoutePlanner{}.plan(boardRequest);
  if (!boardRoute.success() || boardRoute.compressedPathSquares.back() != "a4") return false;

  offline::ExternalTransferRequest laneRequest;
  laneRequest.from = "a1";
  laneRequest.to = "a8";
  laneRequest.expectedOccupancy = occupancy;
  laneRequest.slots = offline::defaultExternalSlots();
  laneRequest.forceLane = true;
  const auto laneRoute = offline::OfflineExternalRoutePlanner{}.planTransfer(laneRequest);
  if (!laneRoute.success() || laneRoute.mode != offline::ExternalRouteMode::Lane) return false;

  offline::GraveyardRouteRequest graveyardRequest;
  graveyardRequest.sourceSquare = "a1";
  graveyardRequest.expectedOccupancy = occupancy;
  graveyardRequest.slots = offline::defaultExternalSlots();
  const auto graveyard =
      offline::OfflineExternalRoutePlanner{}.planGraveyardRemoval(graveyardRequest);
  return graveyard.success() && graveyard.selected.has_value();
}

bool runMotionSmoke() {
  const auto slots = offline::defaultExternalSlots();
  offline::MotionPlanningContext context;
  context.slots = slots;

  offline::OfflineGame captureGame;
  if (!captureGame.loadFen("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1")) return false;
  context.sensedOccupancy = offline::occupancyFromFen(captureGame.fen());
  const auto capture = offline::OfflineMotionPlanner{}.planMove(captureGame, "e5d6", context);
  if (!capture.success() || capture.phases.size() < 2 || !capture.proposedGraveyardSlot.has_value()) {
    return false;
  }

  offline::OfflineGame castleGame;
  if (!castleGame.loadFen("4k2r/8/8/8/8/8/8/4K3 b k - 0 1")) return false;
  context.sensedOccupancy = offline::occupancyFromFen(castleGame.fen());
  const auto castle = offline::OfflineMotionPlanner{}.planMove(castleGame, "e8g8", context);
  if (!castle.success() || castle.phases.size() != 2 || !castle.move.castling) return false;

  offline::OfflineGame promotionGame;
  if (!promotionGame.loadFen("7k/P7/8/8/8/8/8/7K w - - 0 1")) return false;
  context.sensedOccupancy = offline::occupancyFromFen(promotionGame.fen());
  const auto promotion =
      offline::OfflineMotionPlanner{}.planMove(promotionGame, "a7a8q", context);
  return promotion.success() && promotion.move.promotion == "q";
}

bool runCoordinatorSmoke(const offline::SearchResult& openingSearch) {
  offline::OfflineCoordinatorConfig config;
  config.humanColor = offline::HumanColor::Black;
  config.externalSlots = offline::defaultExternalSlots();
  config.searchLimits.timeLimitMs = 0;
  config.searchLimits.maxNodes = 2000;
  config.searchLimits.maxDepth = 12;

  offline::OfflineTurnCoordinator coordinator(config);
  const auto request = coordinator.pendingEngineRequest();
  if (!request.has_value()) return false;

  const auto staged = coordinator.submitEngineResult(
      request->generation, openingSearch, coordinator.physical().committedOccupancy());
  if (staged.phase != offline::OfflineTurnPhase::OpponentMoveReady ||
      !staged.motionTransaction.has_value()) {
    return false;
  }

  const auto started = coordinator.beginOpponentExecution();
  if (started.phase != offline::OfflineTurnPhase::OpponentMoveExecuting) return false;

  const auto transaction = coordinator.pendingMotionTransaction();
  if (!transaction.has_value()) return false;
  const auto completed = coordinator.completeOpponentExecution(
      transaction->motion.finalExpectedOccupancy);
  return completed.phase == offline::OfflineTurnPhase::HumanTurn &&
         completed.acceptedMove.has_value();
}

bool runCoordinatorPromotionSmoke() {
  offline::OfflineCoordinatorConfig config;
  config.humanColor = offline::HumanColor::Black;
  config.externalSlots = offline::defaultExternalSlots();
  offline::OfflineTurnCoordinator coordinator(config);
  if (!coordinator.loadFen("7k/P7/8/8/8/8/8/7K w - - 0 1")) return false;

  const auto request = coordinator.pendingEngineRequest();
  if (!request.has_value()) return false;

  offline::SearchResult result;
  result.bestMove = "a7a8q";
  result.score = 900;
  result.completedDepth = 1;
  result.nodes = 1;
  result.stopReason = offline::SearchStopReason::DepthLimit;
  result.rankedRootMoves.push_back({"a7a8q", 900, 0});

  const auto staged = coordinator.submitEngineResult(
      request->generation, result, coordinator.physical().committedOccupancy());
  if (staged.phase != offline::OfflineTurnPhase::OpponentMoveReady) return false;
  if (coordinator.beginOpponentExecution().phase !=
      offline::OfflineTurnPhase::OpponentMoveExecuting) {
    return false;
  }

  const auto transaction = coordinator.pendingMotionTransaction();
  if (!transaction.has_value()) return false;
  const offline::Occupancy expected = transaction->motion.finalExpectedOccupancy;
  const auto moved = coordinator.completeOpponentExecution(expected);
  if (moved.phase != offline::OfflineTurnPhase::OpponentPromotionPending) return false;

  offline::Occupancy replacement = expected;
  replacement[static_cast<std::size_t>(offline::squareToRawIndex("a8"))] = false;
  const auto replacing = coordinator.processOpponentPromotionSnapshot(replacement);
  if (replacing.event !=
      offline::OfflineTurnEvent::OpponentPromotionReplacementInProgress) {
    return false;
  }

  const auto ready = coordinator.processOpponentPromotionSnapshot(expected);
  if (ready.event != offline::OfflineTurnEvent::OpponentPromotionConfirmationReady) return false;
  const auto confirmed = coordinator.confirmOpponentPromotion('q', expected);
  return confirmed.phase == offline::OfflineTurnPhase::HumanTurn &&
         confirmed.acceptedMove.has_value() && confirmed.acceptedMove->promotion == "q";
}

offline::SearchResult runTimedSearch(
    const offline::OfflineEngine& engine,
    const char* name,
    const char* fen,
    std::uint32_t timeLimitMs) {
  offline::SearchLimits limits;
  limits.timeLimitMs = timeLimitMs;
  limits.maxDepth = 12;
  const auto result = engine.searchFen(fen, limits);
  const bool pass = legalSearchMove(fen, result) &&
                    result.elapsedMs <= timeLimitMs + kSearchOverrunAllowanceMs;
  emitSearch(name, result, pass);
  return result;
}

void diagnosticTask(void*) {
  const std::uint32_t serialWaitStartedAt = millis();
  while (!Serial && millis() - serialWaitStartedAt < kSerialAttachTimeoutMs) {
    vTaskDelay(pdMS_TO_TICKS(50));
  }
  emitPhase("task-started");
  vTaskDelay(pdMS_TO_TICKS(kDiagnosticStartupDelayMs));
  const std::uint32_t startedAt = millis();
  esp_rom_printf(
      "[OFFLINE_DIAG] {\"type\":\"start\",\"motorsLocked\":true,"
      "\"core\":0,\"priority\":0}\n");

  emitCheck("psram-found", psramFound());
  if (!psramFound()) {
    esp_rom_printf("[OFFLINE_DIAG] {\"type\":\"summary\",\"pass\":false}\n");
    vTaskDelete(nullptr);
    return;
  }

  const std::size_t psramBefore = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  emitPhase("attack-table-initialization");
  const std::uint32_t tableStartedAt = millis();
  chess::attacks::initAttacks();
  const bool tablesReady = chess::attacks::embeddedAttackTablesReady();
  const bool rookInPsram =
      tablesReady && esp_ptr_external_ram(chess::attacks::embeddedRookAttackTable());
  const bool bishopInPsram =
      tablesReady && esp_ptr_external_ram(chess::attacks::embeddedBishopAttackTable());
  chess::movegen::initEmbeddedBetweenTable();
  const std::uint32_t tableInitMs = millis() - tableStartedAt;
  const bool betweenReady = chess::movegen::embeddedBetweenTableReady();
  const bool betweenInPsram =
      betweenReady && esp_ptr_external_ram(chess::movegen::embeddedBetweenTable());
  emitCheck("attack-tables-ready", tablesReady);
  emitCheck("rook-table-in-psram", rookInPsram);
  emitCheck("bishop-table-in-psram", bishopInPsram);
  emitCheck("between-table-ready", betweenReady);
  emitCheck("between-table-in-psram", betweenInPsram);
  esp_rom_printf(
      "[OFFLINE_DIAG] {\"type\":\"attackTables\",\"bytes\":%u,"
      "\"betweenBytes\":%u,\"initMs\":%u,\"psramBefore\":%u,"
      "\"psramAfter\":%u}\n",
      static_cast<unsigned>(chess::attacks::embeddedAttackTableBytes()),
      static_cast<unsigned>(chess::movegen::embeddedBetweenTableBytes()),
      tableInitMs,
      static_cast<unsigned>(psramBefore),
      static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));
  if (!tablesReady || !rookInPsram || !bishopInPsram || !betweenReady ||
      !betweenInPsram) {
    esp_rom_printf("[OFFLINE_DIAG] {\"type\":\"summary\",\"pass\":false}\n");
    vTaskDelete(nullptr);
    return;
  }

  emitPhase("rules-smoke");
  emitCheck("rules-apply-undo-promotion", runRulesSmoke());
  emitPhase("physical-smoke");
  emitCheck("physical-interpreter", runPhysicalSmoke());
  emitPhase("route-smoke");
  emitCheck("board-lane-graveyard-routes", runRouteSmoke());
  emitPhase("motion-smoke");
  emitCheck("capture-castling-promotion-motion", runMotionSmoke());

  const std::uint32_t pollsBeforeSearch = offlineDiagnosticSuccessfulPollCount;
  const std::uint32_t scansBeforeSearch = offlineDiagnosticSensorScanCount;
  offlineDiagnosticSensorMaxGapMs = 0;

  emitPhase("node-limited-searches");
  offline::OfflineEngine engine;
  offline::SearchLimits nodeLimits;
  nodeLimits.timeLimitMs = 0;
  nodeLimits.maxNodes = 2000;
  nodeLimits.maxDepth = 12;
  const auto deterministicA = engine.searchFen(kStartFen, nodeLimits);
  const auto deterministicB = engine.searchFen(kStartFen, nodeLimits);
  const bool deterministic = legalSearchMove(kStartFen, deterministicA) &&
                             deterministicA.bestMove == deterministicB.bestMove &&
                             deterministicA.score == deterministicB.score &&
                             deterministicA.completedDepth == deterministicB.completedDepth;
  emitSearch("node-2000-a", deterministicA, deterministic);
  emitSearch("node-2000-b", deterministicB, deterministic);
  emitCheck("coordinator-transaction", runCoordinatorSmoke(deterministicA));
  emitCheck("coordinator-promotion", runCoordinatorPromotionSmoke());

  emitPhase("timed-searches");
  runTimedSearch(engine, "opening-250ms", kStartFen, 250);
  runTimedSearch(engine, "middlegame-250ms", kMiddlegameFen, 250);
  runTimedSearch(engine, "opening-1000ms", kStartFen, 1000);
  runTimedSearch(engine, "middlegame-1000ms", kMiddlegameFen, 1000);
  runTimedSearch(engine, "opening-3000ms", kStartFen, 3000);
  runTimedSearch(engine, "middlegame-3000ms", kMiddlegameFen, 3000);

  emitPhase("resource-summary");
  const std::size_t internalFree =
      heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t largestInternal =
      heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t minimumInternal =
      heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t psramFree = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  const std::size_t stackHeadroom = uxTaskGetStackHighWaterMark(nullptr);
  emitMemory(
      "final",
      internalFree,
      largestInternal,
      minimumInternal,
      psramFree,
      stackHeadroom);

  emitCheck("internal-heap-threshold", internalFree >= kMinimumInternalHeapBytes);
  emitCheck(
      "largest-internal-block-threshold",
      largestInternal >= kMinimumLargestInternalBlockBytes);
  emitCheck("psram-threshold", psramFree >= kMinimumFreePsramBytes);
  emitCheck("stack-threshold", stackHeadroom >= kMinimumStackHeadroomBytes);
  emitCheck(
      "sensor-loop-progress",
      offlineDiagnosticSensorScanCount > scansBeforeSearch &&
          offlineDiagnosticSensorMaxGapMs <= kMaximumSensorGapMs);
  emitCheck(
      "http-poll-progress",
      WiFi.status() == WL_CONNECTED &&
          offlineDiagnosticSuccessfulPollCount > pollsBeforeSearch);

  esp_rom_printf(
      "[OFFLINE_DIAG] {\"type\":\"timing\",\"sensorScans\":%u,"
      "\"sensorMaxGapMs\":%u,\"successfulPolls\":%u,\"totalElapsedMs\":%u}\n",
      static_cast<unsigned>(offlineDiagnosticSensorScanCount - scansBeforeSearch),
      static_cast<unsigned>(offlineDiagnosticSensorMaxGapMs),
      static_cast<unsigned>(offlineDiagnosticSuccessfulPollCount - pollsBeforeSearch),
      millis() - startedAt);
  esp_rom_printf(
      "[OFFLINE_DIAG] {\"type\":\"summary\",\"pass\":%s}\n",
      overallPass ? "true" : "false");

  vTaskDelete(nullptr);
}

}  // namespace

volatile uint32_t offlineDiagnosticSensorScanCount = 0;
volatile uint32_t offlineDiagnosticSensorMaxGapMs = 0;
volatile uint32_t offlineDiagnosticSuccessfulPollCount = 0;

void beginOfflineEmbeddedDiagnostics() {
  const BaseType_t created = xTaskCreatePinnedToCore(
      diagnosticTask,
      "offlineDiagnostics",
      kDiagnosticStackBytes,
      nullptr,
      tskIDLE_PRIORITY,
      nullptr,
      0);
  if (created != pdPASS) {
    esp_rom_printf(
        "[OFFLINE_DIAG] {\"type\":\"summary\",\"pass\":false,"
        "\"error\":\"task-create-failed\"}\n");
  }
}

#endif
