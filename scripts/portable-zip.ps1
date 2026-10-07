$ErrorActionPreference = 'Stop'
$vmotionRelease = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) 'release'))
$vmotionSource = Join-Path $vmotionRelease 'Vmotion'
if (!(Test-Path -LiteralPath (Join-Path $vmotionSource 'portable-manifest.json'))) { throw 'Build the portable package first' }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$vmotionArchive = Join-Path $vmotionRelease 'Vmotion-Windows-x64-Portable.zip'
$vmotionPartial = $vmotionArchive + '.partial'
$vmotionStream = [System.IO.File]::Open($vmotionPartial, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$vmotionZip = New-Object System.IO.Compression.ZipArchive($vmotionStream, [System.IO.Compression.ZipArchiveMode]::Create)
$vmotionFiles = 0
try {
  foreach ($vmotionFile in Get-ChildItem -LiteralPath $vmotionSource -File -Recurse) {
    $vmotionRelative = $vmotionFile.FullName.Substring($vmotionSource.Length + 1)
    if ($vmotionRelative -eq 'profile' -or $vmotionRelative.StartsWith('profile')) { continue }
    $vmotionEntry = 'Vmotion/' + $vmotionRelative.Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($vmotionZip, $vmotionFile.FullName, $vmotionEntry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    $vmotionFiles++
  }
} finally { $vmotionZip.Dispose(); $vmotionStream.Dispose() }
Move-Item -LiteralPath $vmotionPartial -Destination $vmotionArchive -Force
$vmotionDigest = (Get-FileHash -LiteralPath $vmotionArchive -Algorithm SHA256).Hash.ToLower()
[System.IO.File]::WriteAllText($vmotionArchive + '.sha256', $vmotionDigest + '  ' + [System.IO.Path]::GetFileName($vmotionArchive) + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
@{output=$vmotionArchive;bytes=(Get-Item -LiteralPath $vmotionArchive).Length;files=$vmotionFiles;sha256=$vmotionDigest} | ConvertTo-Json -Compress
