/**
 * dsh-plugin-notify - a native desktop card whenever the agent needs an answer.
 *
 * ## What it hooks
 *
 * The harness has exactly two "a human must answer" seams, and both are Cordis
 * waterfalls:
 *
 *   - `user-questions/request` - `ask_user_question`, the `exit_plan_mode` plan
 *     review, and any plugin asking through `ctx.userQuestions.ask()`.
 *   - `approval/request` - the permission prompt raised before a sensitive tool
 *     action.
 *
 * ## It notifies; it does not answer
 *
 * The plugin is a pure observer: it calls `next()` and returns whatever the rest
 * of the waterfall produces, so the chat behaves exactly as it would without
 * this plugin. The card shows what is being asked and, when clicked, brings the
 * chat forward - the answer is always given in the chat.
 *
 * That is a deliberate reversal of an earlier design that answered from the card.
 * The chat client owns each pending question through its own waterfall channel
 * (`createWaterfallRequest` / `detachWaterfall`, and "the card stays"), so an
 * answer delivered out-of-band settles the request while leaving the client's
 * card on screen with nothing able to settle it. A host plugin cannot reach into
 * that channel, so it must not answer at all.
 *
 * ## One card per chat, one tab per question
 *
 * A card belongs to a chat. Every pending question from that session becomes a
 * TAB on its card, the way the chat UI presents them - so two questions asked in
 * one request are one card with two tabs, not two pop-ups. Separate pop-ups are
 * reserved for separate chats.
 *
 * Grouping is by `request.agent.session.id` plus the kind of decision, so a
 * session's questions and its approvals never share a card. When another question
 * joins a chat that already has a card, the card is respawned with the extra tab,
 * keeping its slot on screen.
 *
 * ## Cards persist and stack
 *
 * A card does not time out. It closes when you click it, or when a card from
 * another chat pushes it up - at which point it starts a countdown. A card that
 * becomes the newest again stops counting and stays.
 *
 * The cards are separate processes and cannot talk to each other, so the plugin
 * owns the stack and publishes it as a plain-text LAYOUT file that every card
 * polls:
 *
 *     <cardId>|<countdownSeconds>      one line per card, newest first
 *
 * Index 0 is the newest card, at the bottom nearest the corner. Heights are
 * deliberately not in that file - each card writes its own `<cardId>.size`, so a
 * card positions itself from the real heights of the cards below it.
 *
 * ## Why the delivery layer looks like this
 *
 * The DSH host runs in a Node child process spawned by the Electron shell, not
 * in the Electron main process, so `electron.Notification` is unreachable. And
 * on Windows 11 24H2 the WinRT toast APIs reject unpackaged senders with
 * `0x80073D54 "The process has no package identity"`. The card is therefore
 * drawn by a short-lived, hidden `powershell.exe` (see `lib/card.cs`).
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** Cordis plugin name; also the logger name. */
export const name = 'dsh-plugin-notify'

const PLUGIN_NAME = 'dsh-plugin-notify'
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const HELPER = join(PLUGIN_DIR, 'lib', 'popup.ps1')
const RUNTIME_DIR = join(tmpdir(), 'dsh-plugin-notify')

/** Accent colours, one per kind of decision. */
const ACCENT = {
  question: '#4D6BFE',
  review: '#7C5CFF',
  approval: '#E5A00D',
}

// Unique across every stack in this process; see createStack().
let cardSeq = 0
let stackSeq = 0

/** Defaults; every field is also a Config key in `cordis.patch.yml`. */
const DEFAULTS = {
  enabled: true,
  questions: true,
  approvals: true,
  countdownMs: 20000,
  maxStack: 5,
  sound: true,
  focusOnClick: true,
  // Window for suppressing an IDENTICAL request re-dispatched in a loop. It must
  // never gate distinct questions: those become tabs on the same card.
  throttleMs: 5000,
  powershell: 'powershell.exe',
  maxBodyChars: 220,
  title: 'DSH needs your answer',
  debug: false,
  debugPath: '',
}

