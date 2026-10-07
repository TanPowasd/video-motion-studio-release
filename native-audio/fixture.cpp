#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "public.sdk/source/common/pluginview.h"
#include "public.sdk/source/main/pluginfactory.h"
#include "public.sdk/source/vst/vstsinglecomponenteffect.h"
#ifdef _WIN32
#include <windows.h>
#endif
#include <array>
#include <cmath>
using namespace Steinberg;
using namespace Steinberg::Vst;
namespace {
const FUID synthId(0x914A61E1, 0x28FE4B22, 0xA4B63751, 0xC50BE933),
    gainId(0xB1D3C281, 0x7C8249E8, 0x8DEA053A, 0xF81C7B62);
class Fixture : public SingleComponentEffect {
  bool synth;
  double rate = 48000, gain = .25;
  std::array<double, 128> phase{}, level{};

public:
  explicit Fixture(bool isSynth) : synth(isSynth) {}
  static FUnknown *makeSynth(void *) {
    return static_cast<IComponent *>(new Fixture(true));
  }
  static FUnknown *makeGain(void *) {
    return static_cast<IComponent *>(new Fixture(false));
  }
  tresult PLUGIN_API initialize(FUnknown *host) override {
    auto result = SingleComponentEffect::initialize(host);
    if (result != kResultOk)
      return result;
    if (!synth)
      addAudioInput(STR16("Input"), SpeakerArr::kStereo);
    addAudioOutput(STR16("Output"), SpeakerArr::kStereo);
    addEventInput(STR16("MIDI"), 16);
    parameters.addParameter(STR16("Gain"), STR16(""), 0, .25, ParameterInfo::kCanAutomate, 1);
    return kResultOk;
  }
  tresult PLUGIN_API setupProcessing(ProcessSetup &setup) override {
    rate = setup.sampleRate;
    return SingleComponentEffect::setupProcessing(setup);
  }
  tresult PLUGIN_API setProcessing(TBool) override {
    return kResultOk;
  }
  tresult PLUGIN_API process(ProcessData &data) override {
    if (data.inputParameterChanges)
      for (int p = 0; p < data.inputParameterChanges->getParameterCount(); p++) {
        auto q = data.inputParameterChanges->getParameterData(p);
        if (q->getParameterId() == 1) {
          int32 offset;
          double v;
          if (q->getPoint(q->getPointCount() - 1, offset, v) == kResultOk)
            gain = v;
        }
      }
    if (data.numOutputs == 0)
      return kResultOk;
    int next = 0;
    Event event{};
    bool has = data.inputEvents && data.inputEvents->getEvent(0, event) == kResultOk;
    for (int i = 0; i < data.numSamples; i++) {
      while (has && event.sampleOffset <= i) {
        if (event.type == Event::kNoteOnEvent)
          level[event.noteOn.pitch] = event.noteOn.velocity;
        else if (event.type == Event::kNoteOffEvent)
          level[event.noteOff.pitch] = 0;
        has = data.inputEvents->getEvent(++next, event) == kResultOk;
      }
      double value = 0;
      for (int n = 0; synth && n < 128; n++)
        if (level[n]) {
          value += std::sin(phase[n]) * level[n] * gain;
          phase[n] += 6.283185307179586 * 440 * std::pow(2, (n - 69) / 12.0) / rate;
        }
      for (int ch = 0; ch < data.outputs[0].numChannels; ch++)
        data.outputs[0].channelBuffers32[ch][i] =
            synth ? float(value)
                  : (data.numInputs ? data.inputs[0].channelBuffers32[ch][i] * float(gain) : 0);
    }
    data.outputs[0].silenceFlags = 0;
    return kResultOk;
  }
  tresult PLUGIN_API setState(IBStream *stream) override {
    int32 count = 0;
    auto result = stream->read(&gain, sizeof(gain), &count);
    if (result == kResultOk && count == sizeof(gain)) {
      setParamNormalized(1, gain);
      return kResultOk;
    }
    return kResultFalse;
  }
  tresult PLUGIN_API getState(IBStream *stream) override {
    int32 count = 0;
    return stream->write(&gain, sizeof(gain), &count);
  }
  IPlugView *PLUGIN_API createView(FIDString name) override;
};
#ifdef _WIN32
class FixtureView final : public CPluginView {
  Fixture *controller;
  HWND child = nullptr;

public:
  explicit FixtureView(Fixture *c) : controller(c) {
    ViewRect size{0, 0, 360, 120};
    setRect(size);
  }
  tresult PLUGIN_API isPlatformTypeSupported(FIDString type) override {
    return strcmp(type, kPlatformTypeHWND) == 0 ? kResultTrue : kResultFalse;
  }
  tresult PLUGIN_API attached(void *parent, FIDString type) override {
    if (isPlatformTypeSupported(type) != kResultTrue)
      return kResultFalse;
    static bool registered = false;
    if (!registered) {
      WNDCLASSW cls{};
      cls.hInstance = GetModuleHandleW(nullptr);
      cls.lpszClassName = L"VmotionFixtureEditor";
      cls.lpfnWndProc = [](HWND window, UINT message, WPARAM a, LPARAM b) -> LRESULT {
        if (message == WM_COMMAND) {
          auto *self = reinterpret_cast<FixtureView *>(GetWindowLongPtrW(window, GWLP_USERDATA));
          if (self) {
            double value = a == 1 ? .2 : .6;
            self->controller->setParamNormalized(1, value);
            self->controller->beginEdit(1);
            self->controller->performEdit(1, value);
            self->controller->endEdit(1);
            return 0;
          }
        }
        return DefWindowProcW(window, message, a, b);
      };
      RegisterClassW(&cls);
      registered = true;
    }
    child = CreateWindowW(L"VmotionFixtureEditor", L"", WS_CHILD | WS_VISIBLE, 0, 0, 360, 120,
                          static_cast<HWND>(parent), nullptr, GetModuleHandleW(nullptr), nullptr);
    SetWindowLongPtrW(child, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
    CreateWindowW(L"STATIC", L"Vmotion VST3 native editor fixture", WS_CHILD | WS_VISIBLE, 16, 12,
                  300, 20, child, nullptr, GetModuleHandleW(nullptr), nullptr);
    CreateWindowW(L"BUTTON", L"Gain 0.2", WS_CHILD | WS_VISIBLE, 16, 48, 120, 32, child,
                  reinterpret_cast<HMENU>(1), GetModuleHandleW(nullptr), nullptr);
    CreateWindowW(L"BUTTON", L"Gain 0.6", WS_CHILD | WS_VISIBLE, 150, 48, 120, 32, child,
                  reinterpret_cast<HMENU>(2), GetModuleHandleW(nullptr), nullptr);
    return CPluginView::attached(parent, type);
  }
  tresult PLUGIN_API removed() override {
    if (child)
      DestroyWindow(child);
    child = nullptr;
    return CPluginView::removed();
  }
};
IPlugView *PLUGIN_API Fixture::createView(FIDString name) {
  return strcmp(name, ViewType::kEditor) == 0 ? new FixtureView(this) : nullptr;
}
#else
IPlugView *PLUGIN_API Fixture::createView(FIDString) {
  return nullptr;
}
#endif
} // namespace
BEGIN_FACTORY_DEF("Vmotion", "https://github.com/TanPowasd/video-motion-studio", "")
DEF_CLASS2(INLINE_UID_FROM_FUID(synthId), PClassInfo::kManyInstances, kVstAudioEffectClass,
           "Vmotion Test Synth", Vst::kDistributable, "Instrument|Synth", "1.0.0",
           kVstVersionString, Fixture::makeSynth)
DEF_CLASS2(INLINE_UID_FROM_FUID(gainId), PClassInfo::kManyInstances, kVstAudioEffectClass,
           "Vmotion Test Gain", Vst::kDistributable, "Fx", "1.0.0", kVstVersionString,
           Fixture::makeGain)
END_FACTORY
