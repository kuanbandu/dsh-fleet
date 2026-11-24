/**
 * dsh-fleet log sink.
 *
 * The Host logger (ctx.logger) is not a reliable landing spot for plugin
 * chatter: in this profile nothing the plugin logs at info level reaches the
 * journal or $DSH_HOME/logs, so operations had to be reverse-engineered from
 * runs/<id>/state.json. This module owns a plain, rotating file next to the
 * runs directory; callers mirror lines to the Host logger when one exists.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Rotate once the log passes this size; one generation of history is enough. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

/** Read at most this much when producing a tail. */
const TAIL_BYTES = 256 * 1024

/**
 * Create one append-only log file.
 *
 * @param {object} options sink options
 * @param {string} options.dir directory holding the file
 * @param {string} [options.name] file name
 * @param {number} [options.maxBytes] rotation threshold
 * @returns {object} sink with write/info/warn/error/tail and its path
 */
export function createFileLogger(options) {
  const dir = options.dir
  const name = options.name ?? 'fleet.log'
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)

  const rotate = () => {
    try {
      if (existsSync(path) && statSync(path).size > maxBytes) renameSync(path, path + '.1')
    } catch {
      /* a log that cannot rotate must not break the plugin */
    }
  }

  const write = (level, message) => {
    const line = new Date().toISOString() + ' ' + level.padEnd(5) + ' ' + String(message).trimEnd() + '\n'
    try {
      rotate()
      appendFileSync(path, line, 'utf8')
    } catch {
      /* a full disk must not crash the Harness */
    }
  }

  const tail = (lines) => {
    const want = lines ?? 40
    if (!existsSync(path)) return ''
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return ''
    }
    if (text.length > TAIL_BYTES) text = text.slice(text.length - TAIL_BYTES)
    const rows = text.split('\n').filter(row => row !== '')
    return rows.slice(Math.max(0, rows.length - want)).join('\n')
  }

  return {
    path,
    write,
    info: message => write('INFO', message),
    warn: message => write('WARN', message),
    error: message => write('ERROR', message),
    tail,
  }
}