/**
 * Validate and default the row config. Kept dependency-free on purpose: the
 * plugin must load even in a profile that composes neither `schemastery` nor
 * the harness core, so it validates its own contract and fails loudly.
 *
 * @param {object|undefined} config - the `config:` block from the profile row.
 * @returns {typeof DEFAULTS} resolved config.
 */
export function resolveConfig(config = {}) {
  const resolved = { ...DEFAULTS, ...(config ?? {}) }
  for (const key of ['enabled', 'questions', 'approvals', 'sound', 'focusOnClick', 'debug']) {
    if (typeof resolved[key] !== 'boolean') throw new Error(`${PLUGIN_NAME}: ${key} must be a boolean`)
  }
  for (const key of ['countdownMs', 'maxStack', 'throttleMs', 'maxBodyChars']) {
    if (!Number.isFinite(resolved[key]) || resolved[key] < 0) throw new Error(`${PLUGIN_NAME}: ${key} must be a non-negative number`)
  }
  if (typeof resolved.powershell !== 'string' || resolved.powershell.length === 0) {
    throw new Error(`${PLUGIN_NAME}: powershell must be a non-empty path or command name`)
  }
  if (typeof resolved.title !== 'string' || resolved.title.length === 0) {
    throw new Error(`${PLUGIN_NAME}: title must be a non-empty string`)
  }
  if (typeof resolved.debugPath !== 'string') throw new Error(`${PLUGIN_NAME}: debugPath must be a string`)
  if (resolved.debug && resolved.debugPath === '') resolved.debugPath = join(PLUGIN_DIR, 'debug.log')
  // Prefer the absolute Windows PowerShell path. The host child is spawned by
  // the Electron shell with a modified PATH, so a bare `powershell.exe` would
  // depend on that PATH; an absolute path removes the whole failure class.
  if (resolved.powershell === DEFAULTS.powershell) {
    const absolute = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (existsSync(absolute)) resolved.powershell = absolute
  }
  return resolved
}

/**
 * Append one diagnostic line. Best-effort by construction: a log that cannot be
 * written must never disturb the notification path it exists to explain.
 *
 * @param {typeof DEFAULTS} config - resolved config.
 * @param {string} message - line to record.
 */
