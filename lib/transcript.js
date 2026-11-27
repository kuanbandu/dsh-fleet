/**
 * Read the agent's own final words out of a platform transcript.
 *
 * Some platforms answer `/tasks/{id}/outcome` with statistics only (tool calls,
 * tokens, findings) while the actual conclusion lives in a JSONL transcript on
 * disk — JSONL, one message per line: `{ type, message: { role, content:[{type,text}] } }`.
 * A fleet run that reports "done" without that text is not a deliverable, so the
 * HTTP driver pulls the last assistant message and prints it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Cap on how much assistant text one transcript read returns. */
const DEFAULT_MAX_CHARS = 12_000

/**
 * Turn one JSONL transcript into `[{role, text}]` message list.
 * @param {string} text raw file contents
 * @returns {Array<{role: string, text: string}>} messages with text content
 */
export function parseTranscript(text) {
  const messages = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const message = entry?.message
    if (!message || typeof message.role !== 'string') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const parts = blocks
      .filter(block => block && typeof block === 'object' && (block.type === 'text' || typeof block.text === 'string'))
      .map(block => (typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
    if (parts.length > 0) messages.push({ role: message.role, text: parts.join('\n').trim() })
  }
  return messages
}

/**
 * Read every transcript file matching one platform task id and return the last
 * assistant message across them.
 *
 * @param {object} options read options
 * @param {string} options.dir transcript directory
 * @param {string} options.pattern file glob with `{id}` (simple `*` only)
 * @param {string} options.id platform task/job id
 * @param {number} [options.maxChars] cap on returned text
 * @returns {{files: string[], text: string, role: string, found: boolean}} transcript result
 */
export function readAgentTranscript(options) {
  const { dir, pattern, id, maxChars = DEFAULT_MAX_CHARS } = options
  if (!dir || !existsSync(dir)) return { files: [], text: '', role: '', found: false }

  const prefix = pattern.split('*')[0].replace('{id}', id)
  const suffix = pattern.includes('*') ? pattern.split('*').slice(1).join('*') : ''
  let names = []
  try {
    names = readdirSync(dir)
      .filter(name => name.startsWith(prefix) && name.endsWith(suffix))
      .map(name => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime)
      .map(item => item.name)
  } catch {
    return { files: [], text: '', role: '', found: false }
  }
  if (names.length === 0) return { files: [], text: '', role: '', found: false }

  let last = { role: '', text: '' }
  for (const name of names) {
    let raw = ''
    try {
      raw = readFileSync(join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const message of parseTranscript(raw)) {
      if (message.role === 'assistant' && message.text !== '') last = message
    }
  }
  const text = last.text.length > maxChars ? `${last.text.slice(0, maxChars)}\n… (transcript 已截断)` : last.text
  return { files: names, text, role: last.role, found: last.text !== '' }
}
