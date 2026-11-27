/**
 * Model-facing tools for dsh-fleet.
 *
 * Five tools cover the whole loop: see who is on the roster, hand out missions,
 * watch them, collect one result, stop the fleet. None of them can change an
 * agent's command or credentials — that is config, not conversation.
 */

import { readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildBrief, probeAgent } from './agents.js'

/** Largest text body a single tool result carries. */
const MAX_BODY = 60_000

/** Upper bound for an in-call wait, so one tool call cannot hang a turn. */
const MAX_WAIT_SEC = 180

/**
 * Make a value lossless JSON: drop `undefined`, turn non-finite numbers to null.
 * @param {unknown} value any tool return value
 * @returns {unknown} JSON-lossless value
 */
function clean(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => clean(item))
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    out[key] = clean(item)
  }
  return out
}

/** Clip one text body and say so, so the model knows it is reading a fragment. */
function clip(text, limit = MAX_BODY) {
  if (typeof text !== 'string') return ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… (输出已截断，原文见路径)`
}

/** JSON rendering shared by every tool in this plugin. */
function renderJson(_args, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text: clip(text) }]
}

/** Canonical output declaration helper. */
const output = (description) => ({
  schema: { type: 'object', additionalProperties: true, description },
  render: renderJson,
})

/**
 * Session working directory of the calling agent, used as the default worker
 * cwd so "the workspace" means the same thing to the commander and the workers.
 * @param {any} exec tool run context
 * @returns {string} absolute directory
 */
function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

/**
 * Register the fleet tools.
 *
 * @param {{tools: {register: Function}}} ctx host context (only `tools` is used)
 * @param {import('./runner.js').Fleet} fleet the fleet to drive
 * @param {Map<string, any>} agents resolved agent table
 * @param {{info?: Function}} [logger] host logger
 * @returns {(() => void)[]} disposers
 */
export function registerFleetTools(ctx, fleet, agents, logger) {
  const disposed = []
  const register = (definition) => {
    disposed.push(ctx.tools.register(definition))
  }

  register(defineTool({
    name: 'fleet_agents',
    description: '军团花名册：列出可以派活的执行型 agent 以及它们的适配方式、可用性与擅长方向。action=probe 会真的跑一次 `--version` 或对服务型 agent 发一次 HTTP 请求来确认现在能不能用。派活前先看一眼这个，避免把任务交给一个没登录/没安装的 CLI。',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'probe'],
        description: 'list 只读配置（快）；probe 实际探测二进制/服务是否就绪（约 1-8 秒）。',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: '只关心这些 agent id；省略则全部。',
      },
    },
    output: output('军团花名册：每个 agent 的适配器、命令、擅长方向、可用性、备注'),
    timeoutMs: 60_000,
    async execute(args) {
      const wanted = args.ids?.length ? new Set(args.ids) : null
      const rows = []
      for (const agent of agents.values()) {
        if (wanted && !wanted.has(agent.id)) continue
        const row = {
          id: agent.id,
          label: agent.label,
          adapter: agent.adapter,
          available: agent.available,
          skills: agent.skills,
          notes: agent.notes,
        }
        if (agent.endpoint) row.endpoint = agent.endpoint
        if (agent.driver) row.driver = agent.driver
        if (agent.adapter === 'cli' || agent.adapter === 'exec') row.command = [agent.command, ...agent.args].join(' ')
        if (args.action === 'probe') {
          const probe = await probeAgent(agent, agent.probeTimeoutMs)
          // `available` answers "is there a binary/service at all"; `ready` answers
          // "did the probe itself pass". A slow or unauthenticated CLI can be
          // available but not ready, and dispatch is still allowed.
          row.ready = probe.ready
          row.probe = probe.detail
          if (agent.available && !probe.ready) {
            row.warning = '二进制存在但探活未通过：可能启动慢、未登录或缺少配置；需要时可以试派一个小任务验证。'
          }
        }
        rows.push(row)
      }
      // Availability across the whole roster, not only the ids asked about.
      const runnable = [...agents.values()]
        .filter(agent => agent.adapter !== 'service' && agent.available)
        .map(agent => agent.id)
      logger?.info?.(`dsh-fleet: fleet_agents action=${args.action ?? 'list'} 可用=[${runnable.join(',')}]`)
      return clean({
        agents: rows,
        runnable,
        logPath: fleet.logPath,
        secretsPath: fleet.secretsPath,
        hint: '把任务派给 runnable 里的 agent。cli 型直接跑 CLI；mcp/http 型会起一个协议驱动，把一个平台队列/任务当成一个 run 来监管，凭据从 secretsPath 读。',
      })
    },
  }))

  register(defineTool({
    name: 'fleet_dispatch',
    description: '把客户需求拆给一个或多个执行型 agent 并行去干，立刻返回 runId；用 fleet_status 看进度、fleet_result 取结果。每个 worker 会收到一份含总目标、自己的分工、工作纪律和交付格式的简报，工作在 cwd 里独立进行。这是"客户说方向 → dsh 指挥下面的 agent 干活"的主入口。',
    parameters: {
      goal: {
        type: 'string',
        required: true,
        description: '客户的需求原文（不要改写压缩成一句口号；workers 需要原话）。',
      },
      agents: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: '要派的 agent id 列表（见 fleet_agents）。并行派多个时，每个 agent 拿自己那份 assignment。',
      },
      assignments: {
        type: 'array',
        items: { type: 'string' },
        description: '与 agents 一一对应的分工描述；省略则每个 agent 都拿完整 goal。',
      },
      context: {
        type: 'string',
        description: '给所有 worker 的补充上下文：目标范围、凭据位置、已知结论、禁区。',
      },
      cwd: {
        type: 'string',
        description: 'worker 的工作目录，默认当前会话工作区。',
      },
      timeoutSec: {
        type: 'number',
        description: '单个 worker 的截止时间（秒），默认取该 agent/插件配置。超时会被强制终止。',
      },
      waitSec: {
        type: 'number',
        description: `派完后在本次调用里等待多少秒再返回（0-${MAX_WAIT_SEC}）。短任务给 60 就很省事；<0 表示只派不等。`,
      },
      label: {
        type: 'string',
        description: '这一步的简短标签，用于人名化这场行动的 runId。',
      },
    },
    output: output('已派发的 runId 列表、当前队列/槽位概况，以及（等待后）各 run 的状态'),
    timeoutMs: 210_000,
    async execute(args, exec) {
      const cwd = args.cwd && args.cwd.trim() !== '' ? args.cwd : cwdOf(exec)
      const rows = []
      const errors = []
      args.agents.forEach((id, index) => {
        const agent = agents.get(id)
        if (!agent) {
          errors.push({ agent: id, error: `未知 agent，可用：${[...agents.keys()].join(', ')}` })
          return
        }
        if (agent.adapter === 'service') {
          errors.push({ agent: id, error: `这个 agent 只是说明性条目（${agent.notes}）` })
          return
        }
        if (!agent.available) {
          errors.push({
            agent: id,
            error: agent.driver
              ? `远端适配器没就绪：驱动 ${agent.driver} 不存在或未配置 endpoint`
              : `命令不可用：${agent.command} 不在 PATH 中`,
          })
          return
        }
        const assignment = args.assignments?.[index] ?? ''
        const timeoutSec = args.timeoutSec ?? agent.timeoutSec ?? fleet.defaultTimeoutSec
        try {
          const view = fleet.dispatch({
            agentId: agent.id,
            goal: args.goal,
            assignment,
            brief: (runId) => buildBrief({
              agent,
              runId,
              goal: args.goal,
              assignment,
              cwd,
              timeoutSec,
              context: args.context,
            }),
            cwd,
            timeoutSec: args.timeoutSec ?? agent.timeoutSec,
            label: args.label ?? agent.id,
          })
          rows.push(view)
        } catch (error) {
          errors.push({ agent: id, error: error instanceof Error ? error.message : String(error) })
        }
      })

      const waitSec = Math.min(MAX_WAIT_SEC, Math.max(0, args.waitSec ?? 0))
      const ids = rows.map(row => row.runId)
      let settled = false
      if (waitSec > 0 && ids.length > 0) settled = await fleet.waitFor(ids, waitSec * 1000)

      logger?.info?.(`dsh-fleet: dispatch ${ids.length} 个 worker, runIds=[${ids.join(',')}]`)
      return clean({
        dispatched: rows.map(row => ({ runId: row.runId, agent: row.agent, state: row.state, logPath: row.logPath })),
        errors,
        fleet: fleet.summary(),
        waitedSec: waitSec,
        allFinished: settled,
        runs: settled ? ids.map(id => fleet.view(id, 12)) : [],
        next: settled ? '全部结束：用 fleet_result 读每个 worker 的交付，再综合成给客户的结论。' : '任务在后台跑：用 fleet_status 轮询（可 waitSec 内联等待），完成后用 fleet_result 取结论。',
      })
    },
  }))

  register(defineTool({
    name: 'fleet_status',
    description: '查看军团进度：某个 runId 或全部 run 的状态、耗时、退出码、日志尾部。waitSec 可以让这次调用在原地等一会儿，用来轮询比 sleep 省步骤。',
    parameters: {
      runId: {
        type: 'string',
        description: '要看的 runId；省略或 "all" 返回最近的 run 列表。',
      },
      waitSec: {
        type: 'number',
        description: `在内联等待最多多少秒直到这些 run 全部结束（0-${MAX_WAIT_SEC}，默认 0 立即返回）。`,
      },
      tailLines: {
        type: 'number',
        description: '每个 run 附带的日志尾部行数（默认 15，0 表示不带）。',
      },
      limit: {
        type: 'number',
        description: 'runId=all 时返回多少条（默认 20）。',
      },
    },
    output: output('run 状态快照（含日志尾部）与队列概况'),
    timeoutMs: 210_000,
    async execute(args) {
      const waitSec = Math.min(MAX_WAIT_SEC, Math.max(0, args.waitSec ?? 0))
      const tailLines = args.tailLines ?? 15
      const target = args.runId && args.runId !== 'all' ? args.runId : null
      if (target) {
        const run = fleet.runs.get(target)
        if (!run) return clean({ error: `没有这个 runId: ${target}`, known: fleet.list(10).map(view => view.runId) })
        if (waitSec > 0) await fleet.waitFor([target], waitSec * 1000)
        return clean({ run: fleet.view(target, tailLines), fleet: fleet.summary() })
      }
      const ids = fleet.list(args.limit ?? 20).map(view => view.runId)
      if (waitSec > 0 && ids.length > 0) await fleet.waitFor(ids, waitSec * 1000)
      const views = ids.map(id => fleet.view(id, tailLines))
      const suspect = views
        .filter(view => (view.suspect ?? []).length > 0)
        .map(view => ({ runId: view.runId, agent: view.agent, why: view.suspect }))
      return clean({
        runs: views,
        fleet: fleet.summary(),
        suspect,
        hint: suspect.length > 0
          ? 'suspect 里的 run 进程正常退出但输出自报失败：它们不算完成，先看为什么再决定重派或换 agent。'
          : undefined,
      })
    },
  }))

  register(defineTool({
    name: 'fleet_result',
    description: '取回一个 worker 的交付：状态、退出码、简报路径、日志尾部，以及日志里的完整正文（默认截断到 60k 字符）。任务还没结束时会明确告诉你当前状态和已有的部分输出。',
    parameters: {
      runId: { type: 'string', required: true, description: '要取结果的 runId。' },
      tailLines: { type: 'number', description: '日志尾部行数，默认 80。' },
      full: { type: 'boolean', description: 'true 时尽量给完整日志正文（仍受单条结果上限约束）。' },
    },
    output: output('单个 worker 的结果：状态、证据路径、日志正文'),
    timeoutMs: 60_000,
    async execute(args) {
      const run = fleet.runs.get(args.runId)
      if (!run) return clean({ error: `没有这个 runId: ${args.runId}`, known: fleet.list(10).map(view => view.runId) })
      const lines = args.tailLines ?? (args.full ? 4000 : 80)
      let body = ''
      try {
        body = readFileSync(run.logPath, 'utf8')
      } catch {
        body = ''
      }
      return clean({
        run: fleet.view(args.runId, lines),
        finished: ['done', 'failed', 'timeout', 'stopped', 'lost'].includes(run.state),
        output: clip(body),
        outputBytes: body.length,
        briefPath: run.briefPath,
        logPath: run.logPath,
        warning: (run.suspect ?? []).length > 0
          ? `exit 0 不等于成功：输出里有失败特征（${run.suspect.join('；')}）。不要把它当成交付；先修 agent 侧配置，或换一个 agent 重派。`
          : undefined,
        hint: (run.suspect ?? []).length > 0
          ? '这个 worker 的进程正常退出，但它自己说没干成；把原因写进对客户的汇报，别把它的自述抄成结论。'
          : run.state === 'done'
            ? '用日志里的「## 结论 / ## 证据 / ## 未完成」段作为对客户的汇报素材；证据不足时回读 briefPath 与 logPath。'
            : '未结束时先看 fleet_status；确实要放弃就用 fleet_stop。',
      })
    },
  }))

  register(defineTool({
    name: 'fleet_stop',
    description: '停掉一个 run 或全部 run（先 SIGTERM，8 秒后 SIGKILL）。用于任务跑偏、超预算或用户取消时；已结束的 run 不受影响。',
    parameters: {
      runId: { type: 'string', required: true, description: 'runId，或 "all" 停掉所有未结束的 run。' },
      reason: { type: 'string', description: '停止原因，写进 run 记录便于事后复盘。' },
    },
    output: output('被停止的 runId 列表'),
    timeoutMs: 30_000,
    async execute(args) {
      const result = fleet.stop(args.runId)
      for (const id of result.stopped) {
        const run = fleet.runs.get(id)
        if (run && args.reason) run.note = `停止原因：${args.reason}`
      }
      logger?.info?.(`dsh-fleet: stop ${args.runId} → ${result.stopped.length} 个`)
      return clean({ stopped: result.stopped, fleet: fleet.summary() })
    },
  }))

  return disposed
}
