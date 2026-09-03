$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$fixtureDir = Join-Path $root "tests\fixtures"
$output = Join-Path $fixtureDir "engine-acceptance.mp4"
$subtitle = Join-Path $fixtureDir "engine-acceptance.ass"
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("video-digest-media-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporary | Out-Null

try {
  Add-Type -AssemblyName System.Speech
  $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $english = $voice.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } | Where-Object { $_.Culture.Name -eq "en-US" } | Select-Object -First 1
  if (-not $english) { throw "Generating the owned media fixture requires an installed en-US Windows SAPI voice." }
  $voice.SelectVoice($english.Name)
  $speech = Join-Path $temporary "speech.wav"
  $voice.SetOutputToWaveFile($speech)
  $voice.Speak("Hello Video Digest. This is a subtitle test.")
  $voice.Dispose()

  $ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source
  & $ffmpeg -hide_banner -loglevel error -y `
    -f lavfi -i "color=c=0x202634:s=1280x720:r=25:d=10" `
    -i $speech `
    -vf "subtitles='$($subtitle.Replace('\','/').Replace(':','\:'))'" `
    -af "adelay=1000|1000,apad=pad_dur=10" `
    -t 10 -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -c:a aac -b:a 96k $output
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output)) {
    throw "FFmpeg failed to generate the engine acceptance fixture."
  }
  Write-Host "Generated $output"
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
