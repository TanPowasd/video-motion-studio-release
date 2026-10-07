$vmotionCargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
if (!(Test-Path -LiteralPath $vmotionCargo)) { $vmotionCargo = 'cargo' }
& $vmotionCargo test --manifest-path crates/vmotion-core/Cargo.toml
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $vmotionCargo test --manifest-path crates/vmotion-gpu/Cargo.toml
exit $LASTEXITCODE
