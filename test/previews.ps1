# Render each card variant to docs/*.png for the README.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/previews.ps1
#
# Must run under Windows PowerShell 5.1, not pwsh: the card is compiled with
# -ReferencedAssemblies System.Drawing.dll, which is correct for .NET Framework
# but not for PowerShell 7 (where System.Drawing forwards to
# System.Drawing.Common).
#
# This file is deliberately pure ASCII. Windows PowerShell 5.1 guesses ANSI for a
# script with no BOM, so a literal em dash here would be corrupted before it ever
# reached the card. The payload still exercises non-ASCII end-to-end by building
# the dash from its code point.
#
# The card's own dumpPng output is a plain rectangle - the rounded Region is a
# window property, not something DrawToBitmap captures - so the corners are
# re-rounded here to match what appears on screen.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'docs'
$helper = Join-Path $root 'lib\popup.ps1'
$log = Join-Path $env:TEMP 'dsh-notify-previews.log'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Remove-Item $log -ErrorAction SilentlyContinue

# Re-apply the rounded corners the window Region would have clipped.
function Round-Corners($path, $radius) {
  $src = [System.Drawing.Bitmap]::FromFile($path)
  $out = New-Object System.Drawing.Bitmap $src.Width, $src.Height
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $d = $radius * 2
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc(0, 0, $d, $d, 180, 90)
  $p.AddArc($src.Width - $d, 0, $d, $d, 270, 90)
  $p.AddArc($src.Width - $d, $src.Height - $d, $d, $d, 0, 90)
  $p.AddArc(0, $src.Height - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  $g.SetClip($p)
  $g.DrawImage($src, 0, 0, $src.Width, $src.Height)
  $g.Dispose(); $p.Dispose(); $src.Dispose()
  $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
}

function Render-Card($name, $accent, $heading, $tabs) {
  $target = Join-Path $outDir $name
  Remove-Item $target -ErrorAction SilentlyContinue
  $spec = [ordered]@{
    cardId = 'preview'; accent = $accent; heading = $heading; hint = 'Click to open the chat'
    sound = $false; focusOnClick = $false
    layoutPath = ''; dumpPng = $target; tabs = $tabs
  }
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($spec | ConvertTo-Json -Depth 8 -Compress)))
  # A card no longer times out, so the helper is told to close itself: without
  # this the preview run would never return.
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $helper -Payload $b64 -LogPath $log -AutoCloseMs 700 | Out-Null
  if (Test-Path $target) { Round-Corners $target 12 }
  $size = if (Test-Path $target) { (Get-Item $target).Length } else { 0 }
  "$name : $size bytes"
}

$dash = [char]0x2014
# Built from a code point: this file must stay pure ASCII, because Windows
# PowerShell 5.1 guesses ANSI for a BOM-less script and would mangle a literal.
$dot = [char]0x00B7

Render-Card 'question.png' '#4D6BFE' 'DSH needs your answer' @(
  [ordered]@{ label = 'Choose a database'; body = ('Which database should the new service use ' + $dash + ' Postgres or SQLite?') }
)

Render-Card 'approval.png' '#E5A00D' 'Permission needed' @(
  [ordered]@{ label = 'pwsh'; body = 'Run a command that writes outside the workspace.' }
)

Render-Card 'review.png' '#7C5CFF' 'Plan ready for review' @(
  [ordered]@{ label = 'Plan review'; body = 'Add a notification plugin that pops a card whenever the agent needs an answer.' }
)

# Two questions from one request: one card, one tab each.
Render-Card 'tabs.png' '#4D6BFE' 'DSH needs your answer' @(
  [ordered]@{ label = 'Database'; body = 'Which database should the new service use?' },
  [ordered]@{ label = 'Region'; body = 'Which region should it deploy to?' }
)

# A finished turn: the body is the last thing the agent said, the tab labels the
# working directory so concurrent chats stay tellable apart.
Render-Card 'finished.png' '#2FA65A' ('Task finished ' + $dot + ' DSH Plugins') @(
  [ordered]@{ label = 'DSH Plugins'; body = 'Done. I added the notification plugin and pushed it to GitHub.' }
)

Render-Card 'failed.png' '#C4483F' ('Task failed ' + $dot + ' DSH Plugins') @(
  [ordered]@{ label = 'DSH Plugins'; body = 'rate limited' }
)
