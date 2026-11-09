#pragma once
#include "music_spectrum_core.h"
bool beginMusicSpectrum();
bool musicSpectrumAvailable();
void setMusicSpectrumEnabled(bool enabled);
void setMusicSpectrumPlayback(bool playing, uint32_t sampleRate = 0);
bool takeMusicSpectrum(uint32_t now, SpectrumFrame& frame, uint32_t& generation);

struct SpectrumRuntime {
  uint32_t frames = 0, droppedWindows = 0, maxAnalysisUs = 0;
  float levels[8] = {};
};
SpectrumRuntime musicSpectrumRuntime();
