/**
 * dsh-fleet runner — the "soldier barracks" half of the plugin.
 *
 * A {@link Fleet} owns every worker process the Harness ever dispatched:
 * a queue, a fixed number of concurrency slots, one run directory per run
 * (`brief.md`, `out.log`, `state.json`), a watchdog tick that enforces
 * deadlines and reports crashed attempts, and an on-disk state machine that
 * survives a Harness restart. It knows nothing about the model-facing tools
 * and nothing about any particular CLI: an *agent* is `{ command, args }`
 * plus a brief, so swapping opencode for hermes is a config edit.
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** Grace between SIGTERM and SIGKILL when stopping a worker. */
const TERM_GRACE_MS = 8_000

/** Cap on the pending queue, so a runaway caller cannot exhaust the machine. */
const MAX_PENDING = 64

/** Read at most this much of a log when producing a tail. */
const TAIL_BYTES = 256 * 1024

/** Terminal states: no further transition happens for these runs. */
const TERMINAL = new Set(['done', 'failed', 'timeout', 'stopped', 'lost'])

/**
 * Worker CLIs that answer "did it work" with exit status 0 even when the model
 * call never happened (hermes-agent prints `Completed: False` and exits 0).
 * A hit does not change the state — it makes the run *suspect*, so the commander
 * is told to read the output instead of trusting the exit code.
 *
 * Deliberately narrow: generic `HTTP 4xx` is excluded, because a pentest worker
 * printing a 404 target response is normal work.
 *
 * @type {Array<{label: string, pattern: RegExp}>}
 */
const FAILURE_SIGNALS = [
  { label: '模型未配置（Missing model）', pattern: /Missing model/i },
  { label: 'CLI 自报未完成（Completed: False）', pattern: /Completed:\s*False/i },
  { label: '调用不可重试失败（not retryable failed）', pattern: /not retryable failed/i },
  { label: 'provider 拒答（HTTP 4xx/5xx from provider）', pattern: /(OpenRouter|Anthropic|OpenAI|DeepSeek)[^\n]*HTTP \d{3}|HTTP \d{3}[^\n]*(provider|rejected)/i },
  { label: 'Python 异常栈（Traceback）', pattern: /Traceback \(most recent call last\)/ },
  { label: '命令不存在（command not found）', pattern: /command not found/i },
]

/**
 * Scan one attempt's output for the failure signatures above.
 * @param {string} text captured stdout+stderr
 * @returns {string[]} matched labels, deduplicated
 */
export function detectFailureSignals(text) {
  if (!text) return []
  const hits = []
  for (const signal of FAILURE_SIGNALS) {
    if (signal.pattern.test(text) && !hits.includes(signal.label)) hits.push(signal.label)
  }
  return hits
}

/** @typedef {'queued'|'running'|'done'|'failed'|'timeout'|'stopped'|'lost'} RunState */

/** Short random id, unique enough for one machine and readable in a log. */
function makeRunId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  return `r-${stamp}-${Math.random().toString(16).slice(2, 6)}`
}

/** ISO timestamp for the current instant. */
function nowIso() {
  return new Date().toISOString()
}

/**
 * Whether a pid is still alive. `EPERM` means the process exists but belongs to
 * someone else, which still counts as alive for supervision purposes.
 * @param {number} pid process id
 * @returns {boolean} liveness
 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Substitute `{name}` placeholders in one template string.
 * @param {string} template template with braces
 * @param {Record<string, string>} values replacement values
 * @returns {string} substituted text; unknown placeholders are left alone
 */
function substitute(template, values) {
  return template.replace(/\{(\w+)\}/g, (whole, key) => (key in values ? values[key] : whole))
}

/**
 * Last `count` non-empty lines of a text file, without loading the whole file.
 * @param {string} path file path
 * @param {number} count how many lines to keep
 * @returns {string} text tail ('' when missing)
 */
export function tailFile(path, count) {
  if (!existsSync(path)) return ''
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return ''
  }
  if (text.length > TAIL_BYTES) text = text.slice(text.length - TAIL_BYTES)
  const lines = text.split('\n')
  return lines.slice(Math.max(0, lines.length - count)).join('\n')
}

/**
 * The log text of the *latest* attempt only, so an earlier failed attempt's
 * error text cannot make the current one look suspect.
 * @param {string} path log file path
 * @returns {string} attempt output
 */
