#!/usr/bin/env node
/**
 * dsh-fleet · MCP adapter driver.
 *
 * Runs as one supervised child process, exactly like a CLI worker, so the
 * runner needs no knowledge of remote platforms: queue, slots, deadline,
 * SIGTERM, log capture, and the suspect scan all keep working unchanged.
 *
 * The driver speaks JSON-RPC over HTTP to an MCP server, and turns one platform
 * "batch task queue" into one fleet run:
 *
 *   initialize → create(queue with the brief as its single task)
 *              → start(queue)              [optional]
 *              → poll(get) until the queue or its tasks finish
 *
 * Everything platform-specific (tool names, argument templates, which status
 * means done) comes from FLEET_REMOTE_SPEC, so a new platform is config.
 *
 * Env in:  FLEET_BRIEF (brief.md path), FLEET_RUN_ID, FLEET_TIMEOUT_SEC,
 *          FLEET_REMOTE_SPEC (JSON), FLEET_DATA_DIR (for secrets.json)
 * Exit:    0 finished, 2 platform reported failure, 3 deadline, 4 protocol error
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const EXIT = { ok: 0, failed: 2, timeout: 3, protocol: 4 }

/** Human-readable progress line on the run log. */
function say(message) {
  console.log(`[mcp] ${message}`)
}

/** Resolve `@section.key` references (secrets) and `{placeholders}` in a template. */
function render(value, context) {
  if (typeof value === 'string') {
    if (value.startsWith('@')) {
      const [section, key] = value.slice(1).split('.')
      const secret = context.secrets?.[section]?.[key]
      if (secret === undefined) throw new Error(`secrets.json 缺少 ${section}.${key}`)
      return secret
    }
    return value.replace(/\{(\w+)\}/g, (whole, name) => (name in context.vars ? String(context.vars[name]) : whole))
  }
  if (Array.isArray(value)) return value.map(item => render(item, context))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = render(item, context)
    return out
  }
  return value
}

