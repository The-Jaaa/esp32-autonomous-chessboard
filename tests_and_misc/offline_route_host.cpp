#include "../offline_core/offline_route.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using offline::BoardRouteMode;
using offline::BoardRouteRequest;
using offline::BoardRouteResult;
using offline::BoardRouteStatus;
using offline::MoveInfo;
using offline::Occupancy;
using offline::OfflineBoardRoutePlanner;
using offline::OfflineGame;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

std::vector<std::string> split(const std::string& value, char delimiter) {
  std::vector<std::string> parts;
  std::stringstream stream(value);
  std::string part;
  while (std::getline(stream, part, delimiter)) parts.push_back(part);
  if (!value.empty() && value.back() == delimiter) parts.emplace_back();
  return parts;
}

std::string join(const std::vector<std::string>& values) {
  std::string result;
  for (std::size_t index = 0; index < values.size(); ++index) {
    if (index > 0) result += ',';
    result += values[index];
  }
  return result;
}

void place(Occupancy& occupancy, const std::string& square, bool occupied) {
  const int index = offline::squareToRawIndex(square);
  require(index >= 0, "Invalid test square: " + square);
  occupancy[static_cast<std::size_t>(index)] = occupied;
}

bool occupied(const Occupancy& occupancy, const std::string& square) {
  const int index = offline::squareToRawIndex(square);
  require(index >= 0, "Invalid occupancy square: " + square);
  return occupancy[static_cast<std::size_t>(index)];
}

std::vector<std::string> expandSegment(const std::string& from, const std::string& to) {
  const int fromFile = from[0] - 'a';
  const int toFile = to[0] - 'a';
  const int fromRank = from[1] - '0';
  const int toRank = to[1] - '0';
  const int fileDistance = std::abs(toFile - fromFile);
  const int rankDistance = std::abs(toRank - fromRank);
  require(fromFile == toFile || fromRank == toRank || fileDistance == rankDistance,
          "Compressed segment is not rank, file, or diagonal aligned.");
  const int df = (toFile > fromFile) - (toFile < fromFile);
  const int dr = (toRank > fromRank) - (toRank < fromRank);
  std::vector<std::string> result;
  int file = fromFile;
  int rank = fromRank;
  do {
    file += df;
    rank += dr;
    result.push_back(std::string{
        static_cast<char>('a' + file), static_cast<char>('0' + rank)});
  } while (file != toFile || rank != toRank);
  return result;
}

std::vector<std::string> expandCompressed(const std::vector<std::string>& compressed) {
  if (compressed.empty()) return {};
  std::vector<std::string> result{compressed.front()};
  for (std::size_t index = 1; index < compressed.size(); ++index) {
    const std::vector<std::string> segment = expandSegment(compressed[index - 1], compressed[index]);
    result.insert(result.end(), segment.begin(), segment.end());
  }
  return result;
}

Occupancy mergedPlanningOccupancy(const BoardRouteRequest& request) {
  Occupancy occupancy = request.expectedOccupancy;
  if (request.sensedOccupancy) {
    for (std::size_t index = 0; index < occupancy.size(); ++index) {
      occupancy[index] = occupancy[index] || (*request.sensedOccupancy)[index];
    }
  }
  std::vector<std::string> ignored = request.ignoredSquares;
  ignored.push_back(request.from);
  ignored.push_back(request.to);
  for (const std::string& square : ignored) place(occupancy, square, false);
  return occupancy;
}

void verifySuccessfulRoute(
    const BoardRouteRequest& request, const BoardRouteResult& result, const std::string& context) {
  require(result.success(), context + ": route should be successful.");
  require(!result.rawPathSquares.empty() && result.rawPathSquares.front() == request.from &&
              result.rawPathSquares.back() == request.to,
          context + ": raw path endpoints are incorrect.");
  require(!result.compressedPathSquares.empty() &&
              result.compressedPathSquares.front() == request.from &&
              result.compressedPathSquares.back() == request.to,
          context + ": compressed path endpoints are incorrect.");
  if (result.mode == BoardRouteMode::Direct) {
    require(result.rawPathSquares == result.compressedPathSquares &&
                result.rawPathSquares.size() == 2,
            context + ": direct route must retain the online endpoint-only metadata contract.");
  } else {
    require(expandCompressed(result.compressedPathSquares) == result.rawPathSquares,
            context + ": compressed path does not reconstruct the raw path.");
  }

  const Occupancy occupancy = mergedPlanningOccupancy(request);
  for (std::size_t index = 1; index + 1 < result.rawPathSquares.size(); ++index) {
    require(!occupied(occupancy, result.rawPathSquares[index]),
            context + ": route crosses occupied square " + result.rawPathSquares[index] + '.');
  }
}

std::uint32_t nextRandom(std::uint32_t& state) {
  state ^= state << 13;
  state ^= state >> 17;
  state ^= state << 5;
  return state;
}

void verifyMappingAndInvalidRequests() {
  require(offline::squareToRawIndex("h8") == 0, "Route mapping must keep h8 at index 0.");
  require(offline::squareToRawIndex("a1") == 56, "Route mapping must keep a1 at index 56.");
  require(offline::squareToRawIndex("a8") == 63, "Route mapping must keep a8 at index 63.");

  OfflineBoardRoutePlanner planner;
  BoardRouteRequest invalid;
  invalid.from = "z9";
  invalid.to = "a1";
  invalid.expectedOccupancy[0] = true;
  const BoardRouteRequest before = invalid;
  const BoardRouteResult result = planner.plan(invalid);
  require(result.status == BoardRouteStatus::InvalidRequest &&
              result.rawPathSquares.empty() && result.compressedPathSquares.empty(),
          "Invalid route request must fail without a partial path.");
  require(invalid.from == before.from && invalid.to == before.to &&
              invalid.expectedOccupancy == before.expectedOccupancy,
          "Planner must not mutate an invalid request.");
}