function attemptOutput(path) {
  const text = readTextBounded(path)
  const marker = text.lastIndexOf('\n===== ')
  return marker >= 0 ? text.slice(marker) : text
}

/**
 * Read at most the tail of a text file, without loading an unbounded log.
 * @param {string} path file path
 * @returns {string} text ('' when missing)
 */
function readTextBounded(path) {
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf8').slice(-TAIL_BYTES)
  } catch {
    return ''
  }
}

/** Human-scale elapsed seconds for one run record. */
function elapsedSec(run) {
  const start = Date.parse(run.startedAt ?? run.createdAt)
  const end = run.endedAt ? Date.parse(run.endedAt) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, Math.round((end - start) / 1000))
}

/**
 * One fleet of worker agents.
 *
 * @fires Fleet#change emitted after any state transition, with `{ id, state }`
 */
export class Fleet extends EventEmitter {
  /**
   * @param {object} options fleet options
   * @param {string} options.dataDir directory holding `runs/`
   * @param {Map<string, import('./agents.js').AgentSpec>} options.agents configured agents
   * @param {number} [options.maxConcurrent] parallel worker slots
   * @param {number} [options.defaultTimeoutSec] deadline when a dispatch sets none
   * @param {number} [options.retryLimit] automatic retries after a failed attempt
   * @param {number} [options.pollMs] watchdog tick
   * @param {number} [options.keepRuns] terminal run directories kept on disk
   * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger] host logger
   */
  constructor(options) {
    super()
    this.dataDir = options.dataDir
    this.runsDir = join(this.dataDir, 'runs')
    this.agents = options.agents ?? new Map()
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 4)
    this.defaultTimeoutSec = Math.max(30, options.defaultTimeoutSec ?? 1800)
    this.retryLimit = Math.max(0, options.retryLimit ?? 0)
    this.pollMs = Math.max(250, options.pollMs ?? 1500)
    this.keepRuns = Math.max(1, options.keepRuns ?? 50)
    this.logger = options.logger
    /** @type {Map<string, any>} every run this fleet knows about */
    this.runs = new Map()
    /** @type {Map<string, import('node:child_process').ChildProcess>} live children */
    this.children = new Map()
    /** @type {string[]} run ids waiting for a slot */
    this.queue = []
    mkdirSync(this.runsDir, { recursive: true })
    this.#adopt()
    this.#prune()
    this.watchdog = setInterval(() => this.#tick(), this.pollMs)
    this.watchdog.unref?.()
  }

  /** Persist one run record atomically. */
  #save(run) {
    const dir = join(this.runsDir, run.id)
    mkdirSync(dir, { recursive: true })
    const target = join(dir, 'state.json')
    writeFileSync(`${target}.tmp`, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
    renameSync(`${target}.tmp`, target)
  }

  /**
   * Rebuild the in-memory table from `runs/` after a Harness restart. Runs whose
   * process is still alive are re-adopted by pid (no child handle, so only exit
   * detection is lost); runs whose process is gone become `lost`.
   */
  #adopt() {
    let dirs = []
    try {
      dirs = readdirSync(this.runsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
      return
    }
    for (const id of dirs) {
      const file = join(this.runsDir, id, 'state.json')
      if (!existsSync(file)) continue
      let run
      try {
        run = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      if (!run?.id) continue
      // Runs recorded before the suspect scan existed get it back-filled from
      // their own log, so history stays honest after an upgrade.
      if (TERMINAL.has(run.state) && run.suspect === undefined) {
        run.suspect = detectFailureSignals(attemptOutput(run.logPath))
        if (run.suspect.length > 0) {
          run.note = run.note ?? `exit ${run.exitCode ?? 'null'}，输出里有失败特征：${run.suspect.join('；')}`
          this.#save(run)
        }
      }
      if (!TERMINAL.has(run.state)) {
        if (isAlive(run.pid)) {
          run.state = 'running'
          run.adopted = true
          run.note = '运行状态来自上一次 Harness 进程，按 pid 继续监管'
        } else {
          run.state = 'lost'
          run.endedAt = run.endedAt ?? nowIso()
          run.note = 'Harness 重启前进程已退出，退出码未知'
        }
        this.#save(run)
      }
      this.runs.set(run.id, run)
    }
    if (this.runs.size > 0) this.logger?.info?.(`dsh-fleet: 接管 ${this.runs.size} 条历史运行记录`)
  }

  /**
   * Keep the runs directory bounded: newest `keepRuns` finished runs stay,
   * older ones are removed with their logs. Unfinished runs are never pruned.
   */
  #prune() {
    const finished = [...this.runs.values()]
      .filter(run => TERMINAL.has(run.state))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    const doomed = finished.slice(this.keepRuns)
    for (const run of doomed) {
      this.runs.delete(run.id)
      try {
        rmSync(join(this.runsDir, run.id), { recursive: true, force: true })
      } catch {
        /* a directory that will not delete is not worth failing activation over */
      }
    }
    if (doomed.length > 0) {
      this.logger?.info?.(`dsh-fleet: 清理 ${doomed.length} 条历史运行记录（保留最近 ${this.keepRuns} 条）`)
    }
  }

