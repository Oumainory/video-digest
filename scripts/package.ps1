param(
  [string]$OutputDirectory = "dist",
  [string]$CompanionDownloadUrl = "$env:VIDEO_DIGEST_COMPANION_DOWNLOAD_URL"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$files = @(
  "manifest.json",
  "background.js",
  "content.js",
  "youtube-content.js",
  "settings.js",
  "sidepanel.html",
  "sidepanel.css",
  "sidepanel.js",
  "options.html",
  "options.css",
  "options.js",
  "lib/companion-protocol.js",
  "lib/companion-bridge.js",
  "lib/companion-release.js",
  "lib/local-transcript-store.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png"
)
$directories = @("lib", "prompts", "_locales")
$manifest = Get-Content -Raw -LiteralPath "manifest.json" | ConvertFrom-Json
$version = $manifest.version
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "video-digest-extension-$([guid]::NewGuid().ToString('N'))"
$output = Join-Path $root (Join-Path $OutputDirectory "digest-for-bilibili-$version.zip")

try {
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing file: $file" }
    $destination = Join-Path $stage $file
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $file -Destination $destination -Force
  }
  foreach ($directory in $directories) {
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw "Missing directory: $directory" }
    $destination = Join-Path $stage $directory
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Get-ChildItem -LiteralPath $directory -Force | Copy-Item -Destination $destination -Recurse -Force
  }

  if ($CompanionDownloadUrl) {
    & node (Join-Path $PSScriptRoot "write-companion-release.cjs") `
      (Join-Path $stage "lib/companion-release.js") $CompanionDownloadUrl $version
    if ($LASTEXITCODE -ne 0) { throw "Invalid companion download URL." }
  }

  # Validate manifest, HTML, and service-worker references before zipping.
  & node (Join-Path $PSScriptRoot "validate-package.cjs") $stage
  if ($LASTEXITCODE -ne 0) { throw "Extension reference validation failed." }

  $outputParent = Split-Path -Parent $output
  New-Item -ItemType Directory -Force -Path $outputParent | Out-Null
  if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stage,
    $output,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )
  Write-Output $output
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
