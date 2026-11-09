#include <Arduino.h>
#include "music_spectrum.h"
namespace {
portMUX_TYPE spectrumMux = portMUX_INITIALIZER_UNLOCKED;
TaskHandle_t worker = nullptr;
bool enabled = false, playing = false;
uint32_t rate = 0, generation = 0, serial = 0;
struct Window {
  float samples[SpectrumAnalyser::Size];
  uint32_t generation = 0, rate = 0, timestamp = 0, serial = 0;
  uint8_t state = 0; // free, callback-owned, ready, worker-owned
};
Window windows[3];
SpectrumQueue queue;
SpectrumAnalyser analyser;
SpectrumRuntime runtime;
void analyseTask(void*) {
  uint32_t applied = UINT32_MAX;
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    int selected = -1;
    portENTER_CRITICAL(&spectrumMux);
    for (int i=0;i<3;++i) if (windows[i].state == 2 &&
        (selected < 0 || int32_t(windows[i].serial-windows[selected].serial)>0)) selected=i;
    for (int i=0;i<3;++i) if (windows[i].state == 2) {
      if(i!=selected) ++runtime.droppedWindows;
      windows[i].state = i==selected ? 3 : 0;
    }
    portEXIT_CRITICAL(&spectrumMux);
    if (selected < 0) continue;
    Window& input = windows[selected];
    if (applied != input.generation) { analyser.reset(); applied = input.generation; }
    SpectrumFrame frame;
    const uint32_t started = micros();
    analyser.analyse(input.samples, input.rate, frame);
    const uint32_t duration = micros() - started;
    frame.timestamp = input.timestamp;
    portENTER_CRITICAL(&spectrumMux);
    if (generation == input.generation && enabled && playing) {
      queue.push(frame); ++runtime.frames;
      runtime.maxAnalysisUs = max(runtime.maxAnalysisUs, duration);
      for (int b=0;b<8;++b) runtime.levels[b]=frame.levels[b];
    }
    input.state = 0;
    portEXIT_CRITICAL(&spectrumMux);
  }
}
}
bool beginMusicSpectrum() {
  if (worker) return true;
  return xTaskCreatePinnedToCore(analyseTask, "spectrum", 4096, nullptr, 1, &worker, 0) == pdPASS;
}
bool musicSpectrumAvailable() { return worker != nullptr; }
void setMusicSpectrumEnabled(bool value) {
  portENTER_CRITICAL(&spectrumMux);
  if (enabled != value) { enabled=value; ++generation; queue.clear();
    for(float& level:runtime.levels) level=0; }
  portEXIT_CRITICAL(&spectrumMux);
}
void setMusicSpectrumPlayback(bool value, uint32_t sampleRate) {
  portENTER_CRITICAL(&spectrumMux);
  if (playing!=value || rate!=sampleRate) { playing=value; rate=sampleRate; ++generation; queue.clear();
    for(float& level:runtime.levels) level=0; }
  portEXIT_CRITICAL(&spectrumMux);
}
SpectrumRuntime musicSpectrumRuntime() {
  portENTER_CRITICAL(&spectrumMux);
  const SpectrumRuntime result=runtime;
  portEXIT_CRITICAL(&spectrumMux);
  return result;
}
bool takeMusicSpectrum(uint32_t now, SpectrumFrame& frame, uint32_t& currentGeneration) {
  portENTER_CRITICAL(&spectrumMux);
  currentGeneration=generation;
  const bool found=queue.takeDue(now, frame);
  portEXIT_CRITICAL(&spectrumMux);
  return found;
}
void audio_process_i2s(int32_t* samples, int16_t frames, bool* continueI2S) {
  (void)continueI2S;
  static int slot=-1;
  static unsigned filled=0;
  static uint32_t applied=UINT32_MAX;
  bool active;
  uint32_t current, sampleRate;
  portENTER_CRITICAL(&spectrumMux);
  current=generation; sampleRate=rate; active=enabled && playing && worker && rate;
  if (applied!=current) {
    if (slot>=0) windows[slot].state=0;
    slot=-1; filled=0; applied=current;
    for (Window& w:windows) if(w.state==2) w.state=0;
  }
  portEXIT_CRITICAL(&spectrumMux);
  if (!active) return;
  const uint32_t callbackTime=millis();
  for (int i=0;i<frames;++i) {
    if (slot<0) {
      portENTER_CRITICAL(&spectrumMux);
      for (int n=0;n<3;++n) if(windows[n].state==0) { slot=n; break; }
      if(slot<0) for(int n=0;n<3;++n) if(windows[n].state==2 &&
          (slot<0 || int32_t(windows[n].serial-windows[slot].serial)<0)) slot=n;
      if(slot>=0) { if(windows[slot].state==2) ++runtime.droppedWindows; windows[slot].state=1; }
      portEXIT_CRITICAL(&spectrumMux);
      if(slot<0) return; // Never block audio for analysis.
    }
    windows[slot].samples[filled++]=(float(samples[i*2])+float(samples[i*2+1]))*(1.0f/4294967296.0f);
    if(filled!=SpectrumAnalyser::Size) continue;
    portENTER_CRITICAL(&spectrumMux);
    Window& w=windows[slot];
    w.generation=current; w.rate=sampleRate; w.serial=++serial;
    // Centre of FFT window, plus installed library's 32 x 256 DMA frames.
    w.timestamp=callbackTime+((8192u+uint32_t(i)-SpectrumAnalyser::Size/2)*1000u)/sampleRate;
    w.state=generation==current ? 2 : 0;
    portEXIT_CRITICAL(&spectrumMux);
    slot=-1; filled=0;
    xTaskNotifyGive(worker);
  }
}
