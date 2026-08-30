param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\engine-build"),
  [string]$VideocrCliPath = "$env:VIDEO_DIGEST_VIDEOCR_CLI",
  [string]$WhisperCliPath = "$env:VIDEO_DIGEST_WHISPER_CLI",
  [string]$FfmpegPath = "$env:VIDEO_DIGEST_FFMPEG",
  [string]$FfprobePath = "$env:VIDEO_DIGEST_FFPROBE"
)

$ErrorActionPreference = "Stop"
$sourceDirectory = Join-Path $PSScriptRoot "video-digest-engine"
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$staging = Join-Path $output "adapter-build"

function Require-File([string]$PathValue, [string]$Label) {
  if (-not $PathValue -or -not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
    throw "$Label 不存在：$PathValue"
  }
  return (Resolve-Path -LiteralPath $PathValue).Path
}

function Copy-Backend([string]$PathValue, [string]$Label, [string]$ExpectedName) {
  if (-not $PathValue) { throw "$Label 未配置。" }
  if (Test-Path -LiteralPath $PathValue -PathType Leaf) {
    Copy-Item -LiteralPath $PathValue -Destination (Join-Path $output $ExpectedName) -Force
    return
  }
  if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) {
    throw "$Label 不存在：$PathValue"
  }
  Get-ChildItem -LiteralPath $PathValue -Force | Copy-Item -Destination $output -Recurse -Force
  if (-not (Test-Path -LiteralPath (Join-Path $output $ExpectedName) -PathType Leaf)) {
    throw "$Label 目录中没有 $ExpectedName。"
  }
}

if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
New-Item -ItemType Directory -Path $output -Force | Out-Null
New-Item -ItemType Directory -Path $staging -Force | Out-Null

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { throw "构建引擎需要构建机安装 Python。" }

& $python.Source -m nuitka --version *> $null
if ($LASTEXITCODE -ne 0) { throw "构建引擎需要安装 Nuitka：python -m pip install nuitka" }

& $python.Source -m nuitka `
  --onefile `
  --follow-imports `
  --assume-yes-for-downloads `
  --output-dir=$staging `
  --output-filename=video-digest-engine.exe `
  (Join-Path $sourceDirectory "video_digest_engine.py")
if ($LASTEXITCODE -ne 0) { throw "Video Digest 引擎适配器编译失败。" }

Copy-Item -LiteralPath (Join-Path $staging "video-digest-engine.exe") -Destination (Join-Path $output "video-digest-engine.exe") -Force
Copy-Backend $VideocrCliPath "VideOCR CLI" "videocr-cli.exe"
Copy-Backend $WhisperCliPath "whisper.cpp CLI" "whisper-cli.exe"
Copy-Backend $FfmpegPath "FFmpeg" "ffmpeg.exe"
if ($FfprobePath) { Copy-Backend $FfprobePath "FFprobe" "ffprobe.exe" }

$manifest = @{
  name = "Video Digest local OCR/ASR engine"
  version = "0.1.0"
  executable = "video-digest-engine.exe"
  args = @("--config", "{{configPath}}")
  protocol = "jsonl-v1"
  supportsPause = $true
  backends = @{
    ocr = "VideOCR CLI + PaddleOCR (local)"
    asr = "whisper.cpp"
  }
} | ConvertTo-Json -Depth 6
Set-Content -LiteralPath (Join-Path $output "manifest.json") -Value $manifest -Encoding utf8

$licenseSource = Join-Path $PSScriptRoot "licenses"
if (Test-Path -LiteralPath $licenseSource -PathType Container) {
  New-Item -ItemType Directory -Path (Join-Path $output "licenses") -Force | Out-Null
  Get-ChildItem -LiteralPath $licenseSource -Force | Copy-Item -Destination (Join-Path $output "licenses") -Recurse -Force
}

Remove-Item -LiteralPath $staging -Recurse -Force
Write-Output $output
