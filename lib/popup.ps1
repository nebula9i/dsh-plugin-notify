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

try {
  $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Payload))
  $spec = $json | ConvertFrom-Json
} catch {
  if ($LogPath) { Add-Content -LiteralPath $LogPath -Value "helper: payload decode failed: $($_.Exception.Message)" -ErrorAction SilentlyContinue }
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

if ($LogPath) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  Add-Content -LiteralPath $LogPath -Value "$stamp helper: start pid=$PID card=$($model.CardId) tabs=$($model.Tabs.Count)" -ErrorAction SilentlyContinue
}

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
  if ($LogPath) { Add-Content -LiteralPath $LogPath -Value "helper: card failed: $($_.Exception.Message)" -ErrorAction SilentlyContinue }
  exit 3
}

exit 0
