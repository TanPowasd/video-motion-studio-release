#include "base/source/fstring.h"
#include "host.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstmidicontrollers.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include <cmath>
#include <map>
#include <stdexcept>
#ifdef _WIN32
#include <windows.h>
#endif
using namespace Steinberg;
using namespace Steinberg::Vst;
namespace Hosting = VST3::Hosting;
static std::string utf8(const char16_t *text) {
  return String(text).text8();
}
static void require(bool good, const char *message) {
  if (!good)
    throw std::runtime_error(message);
}
Json scanVst(const std::string &path) {
  std::string error;
  auto module = Hosting::Module::create(path, error);
  require(bool(module), error.c_str());
  Json list = Json::array();
  for (const auto &item : module->getFactory().classInfos())
    if (item.category() == kVstAudioEffectClass)
      list.push_back({{"format", "vst3"},
                      {"path", path},
                      {"classId", item.ID().toString()},
                      {"name", item.name()},
                      {"vendor", item.vendor()},
                      {"version", item.version()},
                      {"categories", item.subCategories()}});
  return list;
}
struct Handler final : IComponentHandler, IPlugFrame {
  std::map<ParamID, double> changes;
  int restart = 0;
  uint32 refs = 1;
#ifdef _WIN32
  HWND window = nullptr;
#endif
  tresult PLUGIN_API queryInterface(const TUID iid, void **out) override {
    *out = nullptr;
    if (FUnknownPrivate::iidEqual(iid, IComponentHandler::iid) ||
        FUnknownPrivate::iidEqual(iid, FUnknown::iid))
      *out = static_cast<IComponentHandler *>(this);
    else if (FUnknownPrivate::iidEqual(iid, IPlugFrame::iid))
      *out = static_cast<IPlugFrame *>(this);
    if (!*out)
      return kNoInterface;
    addRef();
    return kResultOk;
  }
  uint32 PLUGIN_API addRef() override {
    return ++refs;
  }
  uint32 PLUGIN_API release() override {
    return --refs;
  }
  tresult PLUGIN_API beginEdit(ParamID) override {
    return kResultOk;
  }
  tresult PLUGIN_API performEdit(ParamID id, ParamValue value) override {
    changes[id] = value;
    return kResultOk;
  }
  tresult PLUGIN_API endEdit(ParamID) override {
    return kResultOk;
  }
  tresult PLUGIN_API restartComponent(int32 flags) override {
    restart |= flags;
    return kResultOk;
  }
  tresult PLUGIN_API resizeView(IPlugView *view, ViewRect *rect) override {
#ifdef _WIN32
    if (window) {
      RECT size{0, 0, rect->getWidth(), rect->getHeight()};
      AdjustWindowRect(&size, WS_OVERLAPPEDWINDOW, FALSE);
      SetWindowPos(window, nullptr, 0, 0, size.right - size.left, size.bottom - size.top,
                   SWP_NOMOVE | SWP_NOZORDER);
      view->onSize(rect);
      return kResultOk;
    }
#endif
    return kNotImplemented;
  }
};
class VstInstance final : public AudioInstance {
  IPtr<HostApplication> host;
  Hosting::Module::Ptr module;
  IPtr<PlugProvider> provider;
  IPtr<IComponent> component;
  IPtr<IEditController> controller;
  FUnknownPtr<IAudioProcessor> processor;
  FUnknownPtr<IMidiMapping> mapping;
  Handler handler;
  HostProcessData data;
  EventList events{2048};
  ParameterChanges params{2048}, outputParams{2048};
  ProcessContext context{};
  IPtr<IPlugView> view;
  Json identity;
  double rate = 48000;
  int maximum = 4096;
  std::map<ParamID, double> pending;
  bool active = false;
  void parameter(ParamID id, double value, int offset = 0) {
    int32 index = 0, point = 0;
    auto queue = params.addParameterData(id, index);
    require(queue != nullptr, "Parameter queue limit");
    queue->addPoint(offset, value, point);
    if (controller)
      controller->setParamNormalized(id, value);
  }

public:
  explicit VstInstance(const Json &config) {
    rate = config.value("sampleRate", 48000.0);
    maximum = config.value("blockSize", 4096);
    require(rate >= 8000 && rate <= 192000 && maximum >= 64 && maximum <= 16384,
            "Invalid audio setup");
    host = owned(new HostApplication);
    PluginContextFactory::instance().setPluginContext(host);
    std::string error;
    module = Hosting::Module::create(config.at("path"), error);
    require(bool(module), error.c_str());
    auto factory = module->getFactory();
    factory.setHostContext(host);
    for (auto item : factory.classInfos())
      if (item.category() == kVstAudioEffectClass &&
          item.ID().toString() == config.at("classId").get<std::string>()) {
        identity = {{"name", item.name()},       {"vendor", item.vendor()},
                    {"version", item.version()}, {"classId", item.ID().toString()},
                    {"format", "vst3"},          {"path", config.at("path")}};
        provider = owned(new PlugProvider(factory, item, true));
        break;
      }
    require(bool(provider), "VST3 class ID not found");
    require(provider->initialize(), "VST3 initialization failed");
    component = provider->getComponentPtr();
    controller = provider->getControllerPtr();
    processor = component;
    mapping = controller;
    require(bool(processor), "VST3 has no audio processor");
    if (controller)
      controller->setComponentHandler(&handler);
    if (config.contains("state") && !config["state"].get<std::string>().empty()) {
      auto bytes = decode64(config["state"]);
      MemoryStream stream(bytes.data(), bytes.size());
      require(component->setState(&stream) == kResultOk, "Plugin rejected saved processor state");
      stream.seek(0, IBStream::kIBSeekSet, nullptr);
      if (controller)
        controller->setComponentState(&stream);
    }
    if (config.contains("controllerState") && controller) {
      auto bytes = decode64(config["controllerState"]);
      MemoryStream stream(bytes.data(), bytes.size());
      controller->setState(&stream);
    }
    auto inputCount = component->getBusCount(kAudio, kInput),
         outputCount = component->getBusCount(kAudio, kOutput);
    require(outputCount > 0, "Plugin has no audio output");
    std::vector<SpeakerArrangement> ins(inputCount, SpeakerArr::kStereo),
        outs(outputCount, SpeakerArr::kStereo);
    processor->setBusArrangements(ins.data(), inputCount, outs.data(), outputCount);
    for (auto dir : {kInput, kOutput}) {
      for (int32 bus = 0; bus < component->getBusCount(kAudio, dir); bus++)
        component->activateBus(kAudio, dir, bus, bus == 0);
      for (int32 bus = 0; bus < component->getBusCount(kEvent, dir); bus++)
        component->activateBus(kEvent, dir, bus, bus == 0);
    }
    require(processor->canProcessSampleSize(kSample32) == kResultOk,
            "Plugin requires unsupported float64 processing");
    ProcessSetup setup{config.value("realtime", false) ? kRealtime : kOffline, kSample32, maximum,
                       rate};
    require(processor->setupProcessing(setup) == kResultOk, "Plugin rejected processing setup");
    require(data.prepare(*component, maximum, kSample32), "Cannot allocate plugin buses");
    require(data.numOutputs > 0 && data.outputs[0].numChannels >= 1 &&
                data.outputs[0].numChannels <= 2,
            "Only mono/stereo main outputs are supported");
    require(data.numInputs == 0 || data.inputs[0].numChannels <= 2,
            "Only mono/stereo main inputs are supported");
    require(component->setActive(true) == kResultOk, "Cannot activate plugin");
    active = true;
    require(processor->setProcessing(true) == kResultOk, "Cannot start plugin processing");
    if (config.contains("parameters"))
      for (auto it = config["parameters"].begin(); it != config["parameters"].end(); ++it)
        pending[std::stoul(it.key())] = it.value().get<double>();
  }
  ~VstInstance() override {
    try {
      editor(false);
    } catch (...) {
    }
    if (controller)
      controller->setComponentHandler(nullptr);
    if (active) {
      processor->setProcessing(false);
      component->setActive(false);
    }
    data.unprepare();
    mapping = nullptr;
    processor = nullptr;
    controller = nullptr;
    component = nullptr;
    provider = nullptr;
    module.reset();
    PluginContextFactory::instance().setPluginContext(nullptr);
  }
  Json describe() override {
    Json result = identity;
    result["latencySamples"] = processor->getLatencySamples();
    result["tailSamples"] = processor->getTailSamples();
    result["parameters"] = Json::array();
    result["restartFlags"] = handler.restart;
    if (controller)
      for (int i = 0; i < std::min(2048, controller->getParameterCount()); i++) {
        ParameterInfo info{};
        if (controller->getParameterInfo(i, info) == kResultOk)
          result["parameters"].push_back({{"id", std::to_string(info.id)},
                                          {"name", utf8(info.title)},
                                          {"unit", utf8(info.units)},
                                          {"value", controller->getParamNormalized(info.id)},
                                          {"default", info.defaultNormalizedValue},
                                          {"steps", info.stepCount},
                                          {"flags", info.flags}});
      }
    return result;
  }
  void process(const Json &request, const std::vector<float> &input,
               std::vector<float> &output) override {
    int count = request.value("frames", 0);
    require(count > 0 && count <= maximum, "Audio block exceeds negotiated size");
    require(input.empty() || input.size() == size_t(count * 2), "PCM input size mismatch");
    events.clear();
    params.clearQueue();
    outputParams.clearQueue();
    for (auto dir : {kInput, kOutput}) {
      auto buses = dir == kInput ? data.inputs : data.outputs;
      int size = dir == kInput ? data.numInputs : data.numOutputs;
      for (int b = 0; b < size; b++) {
        buses[b].silenceFlags = 0;
        for (int ch = 0; ch < buses[b].numChannels; ch++)
          std::fill(buses[b].channelBuffers32[ch], buses[b].channelBuffers32[ch] + count, 0);
      }
    }
    if (data.numInputs && input.size())
      for (int i = 0; i < count; i++)
        for (int ch = 0; ch < data.inputs[0].numChannels; ch++)
          data.inputs[0].channelBuffers32[ch][i] = data.inputs[0].numChannels == 1
                                                       ? (input[i * 2] + input[i * 2 + 1]) * .5f
                                                       : input[i * 2 + ch];
    for (auto p : pending)
      parameter(p.first, p.second);
    pending.clear();
    for (auto p : handler.changes)
      parameter(p.first, p.second);
    handler.changes.clear();
    require((handler.restart & (kReloadComponent | kIoChanged | kLatencyChanged)) == 0,
            "Plugin requested an IO/latency restart; capture state and reopen the instrument");
    if ((handler.restart & kParamValuesChanged) && controller) {
      for (int i = 0; i < controller->getParameterCount(); i++) {
        ParameterInfo info{};
        if (controller->getParameterInfo(i, info) == kResultOk)
          parameter(info.id, controller->getParamNormalized(info.id));
      }
      handler.restart &= ~kParamValuesChanged;
    }
    if (request.contains("parameters"))
      for (auto it = request["parameters"].begin(); it != request["parameters"].end(); ++it)
        parameter(std::stoul(it.key()), it.value().get<double>());
    const auto midi = request.value("midi", Json::array());
    require(midi.size() <= 2048, "MIDI event block exceeds limit");
    for (const auto &message : midi) {
      int status = message.at("status"), a = message.value("a", 0), b = message.value("b", 0),
          offset = message.value("offset", 0), channel = status & 15;
      require(status >= 128 && status < 240 && a >= 0 && a <= 127 && b >= 0 && b <= 127 &&
                  offset >= 0 && offset < count,
              "Invalid MIDI event");
      int kind = status & 240;
      Event event{};
      event.busIndex = 0;
      event.sampleOffset = offset;
      event.flags = Event::kIsLive;
      bool send = false;
      if (kind == 144 && b) {
        event.type = Event::kNoteOnEvent;
        event.noteOn = {int16(channel), int16(a), 0, b / 127.f, 0, -1};
        send = true;
      } else if (kind == 128 || (kind == 144 && !b)) {
        event.type = Event::kNoteOffEvent;
        event.noteOff = {int16(channel), int16(a), b / 127.f, -1, 0};
        send = true;
      } else if (kind == 160) {
        event.type = Event::kPolyPressureEvent;
        event.polyPressure = {int16(channel), int16(a), b / 127.f, -1};
        send = true;
      } else {
        int control = kind == 224 ? kPitchBend : kind == 208 ? kAfterTouch : a;
        ParamID id = 0;
        double value = kind == 224 ? (a + b * 128) / 16383.0 : kind == 208 ? a / 127.0 : b / 127.0;
        if (mapping &&
            mapping->getMidiControllerAssignment(0, channel, int16(control), id) == kResultOk)
          parameter(id, value, offset);
        else if (kind == 176 && (a == 123 || a == 120))
          for (int pitch = 0; pitch < 128; pitch++) {
            Event off{};
            off.busIndex = 0;
            off.sampleOffset = offset;
            off.type = Event::kNoteOffEvent;
            off.noteOff = {int16(channel), int16(pitch), 0, -1, 0};
            events.addEvent(off);
          }
      }
      if (send)
        require(events.addEvent(event) == kResultOk, "MIDI queue full");
    }
    context = {};
    context.sampleRate = rate;
    context.projectTimeSamples = request.value("startSample", int64_t(0));
    context.continousTimeSamples = context.projectTimeSamples;
    context.projectTimeMusic = request.value("beat", 0.0);
    context.tempo = request.value("bpm", 120.0);
    context.timeSigNumerator = request.value("numerator", 4);
    context.timeSigDenominator = request.value("denominator", 4);
    context.state = ProcessContext::kPlaying | ProcessContext::kTempoValid |
                    ProcessContext::kTimeSigValid | ProcessContext::kProjectTimeMusicValid |
                    ProcessContext::kContTimeValid;
    data.numSamples = count;
    data.processContext = &context;
    data.inputEvents = &events;
    data.inputParameterChanges = &params;
    data.outputParameterChanges = &outputParams;
    require(processor->process(data) == kResultOk, "Plugin failed its audio block");
    output.resize(count * 2);
    for (int i = 0; i < count; i++)
      for (int ch = 0; ch < 2; ch++) {
        float value =
            data.outputs[0].channelBuffers32[data.outputs[0].numChannels == 1 ? 0 : ch][i];
        require(std::isfinite(value), "Plugin returned nonfinite audio");
        output[i * 2 + ch] = value;
      }
    if (controller)
      for (int i = 0; i < outputParams.getParameterCount(); i++) {
        auto queue = outputParams.getParameterData(i);
        int32 offset;
        double value;
        if (queue->getPoint(queue->getPointCount() - 1, offset, value) == kResultOk)
          controller->setParamNormalized(queue->getParameterId(), value);
      }
  }
  Json state() override {
    MemoryStream stream;
    require(component->getState(&stream) == kResultOk, "Plugin does not provide processor state");
    Json result = {
        {"state", encode64(reinterpret_cast<uint8_t *>(stream.getData()), stream.getSize())},
        {"parameters", Json::object()}};
    if (controller) {
      MemoryStream extra;
      if (controller->getState(&extra) == kResultOk)
        result["controllerState"] =
            encode64(reinterpret_cast<uint8_t *>(extra.getData()), extra.getSize());
      for (int i = 0; i < controller->getParameterCount(); i++) {
        ParameterInfo info{};
        if (controller->getParameterInfo(i, info) == kResultOk)
          result["parameters"][std::to_string(info.id)] = controller->getParamNormalized(info.id);
      }
    }
    return result;
  }
  void editor(bool show) override {
#ifdef _WIN32
    if (!show) {
      if (view) {
        view->removed();
        view->setFrame(nullptr);
        view = nullptr;
      }
      if (handler.window) {
        DestroyWindow(handler.window);
        handler.window = nullptr;
      }
      return;
    }
    if (handler.window) {
      ShowWindow(handler.window, SW_SHOW);
      SetForegroundWindow(handler.window);
      return;
    }
    require(bool(controller), "Plugin has no edit controller");
    view = owned(controller->createView(ViewType::kEditor));
    require(bool(view), "Plugin has no custom editor; use parameter controls");
    require(view->isPlatformTypeSupported(kPlatformTypeHWND) == kResultTrue,
            "Plugin editor does not support HWND");
    ViewRect rect{};
    view->getSize(&rect);
    RECT size{0, 0, std::max(200, rect.getWidth()), std::max(100, rect.getHeight())};
    AdjustWindowRect(&size, WS_OVERLAPPEDWINDOW, FALSE);
    static bool registered = false;
    if (!registered) {
      WNDCLASSW cls{};
      cls.lpfnWndProc = [](HWND w, UINT m, WPARAM a, LPARAM b) -> LRESULT {
        if (m == WM_CLOSE) {
          ShowWindow(w, SW_HIDE);
          return 0;
        }
        return DefWindowProcW(w, m, a, b);
      };
      cls.hInstance = GetModuleHandleW(nullptr);
      cls.lpszClassName = L"VmotionPluginEditor";
      RegisterClassW(&cls);
      registered = true;
    }
    handler.window =
        CreateWindowW(L"VmotionPluginEditor", L"Vmotion · VST3", WS_OVERLAPPEDWINDOW, CW_USEDEFAULT,
                      CW_USEDEFAULT, size.right - size.left, size.bottom - size.top, nullptr,
                      nullptr, GetModuleHandleW(nullptr), nullptr);
    require(handler.window != nullptr, "Cannot create plugin editor window");
    view->setFrame(&handler);
    require(view->attached(handler.window, kPlatformTypeHWND) == kResultOk,
            "Cannot attach plugin editor");
    ShowWindow(handler.window, SW_SHOW);
#else
    if (show)
      throw std::runtime_error(
          "Custom VST3 editor currently requires Windows; use parameter controls");
#endif
  }
};
std::unique_ptr<AudioInstance> createVst(const Json &config) {
  return std::make_unique<VstInstance>(config);
}
void pumpVstWindows() {
#ifdef _WIN32
  MSG message;
  while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
#endif
}
