#!/usr/bin/env node
/**
 * Self-test for dsh-fleet's scheduler half. Runs no model and no external CLI:
 * every worker is `scripts/stub-agent.mjs` spawned with this Node binary, so the
 * queue, deadline, retry, stop, adoption, and log paths are all exercised for
 * real. `node scripts/selftest.mjs` prints one line per check and exits non-zero
 * on the first failure.
 */

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAgentTable, buildBrief, DEFAULT_AGENTS } from '../lib/agents.js'
import { Fleet, isAlive, tailFile } from '../lib/runner.js'

const STUB = new URL('./stub-agent.mjs', import.meta.url).pathname
let failures = 0
let checks = 0

/** Print one check result and remember failures. */
function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Fresh data directory for one scenario. */
function freshDir(label) {
  return mkdtempSync(join(tmpdir(), `dsh-fleet-${label}-`))
}

/** Stub agent table: a real process, no login, no tokens. */
function stubAgents(extra = {}) {
  return buildAgentTable([
    { id: 'stub', label: 'Stub', command: process.execPath, args: [STUB, '{brief}'], ...extra },
  ], ['claude', 'codex', 'cyberstrike', 'artex'])
}

/** Wait until a predicate holds or the budget runs out. */
async function until(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

console.log('dsh-fleet selftest')

// --- catalog ---------------------------------------------------------------
{
  console.log('catalog')
  const table = buildAgentTable([{ id: 'opencode', args: ['run', '{prompt}'] }])
  check('shipped catalog has the five runnable-agent slots + two services', DEFAULT_AGENTS.length === 7, DEFAULT_AGENTS.length)
  check('override replaces only the fields it sets', table.get('opencode').args.join(' ') === 'run {prompt}' && table.get('opencode').adapter === 'cli')
  check('disabled ids are dropped', !stubAgents().has('claude'))
  check('service agents stay available without a binary', buildAgentTable().get('cyberstrike').adapter === 'service')
}

// --- brief -----------------------------------------------------------------
{
  console.log('brief')
  const agent = { id: 'stub', label: 'Stub' }
  const brief = buildBrief({ agent, runId: 'r-1', goal: '给客户的原始需求', assignment: '只做第一步', cwd: '/tmp', timeoutSec: 600 })
  check('brief carries the verbatim goal', brief.includes('给客户的原始需求'))
  check('brief carries the worker assignment', brief.includes('只做第一步'))
  check('brief states the deadline in minutes', brief.includes('约 10 分钟'))
  check('brief demands the three-part deliverable', brief.includes('## 结论') && brief.includes('## 证据 / 产出') && brief.includes('## 未完成 / 风险'))
}

// --- happy path ------------------------------------------------------------
{
  console.log('happy path')
  const fleet = new Fleet({ dataDir: freshDir('ok'), agents: stubAgents(), maxConcurrent: 2, pollMs: 200 })
  const before = fleet.dispatch({ agentId: 'stub', goal: '跑通闭环', assignment: '打印三步', brief: id => `goal 跑通闭环 run ${id}`, cwd: tmpdir() })
  const after = fleet.dispatch({ agentId: 'stub', goal: '跑通闭环', assignment: '打印三步', brief: id => `goal 跑通闭环 run ${id}`, cwd: tmpdir() })
  check('dispatch returns distinct run ids', before.runId !== after.runId)
  check('run starts in queued or running', ['queued', 'running'].includes(before.state), before.state)
  await fleet.waitFor([before.runId, after.runId], 20_000)
  const one = fleet.view(before.runId, 40)
  check('worker reaches done', one.state === 'done', `${one.state} exit=${one.exitCode}`)
  check('brief.md written with the run id', readFileSync(one.briefPath, 'utf8').includes(before.runId))
  check('out.log has the header, the work, and the deliverable', one.tail.includes('attempt 1') && one.tail.includes('## 结论') && one.tail.includes('## 证据'))
  check('worker inherited FLEET_RUN_ID', one.tail.includes(before.runId))
  check('summary counts both runs as done', fleet.summary().done === 2, JSON.stringify(fleet.summary()))
  check('a clean worker carries no suspect flags', one.suspect.length === 0, JSON.stringify(one.suspect))
  fleet.dispose()
}

// --- concurrency slots -----------------------------------------------------
{
  console.log('concurrency')
  const fleet = new Fleet({ dataDir: freshDir('slots'), agents: stubAgents({ env: { STUB_SLEEP_MS: '1500' } }), maxConcurrent: 1, pollMs: 100 })
  const first = fleet.dispatch({ agentId: 'stub', goal: 'g', brief: 'b', cwd: tmpdir() })
  const second = fleet.dispatch({ agentId: 'stub', goal: 'g', brief: 'b', cwd: tmpdir() })
  await new Promise(resolve => setTimeout(resolve, 400))
  check('one slot means the second run waits in the queue', fleet.view(first.runId).state === 'running' && fleet.view(second.runId).state === 'queued')
  await fleet.waitFor([first.runId, second.runId], 20_000)
  check('queued run eventually runs', fleet.view(second.runId).state === 'done')
  fleet.dispose()
}

// --- exit code vs. real work -----------------------------------------------
{
  console.log('suspect output')
  const fleet = new Fleet({ dataDir: freshDir('suspect'), agents: stubAgents({ env: { STUB_FAKE_ERROR: '1' } }), pollMs: 100 })
  const run = fleet.dispatch({ agentId: 'stub', goal: 'g', brief: 'b', cwd: tmpdir() })
  await fleet.waitFor([run.runId], 20_000)
  const view = fleet.view(run.runId, 10)
  check('exit 0 with a provider failure stays "done"', view.state === 'done' && view.exitCode === 0)
  check('but it is flagged suspect', view.suspect.length >= 2, JSON.stringify(view.suspect))
  check('the note explains why it is not a success', String(view.note ?? '').includes('失败特征'), view.note)
  fleet.dispose()
}

// --- deadline --------------------------------------------------------------
{
  console.log('deadline')
  const fleet = new Fleet({ dataDir: freshDir('timeout'), agents: stubAgents({ env: { STUB_SLEEP_MS: '9000' } }), pollMs: 100 })
  const run = fleet.dispatch({ agentId: 'stub', goal: 'g', brief: 'b', cwd: tmpdir(), timeoutSec: 1 })
  const finished = await until(() => ['timeout', 'stopped', 'failed', 'done'].includes(fleet.view(run.runId).state), 20_000)
  const view = fleet.view(run.runId)
  check('deadline kills the worker', finished && view.state === 'timeout', view.state)
  check('deadline is recorded on the run', String(view.note ?? '').includes('截止时间'), view.note)
  fleet.dispose()
}

// --- stop ------------------------------------------------------------------
{
  console.log('stop')
  const fleet = new Fleet({ dataDir: freshDir('stop'), agents: stubAgents({ env: { STUB_SLEEP_MS: '9000' } }), pollMs: 100 })
  const run = fleet.dispatch({ agentId: 'stub', goal: 'g', brief: 'b', cwd: tmpdir() })
  await until(() => fleet.view(run.runId).state === 'running', 5000)
  const result = fleet.stop(run.runId)
  const finished = await until(() => fleet.view(run.runId).state === 'stopped', 20_000)
  check('stop reports the live run', result.stopped.includes(run.runId))
  check('stop lands in the stopped state', finished, fleet.view(run.runId).state)
  fleet.dispose()
}

// --- failure and retry -----------------------------------------------------
{
  console.log('retry')
  const fleet = new Fleet({ dataDir: freshDir('retry'), agents: stubAgents({ env: { STUB_EXIT_CODE: '3' } }), pollMs: 100, retryLimit: 1 })
  const run = fleet.dispatch({ agentId: 'stub', goal: 'g', brief: 'b', cwd: tmpdir() })
  const finished = await until(() => fleet.view(run.runId).state === 'failed', 25_000)
  const view = fleet.view(run.runId)
  check('failed attempt is retried once', view.attempts === 2, view.attempts)
  check('retry keeps the exit code', finished && view.exitCode === 3, view.exitCode)
  check('both attempts are in the log', (readFileSync(view.logPath, 'utf8').match(/attempt \d/g) ?? []).length === 2)
  fleet.dispose()
}

// --- restart adoption ------------------------------------------------------
{
  console.log('adoption')
  const dir = freshDir('adopt')
  const runsDir = join(dir, 'runs')
  mkdirSync(join(runsDir, 'r-20260101-000000-abcd'), { recursive: true })
  const orphan = {
    id: 'r-20260101-000000-abcd',
    agentId: 'stub',
    state: 'running',
    pid: process.pid,
    attempts: 1,
    timeoutSec: 600,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    logPath: join(runsDir, 'r-20260101-000000-abcd', 'out.log'),
    briefPath: join(runsDir, 'r-20260101-000000-abcd', 'brief.md'),
  }
  writeFileSync(join(runsDir, orphan.id, 'state.json'), JSON.stringify(orphan))
  writeFileSync(join(runsDir, 'r-20260101-000000-aaaa.state.json'), '{}')
  writeFileSync(join(runsDir, orphan.id, 'out.log'), 'line-1\nline-2\nline-3\nline-4\nline-5\n')
  const fleet = new Fleet({ dataDir: dir, agents: stubAgents(), pollMs: 200 })
  const adopted = fleet.view(orphan.id, 0)
  check('a live pid from a previous Harness is re-adopted', adopted?.state === 'running' && adopted.note.includes('按 pid'), adopted?.note)
  check('isAlive rejects a dead pid', isAlive(999_999_999) === false)
  const tail = tailFile(join(runsDir, orphan.id, 'out.log'), 2)
  check('tailFile returns the last lines of a log', tail.includes('line-5') && !tail.includes('line-1'), JSON.stringify(tail))
  fleet.dispose()
}

// --- retention -------------------------------------------------------------
{
  console.log('retention')
  const dir = freshDir('prune')
  const fleet = new Fleet({ dataDir: dir, agents: stubAgents(), pollMs: 100, keepRuns: 1 })
  const first = fleet.dispatch({ agentId: 'stub', goal: 'g', brief: 'b', cwd: tmpdir() })
  await fleet.waitFor([first.runId], 20_000)
  const second = fleet.dispatch({ agentId: 'stub', goal: 'g', brief: 'b', cwd: tmpdir() })
  await fleet.waitFor([second.runId], 20_000)
  fleet.dispose()
  const before = readdirSync(join(dir, 'runs')).length
  const reopened = new Fleet({ dataDir: dir, agents: stubAgents(), pollMs: 100, keepRuns: 1 })
  const after = readdirSync(join(dir, 'runs')).length
  check('activation prunes finished runs beyond keepRuns', before === 2 && after === 1, `${before} → ${after}`)
  check('the newest run survives pruning', reopened.runs.has(second.runId) && !reopened.runs.has(first.runId))
  reopened.dispose()
}

// --- unknown ---------------------------------------------------------------
{
  console.log('validation')
  const fleet = new Fleet({ dataDir: freshDir('valid'), agents: stubAgents(), pollMs: 200 })
  let threw = false
  try {
    fleet.dispatch({ agentId: 'nope', goal: 'g', brief: 'b', cwd: tmpdir() })
  } catch {
    threw = true
  }
  check('dispatching an unknown agent throws', threw)
  fleet.dispose()
}

console.log(failures === 0 ? `\nPASS ${checks} checks` : `\nFAIL ${failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
