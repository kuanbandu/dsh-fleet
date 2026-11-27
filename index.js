/**
 * dsh-fleet — turn the Harness into a commander with a legion behind it.
 *
 * The model stays the commander: the user types a client's direction into the
 * chat, the model splits it, and these tools hand each part to an external
 * executor (a CLI process, or a platform driven over MCP / HTTP) running as a
 * supervised worker. There is no separate commander process to build: the dsh
 * session *is* the commander, so what remains is the pool of workers plus the
 * watchdog that keeps them honest (deadlines, retries, on-disk state).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildAgentTable } from './lib/agents.js'
import { createFileLogger } from './lib/log.js'
import { Fleet } from './lib/runner.js'
import { registerFleetTools } from './lib/tools.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-fleet'

/** The plugin needs the tool registry; everything else is optional. */
export const inject = ['tools']

/**
 * Plugin configuration (set in `cordis.patch.yml`).
 *
 * @typedef {object} FleetPluginConfig
 * @property {string} [dataDir] where `runs/` lives (default `$DSH_HOME/plugin-data/dsh-fleet`)
 * @property {number} [maxConcurrent] parallel worker slots
 * @property {number} [timeoutSec] default deadline for one worker
 * @property {number} [retryLimit] automatic retries after a failed attempt
 * @property {number} [pollMs] watchdog tick
 * @property {number} [keepRuns] finished run directories kept under `runs/`
 * @property {boolean} [systemPrompt] inject the capability section into the prompt
 * @property {Array<object>} [agents] agent rows: same `id` overrides a shipped entry, a new `id` adds one
 * @property {string[]} [disabled] shipped agent ids to drop
 */

/**
 * Resolve the plugin config into what the fleet constructor and tools expect.
 * Hand-rolled on purpose: one bad row should produce a readable error naming it,
 * not an opaque schema rejection at activation time.
 *
 * @param {FleetPluginConfig} [config] raw row config
 * @returns {{dataDir: string, maxConcurrent: number, timeoutSec: number, retryLimit: number, pollMs: number, systemPrompt: boolean, agents: any[], disabled: string[]}} resolved config
 */
export function normalizeConfig(config = {}) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const agents = config.agents ?? []
  if (!Array.isArray(agents)) throw new Error('dsh-fleet: config.agents 必须是数组')
  agents.forEach((row, index) => {
    if (!row || typeof row !== 'object') throw new Error(`dsh-fleet: config.agents[${index}] 必须是对象`)
    if (typeof row.id !== 'string' || row.id.trim() === '') throw new Error(`dsh-fleet: config.agents[${index}].id 必须是非空字符串`)
    if (row.adapter !== undefined && !['cli', 'exec', 'service'].includes(row.adapter)) {
      throw new Error(`dsh-fleet: config.agents[${index}].adapter 只能是 cli / exec / service`)
    }
    if (['cli', 'exec'].includes(row.adapter ?? 'cli') && row.command !== undefined && typeof row.command !== 'string') {
      throw new Error(`dsh-fleet: config.agents[${index}].command 必须是字符串`)
    }
    if (row.args !== undefined && !Array.isArray(row.args)) throw new Error(`dsh-fleet: config.agents[${index}].args 必须是数组`)
  })
  return {
    dataDir: config.dataDir ?? join(home, 'plugin-data', 'dsh-fleet'),
    maxConcurrent: config.maxConcurrent ?? 4,
    timeoutSec: config.timeoutSec ?? 1800,
    retryLimit: config.retryLimit ?? 0,
    pollMs: config.pollMs ?? 1500,
    keepRuns: config.keepRuns ?? 50,
    systemPrompt: config.systemPrompt !== false,
    agents,
    disabled: Array.isArray(config.disabled) ? config.disabled : [],
  }
}

/**
 * Activate the plugin: one fleet, five tools, one prompt section.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx host context
 * @param {FleetPluginConfig} [config] plugin row config
 */
