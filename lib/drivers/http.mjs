#!/usr/bin/env node
/**
 * dsh-fleet · HTTP adapter driver.
 *
 * Same contract as the MCP driver: one supervised child process that turns a
 * REST platform's "create one job, wait for it" into one fleet run, so the
 * runner keeps its queue, deadline, kill and log guarantees.
 *
 * Flow:  [login] → POST create → GET poll until done/failed → [GET outcome]
 *
 * Everything endpoint-specific is FLEET_REMOTE_SPEC (paths, JSON templates,
 * which status string means done, where the id lives in the response).
 *
 * Env in:  FLEET_BRIEF, FLEET_RUN_ID, FLEET_TIMEOUT_SEC, FLEET_REMOTE_SPEC, FLEET_DATA_DIR
 * Exit:    0 finished, 2 platform reported failure, 3 deadline, 4 protocol error
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const EXIT = { ok: 0, failed: 2, timeout: 3, protocol: 4 }

/** Progress line on the run log. */
function say(message) {
  console.log(`[http] ${message}`)
}

/** Resolve `@section.key` secrets and `{placeholders}` in a template. */
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

/** Read `a.b.0.c` out of a parsed response. */
function pick(value, path) {
  if (!path) return undefined
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined
    return acc[/^\d+$/.test(key) ? Number(key) : key]
  }, value)
}

/** Load the optional secrets file. */
function loadSecrets(dataDir) {
  if (!dataDir) return {}
  try {
    return JSON.parse(readFileSync(join(dataDir, 'secrets.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** One HTTP request with JSON in/out; non-2xx throws with the server's message. */
async function request(connection, method, path, options = {}) {
  const url = `${connection.endpoint.replace(/\/+$/, '')}${path}`
  const headers = { accept: 'application/json', ...connection.headers }
  let body
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.json)
  }
  const response = await fetch(url, { method, headers, body })
  const text = await response.text()
  let payload
  try {
    payload = text.trim() === '' ? {} : JSON.parse(text)
  } catch {
    payload = { text }
  }
  if (!response.ok) {
    const message = payload?.error ?? payload?.message ?? payload?.text ?? text.slice(0, 200)
    throw new Error(`${method} ${path} → HTTP ${response.status}: ${String(message).slice(0, 300)}`)
  }
  return payload
}

/** Entry point. */
async function main() {
  const spec = JSON.parse(process.env.FLEET_REMOTE_SPEC ?? '{}')
  const briefPath = process.env.FLEET_BRIEF ?? ''
  const runId = process.env.FLEET_RUN_ID ?? '(no run id)'
  const deadlineMs = Math.max(30, Number(process.env.FLEET_TIMEOUT_SEC ?? spec.deadlineSec ?? 1800)) * 1000

  let brief = ''
  try {
    brief = readFileSync(briefPath, 'utf8')
  } catch {
    throw new Error(`读不到简报: ${briefPath}`)
  }
  const secrets = loadSecrets(process.env.FLEET_DATA_DIR ?? '')
  const vars = { brief, briefPath, runId }
  const connection = {
    endpoint: spec.endpoint,
    headers: render(spec.headers ?? {}, { secrets, vars }),
  }
  if (!connection.endpoint) throw new Error('spec.endpoint 未配置')
  say(`连接 ${connection.endpoint} (run ${runId})`)

  if (spec.login?.path) {
    const body = render(spec.login.body ?? {}, { secrets, vars })
    const payload = await request(connection, spec.login.method ?? 'POST', spec.login.path, { json: body })
    const token = pick(payload, spec.login.tokenPath ?? 'token')
    if (typeof token !== 'string' || token === '') throw new Error(`登录成功但没拿到 token: ${JSON.stringify(payload).slice(0, 200)}`)
    connection.headers = {
      ...connection.headers,
      [spec.login.header ?? 'Authorization']: `${spec.login.prefix ?? 'Bearer '}${token}`,
    }
    say('登录成功')
  }

  const createBody = render(spec.create.body ?? {}, { secrets, vars })
  const created = await request(connection, spec.create.method ?? 'POST', spec.create.path, { json: createBody })
  const jobId = pick(created, spec.create.idPath ?? 'id')
  if (jobId === undefined || jobId === null || jobId === '') throw new Error(`创建成功但没找到任务 id: ${JSON.stringify(created).slice(0, 300)}`)
  vars.id = String(jobId)
  say(`任务 #${vars.id}`)

  const poll = spec.poll ?? {}
  const intervalMs = Math.max(1000, Number(poll.intervalSec ?? 10) * 1000)
  const done = new Set(poll.doneStatuses ?? ['completed', 'done', 'finished', 'success'])
  const fail = new Set(poll.failStatuses ?? ['failed', 'cancelled', 'error', 'timeout'])
  const statePath = poll.statePath ?? 'status'
  const startedAt = Date.now()
  let last = created

  while (Date.now() - startedAt < deadlineMs) {
    await new Promise(resolve => setTimeout(resolve, intervalMs))
    last = await request(connection, poll.method ?? 'GET', render(poll.path ?? '/{id}', { secrets, vars }), {})
    const state = String(pick(last, statePath) ?? '')
    say(`轮询 ${Math.round((Date.now() - startedAt) / 1000)}s: ${statePath}=${state || '?'}`)
    if (fail.has(state)) {
      console.log('## 结论')
      console.log(`平台报告任务 #${vars.id} 失败（${statePath}=${state}）。`)
      console.log('## 证据 / 产出')
      console.log(JSON.stringify(last).slice(0, 3000))
      console.log('## 未完成 / 风险')
      console.log('需要人看平台侧日志决定是否重跑。')
      return EXIT.failed
    }
    if (done.has(state)) {
      let outcome = null
      if (spec.outcome?.path) {
        try {
          outcome = await request(connection, 'GET', render(spec.outcome.path, { secrets, vars }), {})
        } catch (error) {
          say(`取结果失败（不影响完成判定）：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      console.log('## 结论')
      console.log(`平台任务 #${vars.id} 完成（${statePath}=${state}）。`)
      console.log('## 证据 / 产出')
      console.log(`- 平台任务：${vars.id}（可在 ${connection.endpoint} 复查）`)
      console.log('--- 任务状态 ---')
      console.log(JSON.stringify(last, null, 2).slice(0, 4000))
      if (outcome) {
        console.log('--- 任务结果 ---')
        console.log(JSON.stringify(outcome, null, 2).slice(0, 6000))
      }
      console.log('## 未完成 / 风险')
      console.log('无（平台自报完成）')
      return EXIT.ok
    }
  }

  console.log('## 结论')
  console.log(`超过 ${Math.round(deadlineMs / 1000)}s 仍未完成，driver 主动退出；平台任务 #${vars.id} 可能还在跑。`)
  console.log('## 证据 / 产出')
  console.log(JSON.stringify(last).slice(0, 2000))
  console.log('## 未完成 / 风险')
  console.log(`需要人去平台处理任务 #${vars.id}。`)
  return EXIT.timeout
}

main()
  .then((code) => { process.exit(code) })
  .catch((error) => {
    console.log('## 结论')
    console.log(`driver 失败：${error instanceof Error ? error.message : String(error)}`)
    console.log('## 未完成 / 风险')
    console.log('平台侧是否已经建了任务需要人工确认。')
    process.exit(EXIT.protocol)
  })
