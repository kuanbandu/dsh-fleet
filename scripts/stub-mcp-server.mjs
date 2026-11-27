#!/usr/bin/env node
/**
 * Stub platform for the self-test: one HTTP server that speaks both adapter
 * protocols, so the MCP and HTTP drivers are exercised end to end without
 * touching a real pentest platform.
 *
 *   POST /mcp            JSON-RPC: initialize, tools/call batch_task_*
 *   POST /api/auth/login → {token}
 *   POST /api/tasks      → {id: 7, status: 'running'}
 *   GET  /api/tasks/7    → running … completed after N polls
 *   GET  /api/tasks/7/outcome → {summary}
 *
 * Env: STUB_POLLS   how many polls before "completed" (default 2)
 *      STUB_FAIL    '1' to always report failure
 *      STUB_LOG     append every request line to this file
 * Prints `PORT=<n>` on stdout once listening.
 */

import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const pollsBeforeDone = Number(process.env.STUB_POLLS ?? 2)
const fail = process.env.STUB_FAIL === '1'
const logFile = process.env.STUB_LOG ?? ''

let queueState = 'pending'
let polls = 0
let restPolls = 0

/** Append one diagnostic line, if the caller asked for a log. */
function note(line) {
  if (!logFile) return
  try {
    appendFileSync(logFile, line + '\n', 'utf8')
  } catch {
    /* diagnostics only */
  }
}

/** Read and parse a JSON request body. */
async function body(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

/** Send one JSON response. */
function send(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** MCP tool result wrapper. */
function toolResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

/** Queue snapshot in the shape a batch-queue MCP platform returns. */
function queuePayload() {
  return {
    id: 'q-stub',
    status: queueState,
    currentIndex: 0,
    tasks: [{ id: 't1', message: 'stub task', status: queueState === 'completed' ? 'completed' : queueState === 'failed' ? 'failed' : 'running' }],
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://stub.invalid')
  note(`${req.method} ${url.pathname}`)

  if (url.pathname === '/mcp' && req.method === 'POST') {
    const message = await body(req)
    const { id, method, params } = message
    if (method === 'initialize') {
      send(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub-mcp', version: '0.0.1' } } })
      return
    }
    if (method === 'tools/call') {
      const name = params?.name
      const args = params?.arguments ?? {}
      if (name === 'batch_task_create') {
        if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
          send(res, 200, { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'tasks 为空' }] } })
          return
        }
        queueState = 'pending'
        polls = 0
        send(res, 200, { jsonrpc: '2.0', id, result: toolResult({ queue_id: 'q-stub', queue: queuePayload() }) })
        return
      }
      if (name === 'batch_task_start') {
        queueState = 'running'
        send(res, 200, { jsonrpc: '2.0', id, result: toolResult(queuePayload()) })
        return
      }
      if (name === 'batch_task_get') {
        polls += 1
        if (polls >= pollsBeforeDone) queueState = fail ? 'failed' : 'completed'
        send(res, 200, { jsonrpc: '2.0', id, result: toolResult(queuePayload()) })
        return
      }
      send(res, 200, { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `未知工具 ${name}` }] } })
      return
    }
    send(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法 ${method}` } })
    return
  }

  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const credentials = await body(req)
    if (credentials.username === 'stub-user' && credentials.password === 'stub-password') {
      send(res, 200, { token: 'stub-jwt' })
      return
    }
    send(res, 401, { error: 'Incorrect username or password' })
    return
  }

  if (url.pathname === '/api/tasks' && req.method === 'POST') {
    if (req.headers.authorization !== 'Bearer stub-jwt') {
      send(res, 401, { error: 'unauthorized' })
      return
    }
    const payload = await body(req)
    note(`task goal: ${String(payload.goal ?? '').slice(0, 60)}`)
    restPolls = 0
    send(res, 200, { id: 7, status: 'running' })
    return
  }

  if (url.pathname === '/api/tasks/7' && req.method === 'GET') {
    restPolls += 1
    const status = restPolls >= pollsBeforeDone ? (fail ? 'failed' : 'completed') : 'running'
    send(res, 200, { id: 7, status })
    return
  }

  if (url.pathname === '/api/tasks/7/outcome' && req.method === 'GET') {
    send(res, 200, { summary: 'stub outcome', findings: [] })
    return
  }

  send(res, 404, { error: 'not found' })
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write('PORT=' + String(address.port) + '\n')
})

process.on('SIGTERM', () => process.exit(0))
