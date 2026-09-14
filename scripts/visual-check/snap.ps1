<#
.SYNOPSIS
  Screenshots a running process's main window via PrintWindow, without requiring
  the window to be focused/foreground (no clicks, no focus stealing).

.PARAMETER OutFile
  Path to the PNG file to write.

.PARAMETER ProcessId
  PID of the process whose MainWindowHandle should be captured. (Named ProcessId,
  not Pid, because -Pid collides with PowerShell's automatic $PID variable in some
  contexts and shadows it as a parameter name.)
#>
param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [Parameter(Mandatory = $true)][int]$ProcessId
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace VisualCheck
{
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public static class Win32
    {
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    }
}
'@

Add-Type -AssemblyName System.Drawing

# Windows PowerShell is DPI-unaware, so on a scaled display GetWindowRect hands back
# VIRTUALISED (logical) coordinates while PrintWindow draws in physical pixels. The
# bitmap then gets sized 1400x900 for a window that paints 2100x1350, and the capture
# is the top-left corner of the window with the right-hand side silently cut off —
# which reads as a broken layout and is not one. Declaring awareness first makes the
# rect physical, so the bitmap matches what PrintWindow will draw.
#
# Per-monitor-v2 (-4) is the right context on a multi-monitor setup with mixed scaling;
# SetProcessDPIAware is the fallback for hosts too old for it. Both return false if the
# awareness is already set for this process, which is fine — it only has to be set once.
try {
  [void][VisualCheck.Win32]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
} catch {
  try { [void][VisualCheck.Win32]::SetProcessDPIAware() } catch {}
}

function Get-MainWindowHandle([int]$ProcId) {
  $proc = Get-Process -Id $ProcId -ErrorAction Stop
  $proc.Refresh()
  return $proc.MainWindowHandle
}

$hwnd = Get-MainWindowHandle -ProcId $ProcessId
if ($hwnd -eq [IntPtr]::Zero) {
  throw "Process $ProcessId has no MainWindowHandle (window not yet created?)."
}

$rect = New-Object VisualCheck.RECT
[void][VisualCheck.Win32]::GetWindowRect($hwnd, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

# A minimized (or not-yet-shown) window reports a tiny/degenerate rect
# (observed ~160x28). Restore it and re-measure before capturing.
if ($width -lt 300 -or $height -lt 200) {
  [void][VisualCheck.Win32]::ShowWindow($hwnd, 9) # SW_RESTORE
  Start-Sleep -Milliseconds 900
  [void][VisualCheck.Win32]::GetWindowRect($hwnd, [ref]$rect)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
}

if ($width -le 0 -or $height -le 0) {
  throw "Window rect is still degenerate after restore attempt ($width x $height)."
}

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
try {
  # PW_RENDERFULLCONTENT (0x3) — required for modern (Chromium/DirectComposition-backed)
  # windows; plain PrintWindow(0) often yields a blank/black frame for Electron apps.
  [void][VisualCheck.Win32]::PrintWindow($hwnd, $hdc, 3)
} finally {
  $graphics.ReleaseHdc($hdc)
}

$outDir = Split-Path -Parent $OutFile
if ($outDir -and -not (Test-Path $outDir)) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

$bitmap.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

Write-Host "Saved screenshot to $OutFile ($width x $height)"
