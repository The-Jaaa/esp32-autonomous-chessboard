#include "../offline_core/offline_human_promotion.h"
#include "../offline_core/offline_led.h"
#include "../offline_core/offline_runtime.h"
#include "../offline_core/offline_side_selection.h"

#include <iostream>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using offline::HumanColor;
using offline::HumanPromotionSelectionEvent;
using offline::HumanPromotionSelectionState;
using offline::LedFrame;
using offline::Occupancy;
using offline::OfflineFeedbackInput;
using offline::OfflineFeedbackState;
using offline::OfflineHumanPromotionSelector;
using offline::OfflineLedRenderer;
using offline::OfflinePhysicalController;
using offline::OfflineReadOnlyRuntime;
using offline::OfflineRuntimeConfig;
using offline::OfflineRuntimeEvent;
using offline::OfflineRuntimePhase;
using offline::OfflineSideSelectionEvent;
using offline::OfflineSideSelectionState;
using offline::OfflineSideSelector;
using offline::OwnershipDecision;
using offline::OwnershipState;
using offline::PhysicalPhase;

constexpr const char* kStartFen =
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

void setSquare(Occupancy& occupancy, const std::string& square, bool occupied) {
  const int index = offline::squareToRawIndex(square);
  require(index >= 0, "Invalid test square: " + square);
  occupancy[static_cast<std::size_t>(index)] = occupied;
}

std::size_t litPixels(const LedFrame& frame) {
  std::size_t count = 0;
  for (const auto& pixel : frame) {
    if (pixel != offline::led_colors::kOff) ++count;
  }
  return count;
}

std::string frameSignature(const LedFrame& frame) {
  std::string signature;
  signature.reserve(frame.size() * 3);
  for (const auto& pixel : frame) {
    signature.push_back(static_cast<char>(pixel.red));
    signature.push_back(static_cast<char>(pixel.green));
    signature.push_back(static_cast<char>(pixel.blue));
  }
  return signature;
}

void verifyMeasuredMatrixMapping() {
  std::set<int> indices;
  for (std::size_t row = 0; row < 16; ++row) {
    for (std::size_t column = 0; column < 16; ++column) {
      const int index = OfflineLedRenderer::matrixToStripIndex(row, column);
      require(index >= 0 && index < 256, "A matrix coordinate mapped out of bounds.");
      require(indices.insert(index).second, "Two matrix coordinates share a strip pixel.");
      const auto inverse = OfflineLedRenderer::stripIndexToMatrix(
          static_cast<std::size_t>(index));
      require(inverse && inverse->first == row && inverse->second == column,
              "The measured LED mapping did not invert exactly.");
    }
  }
  require(indices.size() == 256, "The matrix mapping is not bijective.");
  require(OfflineLedRenderer::matrixToStripIndex(14, 14) == 3 &&
              OfflineLedRenderer::matrixToStripIndex(14, 15) == 0 &&
              OfflineLedRenderer::matrixToStripIndex(15, 14) == 2 &&
              OfflineLedRenderer::matrixToStripIndex(15, 15) == 1,
          "The distinct H-row orientation changed.");
  require(OfflineLedRenderer::matrixToStripIndex(4, 0) == 160 &&
              OfflineLedRenderer::matrixToStripIndex(4, 1) == 163 &&
              OfflineLedRenderer::matrixToStripIndex(5, 0) == 161 &&
              OfflineLedRenderer::matrixToStripIndex(5, 1) == 162,
          "The distinct C-row orientation changed.");
  require(OfflineLedRenderer::matrixToStripIndex(0, 0) == 225,
          "The A1 top-left calibration point changed.");
  require(OfflineLedRenderer::matrixToStripIndex(16, 0) == -1 &&
              !OfflineLedRenderer::stripIndexToMatrix(256),
          "Out-of-bounds LED coordinates were accepted.");
}

