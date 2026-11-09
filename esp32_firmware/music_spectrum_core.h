#pragma once
#include <cmath>
#include <cstdint>
#include <algorithm>

struct SpectrumFrame {
  uint32_t timestamp = 0;
  float levels[8] = {};
};

// Fixed-size, portable DSP; owned exclusively by the analysis worker.
class SpectrumAnalyser {
 public:
  static constexpr unsigned Size = 2048;
  void reset() { reference = 0; }
  void analyse(const float* samples, uint32_t rate, SpectrumFrame& output) {
    output = SpectrumFrame{};
    if (!rate) return;
    float mean = 0;
    for (unsigned i = 0; i < Size; ++i) mean += samples[i] / Size;
    for (unsigned i = 0; i < Size; ++i) {
      re[i] = (samples[i] - mean) * (0.5f - 0.5f * std::cos(6.283185307f * i / (Size - 1)));
      im[i] = 0;
    }
    for (unsigned i = 1, j = 0; i < Size; ++i) {
      unsigned bit = Size >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { std::swap(re[i], re[j]); std::swap(im[i], im[j]); }
    }
    for (unsigned length = 2; length <= Size; length <<= 1) {
      const float angle = -6.283185307f / length;
      const float wr = std::cos(angle), wi = std::sin(angle);
      for (unsigned start = 0; start < Size; start += length) {
        float ur = 1, ui = 0;
        for (unsigned j = 0; j < length / 2; ++j) {
          const unsigned a = start + j, b = a + length / 2;
          const float vr = re[b] * ur - im[b] * ui, vi = re[b] * ui + im[b] * ur;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr; im[a] += vi;
          const float next = ur * wr - ui * wi;
          ui = ur * wi + ui * wr; ur = next;
        }
      }
    }
    constexpr float edges[9] = {40,100,250,500,1000,2000,3500,5500,12000};
    float power[8] = {}, db[8], strongest = -120;
    // Hann power normalization; a full-scale sine has approximately 0 dBFS.
    constexpr float norm = 4.0f / (Size * Size * 0.375f);
    for (unsigned i = 1; i < Size / 2; ++i) {
      const float hz = float(i) * rate / Size;
      for (unsigned b = 0; b < 8; ++b) if (hz >= edges[b] && hz < edges[b+1]) {
        power[b] += (re[i]*re[i] + im[i]*im[i]) * norm;
        break;
      }
    }
    for (unsigned b = 0; b < 8; ++b) {
      db[b] = 10 * std::log10(std::max(power[b], 1e-12f));
      strongest = std::max(strongest, db[b]);
    }
    const float seconds = float(Size) / rate;
    const float desired = std::max(-24.0f, std::min(0.0f, strongest));
    const float time = desired > reference ? 0.1f : 3.0f;
    reference += (desired - reference) * (1 - std::exp(-seconds / time));
    // Reserve 12 dB above the adaptive reference for musical transients.
    for (unsigned b = 0; b < 8; ++b)
      output.levels[b] = db[b] < -60 ? 0 : std::max(0.0f, std::min(1.0f, (db[b] - reference + 48 - 12) / 48));
  }
  float referenceDb() const { return reference; }
 private:
  float re[Size] = {}, im[Size] = {}, reference = 0;
};

// Externally protected by a short critical section on the ESP32.
class SpectrumQueue {
 public:
  void clear() { head = count = 0; }
  bool push(const SpectrumFrame& frame) {
    if (count && int32_t(frame.timestamp - frames[(head + count - 1) % 16].timestamp) < 0) return false;
    if (count == 16) { head = (head + 1) % 16; --count; }
    frames[(head + count++) % 16] = frame;
    return true;
  }
  bool takeDue(uint32_t now, SpectrumFrame& output) {
    bool found = false;
    while (count && int32_t(now - frames[head].timestamp) >= 0) {
      const SpectrumFrame frame = frames[head];
      head = (head + 1) % 16; --count;
      if (now - frame.timestamp <= 300) { output = frame; found = true; }
    }
    return found;
  }
  unsigned size() const { return count; }
 private:
  SpectrumFrame frames[16];
  unsigned head = 0, count = 0;
};

class SpectrumDisplay {
 public:
  float heights[8] = {};
  void reset(uint32_t now) {
    last = lastFrame = now; active = false;
    for (unsigned b=0;b<8;++b) { heights[b]=target[b]=0; }
  }
  void update(uint32_t now, const SpectrumFrame* frame) {
    const float dt = std::min(0.3f, float(now - last) / 1000); last = now;
    if (frame) { for(unsigned b=0;b<8;++b) target[b]=frame->levels[b]*8; lastFrame=now; active=true; }
    const bool stale = !active || now - lastFrame >= 100;
    for(unsigned b=0;b<8;++b) {
      const float goal = stale ? 0 : target[b];
      heights[b] = goal >= heights[b] ? goal : std::max(goal, heights[b] - 32*dt);
      if (stale && now-lastFrame >= 300) heights[b]=0;
    }
  }
 private:
  float target[8] = {};
  uint32_t last = 0, lastFrame = 0;
  bool active = false;
};
