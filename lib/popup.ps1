# dsh-plugin-notify notification helper.
#
# One process per CARD, spawned hidden by index.mjs. Parses a base64 card spec,
# hands it to lib/card.cs (compiled on first use in this process), shows the
# card, and exits when it closes.
#
# A card carries one tab per pending question from a single chat; several cards
# (several chats) stack. The spec travels base64-encoded (UTF-8 JSON) so no
# question text can be mangled by command-line quoting or by the console code
# page.
#
# The card NOTIFIES, it does not answer: there are no answer buttons, and
# clicking it brings the chat forward. See the header of card.cs for why.
#
# A card does not time out on its own. It closes when you click it, or when the
# plugin pushes it up by adding a card from another chat and writes a countdown
# into the shared layout file.

param(
  [Parameter(Mandatory = $true)][string]$Payload,
  [string]$LogPath = '',
  [int]$AutoClickMs = 0,
  [int]$AutoCloseMs = 0
)

$ErrorActionPreference = 'Stop'

# Append one diagnostic line, tolerating concurrent writers. Add-Content opens
# with a share mode that makes two cards logging at the same instant lose one of
# the lines, and a missing "start" line is indistinguishable from a helper that
# never ran at all. Defined before first use, since PowerShell resolves functions
# in execution order.
function Write-HelperLog([string]$Message) {
  if (-not $LogPath) { return }
  $line = "$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) helper: $Message`r`n"
  for ($attempt = 0; $attempt -lt 8; $attempt++) {
    try {
      $stream = [System.IO.File]::Open($LogPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
      $writer = New-Object System.IO.StreamWriter($stream, (New-Object System.Text.UTF8Encoding($false)))
      $writer.Write($line)
      $writer.Dispose()
      $stream.Dispose()
      return
    } catch {
      Start-Sleep -Milliseconds 25
    }
  }
}

try {
  $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Payload))
  $spec = $json | ConvertFrom-Json
} catch {
  Write-HelperLog "payload decode failed: $($_.Exception.Message)"
  exit 2
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$cardSource = Join-Path $PSScriptRoot 'card.cs'
if (-not ('DshNotify.CardForm' -as [type])) {
  # -Encoding UTF8 explicitly: Windows PowerShell 5.1 otherwise guesses ANSI for a
  # file with no BOM, which silently corrupts any non-ASCII literal in the source.
  Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing `
    -TypeDefinition (Get-Content -LiteralPath $cardSource -Raw -Encoding UTF8)
}

# Map the JSON spec onto the compiled types. ConvertFrom-Json yields
# PSCustomObjects, so every field is copied explicitly rather than deserialized.
$model = New-Object DshNotify.CardSpec
$model.CardId = [string]$spec.cardId
$model.Accent = [string]$spec.accent
$model.Heading = [string]$spec.heading
$model.Hint = [string]$spec.hint
$model.Sound = [bool]$spec.sound
$model.FocusOnClick = [bool]$spec.focusOnClick
$model.LayoutPath = [string]$spec.layoutPath
$model.LogPath = $LogPath
$model.AutoClickMs = $AutoClickMs
$model.AutoCloseMs = $AutoCloseMs
$model.DumpPng = [string]$spec.dumpPng

foreach ($tab in @($spec.tabs)) {
  if ($null -eq $tab) { continue }
  $tabModel = New-Object DshNotify.TabSpec
  $tabModel.Label = [string]$tab.label
  $tabModel.Body = [string]$tab.body
  $model.Tabs.Add($tabModel)
}

Write-HelperLog "start pid=$PID card=$($model.CardId) tabs=$($model.Tabs.Count)"

if ($model.Sound) {
  try { [System.Media.SystemSounds]::Exclamation.Play() } catch { }
}

try {
  [System.Windows.Forms.Application]::EnableVisualStyles()
  # Surface failures instead of parking them in WinForms' unhandled-exception
  # dialog, which is invisible here and leaves the process hanging forever.
  [System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::ThrowException)
  $form = New-Object DshNotify.CardForm $model
  [System.Windows.Forms.Application]::Run($form)
} catch {
  Write-HelperLog "card failed: $($_.Exception.Message)"
  exit 3
}

exit 0