void verifyFeedbackFrames() {
  for (const std::string text : {"WAIT", "SET", "SIDE", "W", "B", "GO", "AI", "ERR", "OK", "DRAW"}) {
    LedFrame frame{};
    require(OfflineLedRenderer::drawCompactText(
                frame, text, offline::led_colors::kAmber) &&
                litPixels(frame) > 0,
            "A required status glyph could not be rendered: " + text);
  }
  LedFrame tooLong{};
  require(!OfflineLedRenderer::drawCompactText(
              tooLong, "HELLO", offline::led_colors::kAmber),
          "An oversized status label was accepted.");

  std::set<std::string> promotionFrames;
  for (const char piece : {'q', 'r', 'b', 'n'}) {
    LedFrame frame{};
    require(OfflineLedRenderer::drawPromotionLetter(
                frame, piece, offline::led_colors::kPurple),
            "A promotion glyph could not be rendered.");
    require(litPixels(frame) > 0 &&
                promotionFrames.insert(frameSignature(frame)).second,
            "Promotion glyphs are empty or not distinct.");
  }

  OfflineFeedbackInput interaction;
  interaction.state = OfflineFeedbackState::HumanInteraction;
  interaction.highlights = {
      {"a1", offline::squareToRawIndex("a1"), offline::HighlightRole::Source},
      {"a2", offline::squareToRawIndex("a2"), offline::HighlightRole::QuietTarget},
      {"a3", offline::squareToRawIndex("a3"), offline::HighlightRole::CaptureTarget},
      {"a4", offline::squareToRawIndex("a4"), offline::HighlightRole::SpecialTarget}};
  const LedFrame interactionFrame = OfflineLedRenderer::render(interaction);
  for (std::size_t offset = 0; offset < 4; ++offset) {
    require(interactionFrame[static_cast<std::size_t>(
                offline::squareToRawIndex("a1") * 4) + offset] ==
                offline::led_colors::kBlue,
            "Source feedback did not color the complete square.");
  }

  OfflineFeedbackInput setup;
  setup.state = OfflineFeedbackState::Setup;
  setup.difference.missing = {"a7"};
  setup.difference.extra = {"b7"};
  setup.detectedSquares = {"a2"};
  const LedFrame setupFrame = OfflineLedRenderer::render(setup);
  require(setupFrame[static_cast<std::size_t>(
              offline::squareToRawIndex("a7") * 4)] == offline::led_colors::kRed &&
              setupFrame[static_cast<std::size_t>(
                  offline::squareToRawIndex("b7") * 4)] == offline::led_colors::kYellow,
          "Setup missing/extra colors changed.");
  require(setupFrame[static_cast<std::size_t>(
              offline::squareToRawIndex("a2") * 4)] == offline::led_colors::kCorrect,
          "Detected setup squares were not shown in green.");

  OfflineFeedbackInput sideSelection{};
  sideSelection.state = OfflineFeedbackState::SideSelection;
  sideSelection.animationOn = true;
  LedFrame expectedSideSelection{};
  OfflineLedRenderer::drawCompactText(
      expectedSideSelection, "SIDE", offline::led_colors::kAmber);
  require(OfflineLedRenderer::render(sideSelection) == expectedSideSelection,
          "Side selection overlays obscure the SIDE label.");

  const std::vector<OfflineFeedbackState> states = {
      OfflineFeedbackState::Wait,
      OfflineFeedbackState::Setup,
      OfflineFeedbackState::SideSelection,
      OfflineFeedbackState::SideSelected,
      OfflineFeedbackState::HumanReady,
      OfflineFeedbackState::HumanInteraction,
      OfflineFeedbackState::EngineThinking,
      OfflineFeedbackState::RobotExecuting,
      OfflineFeedbackState::SyncWarning,
      OfflineFeedbackState::Success,
      OfflineFeedbackState::Check,
      OfflineFeedbackState::Checkmate,
      OfflineFeedbackState::Draw,
      OfflineFeedbackState::PromotionPrompt,
      OfflineFeedbackState::PromotionChoice,
      OfflineFeedbackState::Error};
  for (const auto state : states) {
    OfflineFeedbackInput input;
    input.state = state;
    input.animationOn = true;
    input.selectedColor = HumanColor::White;
    input.highlights = interaction.highlights;
    input.difference = setup.difference;
    input.robotPathSquares = {"a1", "b2"};
    input.checkedKingSquare = "h8";
    input.losingKingSquare = "h8";
    input.winningKingSquare = "a1";
    input.promotionSquare = "a8";
    input.promotionChoice = 'q';
    const LedFrame first = OfflineLedRenderer::render(input);
    const LedFrame second = OfflineLedRenderer::render(input);
    require(first == second && litPixels(first) > 0,
            "A feedback frame was empty or nondeterministic.");
  }
}

