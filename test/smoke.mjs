// End-to-end smoke test.
//
//   node test/smoke.mjs
//
// Drives the plugin through a fake Cordis context the way the loader would. It
// asserts on the helper's OWN log lines, because this plugin has repeatedly
// failed in ways that are invisible from the host side:
//
//   * a card that renders perfectly while parked off-screen (the slide timer);
//   * a helper that exits instantly without running a line (spawned detached);
//   * a card that is requested but never drawn (a compile failure);
//   * a second question from one chat silently dropped (de-duplication keyed on
//     the chat instead of the request).
//
// The plugin never answers: every dispatch must return exactly what the rest of
// the waterfall produced. That is asserted directly.

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply, resolveConfig, questionTabs, approvalTabs, truncate } from '../index.mjs'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const DEBUG_LOG = join(PLUGIN_DIR, 'debug.log')
const RUNTIME_DIR = join(tmpdir(), 'dsh-plugin-notify')

const fail = (message) => { console.error('FAIL', message); process.exitCode = 1 }
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const immediately = (value) => async () => value
const never = () => new Promise(() => {})
const agent = (id) => ({ session: { id } })

/**
 * Wait for the helper to actually do something, rather than for a fixed delay.
 *
 * A card costs an Add-Type compile of ~33 KB of C#, which takes ~0.5 s on a warm
 * machine and several seconds on a cold CI runner. Fixed sleeps killed the
 * helpers mid-compile, which looks exactly like "the helper never ran" - and
 * that is precisely how the first CI run failed.
 *
 * @param {string} needle - text to look for in the debug log.
 * @param {number} [timeoutMs] - how long to wait before giving up.
 * @returns {Promise<boolean>} whether it appeared.
 */
async function waitForLog(needle, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (readFileSync(DEBUG_LOG, 'utf8').includes(needle)) return true
    } catch {
      // not written yet
    }
    await sleep(250)
  }
  return false
}

/** Mount the plugin against a fresh fake context. */
function mount(config) {
  const listeners = new Map()
  const warnings = []
  const ctx = {
    logger: () => ({ warn: (message) => { warnings.push(message); console.log('WARN', message) } }),
    on: (name, callback) => { listeners.set(name, callback) },
  }
  apply(ctx, config)
  return { listeners, warnings }
}

/** The one layout file currently on disk. */
function layoutFile() {
  const found = readdirSync(RUNTIME_DIR).filter(name => name.endsWith('.layout'))
  if (found.length !== 1) fail(`expected exactly one layout file, found ${found.length}: ${found.join(', ')}`)
  return join(RUNTIME_DIR, found[0] ?? 'missing')
}

rmSync(DEBUG_LOG, { force: true })
rmSync(RUNTIME_DIR, { recursive: true, force: true })

// ---------------------------------------------------------------- card shapes

const config = resolveConfig()
console.log('resolved config:', JSON.stringify({ ...config, powershell: config.powershell.replace(/.*\\/, '…\\') }))

const options = {
  questions: [{
    id: 'q1',
    header: 'Choose a database',
    question: 'Which database should the new service use - Postgres or SQLite?',
    options: [{ label: 'Postgres' }, { label: 'SQLite' }],
  }],
}
const freeText = { questions: [{ id: 'q2', question: 'What should the service be called?' }] }
const batch = { questions: [{ id: 'q4', header: 'One', question: 'First?' }, { id: 'q5', header: 'Two', question: 'Second?' }] }
const review = { questions: [{ id: 'p1', question: 'Approve this plan?', detail: 'step 1…', intent: { kind: 'plan-review', approve: 'Approve' } }] }
const approval = { toolName: 'pwsh', reason: 'Run a command that writes outside the workspace.' }

for (const [label, built] of [
  ['question with header', questionTabs(options, config)],
  ['question without     ', questionTabs(freeText, config)],
  ['two-question request ', questionTabs(batch, config)],
  ['plan review          ', questionTabs(review, config)],
  ['approval             ', approvalTabs(approval, config)],
]) {
  console.log(`${label}: ${built.accent} ${built.tabs.map(t => `"${t.label}"`).join(' + ')}`)
}

if (questionTabs(options, config).tabs[0].label !== 'Choose a database') fail('question header was not used as the tab label')
if (questionTabs(freeText, config).tabs[0].label !== 'Question 1') fail('headerless question did not get a numbered tab label')
if (questionTabs(batch, config).tabs.length !== 2) fail('a two-question request did not produce two tabs')
if (questionTabs(review, config).accent !== '#7C5CFF') fail('plan review did not get its own accent')
if (approvalTabs(approval, config).accent !== '#E5A00D') fail('approval did not get its own accent')
for (const built of [questionTabs(options, config), approvalTabs(approval, config)]) {
  if (built.tabs.some(tab => 'options' in tab || 'answers' in tab)) fail('a tab still carries answer buttons')
}
console.log('truncate:', truncate('a '.repeat(200), 40))

// ------------------------------------------------------------- never answers

