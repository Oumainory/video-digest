param(
  [string]$ExtensionId = "",
  [string]$EdgeExtensionId = "",
  [string]$InstallDir = "$env:LOCALAPPDATA\Video Digest Companion\native-host",
  [string]$HostExecutable = "",
  [switch]$Unregister
)

$ErrorActionPreference = "Stop"

$manifestSource = Join-Path $PSScriptRoot "native-host-manifest.example.json"
$manifestTemplate = Get-Content -Raw -LiteralPath $manifestSource | ConvertFrom-Json
$chromeKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$($manifestTemplate.name)"
$edgeKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$($manifestTemplate.name)"

if ($Unregister) {
  foreach ($key in @($chromeKey, $edgeKey)) {
    if (Test-Path -LiteralPath $key) {
      Remove-Item -LiteralPath $key -Recurse -Force
    }
  }
  exit 0
}

function Assert-ExtensionId([string]$value, [string]$label) {
  if ($value -notmatch '^[a-p]{32}$') {
    throw "$label is not a valid Chromium extension ID: $value"
  }
}

if (-not $ExtensionId) {
  throw "A Chrome extension ID is required to install the Native Messaging host."
}
Assert-ExtensionId $ExtensionId "Chrome extension ID"
if ($EdgeExtensionId) { Assert-ExtensionId $EdgeExtensionId "Edge extension ID" }

$ids = @($ExtensionId, $EdgeExtensionId) | Where-Object { $_ } | Select-Object -Unique
if (-not $HostExecutable) {
  $HostExecutable = Join-Path (Split-Path -Parent $InstallDir) "Video Digest Companion.exe"
}
if (-not (Test-Path -LiteralPath $HostExecutable)) {
  throw "Desktop application not found: $HostExecutable"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$manifest = $manifestTemplate | ConvertTo-Json -Depth 5 | ConvertFrom-Json
$manifest.path = [System.IO.Path]::GetFullPath($HostExecutable)
$manifest.allowed_origins = @($ids | ForEach-Object { "chrome-extension://$_/" })
$manifestPath = Join-Path $InstallDir "native-host-manifest.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
  $manifestPath,
  ($manifest | ConvertTo-Json -Depth 5),
  $utf8NoBom
)

foreach ($key in @($chromeKey, $edgeKey)) {
  New-Item -Force -Path $key | Out-Null
  New-ItemProperty -LiteralPath $key -Name "(default)" -Value $manifestPath -PropertyType String -Force | Out-Null
}

Write-Output "Native Messaging host registered for Chrome and Edge."