void verifySideSelection() {
  const Occupancy setup = offline::occupancyFromFen(kStartFen);
  Occupancy whiteLift = setup;
  setSquare(whiteLift, "e1", false);
  Occupancy blackLift = setup;
  setSquare(blackLift, "e8", false);

  OfflineSideSelector selector;
  require(selector.begin(setup, 100), "Valid side selection did not arm.");
  auto update = selector.processSnapshot(200, whiteLift);
  require(update.state == OfflineSideSelectionState::HoldingChoice &&
              update.event == OfflineSideSelectionEvent::ChoiceStarted &&
              update.candidate == HumanColor::White,
          "White king lift did not begin White selection.");
  require(selector.processSnapshot(1199, whiteLift).state ==
              OfflineSideSelectionState::HoldingChoice,
          "Side selection latched before 1000 ms.");
  update = selector.processSnapshot(1200, whiteLift);
  require(update.state == OfflineSideSelectionState::RestoringSetup &&
              update.event == OfflineSideSelectionEvent::ChoiceLatched,
          "Side selection did not latch at 1000 ms.");
  update = selector.processSnapshot(1300, setup);
  require(update.event == OfflineSideSelectionEvent::RestoreStabilizing,
          "Restoration stability did not start.");
  require(selector.processSnapshot(1799, setup).state ==
              OfflineSideSelectionState::RestoringSetup,
          "Side selection confirmed before 500 ms restoration.");
  update = selector.processSnapshot(1800, setup);
  require(update.state == OfflineSideSelectionState::Complete &&
              update.event == OfflineSideSelectionEvent::ChoiceConfirmed &&
              update.selected == HumanColor::White,
          "White side did not confirm at the exact boundary.");

  selector.begin(setup, 0);
  selector.processSnapshot(1, blackLift);
  update = selector.processSnapshot(500, setup);
  require(update.state == OfflineSideSelectionState::AwaitingChoice &&
              update.event == OfflineSideSelectionEvent::ChoiceCancelled,
          "Early king restoration did not cancel selection.");

  Occupancy disturbed = setup;
  setSquare(disturbed, "a2", false);
  update = selector.processSnapshot(600, disturbed);
  require(update.state == OfflineSideSelectionState::SyncWarning,
          "An unrelated disturbance did not enter SyncWarning.");
  update = selector.processSnapshot(700, setup);
  require(update.state == OfflineSideSelectionState::AwaitingChoice &&
              update.event == OfflineSideSelectionEvent::Recovered,
          "Exact restoration did not recover side selection.");

  const std::uint32_t wrap = 0xFFFFFC00U;
  selector.begin(setup, wrap);
  selector.processSnapshot(wrap + 100U, blackLift);
  require(selector.processSnapshot(wrap + 1099U, blackLift).state ==
              OfflineSideSelectionState::HoldingChoice,
          "Hold timing failed before millis wraparound.");
  update = selector.processSnapshot(wrap + 1100U, blackLift);
  require(update.event == OfflineSideSelectionEvent::ChoiceLatched,
          "Hold timing failed across millis wraparound.");
}