export function debugLog(config, message) {
  if (!config.debug) return
  try {
    appendFileSync(config.debugPath, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // Deliberately silent: diagnostics never break delivery.
  }
}

/** Collapse whitespace and clamp to `limit` characters with an ellipsis. */
export function truncate(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

/**
 * Describe a `user-questions/request` as tabs - one per question in the request.
 *
 * @param {object} request - the dispatched request.
 * @param {typeof DEFAULTS} config - resolved config.
 * @returns {{accent: string, tabs: object[]}} the card's tabs.
 */
export function questionTabs(request, config) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  const review = questions[0]?.intent?.kind === 'plan-review'
  return {
    accent: review ? ACCENT.review : ACCENT.question,
    // The heading anchors the card. Without it a one-question card is a bare
    // 47px strip of body text that reads as a rendering artifact.
    heading: questions.length === 1 && questions[0]?.header
      ? truncate(questions[0].header, 60)
      : config.title,
    tabs: questions.map((question, index) => ({
      label: question.header ? truncate(question.header, 40) : `Question ${index + 1}`,
      body: truncate(question.question, config.maxBodyChars) || 'The agent is waiting for your answer.',
    })),
  }
}

/**
 * Describe an `approval/request` as a single tab.
 *
 * The request carries no tool arguments by design (only the tool name, an
 * optional reason, and an optional call id), so the body is the tool identity.
 *
 * @param {object} request - the dispatched request.
 * @param {typeof DEFAULTS} config - resolved config.
 * @returns {{accent: string, tabs: object[]}} one tab.
 */
export function approvalTabs(request, config) {
  const tool = truncate(request?.toolName, 60) || 'a sensitive action'
  const reason = truncate(request?.reason, config.maxBodyChars)
  return {
    accent: ACCENT.approval,
    heading: 'Permission needed',
    tabs: [{
      label: tool,
      body: reason.length > 0 ? reason : `The agent needs your approval to run ${tool}.`,
    }],
  }
}

/**
 * Own the card stack: allocation of ids, the shared layout file every card polls,
 * eviction past `maxStack`, and teardown.
 *
 * The layout is rewritten whenever the stack changes. It is a plain text file,
 * not JSON, because the cards parse it in C# where no JSON reader is available
 * without pulling in another assembly.
 *
 * @param {typeof DEFAULTS} config - resolved config.
 * @param {{warn: (message: string) => void}} logger - plugin logger.
 * @returns {object} stack controller.
 */
function createStack(config, logger) {
  const layoutPath = join(RUNTIME_DIR, `${process.pid}-${stackSeq++}.layout`)
  const cards = [] // newest first: index 0 is the bottom-most card on screen

  const write = () => {
    try {
      mkdirSync(RUNTIME_DIR, { recursive: true })
      const seconds = Math.max(1, Math.round(config.countdownMs / 1000))
      const lines = cards.map((card, index) => `${card.id}|${index === 0 ? 0 : seconds}`)
      writeFileSync(layoutPath, `${lines.join('\n')}\n`, 'utf8')
    } catch (error) {
      debugLog(config, `layout write failed: ${error.message}`)
    }
  }

  const forget = (id) => {
    const index = cards.findIndex(card => card.id === id)
    if (index < 0) return
    cards.splice(index, 1)
    write()
  }

  return {
    layoutPath,

    /** Reserve a slot before spawning, so the card finds itself on its first poll. */
    reserve() {
      const entry = { id: `${process.pid}-${cardSeq++}`, close: undefined }
      cards.unshift(entry)
      // Keep the stack bounded: the oldest card goes even if it was never pushed.
      while (cards.length > Math.max(1, config.maxStack)) {
        const evicted = cards[cards.length - 1]
        debugLog(config, `evicting oldest card ${evicted.id} (maxStack ${config.maxStack})`)
        try { evicted.close?.() } catch { }
        cards.pop()
      }
      write()
      return entry
    },

    /** Attach the current process handle so eviction can kill it. */
    attach(entry, close) {
      entry.close = close
    },

    /** A card exited on its own: drop it and let the others close the gap. */
    forget,

    /** Drop every card and its scratch files. */
    dispose() {
      for (const card of cards) {
        try { card.close?.() } catch { }
      }
      cards.length = 0
      try { rmSync(layoutPath, { force: true }) } catch { }
      for (const name of readdirSafe(RUNTIME_DIR)) {
        if (name.startsWith(`${process.pid}-`)) rmSync(join(RUNTIME_DIR, name), { force: true })
      }
    },
  }
}

/** List a directory without throwing when it does not exist. */
function readdirSafe(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/**
 * Mount the plugin: register both waterfalls as notifying observers.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} [config] - the profile row's `config:` block.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  const logger = typeof ctx.logger === 'function' ? ctx.logger(PLUGIN_NAME) : console
  const stack = createStack(resolved, logger)
  const groups = new Map()
  let lastAt = 0
  let lastKey = ''
  let disabled = false

  /** Release a group: kill its card, drop its slot, forget it. */
  const finish = (group) => {
    if (group.child !== undefined) {
      const child = group.child
      group.child = undefined
      child.dshKilled = true
      try { child.kill() } catch { }
    }
    stack.forget(group.entry.id)
    groups.delete(group.key)
  }

  /** Render one group's card from its current tabs, replacing an existing card. */
  const render = (group) => {
    const tabs = []
    for (const unit of group.units) {
      for (const tab of unit.tabs) tabs.push({ label: tab.label, body: tab.body })
    }

    const payload = Buffer.from(JSON.stringify({
      cardId: group.entry.id,
      accent: group.accent,
      heading: group.heading,
      hint: group.hint,
      tabs,
      sound: resolved.sound,
      focusOnClick: resolved.focusOnClick,
      layoutPath: stack.layoutPath,
    }), 'utf8').toString('base64')

    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', HELPER,
      '-Payload', payload,
      ...resolved.debug ? ['-LogPath', resolved.debugPath] : [],
    ]

    // A card that grows a tab is replaced, reusing its stack entry so it keeps
    // its slot on screen rather than jumping to the bottom of the stack.
    if (group.child !== undefined) {
      const previous = group.child
      group.child = undefined
      previous.dshKilled = true
      try { previous.kill() } catch { }
    }

    let child
    try {
      child = spawn(resolved.powershell, args, {
        // `detached` must stay OFF. On Windows it makes the helper a detached
        // process-group leader, and powershell.exe then exits immediately with
        // code 0 without running a single line of the script: no card, no error,
        // no log line. Measured - detached:true dies in ~130 ms, while
        // detached:false renders the card normally.
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch (error) {
      logger.warn(`could not start the notification helper: ${error instanceof Error ? error.message : String(error)}`)
      finish(group)
      return
    }
    group.child = child
    stack.attach(group.entry, () => { try { child.kill() } catch { } })

    child.on('error', (error) => {
      debugLog(resolved, `helper error: ${error.message}`)
      logger.warn(`notification helper failed: ${error.message}`)
    })
    child.on('exit', (code) => {
      debugLog(resolved, `helper pid=${child.pid} card=${group.entry.id} exited code=${code}${child.dshKilled ? ' (dismissed by us)' : ''}`)
      // A replaced card exits after a newer one took over; only the current child
      // ends the group.
      if (group.child !== child) return
      group.child = undefined
      if (code !== 0 && child.dshKilled !== true) logger.warn(`notification helper exited with code ${code}`)
      // The card's lifetime IS the group's lifetime: when it closes - clicked by
      // the user, or counted down after being pushed - the chat has no pending
      // notification any more.
      finish(group)
    })
  }

  /** Register one dispatch, creating or growing the chat's card. */
  const register = (kind, request, build) => {
    const sessionId = request?.agent?.session?.id
    const key = `${kind}:${sessionId ?? 'agentless'}`
    let group = groups.get(key)
    if (group === undefined) {
      group = { key, units: [], entry: stack.reserve(), child: undefined }
      groups.set(key, group)
    }
    const built = build(request, resolved)
    group.accent = built.accent
    group.heading = built.heading
    group.hint = 'Click to open the chat'
    group.units.push({ tabs: built.tabs })
    debugLog(resolved, `dispatch ${kind} session=${sessionId ?? 'none'} tabs=${built.tabs.length} card=${group.entry.id}`)
    render(group)
  }

  const guard = (kind, build) => (request, next) => {
    // Always delegate, and always return the downstream answer: this plugin never
    // answers anything.
    const downstream = next()
    if (disabled) return downstream
    try {
      const now = Date.now()
      // De-duplicate on the REQUEST, never on the chat. Two different questions
      // asked in one turn share a chat and must both become tabs; keying this on
      // the session silently dropped the second one. throttleMs is the window for
      // suppressing an identical re-dispatch only.
      const key = kind === 'question'
        ? `q:${(request?.questions ?? []).map(question => question?.id ?? '').join(',')}`
        : `a:${request?.callId ?? request?.toolName ?? ''}`
      if (key === lastKey && now - lastAt < resolved.throttleMs) return downstream
      lastAt = now
      lastKey = key
      register(kind, request, build)
    } catch (error) {
      logger.warn(`${kind} notification failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return downstream
  }

  if (resolved.questions) {
    ctx.on('user-questions/request', guard('question', questionTabs))
  }
  if (resolved.approvals) {
    ctx.on('approval/request', guard('approval', approvalTabs))
  }

  ctx.on('dispose', () => {
    disabled = true
    for (const group of [...groups.values()]) finish(group)
    stack.dispose()
  })

  debugLog(resolved, `mounted questions=${resolved.questions} approvals=${resolved.approvals} helper=${HELPER}`)
}