// The plugin must return exactly what the rest of the waterfall produced, both
// when it shows a card and when it does not.
{
  const { listeners } = mount({ countdownMs: 2000, debug: true })
  if (!listeners.has('user-questions/request')) fail('user-questions/request listener missing')
  if (!listeners.has('approval/request')) fail('approval/request listener missing')
  const answered = await listeners.get('user-questions/request')({ ...options, agent: agent('s1') }, immediately('ANSWER-FROM-UI'))
  if (answered !== 'ANSWER-FROM-UI') fail(`question dispatch returned ${JSON.stringify(answered)} instead of the downstream answer`)
  const outcome = await listeners.get('approval/request')({ ...approval, agent: agent('s1') }, immediately('allowed-once'))
  if (outcome !== 'allowed-once') fail(`approval dispatch returned ${JSON.stringify(outcome)} instead of the downstream outcome`)
  console.log('pass-through verified for questions and approvals')
  // The downstream answer resolves immediately, so the plugin writes a close
  // marker and the card retires. Wait for that to be observed rather than
  // guessing at a delay: a card must not be killed mid-compile.
  if (!await waitForLog('dismissed (answered in chat)')) {
    fail('no card retired after the chat answered — the auto-close path never ran')
  }
  listeners.get('dispose')()
}

// ------------------------------------------------------ grouping and stacking

// Two questions from ONE request share one card with two tabs; questions from
// different chats get separate cards that stack.
//
// Deliberately mounted with the DEFAULT throttleMs. An earlier version of this
// test passed throttleMs: 0, which disabled the de-duplication that was silently
// discarding the second question - so the test passed while the app showed only
// one tab. Do not override the throttle here.
{
  const { listeners } = mount({ countdownMs: 4000, debug: true })
  const ask = listeners.get('user-questions/request')

  // `never`, not `immediately`: a resolving downstream now means "the chat
  // answered", which correctly retires the card. These cards must persist to be
  // observed stacking.
  ask({ ...batch, agent: agent('s1') }, never)
  // Wait for the card to finish DRAWING, not merely to start: "tabs=2" also
  // appears on the helper's start line, which is emitted before the form is
  // built. Disposing on that would kill the card mid-render.
  if (!await waitForLog('slid in')) fail('the two-tab card never finished drawing')
  await sleep(400)
  const oneChat = readFileSync(layoutFile(), 'utf8').trim().split('\n')
  if (oneChat.length !== 1) fail(`one request should produce one card, found ${oneChat.length}`)
  if (oneChat[0].split('|')[1] !== '0') fail(`the only card must not count down, got "${oneChat[0]}"`)
  console.log('one request -> one card:', JSON.stringify(oneChat))

  // A different chat gets its own card, which pushes the first one up.
  ask({ questions: [{ id: 'c', question: 'Question from a different chat.' }], agent: agent('s2') }, never)
  if (!await waitForLog('pushed to slot 1')) fail('the first card was never pushed up by the second chat')
  await sleep(400)
  const twoChats = readFileSync(layoutFile(), 'utf8').trim().split('\n')
  if (twoChats.length !== 2) {
    fail(`two chats should produce two cards, found ${twoChats.length}: ${JSON.stringify(twoChats)}`)
  } else {
    if (twoChats[0].split('|')[1] !== '0') fail(`the newest card must not count down, got "${twoChats[0]}"`)
    if (twoChats[1].split('|')[1] === '0') fail(`the pushed card must start a countdown, got "${twoChats[1]}"`)
    console.log('two chats -> stacked:', JSON.stringify(twoChats))
  }

  listeners.get('dispose')()
  await sleep(500)
  const leftover = existsSync(RUNTIME_DIR) ? readdirSync(RUNTIME_DIR).filter(n => n.endsWith('.layout')) : []
  if (leftover.length > 0) fail(`dispose left layout file(s) behind: ${leftover.join(', ')}`)
}

// -------------------------------------------------------------- helper evidence

await sleep(500)
const log = readFileSync(DEBUG_LOG, 'utf8')
console.log('--- debug.log (tail) ---')
console.log(log.trimEnd().split('\n').slice(-12).join('\n'))

for (const [needle, description] of [
  ['mounted', 'plugin never mounted'],
  ['dispatch question', 'the question waterfall never reached the listener'],
  ['helper: start', 'the helper process started but ran no script'],
  ['helper: showing card', 'the helper ran but never drew a card'],
  ['closing card', 'the plugin never noticed an answer arriving in the chat'],
  ['dismissed (answered in chat)', 'a card did not retire when the chat answered'],
]) {
  if (!log.includes(needle)) fail(`missing "${needle}" — ${description}`)
}
if (/helper: card failed|setup failed|size write failed/.test(log)) fail('the helper reported a failure')

// A two-question request must render as ONE card carrying two tabs.
if (!/tabs=2/.test(log)) fail('no card was ever rendered with two tabs')

// The card is created parked off the right edge and slid in by a timer. If the
// animation is skipped, the window never leaves that parked position: it renders
// perfectly, exits cleanly, and reports success while sitting entirely
// off-screen. Assert on where the window ACTUALLY ended up.
const slid = [...log.matchAll(/slid in, window at (-?\d+),(-?\d+) \(target (-?\d+),(-?\d+)\)/g)]
if (slid.length === 0) fail('no card reported completing its slide-in')
for (const match of slid) {
  const [x, y, tx, ty] = match.slice(1).map(Number)
  if (x !== tx || y !== ty) fail(`card settled at ${x},${y} but its target was ${tx},${ty} — it is off-screen`)
}
if (slid.length > 0) console.log(`slide-in verified on ${slid.length} card(s): window reached its target position`)

console.log(process.exitCode === 1 ? 'smoke test FAILED' : 'smoke test passed (cards drawn, two tabs on one card, never answers)')
