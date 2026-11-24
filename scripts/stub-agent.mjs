#!/usr/bin/env node
/**
 * Stub worker used by the self-test: behaves like a headless agent CLI.
 *
 * - takes a brief path (or inline prompt) as argv[2]
 * - STUB_SLEEP_MS   how long to pretend to work (default 200)
 * - STUB_EXIT_CODE  exit status (default 0)
 * - STUB_LINES      how many filler lines of "work" to print (default 3)
 * - STUB_FAKE_ERROR 1 = print a provider failure and still exit 0
 */

import { readFileSync } from 'node:fs'

const arg = process.argv[2] ?? ''
let brief = arg
try {
  brief = readFileSync(arg, 'utf8')
} catch {
  /* treat the argument as the prompt itself */
}

const sleepMs = Number(process.env.STUB_SLEEP_MS ?? 200)
const exitCode = Number(process.env.STUB_EXIT_CODE ?? 0)
const lines = Number(process.env.STUB_LINES ?? 3)

// Simulate the CLI class that exits 0 while its model call never happened.
if (process.env.STUB_FAKE_ERROR === '1') {
  console.log('[stub] Making API call #1/10...')
  console.log('⚠️  Attempt 1/3, not retryable failed: HTTP 400: Missing model')
  console.log('✅ Completed: False')
  process.exit(0)
}

console.log(`[stub] received brief (${brief.length} chars)`)
console.log(`[stub] goal line: ${brief.split('\n').find(line => line.trim() !== '' && !line.startsWith('#')) ?? '(none)'}`)
for (let index = 1; index <= lines; index += 1) {
  console.log(`[stub] working step ${index}/${lines} …`)
  await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.round(sleepMs / Math.max(1, lines)))))
}

console.log('## 结论')
console.log(`stub worker finished ${lines} steps for run ${process.env.FLEET_RUN_ID ?? '(no run id)'}`)
console.log('## 证据 / 产出')
console.log(`- brief: ${process.env.FLEET_BRIEF ?? '(none)'}`)
console.log(`- cwd: ${process.cwd()}`)
console.log('## 未完成 / 风险')
console.log(process.env.STUB_RISK ?? '无')

process.exit(exitCode)