/** Load the optional secrets file; absent file is fine. */
function loadSecrets(dataDir, identity) {
  if (!dataDir || !identity) return {}
  try {
    const text = readFileSync(join(dataDir, 'secrets.json'), 'utf8')
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** POST one JSON-RPC message and return the parsed response. */
async function rpc(connection, id, method, params) {
  const response = await fetch(connection.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...connection.headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} (${method})`)
  const text = await response.text()
  const payload = parseSseOrJson(text)
  if (payload?.error) throw new Error(`${method} → ${JSON.stringify(payload.error).slice(0, 300)}`)
  return payload?.result
}

/** MCP servers answer either JSON directly or a one-event SSE stream. */
function parseSseOrJson(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  const dataLine = trimmed.split('\n').find(line => line.startsWith('data:'))
  if (!dataLine) throw new Error(`无法解析的 MCP 响应: ${trimmed.slice(0, 200)}`)
  return JSON.parse(dataLine.slice(5).trim())
}

/** MCP tool results wrap their payload in content[].text; parse JSON when possible. */
function toolPayload(result) {
  const text = (result?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

/** Call one tool and return its parsed payload. */
async function callTool(connection, counter, name, args) {
  say(`tools/call ${name} ${JSON.stringify(args).slice(0, 200)}`)
  const result = await rpc(connection, counter.next(), 'tools/call', { name, arguments: args })
  if (result?.isError) throw new Error(`${name} 返回错误: ${JSON.stringify(toolPayload(result)).slice(0, 400)}`)
  return toolPayload(result)
}

/** Find the queue id in whatever shape the platform returned. */
function findQueueId(payload, configuredPath) {
  const pick = (object, path) => path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), object)
  if (configuredPath) {
    const value = pick(payload, configuredPath)
    if (typeof value === 'string' && value !== '') return value
  }
  if (typeof payload.queue_id === 'string') return payload.queue_id
  if (typeof payload.queue?.id === 'string') return payload.queue.id
  if (typeof payload.id === 'string') return payload.id
  return undefined
}

/** Queue status across the two shapes seen in the wild. */
function readStatus(payload) {
  return typeof payload?.queue?.status === 'string' ? payload.queue.status : payload?.status
}

/** One-line summary of a queue payload, for the run log. */
function summarize(payload) {
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : []
  const counts = {}
  for (const task of tasks) counts[task?.status ?? '?'] = (counts[task?.status ?? '?'] ?? 0) + 1
  return `status=${readStatus(payload) ?? '?'} tasks=${tasks.length}${Object.keys(counts).length ? ` (${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(', ')})` : ''}`
}

/** Entry point. */
async function main() {
  const spec = JSON.parse(process.env.FLEET_REMOTE_SPEC ?? '{}')
  const briefPath = process.env.FLEET_BRIEF ?? ''
  const runId = process.env.FLEET_RUN_ID ?? '(no run id)'
  const deadlineMs = Math.max(30, Number(process.env.FLEET_TIMEOUT_SEC ?? spec.deadlineSec ?? 1800)) * 1000
  const dataDir = process.env.FLEET_DATA_DIR ?? ''

  let brief = ''
  try {
    brief = readFileSync(briefPath, 'utf8')
  } catch {
    throw new Error(`读不到简报: ${briefPath}`)
  }

  const secrets = loadSecrets(dataDir, spec.identity)
  const vars = { brief, briefPath, runId }
  const connection = {
    endpoint: spec.endpoint,
    headers: render(spec.headers ?? {}, { secrets, vars }),
  }
  if (!connection.endpoint) throw new Error('spec.endpoint 未配置')
  say(`连接 ${connection.endpoint} (run ${runId})`)

  const counter = { value: 0, next() { this.value += 1; return this.value } }
  const init = await rpc(connection, counter.next(), 'initialize', {
    protocolVersion: spec.protocolVersion ?? '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dsh-fleet', version: '0.2.0' },
  })
  say(`已握手：${init?.serverInfo?.name ?? '?'} ${init?.serverInfo?.version ?? ''}`)

  const createArgs = render(spec.create.args ?? {}, { secrets, vars })
  if (spec.create.toText !== undefined) createArgs[spec.create.toText] = [brief]
  const created = await callTool(connection, counter, spec.create.tool, createArgs)
  const queueId = findQueueId(created, spec.create.queueIdPath)
  if (!queueId) throw new Error(`创建成功但没找到队列 id: ${JSON.stringify(created).slice(0, 300)}`)
  say(`队列 ${queueId}`)
  vars.queueId = queueId

  if (spec.start?.tool) {
    const started = await callTool(connection, counter, spec.start.tool, render({ ...spec.start.args, queue_id: '{queueId}' }, { secrets, vars }))
    say(`已启动：${summarize(started) || JSON.stringify(started).slice(0, 160)}`)
  }

  const poll = spec.poll ?? {}
  const intervalMs = Math.max(1000, Number(poll.intervalSec ?? 5) * 1000)
  const doneQueue = new Set(poll.doneQueueStatuses ?? ['completed', 'completed_with_errors', 'done'])
  const failQueue = new Set(poll.failQueueStatuses ?? ['failed', 'cancelled', 'error'])
  const doneTask = new Set(poll.doneTaskStatuses ?? ['completed', 'done'])
  const failTask = new Set(poll.failTaskStatuses ?? ['failed', 'cancelled', 'error'])
  const startedAt = Date.now()
  let lastPayload = created

  while (Date.now() - startedAt < deadlineMs) {
    await new Promise(resolve => setTimeout(resolve, intervalMs))
    lastPayload = await callTool(connection, counter, poll.tool ?? spec.create.tool, render({ ...(poll.args ?? {}), queue_id: '{queueId}' }, { secrets, vars }))
    const status = readStatus(lastPayload)
    const tasks = Array.isArray(lastPayload?.tasks) ? lastPayload.tasks : []
    say(`轮询 ${Math.round((Date.now() - startedAt) / 1000)}s: ${summarize(lastPayload)}`)

    const queueFailed = status !== undefined && failQueue.has(status)
    const queueDone = status !== undefined && doneQueue.has(status)
    const taskFailed = tasks.some(task => failTask.has(task?.status))
    const tasksSettled = tasks.length > 0 && tasks.every(task => doneTask.has(task?.status) || failTask.has(task?.status))

    if (queueFailed || taskFailed) {
      console.log('## 结论')
      console.log(`平台报告队列失败（status=${status ?? '?'}），run ${runId} 未完成。`)
      console.log('## 证据 / 产出')
      console.log(`- 队列：${queueId}`)
      console.log(`- 平台原始返回：${JSON.stringify(lastPayload).slice(0, 2000)}`)
      console.log('## 未完成 / 风险')
      console.log('这次没有把队列跑完；需要人看一眼平台任务面板再决定是否重跑。')
      return EXIT.failed
    }
    if (queueDone || tasksSettled) {
      console.log('## 结论')
      console.log(`队列 ${queueId} 已完成（status=${status ?? '?'}），子任务 ${tasks.length} 条。`)
      console.log('## 证据 / 产出')
      console.log(`- 队列：${queueId}（平台任务管理里可复查）`)
      for (const task of tasks) {
        console.log(`- 子任务 ${task.id ?? '?'}: ${task.status ?? '?'} · ${String(task.message ?? '').slice(0, 120)}`)
        for (const key of ['result', 'output', 'summary', 'error']) {
          if (task?.[key]) console.log(`  ${key}: ${String(task[key]).slice(0, 600)}`)
        }
      }
      console.log('## 未完成 / 风险')
      console.log('无（平台自报完成；深挖细节请回平台任务面板看执行记录）')
      console.log('--- 平台原始返回 ---')
      console.log(JSON.stringify(lastPayload, null, 2).slice(0, 8000))
      return EXIT.ok
    }
  }

  console.log('## 结论')
  console.log(`超过 ${Math.round(deadlineMs / 1000)}s 仍未完成，driver 主动退出；队列 ${queueId} 可能还在平台上跑。`)
  console.log('## 证据 / 产出')
  console.log(`- 最后一次轮询：${JSON.stringify(lastPayload).slice(0, 1500)}`)
  console.log('## 未完成 / 风险')
  console.log(`需要人去平台暂停/删除队列 ${queueId}，否则它会继续消耗算力。`)
  return EXIT.timeout
}

main()
  .then((code) => { process.exit(code) })
  .catch((error) => {
    console.log('## 结论')
    console.log(`driver 失败：${error instanceof Error ? error.message : String(error)}`)
    console.log('## 未完成 / 风险')
    console.log('平台侧是否已经建了队列需要人工确认。')
    process.exit(EXIT.protocol)
  })