void placePromotion(
    OfflinePhysicalController& controller,
    const std::string& source,
    const std::string& target,
    bool capture,
    char choice) {
  Occupancy occupancy = controller.committedOccupancy();
  setSquare(occupancy, source, false);
  auto update = controller.processSnapshot(occupancy);
  require(update.phase == PhysicalPhase::PieceLifted,
          "Promotion source lift was not recognized.");
  if (capture) {
    setSquare(occupancy, target, false);
    update = controller.processSnapshot(occupancy);
    require(update.phase == PhysicalPhase::CapturePending,
            "Capture-promotion removal was not recognized.");
  }
  setSquare(occupancy, target, true);
  update = controller.processSnapshot(occupancy);
  require(update.phase == PhysicalPhase::PromotionPending &&
              update.humanPromotionRequest &&
              update.humanPromotionRequest->legalChoices ==
                  std::vector<char>({'q', 'r', 'b', 'n'}),
          "Promotion did not expose ordered Q/R/B/N choices.");
  update = controller.confirmPromotion(choice);
  require(update.acceptedMove &&
              update.acceptedMove->uci == source + target + choice,
          "Promotion confirmation committed the wrong move.");
}

void verifyPromotionVariants() {
  struct Fixture {
    const char* fen;
    HumanColor color;
    const char* source;
    const char* target;
    bool capture;
  };
  const std::vector<Fixture> fixtures = {
      {"7k/P7/8/8/8/8/8/7K w - - 0 1", HumanColor::White, "a7", "a8", false},
      {"7k/8/8/8/8/8/p7/7K b - - 0 1", HumanColor::Black, "a2", "a1", false},
      {"1r5k/P7/8/8/8/8/8/7K w - - 0 1", HumanColor::White, "a7", "b8", true},
      {"7k/8/8/8/8/8/p7/1R5K b - - 0 1", HumanColor::Black, "a2", "b1", true}};
  for (const auto& fixture : fixtures) {
    for (const char choice : {'q', 'r', 'b', 'n'}) {
      OfflinePhysicalController controller(fixture.color);
      require(controller.loadFen(fixture.fen), "Promotion fixture FEN was invalid.");
      placePromotion(
          controller, fixture.source, fixture.target, fixture.capture, choice);
    }
  }
}

void verifyPromotionSelectorAndRuntime() {
  OfflineRuntimeConfig config;
  config.initialFen = "7k/P7/8/8/8/8/8/7K w - - 0 1";
  config.setupStableMs = 500;
  config.coordinator.humanColor = HumanColor::White;
  config.coordinator.searchLimits.timeLimitMs = 0;
  config.coordinator.searchLimits.maxNodes = 2000;
  config.coordinator.externalSlots = offline::defaultExternalSlots();
  OfflineReadOnlyRuntime runtime(config);
  Occupancy occupancy = runtime.expectedSetupOccupancy();
  OwnershipDecision offline;
  offline.state = OwnershipState::OfflineIdle;
  offline.allowOfflineControl = true;
  runtime.applyOwnershipDecision(0, offline, occupancy);
  auto update = runtime.applyOwnershipDecision(500, offline, occupancy);
  require(update.phase == OfflineRuntimePhase::HumanTurn,
          "Promotion runtime did not arm.");

  setSquare(occupancy, "a7", false);
  runtime.processStableSnapshot(501, occupancy);
  setSquare(occupancy, "a8", true);
  update = runtime.processStableSnapshot(502, occupancy);
  require(update.phase == OfflineRuntimePhase::HumanPromotionPending &&
              update.event == OfflineRuntimeEvent::HumanPromotionRequired &&
              update.humanPromotionRequest && !runtime.pendingEngineRequest(),
          "Human promotion was not held uncommitted.");
  const std::string beforeFen = update.committedFen;
  const auto promotionRequest = *update.humanPromotionRequest;

  OfflineHumanPromotionSelector selector;
  require(selector.begin(promotionRequest, 1000),
          "Promotion selector did not arm.");
  Occupancy emptyTarget = occupancy;
  setSquare(emptyTarget, "a8", false);
  auto selection = selector.processSnapshot(1100, emptyTarget);
  require(selection.state == HumanPromotionSelectionState::Cycling &&
              selection.displayedChoice == 'q',
          "Pawn removal did not start at queen.");
  require(selector.tick(3599).displayedChoice == 'q' &&
              selector.tick(3600).displayedChoice == 'r' &&
              selector.tick(6100).displayedChoice == 'b' &&
              selector.tick(8600).displayedChoice == 'n',
          "Q/R/B/N timing boundaries changed.");
  selection = selector.processSnapshot(8600, occupancy);
  require(selection.event == HumanPromotionSelectionEvent::ChoiceLatched &&
              selection.displayedChoice == 'n',
          "Single placement did not latch knight.");
  require(selector.tick(9099).state ==
              HumanPromotionSelectionState::ConfirmingPlacement,
          "Promotion confirmed before 500 ms.");
  selection = selector.tick(9100);
  require(selection.state == HumanPromotionSelectionState::Complete &&
              selection.confirmedChoice == std::optional<char>('n'),
          "Promotion did not confirm after 500 ms.");
  require(runtime.currentState().committedFen == beforeFen,
          "Promotion changed FEN before runtime confirmation.");
  update = runtime.confirmHumanPromotion('n');
  require(update.event == OfflineRuntimeEvent::HumanPromotionConfirmed &&
              update.acceptedMove && update.acceptedMove->uci == "a7a8n" &&
              update.committedFen == "N6k/8/8/8/8/8/8/7K b - - 0 1" &&
              update.gameStatus.outcome == offline::GameOutcome::InsufficientMaterial,
          "Confirmed promotion produced incorrect state.");

  require(!update.humanPromotionRequest,
          "Completed runtime unexpectedly exposed a promotion request.");

  OfflineHumanPromotionSelector wrappingSelector;
  const std::uint32_t wrapStart = 0xFFFFFF00U;
  require(wrappingSelector.begin(promotionRequest, wrapStart),
          "Wraparound promotion selector did not arm.");
  require(wrappingSelector.processSnapshot(wrapStart + 10U, emptyTarget)
              .displayedChoice == 'q' &&
              wrappingSelector.tick(wrapStart + 2509U).displayedChoice == 'q' &&
              wrappingSelector.tick(wrapStart + 2510U).displayedChoice == 'r',
          "Promotion cycling failed across millis wraparound.");
}

