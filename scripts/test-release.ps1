param(
  [string]$Installer = "$env:VIDEO_DIGEST_INSTALLER",
  [string]$ExtensionZip = "$env:VIDEO_DIGEST_EXTENSION_ZIP"
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "test:release only supports Windows." }

$root = Split-Path -Parent $PSScriptRoot
if (-not $Installer) {
  $Installer = Get-ChildItem -LiteralPath (Join-Path $root "companion\dist") -Filter "*.exe" |
    Where-Object { $_.Name -notmatch '^Uninstall' } | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $ExtensionZip) {
  $ExtensionZip = Get-ChildItem -LiteralPath (Join-Path $root "dist") -Filter "*.zip" |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw "Companion installer not found: $Installer" }
if (-not (Test-Path -LiteralPath $ExtensionZip -PathType Leaf)) { throw "Extension ZIP not found: $ExtensionZip" }

$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("video-digest-release-" + [Guid]::NewGuid().ToString("N"))
$installRoot = Join-Path $temporary "installed"
$extensionRoot = Join-Path $temporary "extension"
$registryKeys = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.video_digest.companion",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.video_digest.companion"
)
$registryBackups = @{}
foreach ($key in $registryKeys) {
  if (Test-Path -LiteralPath $key) {
    $registryBackups[$key] = (Get-ItemProperty -LiteralPath $key).'(default)'
  }
}
New-Item -ItemType Directory -Path $temporary | Out-Null

try {
  Expand-Archive -LiteralPath $ExtensionZip -DestinationPath $extensionRoot -Force
  & node (Join-Path $root "scripts\validate-package.cjs") $extensionRoot
  if ($LASTEXITCODE -ne 0) { throw "Packaged extension validation failed." }
  $env:VIDEO_DIGEST_EXTENSION_ROOT = $extensionRoot
  & npm run test:e2e:extension
  if ($LASTEXITCODE -ne 0) { throw "Packaged extension could not be loaded by Playwright Chromium." }

  $install = Start-Process -FilePath $Installer -ArgumentList @("/S", "/D=$installRoot") -Wait -PassThru -WindowStyle Hidden
  if ($install.ExitCode -ne 0) { throw "Silent installer exited with $($install.ExitCode)." }

  $application = Join-Path $installRoot "Video Digest Companion.exe"
  if (-not (Test-Path -LiteralPath $application -PathType Leaf)) { throw "Installed application is missing." }

  foreach ($key in $registryKeys) {
    if (-not (Test-Path -LiteralPath $key)) { throw "Native Messaging registry key is missing: $key" }
    $manifestPath = (Get-ItemProperty -LiteralPath $key).'(default)'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Native Messaging manifest is missing: $manifestPath" }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ([System.IO.Path]::GetFullPath($manifest.path) -ne [System.IO.Path]::GetFullPath($application)) {
      throw "Native Messaging manifest points to the wrong executable."
    }
  }

  & node (Join-Path $root "scripts\probe-native-host.cjs") $application
  if ($LASTEXITCODE -ne 0) { throw "Installed Native Messaging probe failed." }

  if ($env:VIDEO_DIGEST_ENGINE_DIR -and $env:VIDEO_DIGEST_WHISPER_MODEL) {
    $env:VIDEO_DIGEST_ENGINE_DIR = Join-Path $installRoot "resources\engine"
    & node (Join-Path $root "scripts\test-real-engine.cjs")
    if ($LASTEXITCODE -ne 0) { throw "Real OCR/ASR acceptance failed." }
  } else {
    throw "Release validation requires VIDEO_DIGEST_ENGINE_DIR and VIDEO_DIGEST_WHISPER_MODEL."
  }

  Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  $uninstaller = Join-Path $installRoot "Uninstall Video Digest Companion.exe"
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw "Uninstaller is missing." }
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden
  if ($uninstall.ExitCode -ne 0) { throw "Silent uninstaller exited with $($uninstall.ExitCode)." }
  Start-Sleep -Milliseconds 500
  foreach ($key in $registryKeys) {
    if (Test-Path -LiteralPath $key) { throw "Uninstall left a Native Messaging registry key: $key" }
  }
  Write-Host "Windows release accepted: extension, installer, Native Messaging, OCR/ASR and uninstall."
} finally {
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and $_.Path.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase)
  } | Stop-Process -Force -ErrorAction SilentlyContinue
  foreach ($key in $registryKeys) {
    if ($registryBackups.ContainsKey($key)) {
      New-Item -Path $key -Force | Out-Null
      New-ItemProperty -LiteralPath $key -Name "(default)" -Value $registryBackups[$key] -PropertyType String -Force | Out-Null
    } elseif (Test-Path -LiteralPath $key) {
      Remove-Item -LiteralPath $key -Recurse -Force
    }
  }
  $resolvedTemp = [System.IO.Path]::GetFullPath($temporary)
  $tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if ($resolvedTemp.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTemp)) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
  }
}
