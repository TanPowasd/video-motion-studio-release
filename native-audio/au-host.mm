#include "host.h"
#import <AudioToolbox/AudioToolbox.h>
#import <AudioUnit/AUCocoaUIView.h>
#import <Cocoa/Cocoa.h>
#include <cmath>
#include <sstream>
static void check(OSStatus result, const char *message) {
  if (result != noErr)
    throw std::runtime_error(std::string(message) + " OSStatus=" + std::to_string(result));
}
static std::string auId(const AudioComponentDescription &d) {
  return std::to_string(d.componentType) + ":" + std::to_string(d.componentSubType) + ":" +
         std::to_string(d.componentManufacturer);
}
static AudioComponentDescription parseId(const std::string &id) {
  AudioComponentDescription d{};
  char colon;
  std::istringstream stream(id);
  stream >> d.componentType >> colon >> d.componentSubType >> colon >> d.componentManufacturer;
  if (!stream)
    throw std::runtime_error("Invalid AU component ID");
  return d;
}
static std::string auName(AudioComponent c) {
  CFStringRef name = nullptr;
  AudioComponentCopyName(c, &name);
  std::string value = name ? [(__bridge NSString *)name UTF8String] : "Audio Unit";
  if (name)
    CFRelease(name);
  return value;
}
Json scanAu() {
  Json list = Json::array();
  for (OSType type :
       {kAudioUnitType_MusicDevice, kAudioUnitType_Effect, kAudioUnitType_MusicEffect}) {
    AudioComponentDescription filter{};
    filter.componentType = type;
    AudioComponent c = nullptr;
    while ((c = AudioComponentFindNext(c, &filter))) {
      AudioComponentDescription d{};
      AudioComponentGetDescription(c, &d);
      UInt32 version = 0;
      AudioComponentGetVersion(c, &version);
      list.push_back({{"format", "au"},
                      {"path", "au:" + auId(d)},
                      {"classId", auId(d)},
                      {"name", auName(c)},
                      {"vendor", std::to_string(d.componentManufacturer)},
                      {"version", std::to_string(version)},
                      {"categories",
                       Json::array({type == kAudioUnitType_MusicDevice ? "Instrument" : "Fx"})}});
    }
  }
  return list;
}
class AuInstance final : public AudioInstance {
  AudioUnit unit = nullptr;
  Json identity;
  double rate;
  UInt32 maxFrames;
  std::vector<float> input;
  std::map<UInt32, AudioUnitParameterInfo> infos;
  NSWindow *window = nil;
  static OSStatus callback(void *ref, AudioUnitRenderActionFlags *, const AudioTimeStamp *, UInt32,
                           UInt32 frames, AudioBufferList *data) {
    auto *self = static_cast<AuInstance *>(ref);
    if (data->mNumberBuffers != 1 || data->mBuffers[0].mDataByteSize < frames * 8)
      return kAudio_ParamError;
    memcpy(data->mBuffers[0].mData, self->input.data(), frames * 8);
    return noErr;
  }
  void parameter(UInt32 id, double normalized) {
    auto it = infos.find(id);
    if (it == infos.end())
      return;
    auto &info = it->second;
    check(AudioUnitSetParameter(unit, id, kAudioUnitScope_Global, 0,
                                info.minValue + normalized * (info.maxValue - info.minValue), 0),
          "AU parameter");
  }

public:
  explicit AuInstance(const Json &config) {
    rate = config.value("sampleRate", 48000.0);
    maxFrames = config.value("blockSize", 4096);
    auto d = parseId(config.at("classId"));
    auto c = AudioComponentFindNext(nullptr, &d);
    if (!c)
      throw std::runtime_error("AU is not installed");
    check(AudioComponentInstanceNew(c, &unit), "AU instance");
    identity = {{"format", "au"},
                {"path", config.at("path")},
                {"classId", config.at("classId")},
                {"name", auName(c)},
                {"vendor", std::to_string(d.componentManufacturer)},
                {"version", "system"}};
    AudioStreamBasicDescription format{};
    format.mSampleRate = rate;
    format.mFormatID = kAudioFormatLinearPCM;
    format.mFormatFlags = kAudioFormatFlagsNativeFloatPacked;
    format.mBytesPerPacket = 8;
    format.mFramesPerPacket = 1;
    format.mBytesPerFrame = 8;
    format.mChannelsPerFrame = 2;
    format.mBitsPerChannel = 32;
    check(AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 0,
                               &format, sizeof(format)),
          "AU output format");
    if (d.componentType != kAudioUnitType_MusicDevice) {
      check(AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0,
                                 &format, sizeof(format)),
            "AU input format");
      AURenderCallbackStruct cb{callback, this};
      check(AudioUnitSetProperty(unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input,
                                 0, &cb, sizeof(cb)),
            "AU input callback");
    }
    check(AudioUnitSetProperty(unit, kAudioUnitProperty_MaximumFramesPerSlice,
                               kAudioUnitScope_Global, 0, &maxFrames, sizeof(maxFrames)),
          "AU block size");
    if (config.contains("state")) {
      auto bytes = decode64(config["state"]);
      NSData *data = [NSData dataWithBytes:bytes.data() length:bytes.size()];
      id state = [NSPropertyListSerialization propertyListWithData:data
                                                           options:NSPropertyListImmutable
                                                            format:nil
                                                             error:nil];
      if (!state)
        throw std::runtime_error("Invalid AU saved state");
      CFPropertyListRef cf = (__bridge CFPropertyListRef)state;
      check(AudioUnitSetProperty(unit, kAudioUnitProperty_ClassInfo, kAudioUnitScope_Global, 0, &cf,
                                 sizeof(cf)),
            "AU restore state");
    }
    check(AudioUnitInitialize(unit), "AU initialize");
    UInt32 bytes = 0;
    Boolean writable = false;
    AudioUnitGetPropertyInfo(unit, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0,
                             &bytes, &writable);
    std::vector<UInt32> ids(bytes / sizeof(UInt32));
    if (bytes) {
      check(AudioUnitGetProperty(unit, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0,
                                 ids.data(), &bytes),
            "AU parameters");
      for (auto id : ids) {
        AudioUnitParameterInfo info{};
        UInt32 size = sizeof(info);
        if (AudioUnitGetProperty(unit, kAudioUnitProperty_ParameterInfo, kAudioUnitScope_Global, id,
                                 &info, &size) == noErr)
          infos[id] = info;
      }
    }
    if (config.contains("parameters"))
      for (auto it = config["parameters"].begin(); it != config["parameters"].end(); ++it)
        parameter(std::stoul(it.key()), it.value());
  }
  ~AuInstance() {
    editor(false);
    if (unit) {
      AudioUnitUninitialize(unit);
      AudioComponentInstanceDispose(unit);
    }
    for (auto &[id, info] : infos)
      if (info.flags & kAudioUnitParameterFlag_CFNameRelease && info.cfNameString)
        CFRelease(info.cfNameString);
  }
  Json describe() override {
    Json result = identity;
    result["parameters"] = Json::array();
    Float64 latency = 0, tail = 0;
    UInt32 size = sizeof(latency);
    AudioUnitGetProperty(unit, kAudioUnitProperty_Latency, kAudioUnitScope_Global, 0, &latency,
                         &size);
    size = sizeof(tail);
    AudioUnitGetProperty(unit, kAudioUnitProperty_TailTime, kAudioUnitScope_Global, 0, &tail,
                         &size);
    result["latencySamples"] = std::ceil(latency * rate);
    result["tailSamples"] = std::ceil(tail * rate);
    for (auto &[id, info] : infos) {
      Float32 value = 0;
      AudioUnitGetParameter(unit, id, kAudioUnitScope_Global, 0, &value);
      std::string name = info.flags & kAudioUnitParameterFlag_HasCFNameString && info.cfNameString
                             ? [(__bridge NSString *)info.cfNameString UTF8String]
                             : info.name;
      result["parameters"].push_back(
          {{"id", std::to_string(id)},
           {"name", name},
           {"unit", ""},
           {"value", info.maxValue == info.minValue
                         ? 0
                         : (value - info.minValue) / (info.maxValue - info.minValue)},
           {"default", info.maxValue == info.minValue
                           ? 0
                           : (info.defaultValue - info.minValue) / (info.maxValue - info.minValue)},
           {"steps", 0},
           {"flags", 0}});
    }
    return result;
  }
  void process(const Json &request, const std::vector<float> &pcm,
               std::vector<float> &output) override {
    UInt32 frames = request.at("frames");
    if (frames > maxFrames)
      throw std::runtime_error("AU block budget");
    input = pcm;
    if (input.empty())
      input.resize(frames * 2);
    if (input.size() != frames * 2)
      throw std::runtime_error("AU input mismatch");
    if (request.contains("parameters"))
      for (auto it = request["parameters"].begin(); it != request["parameters"].end(); ++it)
        parameter(std::stoul(it.key()), it.value());
    for (auto &m : request.value("midi", Json::array()))
      check(MusicDeviceMIDIEvent(unit, m.at("status"), m.value("a", 0), m.value("b", 0),
                                 m.value("offset", 0)),
            "AU MIDI");
    output.resize(frames * 2);
    AudioBufferList buffers{1, {{2, frames * 8, output.data()}}};
    AudioTimeStamp time{};
    time.mSampleTime = request.value("startSample", 0.0);
    time.mFlags = kAudioTimeStampSampleTimeValid;
    AudioUnitRenderActionFlags flags = 0;
    check(AudioUnitRender(unit, &flags, &time, 0, frames, &buffers), "AU render");
    for (float v : output)
      if (!std::isfinite(v))
        throw std::runtime_error("AU nonfinite audio");
  }
  Json state() override {
    CFPropertyListRef state = nullptr;
    UInt32 size = sizeof(state);
    check(AudioUnitGetProperty(unit, kAudioUnitProperty_ClassInfo, kAudioUnitScope_Global, 0,
                               &state, &size),
          "AU save state");
    NSData *data = [NSPropertyListSerialization dataWithPropertyList:(__bridge id)state
                                                              format:NSPropertyListBinaryFormat_v1_0
                                                             options:0
                                                               error:nil];
    Json result = {{"state", encode64(static_cast<const uint8_t *>(data.bytes), data.length)},
                   {"parameters", Json::object()}};
    CFRelease(state);
    auto parameters = describe()["parameters"];
    for (auto &p : parameters)
      result["parameters"][p["id"].get<std::string>()] = p["value"];
    return result;
  }
  void editor(bool show) override {
    if (!show) {
      if (window) {
        [window close];
        window = nil;
      }
      return;
    }
    if (window) {
      [window makeKeyAndOrderFront:nil];
      return;
    }
    UInt32 bytes = 0;
    Boolean writable = false;
    check(AudioUnitGetPropertyInfo(unit, kAudioUnitProperty_CocoaUI, kAudioUnitScope_Global, 0,
                                   &bytes, &writable),
          "AU has no Cocoa editor; use parameter controls");
    std::vector<uint8_t> infoBytes(bytes);
    check(AudioUnitGetProperty(unit, kAudioUnitProperty_CocoaUI, kAudioUnitScope_Global, 0,
                               infoBytes.data(), &bytes),
          "AU editor");
    auto *info = reinterpret_cast<AudioUnitCocoaViewInfo *>(infoBytes.data());
    NSBundle *bundle = [NSBundle bundleWithURL:(__bridge NSURL *)info->mCocoaAUViewBundleLocation];
    [bundle load];
    Class cls = NSClassFromString((__bridge NSString *)info->mCocoaAUViewClass[0]);
    id<AUCocoaUIBase> factory = [[cls alloc] init];
    NSView *view = [factory uiViewForAudioUnit:unit withSize:NSMakeSize(640, 480)];
    if (!view)
      throw std::runtime_error("AU returned no editor");
    window =
        [[NSWindow alloc] initWithContentRect:view.frame
                                    styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                                      backing:NSBackingStoreBuffered
                                        defer:NO];
    window.releasedWhenClosed = NO;
    window.contentView = view;
    window.title = @"Vmotion · AU";
    [window makeKeyAndOrderFront:nil];
    CFRelease(info->mCocoaAUViewBundleLocation);
    for (UInt32 i = 0; i < (bytes - sizeof(CFURLRef)) / sizeof(CFStringRef); i++)
      CFRelease(info->mCocoaAUViewClass[i]);
  }
};
std::unique_ptr<AudioInstance> createAu(const Json &config) {
  return std::make_unique<AuInstance>(config);
}
void pumpAuWindows() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    NSEvent *event;
    while ((event = [NSApp nextEventMatchingMask:NSEventMaskAny
                                       untilDate:[NSDate distantPast]
                                          inMode:NSDefaultRunLoopMode
                                         dequeue:YES]))
      [NSApp sendEvent:event];
  }
}
