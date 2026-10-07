#pragma once
#include "json.hpp"
#include <memory>
#include <string>
#include <vector>
using Json = nlohmann::json;
struct AudioInstance {
  virtual ~AudioInstance() = default;
  virtual Json describe() = 0;
  virtual void process(const Json &request, const std::vector<float> &input,
                       std::vector<float> &output) = 0;
  virtual Json state() = 0;
  virtual void editor(bool show) = 0;
};
std::vector<uint8_t> decode64(const std::string &value);
std::string encode64(const uint8_t *data, size_t size);
std::unique_ptr<AudioInstance> createVst(const Json &config);
Json scanVst(const std::string &path);
void pumpVstWindows();
#ifdef __APPLE__
std::unique_ptr<AudioInstance> createAu(const Json &config);
Json scanAu();
void pumpAuWindows();
#endif
