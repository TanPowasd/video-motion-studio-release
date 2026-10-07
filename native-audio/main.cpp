#include "host.h"
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <stdexcept>
#include <thread>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <objbase.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

std::string encode64(const uint8_t *data, size_t size) {
  static const char *digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (size > 1024 * 1024)
    throw std::runtime_error("Plugin state exceeds 1 MiB per processor/controller");
  std::string out;
  out.reserve((size + 2) / 3 * 4);
  for (size_t i = 0; i < size; i += 3) {
    uint32_t v = uint32_t(data[i]) << 16;
    if (i + 1 < size)
      v |= uint32_t(data[i + 1]) << 8;
    if (i + 2 < size)
      v |= data[i + 2];
    out += digits[(v >> 18) & 63];
    out += digits[(v >> 12) & 63];
    out += i + 1 < size ? digits[(v >> 6) & 63] : '=';
    out += i + 2 < size ? digits[v & 63] : '=';
  }
  return out;
}
std::vector<uint8_t> decode64(const std::string &value) {
  if (value.size() > 6 * 1024 * 1024)
    throw std::runtime_error("Plugin state exceeds limit");
  const std::string digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::vector<uint8_t> out;
  uint32_t bits = 0;
  int count = 0;
  for (char c : value) {
    if (c == '=')
      break;
    auto index = digits.find(c);
    if (index == std::string::npos)
      throw std::runtime_error("Invalid state Base64");
    bits = (bits << 6) | uint32_t(index);
    count += 6;
    if (count >= 8) {
      count -= 8;
      out.push_back(uint8_t(bits >> count));
    }
  }
  return out;
}
struct Packet {
  Json request;
  std::vector<float> input;
};
int main() {
#ifdef _WIN32
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  FILE *output = _fdopen(_dup(_fileno(stdout)), "wb");
  _dup2(_fileno(stderr), _fileno(stdout));
  SetStdHandle(STD_OUTPUT_HANDLE, GetStdHandle(STD_ERROR_HANDLE));
#else
  FILE *output = fdopen(dup(fileno(stdout)), "wb");
  dup2(fileno(stderr), fileno(stdout));
#endif
  std::mutex mutex;
  std::condition_variable available, space;
  std::deque<Packet> queue;
  bool ended = false;
  std::thread reader([&] {
    try {
      for (;;) {
        uint32_t sizes[2];
        if (fread(sizes, 1, 8, stdin) != 8)
          break;
        if (sizes[0] > 8 * 1024 * 1024 || sizes[1] > 16384 * 8 || sizes[1] % 8)
          break;
        std::string json(sizes[0], '\0');
        std::vector<float> pcm(sizes[1] / 4);
        if (fread(json.data(), 1, json.size(), stdin) != json.size() ||
            fread(pcm.data(), 1, sizes[1], stdin) != sizes[1])
          break;
        Packet packet{Json::parse(json), std::move(pcm)};
        std::unique_lock<std::mutex> lock(mutex);
        space.wait(lock, [&] { return queue.size() < 8; });
        queue.push_back(std::move(packet));
        available.notify_one();
      }
    } catch (...) {
    }
    {
      std::lock_guard<std::mutex> lock(mutex);
      ended = true;
    }
    available.notify_one();
  });
  std::unique_ptr<AudioInstance> instance;
  for (;;) {
    pumpVstWindows();
#ifdef __APPLE__
    pumpAuWindows();
#endif
    Packet packet;
    {
      std::unique_lock<std::mutex> lock(mutex);
      available.wait_for(lock, std::chrono::milliseconds(4),
                         [&] { return !queue.empty() || ended; });
      if (queue.empty()) {
        if (ended)
          break;
        continue;
      }
      packet = std::move(queue.front());
      queue.pop_front();
      space.notify_one();
    }
    Json response = {{"id", packet.request.value("id", 0)}};
    std::vector<float> audio;
    try {
      const auto op = packet.request.at("op").get<std::string>();
      if (op == "scan") {
        const auto format = packet.request.value("format", "vst3");
        if (format == "vst3")
          response["result"] = scanVst(packet.request.at("path"));
#ifdef __APPLE__
        else if (format == "au")
          response["result"] = scanAu();
#endif
        else
          throw std::runtime_error("AU requires macOS");
      } else if (op == "open") {
        instance.reset();
        if (packet.request.value("format", "vst3") == "vst3")
          instance = createVst(packet.request);
#ifdef __APPLE__
        else
          instance = createAu(packet.request);
#endif
        if (!instance)
          throw std::runtime_error("Plugin format is unavailable on this platform");
        response["result"] = instance->describe();
      } else {
        if (!instance)
          throw std::runtime_error("Plugin is not open");
        if (op == "process") {
          instance->process(packet.request, packet.input, audio);
          response["result"] = {{"frames", audio.size() / 2}};
        } else if (op == "state")
          response["result"] = instance->state();
        else if (op == "editor") {
          instance->editor(packet.request.value("show", true));
          response["result"] = {{"visible", packet.request.value("show", true)}};
        } else if (op == "describe")
          response["result"] = instance->describe();
        else if (op == "close") {
          instance.reset();
          response["result"] = {{"closed", true}};
        } else
          throw std::runtime_error("Unknown audio host command");
      }
    } catch (const std::exception &error) {
      response["error"] = {{"code", "AUDIO_PLUGIN_HOST"}, {"message", error.what()}};
      audio.clear();
    }
    auto text = response.dump(-1, ' ', false, Json::error_handler_t::replace);
    uint32_t sizes[2] = {uint32_t(text.size()), uint32_t(audio.size() * 4)};
    fwrite(sizes, 1, 8, output);
    fwrite(text.data(), 1, text.size(), output);
    fwrite(audio.data(), 1, sizes[1], output);
    fflush(output);
  }
  instance.reset();
  reader.join();
  fclose(output);
#ifdef _WIN32
  CoUninitialize();
#endif
  return 0;
}
