$ErrorActionPreference = 'Stop'
$vmotionSdk = Join-Path $PWD 'artifacts/audio-sdk'
$vmotionAudioDeps = Join-Path $PWD 'artifacts/audio-deps'
$vmotionSdkCommit = '3cdf9ca5d1f5b1b21e0a86832aa4abe55607bd96'
New-Item -ItemType Directory -Path $vmotionAudioDeps -Force | Out-Null
if (!(Test-Path -LiteralPath (Join-Path $vmotionSdk '.git'))) {
 & git -c http.proxy= -c https.proxy= clone --no-checkout https://github.com/steinbergmedia/vst3sdk.git $vmotionSdk
 if ($LASTEXITCODE -ne 0) { throw 'Cannot acquire MIT VST3 SDK' }
}
if ((& git -C $vmotionSdk rev-parse HEAD) -ne $vmotionSdkCommit) {
 & git -C $vmotionSdk -c http.proxy= -c https.proxy= fetch origin $vmotionSdkCommit
 & git -C $vmotionSdk checkout --detach $vmotionSdkCommit
 if ($LASTEXITCODE -ne 0) { throw 'Cannot pin VST3 SDK' }
}
& git -C $vmotionSdk -c http.proxy= -c https.proxy= submodule update --init --depth 1 -- base cmake pluginterfaces public.sdk
if ($LASTEXITCODE -ne 0) { throw 'Cannot acquire pinned VST3 SDK modules' }
$vmotionJson = Join-Path $vmotionAudioDeps 'json.hpp'
if (!(Test-Path -LiteralPath $vmotionJson)) {
 & curl.exe --noproxy '*' --fail -L --max-time 120 -o $vmotionJson 'https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp'
 if ($LASTEXITCODE -ne 0) { throw 'Cannot acquire JSON header' }
}
if ((Get-FileHash -LiteralPath $vmotionJson -Algorithm SHA256).Hash.ToLower() -ne 'aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63') { throw 'JSON header hash mismatch' }
& cmake -S native-audio -B artifacts/audio-build -G 'Visual Studio 17 2022' -A x64 "-DVMOTION_VST3_SDK=$vmotionSdk" "-DVMOTION_JSON_INCLUDE=$vmotionAudioDeps"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& cmake --build artifacts/audio-build --config Release --target vmotion-audio vmotion-audio-fixture --parallel 4
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$vmotionAudioSource = Join-Path $PWD 'artifacts/audio-build/Release/vmotion-audio.exe'
$vmotionAudioHash = (Get-FileHash -LiteralPath $vmotionAudioSource -Algorithm SHA256).Hash.ToLower().Substring(0,16)
$vmotionAudioExe = "vmotion-audio-$vmotionAudioHash.exe"
New-Item -ItemType Directory -Path dist/native/licenses/audio -Force | Out-Null
Copy-Item -LiteralPath $vmotionAudioSource -Destination (Join-Path $PWD "dist/native/$vmotionAudioExe") -Force
$vmotionManifest = Get-Content -LiteralPath dist/native/manifest.json -Raw | ConvertFrom-Json -AsHashtable
$vmotionManifest.audioExecutable=$vmotionAudioExe
$vmotionManifest.audioVersion='0.1.0'
[System.IO.File]::WriteAllText((Join-Path $PWD 'dist/native/manifest.json'),($vmotionManifest|ConvertTo-Json -Compress),[System.Text.UTF8Encoding]::new($false))
foreach ($vmotionPart in @('base','pluginterfaces','public.sdk','')) {
 $vmotionNotice = Join-Path (Join-Path $vmotionSdk $vmotionPart) 'LICENSE.txt'
 if (Test-Path -LiteralPath $vmotionNotice) { Copy-Item -LiteralPath $vmotionNotice -Destination (Join-Path $PWD ('dist/native/licenses/audio/Steinberg-'+($vmotionPart.Replace('.','_'))+'-MIT.txt')) -Force }
}
if (!(Test-Path -LiteralPath artifacts/audio-deps/LICENSE.json)) {
 & curl.exe --noproxy '*' --fail -L --max-time 120 -o artifacts/audio-deps/LICENSE.json 'https://raw.githubusercontent.com/nlohmann/json/v3.12.0/LICENSE.MIT'
 if ($LASTEXITCODE -ne 0) { throw 'Cannot acquire JSON license' }
}
Copy-Item -LiteralPath artifacts/audio-deps/LICENSE.json -Destination dist/native/licenses/audio/nlohmann-json-MIT.txt -Force
@{sdkCommit=$vmotionSdkCommit;sdkVersion='3.8.1';sdkLicense='MIT';jsonVersion='3.12.0';jsonSha256='aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63'} | ConvertTo-Json | Set-Content -LiteralPath dist/native/licenses/audio/provenance.json -Encoding utf8
