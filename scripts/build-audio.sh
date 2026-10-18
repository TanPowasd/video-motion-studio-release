#!/usr/bin/env bash
set -euo pipefail
# macOS/Linux developer build; Windows uses the verified build-audio.ps1.
vmotion_sdk=artifacts/audio-sdk
vmotion_deps=artifacts/audio-deps
vmotion_commit=3cdf9ca5d1f5b1b21e0a86832aa4abe55607bd96
mkdir -p "$vmotion_deps" dist/native/licenses/audio
if [ ! -d "$vmotion_sdk/.git" ]; then git clone --no-checkout https://github.com/steinbergmedia/vst3sdk.git "$vmotion_sdk"; fi
# Force-checkout the pin even if HEAD already matches: a --no-checkout clone has an empty work tree.
git -C "$vmotion_sdk" rev-parse --verify --quiet "$vmotion_commit^{commit}" >/dev/null || git -C "$vmotion_sdk" fetch origin "$vmotion_commit"
git -C "$vmotion_sdk" -c advice.detachedHead=false checkout --force --detach "$vmotion_commit"
[ "$(git -C "$vmotion_sdk" rev-parse HEAD)" = "$vmotion_commit" ] || { echo "VST3 SDK is not at the pinned commit" >&2; exit 1; }
git -C "$vmotion_sdk" submodule update --init --recursive --force --depth 1 -- base cmake pluginterfaces public.sdk
for vmotion_module in base cmake pluginterfaces public.sdk; do
  vmotion_pinned=$(git -C "$vmotion_sdk" ls-tree HEAD "$vmotion_module" | awk '{print $3}')
  [ -n "$vmotion_pinned" ] && [ "$(git -C "$vmotion_sdk/$vmotion_module" rev-parse HEAD)" = "$vmotion_pinned" ] || { echo "VST3 SDK module $vmotion_module is not at its pinned commit" >&2; exit 1; }
done
if [ ! -f "$vmotion_deps/json.hpp" ]; then curl -fL https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp -o "$vmotion_deps/json.hpp"; fi
node --input-type=module -e "import fs from 'node:fs';import {createHash}from'node:crypto';if(createHash('sha256').update(fs.readFileSync('artifacts/audio-deps/json.hpp')).digest('hex')!=='aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63')throw Error('JSON header hash mismatch');"
curl -fL https://raw.githubusercontent.com/nlohmann/json/v3.12.0/LICENSE.MIT -o "$vmotion_deps/LICENSE.json"
cmake -S native-audio -B artifacts/audio-build -DCMAKE_BUILD_TYPE=Release -DVMOTION_VST3_SDK="$PWD/$vmotion_sdk" -DVMOTION_JSON_INCLUDE="$PWD/$vmotion_deps"
cmake --build artifacts/audio-build --target vmotion-audio vmotion-audio-fixture --parallel 4
cp artifacts/audio-build/vmotion-audio dist/native/vmotion-audio
cp "$vmotion_sdk/LICENSE.txt" dist/native/licenses/audio/Steinberg-MIT.txt
cp "$vmotion_deps/LICENSE.json" dist/native/licenses/audio/nlohmann-json-MIT.txt
node --input-type=module -e "import fs from 'node:fs';const file='dist/native/manifest.json';const manifest=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};manifest.audioExecutable='vmotion-audio';manifest.audioVersion='0.1.0';fs.writeFileSync(file,JSON.stringify(manifest));"
