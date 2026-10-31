# Contributing

Thanks for taking a look. This plugin is small and self-contained, and most of
its value is in the traps documented in [README.md](README.md#traps-that-cost-real-debugging-time) —
please read that section before changing the delivery layer.

## Getting set up

The plugin is a normal DSH profile bundle. Point your profile at your checkout:

```jsonc
// <DSH_HOME>/profiles/<profile>/package.json
"dependencies": {
  "dsh-plugin-notify": "link:<absolute path to your checkout>"
},
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "dsh-plugin-notify"
    ]
  }
}
```

Then `pnpm install` in that profile directory and restart the app. There is no
in-place reload in a packaged build: the shell only adds a **Reload Page** menu
item when running in development. `F12` opens DevTools, from where
`location.reload()` works.

## Running the tests

```sh
npm test          # node test/smoke.mjs
```

The test drives the plugin through a fake Cordis context and asserts on the
helper's **own log lines**, because this plugin has repeatedly failed in ways
that are invisible from the host side — a card that renders perfectly while
parked off-screen, a helper that exits without running a line, a second question
silently dropped.

If you change anything about how a card is created, moved, or shown, add an
assertion that would fail if it silently stopped working. That is the whole
point of the suite.

## Re-rendering the previews

```sh
npm run previews
```

This **must** run under Windows PowerShell 5.1 (`powershell.exe`), not `pwsh`:
the card compiles with `-ReferencedAssemblies System.Drawing.dll`, which is
correct for .NET Framework but not for PowerShell 7, where `System.Drawing`
forwards to `System.Drawing.Common` and the compile fails.

## House rules

- **Keep `lib/card.cs`, `lib/popup.ps1` and `test/previews.ps1` pure ASCII.**
  Windows PowerShell 5.1 guesses ANSI for a file with no BOM, so a non-ASCII
  literal is corrupted before it reaches the compiler or the card. Build
  non-ASCII payloads from code points instead (`[char]0x2014`).
- **`lib/card.cs` is compiled as C# 5** and `Add-Type` treats warnings as errors.
  No inline `out` variables, no `out _`, no string interpolation, and no member
  that hides an inherited one (`Click`, `Layout`, `Margin`).
- **The plugin must never answer a question or an approval.** It calls `next()`
  and returns what the rest of the waterfall produced. See
  [README.md](README.md#it-notifies-it-does-not-answer) for why answering from
  the card leaves the chat unable to settle its own prompt.
- **Do not spawn the helper `detached`.** It dies in ~130 ms without running a
  line of the script.

## Pull requests

Small and focused is ideal. If you are fixing a bug, a test that fails without
your fix is worth more than the fix itself. If you are adding a platform (macOS
or Linux), the hook layer in `index.mjs` is already portable — the work is
replacing `lib/card.cs` and `lib/popup.ps1` with a native notifier, and dropping
`"os": ["win32"]` from `package.json`.

## Reporting issues

Please include:

- your DSH version (the app's version, or the `version` in
  `resources/app.asar/dsh/package.json`);
- whether the card appeared at all, and if so what it looked like;
- the contents of `debug.log` with `debug: true` set in your profile row — it
  separates "never mounted" from "never dispatched" from "never drawn".