  /** How many slots are occupied right now. */
  #busy() {
    let busy = 0
    for (const run of this.runs.values()) if (run.state === 'running') busy += 1
    return busy
  }

  /** Start queued runs until the slots are full. */
  #pump() {
    while (this.queue.length > 0 && this.#busy() < this.maxConcurrent) {
      const id = this.queue.shift()
      const run = this.runs.get(id)
      if (!run || run.state !== 'queued') continue
      this.#start(run)
    }
  }

  /** Watchdog: deadlines, orphaned pids, retries, and slot refills. */
  #tick() {
    const now = Date.now()
    for (const run of this.runs.values()) {
      if (run.state !== 'running') continue
      // A re-adopted run has no child handle: its only signal is pid liveness.
      if (!this.children.has(run.id) && run.adopted) {
        if (!isAlive(run.pid)) {
          run.state = 'lost'
          run.endedAt = nowIso()
          run.note = '进程已退出，退出码未知（Harness 重启后接管）'
          this.#save(run)
          this.emit('change', { id: run.id, state: run.state })
          continue
        }
      }
      const deadline = run.startedAt ? Date.parse(run.startedAt) + run.timeoutSec * 1000 : 0
      if (deadline > 0 && now > deadline) {
        run.note = `超过 ${run.timeoutSec}s 截止时间，已终止`
        this.logger?.warn?.(`dsh-fleet: ${run.id} 超时，终止进程 ${run.pid}`)
        this.#signal(run, 'SIGTERM')
        const killAt = now + TERM_GRACE_MS
        setTimeout(() => {
          const latest = this.runs.get(run.id)
          if (latest && latest.state === 'running') this.#signal(latest, 'SIGKILL')
        }, TERM_GRACE_MS).unref?.()
        void killAt
      }
    }
    this.#pump()
  }

  /** Send one signal to a run's process group member, tolerating a dead pid. */
  #signal(run, signal) {
    const child = this.children.get(run.id)
    try {
      if (child) child.kill(signal)
      else if (isAlive(run.pid)) process.kill(run.pid, signal)
    } catch (error) {
      this.logger?.warn?.(`dsh-fleet: 向 ${run.id} 发送 ${signal} 失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Write the log header for one attempt. */
  #openLog(run) {
    const dir = join(this.runsDir, run.id)
    mkdirSync(dir, { recursive: true })
    appendFileSync(
      run.logPath,
      `\n===== ${nowIso()} attempt ${run.attempts} · ${run.agentId} · ${run.id} =====\n`,
      'utf8',
    )
  }

  /** Spawn one worker attempt. */
  #start(run) {
    const agent = this.agents.get(run.agentId)
    if (!agent) {
      run.state = 'failed'
      run.error = `未知 agent: ${run.agentId}`
      run.endedAt = nowIso()
      this.#save(run)
      return
    }
    run.state = 'running'
    run.attempts = (run.attempts ?? 0) + 1
    run.startedAt = nowIso()
    run.endedAt = null
    run.exitCode = null
    run.error = null
    run.suspect = []
    run.adopted = false
    run.pid = null
    this.#openLog(run)

    const values = {
      prompt: run.prompt,
      brief: run.briefPath,
      cwd: run.cwd,
      runDir: join(this.runsDir, run.id),
      runId: run.id,
      goal: run.goal,
    }
    const args = agent.args.map(arg => substitute(arg, values))
    const usesPrompt = agent.args.some(arg => arg.includes('{prompt}') || arg.includes('{brief}'))
    const env = {
      ...process.env,
      ...agent.env,
      FLEET_RUN_ID: run.id,
      FLEET_BRIEF: run.briefPath,
      FLEET_GOAL_FILE: run.briefPath,
      FLEET_TIMEOUT_SEC: String(run.timeoutSec),
      FLEET_DATA_DIR: this.dataDir,
    }

    let child
    try {
      // Prefer the absolute path the catalog resolved: a worker CLI often lives
      // in a directory the Harness process does not have on PATH.
      child = spawn(agent.binary || substitute(agent.command, values), args, {
        cwd: run.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: agent.shell === true,
      })
    } catch (error) {
      this.#finalize(run, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    this.children.set(run.id, child)
    run.pid = child.pid ?? null
    this.#save(run)

    const write = (chunk) => {
      try {
        appendFileSync(run.logPath, chunk)
      } catch {
        /* a full disk must not crash the Harness */
      }
    }
    child.stdout?.on('data', write)
    child.stderr?.on('data', write)
    child.on('error', (error) => {
      this.#finalize(run, { error: error instanceof Error ? error.message : String(error) })
    })
    child.on('exit', (code, signal) => {
      const timedOut = run.note?.includes('截止时间') === true
      this.#finalize(run, { code, signal, timeout: timedOut })
    })

    if (!usesPrompt) {
      // No prompt placeholder: the worker reads its task from stdin.
      child.stdin?.end(`${run.prompt}\n`)
    } else {
      child.stdin?.end()
    }
    this.logger?.info?.(`dsh-fleet: 启动 ${run.id} (${run.agentId}, pid ${run.pid}) 于 ${run.cwd}`)
    this.emit('change', { id: run.id, state: run.state })
  }

  /**
   * Close out one attempt: record the outcome, then either retry or stop.
   * @param {any} run run record
   * @param {{code?: number|null, signal?: string|null, error?: string, timeout?: boolean}} outcome result
   */
  #finalize(run, outcome) {
    this.children.delete(run.id)
    run.endedAt = nowIso()
    run.exitCode = outcome.code ?? null
    run.signal = outcome.signal ?? null
    if (outcome.error) run.error = outcome.error
    const requested = run.stopRequested === true
    if (outcome.timeout) run.state = 'timeout'
    else if (requested) run.state = 'stopped'
    else if (outcome.error) run.state = 'failed'
    else if (outcome.code === 0) run.state = 'done'
    else run.state = 'failed'

    // Exit code is not proof of work: several worker CLIs answer 0 after a
    // provider failure. Record what the output says, separately from state.
    const suspect = detectFailureSignals(attemptOutput(run.logPath))
    run.suspect = suspect
    if (suspect.length > 0 && run.state === 'done') {
      run.note = `exit 0，但输出里有失败特征：${suspect.join('；')}`
    }

    const mayRetry = run.state === 'failed' && !requested && run.attempts <= run.retryLimit
    if (mayRetry) {
      run.note = `第 ${run.attempts} 次尝试失败（exit ${run.exitCode ?? 'null'}），自动重启`
      run.state = 'queued'
      run.retryNote = outLine(run)
      this.#save(run)
      this.queue.push(run.id)
      this.logger?.warn?.(`dsh-fleet: ${run.id} 重试 ${run.attempts}/${run.retryLimit}`)
      this.emit('change', { id: run.id, state: run.state })
      return
    }
    this.#save(run)
    this.logger?.info?.(`dsh-fleet: ${run.id} 结束 state=${run.state} exit=${run.exitCode}`)
    this.emit('change', { id: run.id, state: run.state })
    this.emit(`exit:${run.id}`, run)
  }

  /**
   * Queue one mission.
   *
   * @param {object} request dispatch request
   * @param {string} request.agentId agent id
   * @param {string} request.goal the customer goal, verbatim
   * @param {string} request.assignment this worker's share of the goal
   * @param {string|((runId: string) => string)} request.brief complete brief markdown, or a builder that receives the run id
   * @param {string} request.cwd working directory
   * @param {number} [request.timeoutSec] deadline for this run
   * @param {number} [request.retryLimit] per-run retry override
   * @param {string} [request.label] display label
   * @returns {any} the queued run view
   */
  dispatch(request) {
    if (this.queue.length >= MAX_PENDING) {
      throw new Error(`待执行队列已满（${MAX_PENDING}），先用 fleet_status 收割或 fleet_stop 取消`)
    }
    const agent = this.agents.get(request.agentId)
    if (!agent) throw new Error(`未知 agent: ${request.agentId}`)
    const id = makeRunId()
    const dir = join(this.runsDir, id)
    mkdirSync(dir, { recursive: true })
    const briefText = typeof request.brief === 'function' ? request.brief(id) : request.brief
    const briefPath = join(dir, 'brief.md')
    writeFileSync(briefPath, briefText, 'utf8')
    const run = {
      id,
      agentId: request.agentId,
      adapter: agent.adapter,
      label: request.label ?? request.agentId,
      goal: request.goal,
      assignment: request.assignment,
      cwd: request.cwd,
      state: 'queued',
      attempts: 0,
      retryLimit: request.retryLimit ?? this.retryLimit,
      timeoutSec: request.timeoutSec ?? agent.timeoutSec ?? this.defaultTimeoutSec,
      createdAt: nowIso(),
      startedAt: null,
      endedAt: null,
      pid: null,
      exitCode: null,
      prompt: request.prompt ?? briefText,
      briefPath,
      logPath: join(dir, 'out.log'),
    }
    this.runs.set(id, run)
    this.#save(run)
    this.queue.push(id)
    this.#pump()
    return this.view(id)
  }

  /**
   * Public snapshot of one run, with the log tail.
   * @param {string} id run id
   * @param {number} [tailLines] how many log lines to include
   * @returns {any} view, or undefined when unknown
   */
  view(id, tailLines = 20) {
    const run = this.runs.get(id)
    if (!run) return undefined
    return {
      runId: run.id,
      agent: run.agentId,
      label: run.label,
      state: run.state,
      attempts: run.attempts,
      pid: run.pid,
      cwd: run.cwd,
      timeoutSec: run.timeoutSec,
      durationSec: elapsedSec(run),
      exitCode: run.exitCode,
      error: run.error ?? null,
      note: run.note ?? null,
      suspect: run.suspect ?? [],
      briefPath: run.briefPath,
      logPath: run.logPath,
      tail: tailLines > 0 ? tailFile(run.logPath, tailLines) : '',
    }
  }

  /**
   * Every known run, newest first.
   * @param {number} [limit] how many to return
   * @returns {any[]} views
   */
  list(limit = 20) {
    return [...this.runs.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit)
      .map(run => this.view(run.id, 0))
  }

  /** Counts by state, for one-line progress reports. */
  summary() {
    const counts = { queued: 0, running: 0, done: 0, failed: 0, timeout: 0, stopped: 0, lost: 0 }
    for (const run of this.runs.values()) counts[run.state] = (counts[run.state] ?? 0) + 1
    return { ...counts, pending: this.queue.length, slots: this.maxConcurrent }
  }

  /**
   * Block until every given run reaches a terminal state.
   * @param {string[]} ids run ids
   * @param {number} timeoutMs maximum wait
   * @returns {Promise<boolean>} true when all finished, false on timeout
   */
  async waitFor(ids, timeoutMs) {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    const settled = () => ids.every((id) => {
      const run = this.runs.get(id)
      return !run || TERMINAL.has(run.state)
    })
    if (settled()) return true
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 300))
      if (settled()) return true
    }
    return settled()
  }

  /**
   * Stop one run, or all of them.
   * @param {string} id run id or 'all'
   * @returns {{stopped: string[]}} ids that were still live
   */
  stop(id) {
    const targets = id === 'all'
      ? [...this.runs.values()].filter(run => !TERMINAL.has(run.state)).map(run => run.id)
      : [id]
    const stopped = []
    for (const runId of targets) {
      const index = this.queue.indexOf(runId)
      if (index >= 0) {
        this.queue.splice(index, 1)
        const run = this.runs.get(runId)
        if (run) {
          run.state = 'stopped'
          run.endedAt = nowIso()
          run.note = '排队中被取消'
          this.#save(run)
        }
        stopped.push(runId)
        continue
      }
      const run = this.runs.get(runId)
      if (!run || TERMINAL.has(run.state)) continue
      run.stopRequested = true
      run.note = '收到停止指令'
      this.#signal(run, 'SIGTERM')
      stopped.push(runId)
      setTimeout(() => {
        const latest = this.runs.get(runId)
        if (latest && latest.state === 'running') this.#signal(latest, 'SIGKILL')
      }, TERM_GRACE_MS).unref?.()
    }
    return { stopped }
  }

  /** Release timers. Worker processes are intentionally left running. */
  dispose() {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
  }
}

/** One-line outcome note used when a retry starts a new attempt. */
function outLine(run) {
  const tail = tailFile(run.logPath, 6)
  return `attempt ${run.attempts} failed (exit ${run.exitCode ?? 'null'}); last lines:\n${tail}`
}
