# dsh-fleet · turn the Harness into a commander

**English** | [中文](./README.zh.md)

> Say what the client wants in the chat → the model splits it into non-overlapping assignments → the
> plugin hands each one to an external executor that works in the background → the model reads the
> **actual output** back and reports a synthesised conclusion.
>
> In one line: **not a preset, but a set of scheduling tools the model can call.**
>
> ⚠️ **Authorized use only.** You are fully responsible for every action your workers take — see
> [Disclaimer](#disclaimer) at the end.

> **Credit where it is due:** the *commander / legion / watchdog* split is borrowed from
> [sapper-v2](https://github.com/N1nEmAn/sapper-v2). In dsh the commander needs no separate process —
> the session itself is the commander — so what this plugin builds is the legion and the watchdog.

## 0. Install

```bash
# Web UI: Plugins page → install bundle → @kuanbandu/dsh-fleet
npx @deepseek-ai/dsh web

# or CLI
dsh plugin add @kuanbandu/dsh-fleet
npm i -g @kuanbandu/dsh-fleet          # fetch the package without wiring it into a profile
```

Then declare this machine's executors in `$DSH_HOME/plugin-data/dsh-fleet/agents.local.json`
(see 5.4) and restart the host; `fleet_agents` will list the roster.



The dsh model only acts when it is called. Getting from "the client said one sentence" to "a pool of
agents is working" does not need a better prompt; it needs a **capability the model can call**: one
that spawns processes, allocates slots, watches deadlines, and collects output verbatim.

That place is the Host plugin layer. Tools are registered into `ctx.tools`, and the model — driven by
the conversation — decides whether to dispatch, how many ways to split the work, and when to stop.

```
User: "fix this repo's CI, and update the docs while you're at it"
        │
        ▼
dsh session (commander) ── fleet_agents   who is available?
        │                 fleet_dispatch  split in two, dispatch in parallel
        ▼
┌────────────────────────────────┐
│ runs/<runId>/brief.md   brief   │   ← overall goal + this worker's slice + rules + format
│ runs/<runId>/out.log    output  │
│ runs/<runId>/state.json state   │
└────────────────────────────────┘
        │  spawn(absolute path, args)  or  spawn(protocol driver)
        ▼
  CLI | batch MCP | task REST …   ← executors: the actual muscle
        │
        ▼
dsh session ── fleet_status / fleet_result collect → synthesised answer
        ▲
        └── watchdog: deadlines, retries, re-adoption after restart, slot reclamation, logs on disk
```

## 2. The five tools

| Tool | Purpose | Key parameters |
|---|---|---|
| `fleet_agents` | Roster + liveness probe (`--version` / service handshake) | `action: list\|probe` |
| `fleet_dispatch` | Dispatch work, returns a runId immediately | `goal` (the user's own words), `agents[]`, `assignments[]`, `context`, `cwd`, `timeoutSec`, `waitSec` |
| `fleet_status` | Progress, elapsed time, exit code, log tail | `runId` (or `all`), `waitSec` (inline wait instead of sleeping) |
| `fleet_result` | Collect one worker's deliverable | `runId`, `full`, `tailLines` |
| `fleet_stop` | Cancel (SIGTERM → 8s → SIGKILL) | `runId` or `all`, `reason` |

## 3. Constraints built into the plugin (not left to prompt-following)

- **Queue and slots**: `maxConcurrent` (default 4) caps parallelism; the rest queue up instead of
  melting the machine. Backlog limit 64.
- **Deadlines**: every worker has a `timeoutSec`; on expiry SIGTERM, then SIGKILL 8 seconds later,
  state recorded as `timeout`.
- **Retries**: `retryLimit` (default 0); on retry the previous attempt's log tail is kept in the same
  `out.log` rather than silently discarded.
- **Adoption after restart**: state is persisted to `state.json`; after a Harness restart workers are
  re-adopted by pid (`adopted`), and processes that are already gone are recorded as `lost` instead of
  being reported as successes.
- **The brief is the contract**: each worker's `brief.md` requires delivery in three sections —
  `## Conclusion / ## Evidence / ## Not done` — and the model is required to call `fleet_result` and
  read the real output before reporting anything.

## 4. Directory layout

```
$DSH_HOME/plugin-data/dsh-fleet/
  fleet.log      the plugin's own ops log (activation, adoption, pruning, stop; one 2 MiB rotation)
  secrets.json   remote executor credentials (optional, mode 600): {"<identity>":{"<field>":"…"}}
  runs/
    r-20261124-123705-08e6/
      brief.md     the full brief handed to this worker
      out.log      stdout+stderr verbatim (including per-attempt headers)
      state.json   state machine: queued/running/done/failed/timeout/stopped/lost
```

> `ctx.logger` has no observable sink in this profile (neither the journal nor `$DSH_HOME/logs`
> receives `info`-level plugin logs), so the plugin writes `fleet.log` itself while still mirroring to
> the Host logger.

## 5. Configuration: wiring an executor

Entries in `config.agents` override built-in entries by `id`; a new `id` adds a new entry.

### 5.1 CLI executors

```yaml
        agents:
          - id: my-cli-agent
            command: /opt/my-agent/bin/run     # absolute path is safest; a bare name searches PATH + common bin dirs
            args: ["--prompt", "{prompt}"]     # placeholders: {prompt} {brief} {cwd} {runDir} {runId} {goal}
            timeoutSec: 900
            env: { MY_FLAG: "1" }
```

Placeholder rules:

- `{prompt}` or `{brief}` present in `args` → the brief goes in as an argument (CLI-friendly);
- neither present → the brief is written to **stdin**;
- `FLEET_RUN_ID` and `FLEET_BRIEF` (brief path) are always exported, so a worker can read the brief
  itself.

### 5.2 Batch-style MCP platforms

```yaml
          - id: platform-batch
            adapter: mcp
            endpoint: http://127.0.0.1:8081/mcp
            identity: platform-batch          # section name in secrets.json
            spec:
              headers: { X-MCP-Token: '@platform-batch.token' }
              create: { tool: batch_task_create, toText: tasks, args: { execute_now: false, concurrency: 1 } }
              start:  { tool: batch_task_start }
              poll:   { tool: batch_task_get, intervalSec: 5, doneQueueStatuses: [completed] }
```

### 5.3 Task-style REST platforms

```yaml
          - id: platform-task
            adapter: http
            endpoint: http://127.0.0.1:8787
            identity: platform-task
            spec:
              login: { path: /api/auth/login, body: { username: '@platform-task.username', password: '@platform-task.password' }, tokenPath: token }
              create: { path: /api/tasks, body: { description: 'dsh-fleet {runId}', goal: '{brief}' }, idPath: id }
              poll:   { path: /api/tasks/{id}, statePath: status, intervalSec: 10 }
              outcome: { path: '/api/tasks/{id}/outcome' }
```

`@section.field` is resolved from `secrets.json` and never lives in the repository; `{brief}`,
`{runId}` and `{id}` are placeholders.

**Reading the body back**: some platforms answer `/outcome` with statistics only (tool calls, tokens,
findings) while the actual conclusion sits in the platform's own transcript. The HTTP driver reads the
last assistant message back after completion (`lib/transcript.js`) so that `done` actually means a
deliverable; the location is configurable via `spec.transcript: { dir, pattern }`.

A remote run is still a supervised child process (the protocol driver), so queueing, slots, deadlines,
SIGTERM, logging and `suspect` scanning all apply exactly as they do for local CLIs.

### 5.4 Machine-local overrides: keep machine facts on the machine

Anything that is only true on one host — absolute paths, local ports, private credential sections —
does not belong in the bundle patch. Put it in
`$DSH_HOME/plugin-data/dsh-fleet/agents.local.json` (it overrides fields of the same `id`, is never
committed and never published):

```json
{
  "agents": [
    { "id": "my-cli-agent", "command": "/opt/my-agent/bin/run",
      "args": ["--prompt", "{prompt}"] },
    { "id": "platform-batch", "endpoint": "http://127.0.0.1:8081/" }
  ],
  "disabled": ["some-default-id"]
}
```

That way the repository and the npm package carry generic defaults that work out of the box, while the
paths this machine pins stay local.

## 6. Calibration from real engagements

None of the following was planned up front; every item came out of running actual work.

1. **An egress proxy turns healthy requests into fake failures.** When the host routes through an
   HTTP(S) proxy, an executor's outbound requests can come back as forged 502s or timeouts — and it
   will earnestly report "target unreachable". Briefs must mandate direct connections, and commands
   need `--noproxy '*'` or `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY`. When a model sees "the
   whole target is unreachable", suspect the proxy before the target.
2. **Exit codes lie.** Some CLIs exit 0 while failing (missing model, missing arguments) and only say
   so in their output. The plugin therefore scans each attempt's output for failure signatures and
   marks the run `suspect` — state stays `done`, but `fleet_status` / `fleet_result` warn explicitly
   that it must not be treated as success. The signature list is deliberately narrow and does not
   match plain `HTTP 4xx`, so a genuine 404 on a target is not mistaken for worker failure.
3. **A remote `done` is not a deliverable.** A platform may answer with a single "task completed"
   line while the conclusion lives in its transcript. Reporting without reading it back means treating
   the platform's self-report as evidence — which is exactly why the plugin reads the body back.
4. **Interactive UIs are a blind spot — never let an agent pretend it can click.** Native selects,
   rich-text editor iframes and OS file pickers cannot be driven reliably by "click + keypress": a
   select may open without committing its value, an editor iframe may be unreadable, and uploads
   require a real user gesture. **Degrade the delivery instead**: export the content to a local
   one-click copy page (open in a browser, one click to clipboard), merge the images into a single
   file, and reduce the human's remaining work to "paste + pick + submit". Admitting the boundary
   beats letting a worker randomly click a production form with nobody watching.
5. **Budget needs a valve.** One run can burn hundreds of thousands of tokens: probe with
   `fleet_agents` first, give every worker a sane `timeoutSec`, keep parallelism within what the
   machine can take, and let `keepRuns` prune history. Writing "do not widen the scope on your own"
   into the brief is far cheaper than a later `fleet_stop`.
6. **Directory conventions beat prompts.** The artifacts of one real engagement are: rules of
   engagement, findings, raw evidence, submission material — all under a single
   `engagements/<target>/` with fixed subdirectory names. The plugin only schedules; material
   discipline comes from the directory layout, so handover and review do not depend on memory.
7. **Every command in a report must be run by its author first.** Reproduction steps handed to a
   client or a platform that were never executed produce the worst kind of defect: wrong flags and
   output that does not match — and reviewers do type them in. This is now a hard rule: a command
   written into a report must have been reproduced once, on the spot.
8. **Hot-reload boundary.** Protocol drivers are per-run child processes, so edits to them take effect
   immediately; edits to the plugin's own modules require a host restart (reinstalling the bundle
   only re-runs `apply`, it does not re-`import`).

## 7. Known issues and limits

1. **Source changes require a host restart.** Reinstalling the bundle re-runs `apply` but does not
   re-`import` modules.
2. **Exit codes are unreliable** → see 6.2; the `suspect` marker is the safety net.
3. **A worker's cwd is not guaranteed.** Some CLIs walk the cwd up to the git root. Briefs already ask
   workers to `cd` back to the working directory explicitly; for hard isolation point `cwd` at a
   non-git directory, or run inside a container.
4. **Probing is advisory.** Some CLIs start slowly on `--version`, so `ready:false` may be reported
   while dispatch would still work; if the binary exists (`available:true`), dispatch is allowed.
5. **Remote adapter boundaries.** Queues/tasks live on the platform; the fleet only dispatches and
   collects, and the platform UI can still observe and interfere. When a run times out the platform
   side may keep running, and the fleet **will not** clean it up for you.
6. **Plugin logs are in `fleet.log`,** not in the journal. Start troubleshooting at
   `$DSH_HOME/plugin-data/dsh-fleet/fleet.log`.
7. **Run history is capped.** Runs older than `keepRuns` (default 50) are deleted together with their
   logs on activation.
8. **Restart is only declared successful on "the new token URL returns 200".** The companion script
   stops a crash loop first, clears non-unit processes holding the port, then starts the unit and
   verifies the URL; `manual` mode hands the port back to a manual start and `dry-run` only reports.

## 8. Self-test

```bash
node scripts/selftest.mjs     # 48 checks: dirs/brief/round-trip/slots/deadline/stop/retry/adoption/suspect/retention/MCP+REST adapters/machine-local overrides
```

The self-test uses `scripts/stub-agent.mjs` as a fake worker: it burns no tokens and touches no
external CLI.

## 9. Roadmap

- ~~**Adapter layer**~~ done: MCP (batch-style) and HTTP (task-style) protocol drivers, so
  platform-style executors go through the same `fleet_dispatch` as CLIs.
- **Interactive TUI adapter**: for CLIs that only offer a full-screen interface (type + scrape), as a
  last resort.
- **Shared memory**: aggregate `runs/<id>/` briefs and conclusions per `goal` into a fact graph
  (title/summary/evidence) — no database yet.
- **UI panel**: live slots, logs, one-click stop.

## 10. Security boundary

- What gets dispatched are **real processes**; the working directory defaults to the current session
  workspace, and `brief.md` states that destructive actions must stop and ask first.
- A worker only receives the brief text; it does not inherit dsh credentials. Its own login state is
  managed by its CLI or platform.
- The model side is instructed to read logs back before reporting, and never to state a conclusion the
  logs do not support.
- The plugin never changes an executor's command or credentials — those are configuration, not
  something a conversation can edit.
- Before touching a production system, use `fleet_agents probe` to establish who is being dispatched,
  how long it may take, and what it can reach.

## Disclaimer

This plugin only *schedules* external executors. It provides no offensive capability and ships no
payload aimed at any particular target.

1. **Scope of use** — use it on systems you own, or targets for which you hold explicit written
   authorization.
2. **Compliance** — you are solely responsible for the legality of every scan, probe, exploitation
   attempt or data access carried out through this plugin. Use for unauthorized intrusion, data theft,
   sabotage or regulatory evasion is prohibited.
3. **Executors are outside our control** — the content produced, commands executed, compute consumed
   and costs incurred by executors (CLI, MCP platforms, REST platforms) are configured and borne by
   you. The plugin flags unreliable exit codes and `suspect` runs, but **cannot** recognise every
   failure mode.
4. **Output is untrusted** — worker logs and conclusions are external input and may contain errors,
   hallucinations or injected content. The plugin requires the model to read real output before
   reporting, but you should still verify key conclusions yourself.
5. **Credentials** — `secrets.json` and each executor's login state are yours to manage and protect;
   this repository contains no credentials.
6. **No warranty** — provided "as is" under the MIT license, without warranty of any kind, express or
   implied. The authors and contributors accept no liability for any direct or indirect damages
   (including but not limited to data loss, service interruption, legal disputes or cloud costs)
   arising from use of this software.
7. **Acceptance** — if you do not accept any of the above, do not install or use this plugin.
