#include "../esp32_firmware/music_spectrum_core.h"
#include <cassert>
#include <cstdio>
#include <vector>

float samples[SpectrumAnalyser::Size];
void tone(float hz, uint32_t rate, float amplitude=0.3f, float dc=0) {
  for(unsigned i=0;i<SpectrumAnalyser::Size;++i) samples[i]=dc+amplitude*std::sin(6.283185307f*hz*i/rate);
}
unsigned dominant(const SpectrumFrame& f) {
  unsigned best=0;
  for(unsigned b=1;b<8;++b) if(f.levels[b]>f.levels[best]) best=b;
  return best;
}
int main() {
  SpectrumAnalyser dsp;
  SpectrumFrame frame;
  constexpr float frequencies[8]={70,170,350,750,1500,2700,4300,7500};
  for(uint32_t rate:{24000u,44100u,48000u}) {
    for(unsigned b=0;b<8;++b) {
      dsp.reset(); tone(frequencies[b],rate); dsp.analyse(samples,rate,frame);
      assert(dominant(frame)==b);
      assert(frame.levels[b]>0.45f);
    }
    // Sweep through all eight ranges with enough distance from window leakage.
    for(float hz=65;hz<11000;hz*=1.15f) {
      constexpr float edges[9]={40,100,250,500,1000,2000,3500,5500,12000};
      unsigned expected=0;
      while(expected<7 && hz>=edges[expected+1]) ++expected;
      if(std::min(hz-edges[expected],edges[expected+1]-hz)<float(rate)/2048) continue;
      dsp.reset();tone(hz,rate);dsp.analyse(samples,rate,frame);
      assert(dominant(frame)==expected);
    }
  }
  // Bands above Nyquist and outside the visualised range remain empty.
  dsp.reset();tone(1500,8000);dsp.analyse(samples,8000,frame);
  assert(dominant(frame)==4 && frame.levels[7]==0);
  dsp.reset();tone(18000,48000);dsp.analyse(samples,48000,frame);
  for(float level:frame.levels) assert(level==0);
  // Adjacent sides of boundaries resolve to different bars.
  for(float edge:{100.f,250.f,500.f,1000.f,2000.f,3500.f,5500.f}) {
    dsp.reset();tone(edge-35,44100);dsp.analyse(samples,44100,frame);unsigned below=dominant(frame);
    dsp.reset();tone(edge+35,44100);dsp.analyse(samples,44100,frame);
    assert(dominant(frame)==below+1);
  }
  for(unsigned i=0;i<SpectrumAnalyser::Size;++i)
    samples[i]=0.2f*std::sin(6.283185307f*170*i/44100)+0.2f*std::sin(6.283185307f*4300*i/44100);
  dsp.reset();dsp.analyse(samples,44100,frame);
  assert(frame.levels[1]>0.4f && frame.levels[6]>0.4f);
  assert(std::fabs(frame.levels[1]-frame.levels[6])<0.05f);
  // Silence and DC remain black even after automatic gain settles.
  for(float dc:{0.f,0.4f}) {
    tone(0,44100,0,dc);
    for(int n=0;n<300;++n) dsp.analyse(samples,44100,frame);
    for(float level:frame.levels) assert(level==0);
    assert(dsp.referenceDb()>=-24 && dsp.referenceDb()<=0);
  }
  dsp.reset();tone(1500,44100,0.3f);dsp.analyse(samples,44100,frame);float loud=frame.levels[4];
  dsp.reset();tone(1500,44100,0.03f);dsp.analyse(samples,44100,frame);float quiet=frame.levels[4];
  assert(loud>quiet && std::fabs((loud-quiet)-20.f/48)<0.03f);
  tone(1500,44100,0.00001f);dsp.analyse(samples,44100,frame);
  for(float level:frame.levels) assert(level==0);
  // AGC must not pin a sustained band at the ceiling, at either loud or quiet volume.
  for(float amplitude:{0.05f,0.2f}) {
    dsp.reset();tone(1500,44100,amplitude);
    for(int n=0;n<500;++n) dsp.analyse(samples,44100,frame);
    assert(frame.levels[4]>0.65f && frame.levels[4]<0.80f);
    tone(1500,44100,std::min(1.0f,amplitude*4));
    dsp.analyse(samples,44100,frame);
    assert(frame.levels[4]>0.85f); // sudden peaks can use the reserved space
  }
  dsp.reset();assert(dsp.referenceDb()==0);
  dsp.analyse(samples,0,frame);for(float level:frame.levels) assert(level==0);

  SpectrumQueue queue;
  frame.timestamp=200;frame.levels[0]=0.5f;assert(queue.push(frame));
  SpectrumFrame result;
  assert(!queue.takeDue(199,result));assert(queue.takeDue(200,result));assert(result.levels[0]==0.5f);
  for(unsigned i=0;i<20;++i) {frame.timestamp=1000+i*50;assert(queue.push(frame));}
  assert(queue.size()==16);assert(!queue.takeDue(1150,result));
  assert(queue.takeDue(1500,result));assert(result.timestamp==1500);
  frame.timestamp=1400;assert(!queue.push(frame));
  assert(!queue.takeDue(3000,result));assert(queue.size()==0);
  frame.timestamp=10;queue.push(frame);queue.clear();assert(!queue.takeDue(10,result));
  frame.timestamp=UINT32_MAX-10;queue.push(frame);frame.timestamp=20;queue.push(frame);
  assert(queue.takeDue(25,result));assert(result.timestamp==20);

  SpectrumDisplay display;display.reset(0);frame=SpectrumFrame{};frame.levels[0]=1;frame.levels[7]=0.3125f;
  display.update(50,&frame);assert(display.heights[0]==8 && display.heights[7]==2.5f);
  assert(display.heights[3]==0);
  frame.levels[0]=0;display.update(100,&frame);assert(display.heights[0]<8 && display.heights[0]>0);
  for(unsigned now=150;now<=400;now+=50) display.update(now,&frame);
  assert(display.heights[0]==0); // no detached marker remains after the bar falls
  display.update(600,nullptr);display.update(700,nullptr);display.update(800,nullptr);
  for(float value:display.heights) assert(value==0);
  display.reset(900);for(float value:display.heights) assert(value==0);
  puts("Spectrum: eight bands, sweeps, boundaries, mixed tones, silence/DC, gain, rates, timing queue and display tests passed.");
}
