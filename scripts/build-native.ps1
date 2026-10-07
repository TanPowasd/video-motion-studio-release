$ErrorActionPreference = 'Stop'
$vmotionCargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
if (!(Test-Path -LiteralPath $vmotionCargo)) { $vmotionCargo = 'cargo' }
& $vmotionCargo build --manifest-path crates/vmotion-core/Cargo.toml --release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $vmotionCargo build --manifest-path crates/vmotion-gpu/Cargo.toml --release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
New-Item -ItemType Directory -Path dist/native -Force | Out-Null
$vmotionSha=[System.Security.Cryptography.SHA256]::Create()
try{$vmotionHash=[BitConverter]::ToString($vmotionSha.ComputeHash([System.IO.File]::ReadAllBytes((Join-Path (Get-Location) 'crates/vmotion-core/target/release/vmotion-core.exe')))).Replace('-','').ToLower().Substring(0,16)}finally{$vmotionSha.Dispose()}
$vmotionExecutable='vmotion-core-'+$vmotionHash+'.exe'
$vmotionDestination=Join-Path 'dist/native' $vmotionExecutable
if(!(Test-Path -LiteralPath $vmotionDestination)){Copy-Item -LiteralPath crates/vmotion-core/target/release/vmotion-core.exe -Destination $vmotionDestination}
$vmotionSha=[System.Security.Cryptography.SHA256]::Create()
try{$vmotionGpuHash=[BitConverter]::ToString($vmotionSha.ComputeHash([System.IO.File]::ReadAllBytes((Join-Path (Get-Location) 'crates/vmotion-gpu/target/release/vmotion-gpu.exe')))).Replace('-','').ToLower().Substring(0,16)}finally{$vmotionSha.Dispose()}
$vmotionGpuExecutable='vmotion-gpu-'+$vmotionGpuHash+'.exe'
$vmotionGpuDestination=Join-Path 'dist/native' $vmotionGpuExecutable
if(!(Test-Path -LiteralPath $vmotionGpuDestination)){Copy-Item -LiteralPath crates/vmotion-gpu/target/release/vmotion-gpu.exe -Destination $vmotionGpuDestination}
$vmotionManifest=@{executable=$vmotionExecutable;version='0.5.0';gpuExecutable=$vmotionGpuExecutable;gpuVersion='0.1.0'} | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'dist/native/manifest.json'),$vmotionManifest,(New-Object System.Text.UTF8Encoding($false)))
$vmotionMetadataText = & $vmotionCargo metadata --manifest-path crates/vmotion-gpu/Cargo.toml --format-version 1 --locked
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$vmotionMetadata = $vmotionMetadataText | ConvertFrom-Json
$vmotionNotices = @()
foreach ($vmotionPackage in $vmotionMetadata.packages) {
  if ($vmotionPackage.name -eq 'vmotion-gpu') { continue }
  $vmotionNoticeDir = Join-Path 'dist/native/licenses' ($vmotionPackage.name + '-' + $vmotionPackage.version)
  New-Item -ItemType Directory -Path $vmotionNoticeDir -Force | Out-Null
  $vmotionPackageDir = Split-Path -Parent $vmotionPackage.manifest_path
  $vmotionLicenseFiles = @(Get-ChildItem -LiteralPath $vmotionPackageDir -File | Where-Object { $_.Name -match '^(LICENSE|LICENCE|COPYING|NOTICE)' })
  foreach ($vmotionLicenseFile in $vmotionLicenseFiles) { Copy-Item -LiteralPath $vmotionLicenseFile.FullName -Destination (Join-Path $vmotionNoticeDir $vmotionLicenseFile.Name) }
  if ($vmotionPackage.license_file) {
    $vmotionLicensePath = Join-Path $vmotionPackageDir $vmotionPackage.license_file
    if (Test-Path -LiteralPath $vmotionLicensePath) { Copy-Item -LiteralPath $vmotionLicensePath -Destination (Join-Path $vmotionNoticeDir (Split-Path -Leaf $vmotionLicensePath)) }
  }
  $vmotionNotices += @{name=$vmotionPackage.name;version=$vmotionPackage.version;license=$vmotionPackage.license;repository=$vmotionPackage.repository}
}
[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'dist/native/licenses/index.json'), ($vmotionNotices | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
& pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/build-audio.ps1
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
