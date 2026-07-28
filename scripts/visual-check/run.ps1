<#
.SYNOPSIS
  Launches an isolated instance of the built Argos app (separate userData
  dir, seeded config + demo session) and screenshots it for visual verification.

.PARAMETER View
  Optional view to deep-link to after startup (chat, projects, agents, rooms,
  planner, scheduled, usage, mcp, remote). Defaults to whatever the app opens on.

.PARAMETER OutFile
  Where to save the PNG. Defaults to visual-check.png next to this script.

.PARAMETER KeepOpen
  If set, leaves the isolated app instance running instead of killing it after
  the screenshot (handy for poking around manually).

.PARAMETER SkipBuild
  Skip the `electron-vite build` step (use the existing out/ bundle as-is).
#>
param(
  [string]$View,
  [string]$OutFile,
  [switch]$KeepOpen,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir '..\..')

if (-not $OutFile) {
  $OutFile = Join-Path $scriptDir 'visual-check.png'
}

$userDataDir = Join-Path $env:TEMP 'argos-visual-check\userdata'

Write-Host "== Preparing isolated userData dir: $userDataDir"
if (Test-Path $userDataDir) {
  Remove-Item -Recurse -Force $userDataDir
}
New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $userDataDir 'sessions') | Out-Null

# Seed files are already BOM-free UTF-8; Copy-Item preserves bytes as-is (unlike
# PowerShell 5.1's Set-Content/Out-File, which would add a BOM).
Copy-Item -Path (Join-Path $scriptDir 'seed\config.json') -Destination (Join-Path $userDataDir 'config.json') -Force
Copy-Item -Path (Join-Path $scriptDir 'seed\sessions\*.json') -Destination (Join-Path $userDataDir 'sessions') -Force

if (-not $SkipBuild) {
  Write-Host "== Building app (electron-vite build)"
  Push-Location $repoRoot
  try {
    & npx electron-vite build
    if ($LASTEXITCODE -ne 0) {
      throw "electron-vite build failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "== Skipping build (-SkipBuild)"
}

$electronExe = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
$launchScript = Join-Path $scriptDir 'launch.js'

if (-not (Test-Path $electronExe)) {
  throw "Electron binary not found at $electronExe. Run 'npm install' first."
}

$env:VISUAL_CHECK_USERDATA = $userDataDir
if ($View) {
  $env:VISUAL_CHECK_VIEW = $View
} else {
  Remove-Item Env:\VISUAL_CHECK_VIEW -ErrorAction SilentlyContinue
}

$viewLabel = if ($View) { $View } else { '<default>' }
Write-Host "== Launching isolated instance (view: $viewLabel)"
$proc = Start-Process -FilePath $electronExe -ArgumentList @($launchScript) -PassThru -WorkingDirectory $repoRoot

try {
  Write-Host "== Waiting for the app to render (~11s)"
  Start-Sleep -Seconds 11

  Write-Host "== Capturing screenshot"
  & (Join-Path $scriptDir 'snap.ps1') -OutFile $OutFile -ProcessId $proc.Id
} finally {
  if (-not $KeepOpen) {
    Write-Host "== Stopping isolated instance (PID $($proc.Id))"
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "== Leaving isolated instance running (PID $($proc.Id)) due to -KeepOpen"
  }
}

Remove-Item Env:\VISUAL_CHECK_USERDATA -ErrorAction SilentlyContinue
Remove-Item Env:\VISUAL_CHECK_VIEW -ErrorAction SilentlyContinue

Write-Host "== Done. Screenshot: $OutFile"
