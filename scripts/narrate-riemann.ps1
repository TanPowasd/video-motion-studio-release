param([string]$InputJson,[string]$OutputDirectory,[int]$Rate=0)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$vmotionNarration = Get-Content -LiteralPath $InputJson -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$vmotionSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$vmotionSynth.SelectVoice('Microsoft Huihui Desktop')
$vmotionSynth.Rate=$Rate
$vmotionSynth.Volume=100
$vmotionAudioFormat = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
try {
  foreach($vmotionSegment in $vmotionNarration) {
    $vmotionWavePath=Join-Path $OutputDirectory ($vmotionSegment.id+'.wav')
    if(!(Test-Path -LiteralPath $vmotionWavePath)) {
      $vmotionSynth.SetOutputToWaveFile($vmotionWavePath,$vmotionAudioFormat)
      $vmotionSynth.Speak([string]$vmotionSegment.text)
      $vmotionSynth.SetOutputToNull()
    }
    Write-Output $vmotionSegment.id
  }
} finally { $vmotionSynth.Dispose() }
