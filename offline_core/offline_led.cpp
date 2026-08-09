#include "offline_led.h"

#include <array>
#include <cctype>

namespace offline {
namespace {

using Glyph3x5 = std::array<std::uint8_t, 5>;
using Glyph7x9 = std::array<std::uint8_t, 9>;

constexpr std::array<Glyph3x5, 26> kCompactLetters = {{
    {{0b010, 0b101, 0b111, 0b101, 0b101}},
    {{0b110, 0b101, 0b110, 0b101, 0b110}},
    {{0b011, 0b100, 0b100, 0b100, 0b011}},
    {{0b110, 0b101, 0b101, 0b101, 0b110}},
    {{0b111, 0b100, 0b110, 0b100, 0b111}},
    {{0b111, 0b100, 0b110, 0b100, 0b100}},
    {{0b011, 0b100, 0b101, 0b101, 0b011}},
    {{0b101, 0b101, 0b111, 0b101, 0b101}},
    {{0b111, 0b010, 0b010, 0b010, 0b111}},
    {{0b001, 0b001, 0b001, 0b101, 0b010}},
    {{0b101, 0b101, 0b110, 0b101, 0b101}},
    {{0b100, 0b100, 0b100, 0b100, 0b111}},
    {{0b101, 0b111, 0b111, 0b101, 0b101}},
    {{0b101, 0b111, 0b111, 0b111, 0b101}},
    {{0b010, 0b101, 0b101, 0b101, 0b010}},
    {{0b110, 0b101, 0b110, 0b100, 0b100}},
    {{0b010, 0b101, 0b101, 0b111, 0b011}},
    {{0b110, 0b101, 0b110, 0b101, 0b101}},
    {{0b011, 0b100, 0b010, 0b001, 0b110}},
    {{0b111, 0b010, 0b010, 0b010, 0b010}},
    {{0b101, 0b101, 0b101, 0b101, 0b111}},
    {{0b101, 0b101, 0b101, 0b101, 0b010}},
    {{0b101, 0b101, 0b111, 0b111, 0b101}},
    {{0b101, 0b101, 0b010, 0b101, 0b101}},
    {{0b101, 0b101, 0b010, 0b010, 0b010}},
    {{0b111, 0b001, 0b010, 0b100, 0b111}},
}};

constexpr Glyph7x9 kLargeQueen =
    {{0x3E, 0x41, 0x41, 0x41, 0x41, 0x49, 0x45, 0x3E, 0x03}};
constexpr Glyph7x9 kLargeRook =
    {{0x7E, 0x41, 0x41, 0x41, 0x7E, 0x48, 0x44, 0x42, 0x41}};
constexpr Glyph7x9 kLargeBishop =
    {{0x7E, 0x41, 0x41, 0x41, 0x7E, 0x41, 0x41, 0x41, 0x7E}};
constexpr Glyph7x9 kLargeKnight =
    {{0x41, 0x61, 0x61, 0x51, 0x49, 0x45, 0x43, 0x43, 0x41}};

const Glyph7x9* promotionGlyph(char piece) {
  switch (static_cast<char>(std::tolower(static_cast<unsigned char>(piece)))) {
    case 'q': return &kLargeQueen;
    case 'r': return &kLargeRook;
    case 'b': return &kLargeBishop;
    case 'n': return &kLargeKnight;
    default: return nullptr;
  }
}

LedColor highlightColor(HighlightRole role) {
  switch (role) {
    case HighlightRole::Source: return led_colors::kBlue;
    case HighlightRole::QuietTarget: return led_colors::kGreen;
    case HighlightRole::CaptureTarget: return led_colors::kRed;
    case HighlightRole::SpecialTarget:
    case HighlightRole::RookSource:
    case HighlightRole::RookTarget: return led_colors::kPurple;
    case HighlightRole::Missing: return led_colors::kRed;
    case HighlightRole::Extra: return led_colors::kYellow;
  }
  return led_colors::kOff;
}

void drawHighlights(LedFrame& frame, const std::vector<Highlight>& highlights) {
  for (const Highlight& highlight : highlights) {
    OfflineLedRenderer::setSquareColor(
        frame, highlight.square, highlightColor(highlight.role));
  }
}

void drawDifference(LedFrame& frame, const OccupancyDiff& difference) {
  for (const std::string& square : difference.missing) {
    OfflineLedRenderer::setSquareColor(frame, square, led_colors::kRed);
  }
  for (const std::string& square : difference.extra) {
    OfflineLedRenderer::setSquareColor(frame, square, led_colors::kYellow);
  }
}

void drawKingHalo(LedFrame& frame, std::string_view square, LedColor color) {
  if (square.size() != 2) return;
  const int file = square[0] - 'a';
  const int rank = square[1] - '1';
  for (int fileDelta = -1; fileDelta <= 1; ++fileDelta) {
    for (int rankDelta = -1; rankDelta <= 1; ++rankDelta) {
      if (fileDelta == 0 && rankDelta == 0) continue;
      const int nextFile = file + fileDelta;
      const int nextRank = rank + rankDelta;
      if (nextFile < 0 || nextFile >= 8 || nextRank < 0 || nextRank >= 8) {
        continue;
      }
      const std::string neighbor{
          static_cast<char>('a' + nextFile),
          static_cast<char>('1' + nextRank)};
      OfflineLedRenderer::setSquareColor(frame, neighbor, color);
    }
  }
}

}  // namespace

int OfflineLedRenderer::matrixToStripIndex(
    std::size_t row, std::size_t column) {
  if (row >= kHeight || column >= kWidth) return -1;
  const int fileIndex = static_cast<int>(row / 2);  // A through H.
  const int rank = static_cast<int>(column / 2) + 1;
  const int rawGroup = 7 - fileIndex;
  const int rankOffset = (rawGroup % 2 == 0) ? (8 - rank) : (rank - 1);
  const int rawSquare = rawGroup * 8 + rankOffset;
  const int localPosition = static_cast<int>((row % 2) * 2 + column % 2);
  static constexpr std::uint8_t kOffsetsByFile[8][4] = {
      {1, 2, 0, 3}, {2, 1, 3, 0}, {0, 3, 1, 2}, {2, 1, 3, 0},
      {1, 2, 0, 3}, {2, 1, 3, 0}, {1, 2, 0, 3}, {3, 0, 2, 1}};
  return rawSquare * 4 + kOffsetsByFile[fileIndex][localPosition];
}

std::optional<std::pair<std::size_t, std::size_t>>
OfflineLedRenderer::stripIndexToMatrix(std::size_t stripIndex) {
  if (stripIndex >= 256) return std::nullopt;
  for (std::size_t row = 0; row < kHeight; ++row) {
    for (std::size_t column = 0; column < kWidth; ++column) {
      if (matrixToStripIndex(row, column) == static_cast<int>(stripIndex)) {
        return std::make_pair(row, column);
      }
    }
  }
  return std::nullopt;
}

void OfflineLedRenderer::clear(LedFrame& frame) {
  frame.fill(led_colors::kOff);
}

bool OfflineLedRenderer::setMatrixPixel(
    LedFrame& frame, std::size_t row, std::size_t column, LedColor color) {
  const int index = matrixToStripIndex(row, column);
  if (index < 0) return false;
  frame[static_cast<std::size_t>(index)] = color;
  return true;
}

bool OfflineLedRenderer::setSquareColor(
    LedFrame& frame, std::string_view square, LedColor color) {
  const int rawIndex = squareToRawIndex(square);
  if (rawIndex < 0) return false;
  const std::size_t base = static_cast<std::size_t>(rawIndex) * 4;
  for (std::size_t offset = 0; offset < 4; ++offset) {
    frame[base + offset] = color;
  }
  return true;
}

bool OfflineLedRenderer::drawCompactText(
    LedFrame& frame, std::string_view text, LedColor color) {
  if (text.empty() || text.size() > 4) return false;
  const std::size_t width = text.size() * 3 + text.size() - 1;
  const std::size_t left = (kWidth - width) / 2;
  const std::size_t top = (kHeight - 5) / 2;
  for (std::size_t character = 0; character < text.size(); ++character) {
    const char normalized = static_cast<char>(
        std::toupper(static_cast<unsigned char>(text[character])));
    if (normalized < 'A' || normalized > 'Z') return false;
    const Glyph3x5& glyph =
        kCompactLetters[static_cast<std::size_t>(normalized - 'A')];
    for (std::size_t row = 0; row < glyph.size(); ++row) {
      for (std::size_t column = 0; column < 3; ++column) {
        if ((glyph[row] & (1U << (2U - column))) != 0) {
          setMatrixPixel(frame, top + row, left + character * 4 + column, color);
        }
      }
    }
  }
  return true;
}

bool OfflineLedRenderer::drawPromotionLetter(
    LedFrame& frame, char piece, LedColor color) {
  const Glyph7x9* glyph = promotionGlyph(piece);
  if (!glyph) return false;
  constexpr std::size_t top = 3;
  constexpr std::size_t left = 4;
  for (std::size_t row = 0; row < glyph->size(); ++row) {
    for (std::size_t column = 0; column < 7; ++column) {
      if (((*glyph)[row] & (1U << (6U - column))) != 0) {
        setMatrixPixel(frame, top + row, left + column, color);
      }
    }
  }
  return true;
}

LedFrame OfflineLedRenderer::render(const OfflineFeedbackInput& input) {
  LedFrame frame{};
  clear(frame);
  switch (input.state) {
    case OfflineFeedbackState::Clear:
      break;
    case OfflineFeedbackState::Wait:
      drawCompactText(frame, "WAIT", led_colors::kAmber);
      break;
    case OfflineFeedbackState::Setup:
      drawCompactText(frame, "SET", led_colors::kAmber);
      drawDifference(frame, input.difference);
      break;
    case OfflineFeedbackState::SideSelection:
      drawCompactText(frame, "SIDE", led_colors::kAmber);
      if (input.animationOn) {
        setSquareColor(frame, "e1", led_colors::kWhite);
        setSquareColor(frame, "e8", led_colors::kBlue);
      }
      break;
    case OfflineFeedbackState::SideSelected:
      if (input.selectedColor) {
        drawCompactText(
            frame,
            *input.selectedColor == HumanColor::White ? "W" : "B",
            led_colors::kGreen);
      }
      break;
    case OfflineFeedbackState::HumanReady:
      drawCompactText(frame, "GO", led_colors::kGreen);
      break;
    case OfflineFeedbackState::HumanInteraction:
      drawHighlights(frame, input.highlights);
      break;
    case OfflineFeedbackState::EngineThinking:
      if (input.animationOn) drawCompactText(frame, "AI", led_colors::kBlue);
      break;
    case OfflineFeedbackState::RobotExecuting:
      for (const std::string& square : input.robotPathSquares) {
        setSquareColor(frame, square, led_colors::kCyan);
      }
      drawHighlights(frame, input.highlights);
      break;
    case OfflineFeedbackState::SyncWarning:
      drawCompactText(frame, "ERR", led_colors::kRed);
      drawDifference(frame, input.difference);
      break;
    case OfflineFeedbackState::Success:
      drawCompactText(frame, "OK", led_colors::kGreen);
      break;
    case OfflineFeedbackState::Check:
      if (input.checkedKingSquare && input.animationOn) {
        setSquareColor(frame, *input.checkedKingSquare, led_colors::kRed);
      }
      break;
    case OfflineFeedbackState::Checkmate:
      if (input.losingKingSquare) {
        drawKingHalo(frame, *input.losingKingSquare, led_colors::kRed);
        setSquareColor(
            frame, *input.losingKingSquare,
            input.animationOn ? led_colors::kRed : led_colors::kOff);
      }
      if (input.winningKingSquare) {
        drawKingHalo(frame, *input.winningKingSquare, led_colors::kGreen);
        setSquareColor(
            frame, *input.winningKingSquare,
            input.animationOn ? led_colors::kBlue : led_colors::kOff);
      }
      break;
    case OfflineFeedbackState::Draw:
      drawCompactText(
          frame, "DRAW",
          input.animationOn ? led_colors::kYellow : led_colors::kPurple);
      break;
    case OfflineFeedbackState::PromotionPrompt:
      drawCompactText(frame, "P", led_colors::kPurple);
      if (input.promotionSquare && input.animationOn) {
        setSquareColor(frame, *input.promotionSquare, led_colors::kAmber);
      }
      break;
    case OfflineFeedbackState::PromotionChoice:
      drawPromotionLetter(frame, input.promotionChoice, led_colors::kPurple);
      if (input.promotionSquare && input.animationOn) {
        setSquareColor(frame, *input.promotionSquare, led_colors::kAmber);
      }
      break;
    case OfflineFeedbackState::Error:
      drawCompactText(frame, "ERR", led_colors::kRed);
      break;
  }
  return frame;
}

const char* offlineFeedbackStateName(OfflineFeedbackState state) {
  switch (state) {
    case OfflineFeedbackState::Clear: return "clear";
    case OfflineFeedbackState::Wait: return "wait";
    case OfflineFeedbackState::Setup: return "setup";
    case OfflineFeedbackState::SideSelection: return "side_selection";
    case OfflineFeedbackState::SideSelected: return "side_selected";
    case OfflineFeedbackState::HumanReady: return "human_ready";
    case OfflineFeedbackState::HumanInteraction: return "human_interaction";
    case OfflineFeedbackState::EngineThinking: return "engine_thinking";
    case OfflineFeedbackState::RobotExecuting: return "robot_executing";
    case OfflineFeedbackState::SyncWarning: return "sync_warning";
    case OfflineFeedbackState::Success: return "success";
    case OfflineFeedbackState::Check: return "check";
    case OfflineFeedbackState::Checkmate: return "checkmate";
    case OfflineFeedbackState::Draw: return "draw";
    case OfflineFeedbackState::PromotionPrompt: return "promotion_prompt";
    case OfflineFeedbackState::PromotionChoice: return "promotion_choice";
    case OfflineFeedbackState::Error: return "error";
  }
  return "unknown";
}

}  // namespace offline