export function apply(ctx, config = {}) {
  const resolved = normalizeConfig(config)
  const agents = buildAgentTable(resolved.agents, resolved.disabled)

  // Ops log: a real file next to the runs, mirrored to the Host logger when it
  // lands somewhere visible. This profile's ctx.logger does not.
  const sink = createFileLogger({ dir: resolved.dataDir })
  const logger = {
    path: sink.path,
    info: (message) => {
      sink.info(message)
      ctx.logger?.info?.(message)
    },
    warn: (message) => {
      sink.warn(message)
      ctx.logger?.warn?.(message)
    },
    error: (message) => {
      sink.error(message)
      ctx.logger?.error?.(message)
    },
  }

  const fleet = new Fleet({
    dataDir: resolved.dataDir,
    agents,
    maxConcurrent: resolved.maxConcurrent,
    defaultTimeoutSec: resolved.timeoutSec,
    retryLimit: resolved.retryLimit,
    pollMs: resolved.pollMs,
    keepRuns: resolved.keepRuns,
    logger,
  })
  fleet.logPath = sink.path
  fleet.secretsPath = join(resolved.dataDir, 'secrets.json')

  const runnable = [...agents.values()].filter(agent => agent.adapter !== 'service' && agent.available).map(agent => agent.id)
  const remote = [...agents.values()].filter(agent => agent.driver).map(agent => `${agent.id}(${agent.adapter})`)
  logger.info(`已加载 ${agents.size} 个 agent；可派：${runnable.join(', ') || '无'}${remote.length ? `；远端适配器：${remote.join(', ')}` : ''}`)
  logger.info(`运行目录 ${fleet.runsDir}；日志 ${sink.path}；凭据 ${fleet.secretsPath}（可选）`)

  ctx.effect(() => {
    const disposers = registerFleetTools({ tools: ctx.tools }, fleet, agents, logger)
    return () => {
      for (const dispose of disposers) dispose()
      fleet.dispose()
    }
  }, 'dsh-fleet: tools')

  if (resolved.systemPrompt) {
    ctx.inject(['systemPrompt'], promptCtx => {
      promptCtx.effect(() => promptCtx.systemPrompt.section({
        name: 'dsh-fleet',
        order: 61,
        text: [
          '## 军团（外部 agent 调度）',
          'fleet_* 工具可以把活派给外部执行体（命令行 agent、或协议驱动的平台）在后台并行干活：',
          'fleet_agents（花名册/探活）→ fleet_dispatch（派活，返回 runId）→ fleet_status（进度，可内联等待）→ fleet_result（取交付）→ fleet_stop（取消）。',
          'cli 型直接跑命令行；mcp/http 型由协议驱动把一个平台队列/任务当成一个 run 来监管，凭据从 secrets.json 读。能派谁一律以 fleet_agents 的实际花名册为准。',
          '规则：',
          '- 用户给出方向/目标而任务规模明显超过一轮对话时，先 fleet_agents 确认能用的 agent，再拆成互不重叠的分工并行派出去；小任务自己做完更快，不要为了派而派。',
          '- goal 传用户原话，不要压缩成口号；拆解放在 assignments 里，每个 worker 一份。',
          '- 汇报前必须 fleet_result 读回真实输出：worker 的自述不等于证据，日志里没有的结论不要写进最终答复。',
          '- 交付给客户的是综合后的结论（结论/证据/未完成），不要把 worker 日志整段贴出来；证据路径可以给。',
          '- 宿主走代理时，外部请求可能拿到伪造的失败；简报里要求直连（--noproxy 或清 HTTP(S)_PROXY），见到“整片不可达”先怀疑代理。',
          '- 原生下拉、富文本编辑器 iframe、系统文件上传这三类交互，点击/按键驱动不可靠；不要硬试，改为导出材料＋交给人工确认。',
        ].join('\n'),
      }), 'dsh-fleet: system prompt')
    })
  }
}

/** Re-exported for tests and diagnostics. */
export { Fleet }