void verifyUnsupportedMoves() {
  struct Fixture {
    std::string fen;
    std::string uci;
  };
  const Fixture fixtures[] = {
      {"4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1", "e4d5"},
      {"r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1g1"},
      {"8/8/8/3pP3/8/8/8/4K2k w - d6 0 1", "e5d6"},
      {"4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7a8q"}};

  OfflineBoardRoutePlanner planner;
  for (const Fixture& fixture : fixtures) {
    OfflineGame game;
    require(game.loadFen(fixture.fen), "Unsupported-move fixture must load.");
    MoveInfo move;
    require(game.describeLegalMove(fixture.uci, move), fixture.uci + ": move must be legal.");
    const BoardRouteResult result = planner.planQuietMove(game, move);
    require(result.status == BoardRouteStatus::UnsupportedMove &&
                result.rawPathSquares.empty(),
            fixture.uci + ": special move must be deferred by board-only planner.");
  }
}

void verifyDeterministicSafetyCorpus() {
  OfflineBoardRoutePlanner planner;
  std::uint32_t random = 0xA57A11u;
  for (int iteration = 0; iteration < 256; ++iteration) {
    BoardRouteRequest request;
    const int fromIndex = static_cast<int>(nextRandom(random) % 64);
    int toIndex = static_cast<int>(nextRandom(random) % 64);
    if (toIndex == fromIndex) toIndex = (toIndex + 1) % 64;
    request.from = offline::rawIndexToSquare(static_cast<std::size_t>(fromIndex));
    request.to = offline::rawIndexToSquare(static_cast<std::size_t>(toIndex));

    for (std::size_t index = 0; index < request.expectedOccupancy.size(); ++index) {
      request.expectedOccupancy[index] = nextRandom(random) % 5 == 0;
    }
    Occupancy sensed{};
    for (std::size_t index = 0; index < sensed.size(); ++index) {
      sensed[index] = nextRandom(random) % 13 == 0;
    }
    request.sensedOccupancy = sensed;
    place(request.expectedOccupancy, request.from, true);
    place(request.expectedOccupancy, request.to, false);

    const BoardRouteResult first = planner.plan(request);
    const BoardRouteResult second = planner.plan(request);
    require(first.status == second.status && first.mode == second.mode &&
                first.cost == second.cost && first.rawPathSquares == second.rawPathSquares &&
                first.compressedPathSquares == second.compressedPathSquares,
            "Repeated route planning must be deterministic.");
    if (first.success()) {
      verifySuccessfulRoute(request, first, "random route " + std::to_string(iteration));
    } else {
      require(first.status == BoardRouteStatus::NoBoardPath,
              "Valid random request may fail only with NoBoardPath.");
    }
  }
}

Occupancy parseSensed(const std::string& bits) {
  require(bits.size() == 64, "Sensed occupancy fixture must contain 64 bits.");
  Occupancy occupancy{};
  for (std::size_t index = 0; index < occupancy.size(); ++index) {
    require(bits[index] == '0' || bits[index] == '1', "Sensed occupancy contains a non-bit.");
    occupancy[index] = bits[index] == '1';
  }
  return occupancy;
}

void runParityFixtures(const std::string& fixturePath) {
  std::ifstream fixtures(fixturePath);
  require(fixtures.good(), "Could not open route parity fixture file.");
  OfflineBoardRoutePlanner planner;
  std::string line;
  int count = 0;

  while (std::getline(fixtures, line)) {
    if (line.empty()) continue;
    const std::vector<std::string> fields = split(line, '\t');
    require(fields.size() == 5, "Route fixture must contain five tab-separated fields.");
    const std::string& id = fields[0];
    const std::string& fen = fields[1];
    const std::string& uci = fields[2];

    OfflineGame game;
    require(game.loadFen(fen), id + ": fixture FEN must load.");
    MoveInfo move;
    require(game.describeLegalMove(uci, move), id + ": fixture move must be legal.");

    std::optional<Occupancy> sensed;
    if (fields[3] != "-") sensed = parseSensed(fields[3]);
    const std::vector<std::string> ignored = fields[4].empty()
                                                 ? std::vector<std::string>{}
                                                 : split(fields[4], ',');
    const BoardRouteResult result = planner.planQuietMove(game, move, sensed, ignored);
    if (result.success()) {
      BoardRouteRequest request;
      request.from = move.from;
      request.to = move.to;
      request.expectedOccupancy = offline::occupancyFromFen(game.fen());
      request.sensedOccupancy = sensed;
      request.ignoredSquares = ignored;
      request.directWhenClear = result.mode == BoardRouteMode::Direct;
      verifySuccessfulRoute(request, result, id);
    }

    std::cout << "ROUTE\t" << id << '\t'
              << offline::boardRouteStatusName(result.status) << '\t'
              << (result.success() ? offline::boardRouteModeName(result.mode) : "-") << '\t'
              << result.cost << '\t' << join(result.rawPathSquares) << '\t'
              << join(result.compressedPathSquares) << std::endl;
    ++count;
  }
  require(count > 0, "No route parity fixtures were processed.");
}

}  // namespace

int main(int argc, char** argv) {
  try {
    require(argc == 2, "Usage: offline_route_host <fixtures.tsv>");
    verifyMappingAndInvalidRequests();
    verifyUnsupportedMoves();
    verifyDeterministicSafetyCorpus();
    runParityFixtures(argv[1]);
    std::cout << "offline board route regressions passed" << std::endl;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline board route regression failed: " << error.what() << std::endl;
    return 1;
  }
}
