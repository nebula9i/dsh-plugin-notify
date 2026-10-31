# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-31

First release.

### Added

- **Notifications on both "a human must answer" seams**: `user-questions/request`
  (`ask_user_question` and the `exit_plan_mode` plan review) and
  `approval/request` (permission prompts). The plugin is a pure observer — it
  calls `next()` and returns what the rest of the waterfall produced.
- **One card per chat, one tab per question.** Questions from a single session
  share a card as tabs, the way the chat presents them; separate pop-ups are
  reserved for separate chats. Grouping is by `request.agent.session.id` plus the
  kind of decision.
- **Cards persist.** A card never times out. It closes when you click it (which
  brings the chat forward), when you click its ✕ (which does not), or when a card
  from another chat pushes it up and its countdown expires. A card that becomes
  the newest again stops counting and stays.
- **The card retires itself when you answer in the chat.** The plugin observes
  the promise it already returns, writes a `<cardId>.close` marker, and the card
  slides away. The value returned to the waterfall is never altered.
- **Native rendering**: an ordinary borderless topmost window with a rounded
  `Region`, `CS_DROPSHADOW`, a colour-coded accent bar, slide-in/out animation and
  a countdown bar. Questions are blue, plan reviews purple, approvals amber.
- **Configuration** for the countdown, stack ceiling, sound, click behaviour,
  de-duplication window and a diagnostic log — see the README.
- **A smoke test that asserts on the helper's own log lines**, because every bug
  below was invisible from the host side, plus a preview renderer for the README
  images.
- **CI** on `windows-latest`, reporting the PowerShell and .NET Framework
  versions the card compiles against and re-emitting failures as check-run
  annotations, since a job log is not readable through the REST API.

### Fixed before release

Recorded because each of these failed **silently**, and each is now guarded by a
test or an assertion.

- **`detached: true` killed every card.** On Windows it makes the helper a
  detached process-group leader, and `powershell.exe` then exits with code 0 in
  ~130 ms without running a single line of the script — no card, no error, no log
  entry, and no non-zero exit to notice.
- **The slide-in timer started at `1f`.** The window is created parked off the
  right edge and only the timer moves it in; starting at "already arrived" left
  every card off-screen forever while the bitmap rendered correctly, the window
  reported visible and topmost, and the process exited 0.
- **De-duplication was keyed on the chat, not the request.** The second question
  from one chat was discarded as a duplicate — precisely the case tab support
  exists for — and a flat 250 ms throttle dropped it regardless.
- **A `U+2026` literal in `card.cs` was read as ANSI** by Windows PowerShell 5.1
  (which guesses ANSI for a file with no BOM), so a truncated tab label rendered
  as `â€¦`. The parsed sources are now pure ASCII and the C# is read with an
  explicit `-Encoding UTF8`.
- **Concurrent log appends dropped lines.** `File.AppendAllText` opens with
  `FileShare.Read`, so two cards logging at the same instant made one throw a
  sharing violation — and since the writes are best-effort, the line vanished.
  Missing `showing card` lines are indistinguishable from a card that never drew,
  so the diagnostics were lying. Both writers now use `FileShare.ReadWrite` with
  retries.
- **The test waited on fixed delays.** A card costs an `Add-Type` compile of
  ~33 KB of C#, which is ~0.5 s warm and several seconds on a cold CI runner;
  fixed sleeps killed helpers mid-compile, producing the same "never ran"
  signature. It now waits for evidence in the log.
- **A card with no heading looked like a rendering artifact.** With the answer
  buttons removed, a single-question card was a 47 px strip of body text with
  nothing to suggest it could be clicked. It now carries a heading and a
  "Click to open the chat" hint.

### Changed

- **The card no longer answers.** An earlier design put answer buttons on it
  (option labels, Allow once / Deny). That was removed: the chat client owns each
  pending question through its own waterfall channel, so an answer delivered
  out-of-band settles the request while leaving the client's prompt on screen
  with nothing able to settle it. A host plugin cannot reach into that channel,
  so it does not answer at all.
- **Layered window replaced by a plain window with a `Region`.** The layered
  version was the only way to get antialiased corners *and* a soft shadow, but it
  appeared never to display during development. That diagnosis turned out to rest
  on a broken screen-capture method, so the layered version may well have been
  fine; the plain one is kept because it is simpler and demonstrably displays.

[Unreleased]: https://github.com/nebula9i/dsh-plugin-notify/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nebula9i/dsh-plugin-notify/releases/tag/v0.1.0