void verifyHumanBlackOpeningRequest() {
  OfflineRuntimeConfig config;
  config.initialFen = kStartFen;
  config.setupStableMs = 500;
  config.coordinator.humanColor = HumanColor::Black;
  config.coordinator.searchLimits.timeLimitMs = 0;
  config.coordinator.searchLimits.maxNodes = 2000;
  config.coordinator.externalSlots = offline::defaultExternalSlots();
  OfflineReadOnlyRuntime runtime(config);
  const Occupancy occupancy = runtime.expectedSetupOccupancy();
  require(!runtime.pendingEngineRequest() &&
              !runtime.currentState().engineRequest,
          "Human Black exposed an engine request before setup began.");
  OwnershipDecision offline;
  offline.state = OwnershipState::OfflineIdle;
  offline.allowOfflineControl = true;
  const auto stabilizing = runtime.applyOwnershipDecision(0, offline, occupancy);
  require(stabilizing.phase == OfflineRuntimePhase::WaitingForSetup &&
              !stabilizing.engineRequest && !runtime.pendingEngineRequest(),
          "Human Black exposed an engine request before setup stabilized.");
  const auto armed = runtime.applyOwnershipDecision(500, offline, occupancy);
  require(armed.phase == OfflineRuntimePhase::EngineSearchNeeded &&
              armed.engineRequest,
          "Human Black did not queue exactly one White opener.");
  const std::uint32_t openingGeneration = armed.engineRequest->generation;
  const auto duplicate = runtime.applyOwnershipDecision(1000, offline, occupancy);
  require(duplicate.engineRequest &&
              duplicate.engineRequest->generation == openingGeneration,
          "Duplicate setup processing queued another White opener.");
}

}  // namespace

int main() {
  try {
    verifyMeasuredMatrixMapping();
    verifyFeedbackFrames();
    verifySideSelection();
    verifyPromotionVariants();
    verifyPromotionSelectorAndRuntime();
    verifyHumanBlackOpeningRequest();
    std::cout << "offline interaction regressions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline interaction regression failed: " << error.what() << '\n';
    return 1;
  }
}
