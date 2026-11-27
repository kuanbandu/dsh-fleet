# dsh-fleet · 让 Harness 变成指挥官

[English](./README.en.md) | **中文**

> 在对话框里说明客户要什么 → 模型把方向拆成互不重叠的分工 → 插件把每份分工交给外部执行体
> 在后台并行干活 → 模型读回**真实输出**，综合成给客户的结论。
>
> 一句话：**它不是一个预设，而是一组能被模型调用的调度工具。**
>
> ⚠️ **仅限合法授权场景使用。** 使用者对派出去的所有动作负全责，详见文末《免责声明》。

## 1. 为什么必须是插件

dsh 的模型只在被调用时才行动。要让"客户说一句话、下面一组 agent 动起来"，缺的不是提示词，
而是一个**能被模型调用的能力**：它得能启动进程、分配槽位、盯截止时间、把输出原样收回来。

这个位置只能是 Host 插件：工具注册进 `ctx.tools`，派不派、派几份、什么时候停，由模型按对话决定。

```
用户: "把这个仓库的 CI 修好，顺手把文档补上"
        │
        ▼
dsh 会话（指挥官）── fleet_agents   先看谁能干
        │            fleet_dispatch 拆成两份，并行派出
        ▼
┌───────────────────────────────┐
│ runs/<runId>/brief.md   简报    │   ← 总目标 + 自己的分工 + 纪律 + 交付格式
│ runs/<runId>/out.log   全过程  │
│ runs/<runId>/state.json 状态   │
└───────────────────────────────┘
        │  spawn(绝对路径, args) 或 spawn(协议驱动)
        ▼
  CLI 型 │ MCP 批次型 │ REST 任务型 …   ← 执行体：真正的力气活
        │
        ▼
dsh 会话 ── fleet_status / fleet_result 收结果 → 综合成结论
        ▲
        └── 看门狗：截止时间、失败重试、崩溃重启后接管状态、槽位回收、日志落盘
```

## 2. 五个工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `fleet_agents` | 花名册 + 探活（`--version` / 服务端握手） | `action: list\|probe` |
| `fleet_dispatch` | 派活，立刻返回 runId | `goal`（用户原话）、`agents[]`、`assignments[]`、`context`、`cwd`、`timeoutSec`、`waitSec` |
| `fleet_status` | 进度、耗时、退出码、日志尾部 | `runId`（可 `all`）、`waitSec`（内联等待，省 sleep） |
| `fleet_result` | 取一个 worker 的交付 | `runId`、`full`、`tailLines` |
| `fleet_stop` | 取消（SIGTERM → 8s → SIGKILL） | `runId` 或 `all`、`reason` |

## 3. 写死的约束（不靠提示词祈祷）

- **队列与槽位**：`maxConcurrent`（默认 4）控制并行数，多出来的排队，不炸机器；待执行上限 64。
- **截止时间**：每个 worker 都有 `timeoutSec`，到点 SIGTERM，8 秒后 SIGKILL，状态记 `timeout`。
- **失败重试**：`retryLimit`（默认 0），重试时上一轮日志尾巴保留在同一个 `out.log` 里。
- **重启可接管**：状态落盘 `state.json`；Harness 重启后按 pid 重新接管（`adopted`），
  进程已死的记 `lost`，不假装成功。
- **简报即契约**：worker 的 `brief.md` 要求按 `## 结论 / ## 证据 / ## 未完成` 三段交付；
  模型被要求在汇报前必须 `fleet_result` 读回真实输出。

## 4. 目录布局

```
$DSH_HOME/plugin-data/dsh-fleet/
  fleet.log      插件自身运维日志（激活、接管、清理、停止；2MiB 轮转一份）
  secrets.json   远端执行体凭据（可选，600）：{"<identity>":{"<field>":"…"}}
  runs/
    r-20261124-123705-08e6/
      brief.md     派给它的完整简报
      out.log      stdout+stderr 全量（含每次 attempt 头）
      state.json   状态机：queued/running/done/failed/timeout/stopped/lost
```

> `ctx.logger` 在这个 profile 里没有可观测落点（journal 与 `$DSH_HOME/logs` 都收不到 `info` 级
> 插件日志），所以插件自己写 `fleet.log`，同时仍镜像给 Host logger。

## 5. 配置：接一个执行体

`config.agents` 按 `id` 覆盖内置条目，新 `id` 就是新增条目。

### 5.1 CLI 型

```yaml
        agents:
          - id: my-cli-agent
            command: /opt/my-agent/bin/run     # 绝对路径最稳；裸名会查 PATH + 常见 bin 目录
            args: ["--prompt", "{prompt}"]     # 占位符：{prompt} {brief} {cwd} {runDir} {runId} {goal}
            timeoutSec: 900
            env: { MY_FLAG: "1" }
```

占位符规则：

- `args` 里出现 `{prompt}` 或 `{brief}` → 简报走参数（CLI 友好）；
- 都不出现 → 简报写进 **stdin**；
- 环境变量里总有 `FLEET_RUN_ID`、`FLEET_BRIEF`（简报路径），worker 可自行回读。

### 5.2 批次型 MCP 平台

```yaml
          - id: platform-batch
            adapter: mcp
            endpoint: http://127.0.0.1:8081/mcp
            identity: platform-batch          # secrets.json 里的段名
            spec:
              headers: { X-MCP-Token: '@platform-batch.token' }
              create: { tool: batch_task_create, toText: tasks, args: { execute_now: false, concurrency: 1 } }
              start:  { tool: batch_task_start }
              poll:   { tool: batch_task_get, intervalSec: 5, doneQueueStatuses: [completed] }
```

### 5.3 任务型 REST 平台

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

`@段名.字段` 从 `secrets.json` 取值，不进仓库；`{brief}` / `{runId}` / `{id}` 是占位符。

**正文回读**：有的平台 `/outcome` 只给统计（工具调用数、token、findings），真正的结论在平台
自己的 transcript 里。HTTP 驱动在任务完成后会回读最后一次 assistant 文本（`lib/transcript.js`），
这样 `done` 才是一份交付；路径可用 `spec.transcript: { dir, pattern }` 指定。

远端 run 仍然是一个受管子进程（协议驱动），队列、槽位、截止时间、SIGTERM、日志、suspect 扫描
全部照样生效。

### 5.4 本机覆盖：把机器相关的东西留在机器上

绝对路径、本机端口、私有凭据段这类"只在这台机器成立"的配置，不要写进 bundle 的 patch。
放到 `$DSH_HOME/plugin-data/dsh-fleet/agents.local.json`（覆盖同名 `id` 的字段，不进仓库、不随包发布）：

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

这样仓库和 npm 包里只有通用默认值，别人装上就能用；本机要钉的路径只存在本地。

## 6. 实战校准（真实交付里补出来的东西）

下面每一条都不是设计时想到的，是被真实任务打出来的。

1. **出口代理会把正常请求变成假的失败。** 宿主机走了 HTTP(S) 代理时，外部执行体发出去的请求
   可能拿到伪造的 502/超时，然后它认真地报告"目标不可达"。简报里必须写死"直连"，
   命令上加 `--noproxy '*'` 或 `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY`；
   模型看到"整片不可达"时，先怀疑代理，再怀疑目标。
2. **退出码不可信。** 有的 CLI 在没配模型、缺参数时照样 `exit 0`，失败信息只写在输出里。
   插件因此对每次尝试做输出特征扫描，命中就标 `suspect`（状态仍 `done`，但
   `fleet_status` / `fleet_result` 会明确警告"别当成功"）。特征表故意收窄，
   不匹配普通 `HTTP 4xx`，免得把"目标真的 404"误判成 worker 失败。
3. **远端的 `done` 不等于有交付。** 平台可能只回一行"任务完成"，结论在 transcript 里。
   不读回来就汇报，等于把平台的自述当证据 —— 这正是插件要回读正文的原因。
4. **交互式界面是工具链的盲区，不要让 agent 假装能点。** 原生下拉、富文本 iframe（编辑器）、
   系统文件选择器，这三类东西靠"点击 + 按键"驱动不可靠：下拉可能打得开、值却不提交；
   编辑器 iframe 可能根本读不到 DOM；上传需要真实用户手势。
   **正确做法是降级交付**：把要填的内容导出成本地"一键复制页"（浏览器打开、点一下进剪贴板），
   把要传的图合并成一张，把剩下的人工动作压缩到"粘 + 选 + 点提交"。宁可承认边界，
   也不要让 worker 在没人看的情况下瞎点生产表单。
5. **成本要有闸。** 一次 run 可能吃掉几十万 token：先 `fleet_agents probe` 再派、
   给每个 worker 合理 `timeoutSec`、并发别超过机器能扛的量、历史记录靠 `keepRuns` 清。
   派活简报里明确写"不得自行扩大范围"，比事后 `fleet_stop` 便宜得多。
6. **目录约定比提示词可靠。** 一次真实交付的产物是：交战规则、发现记录、原始证据、
   提交材料 —— 全放在同一个 `engagements/<目标>/` 下，按固定子目录命名。
   插件只负责调度，材料规范靠目录约束，交接和复盘才不靠记忆。
7. **报告里的每条命令，自己先跑一遍。** 交付给客户/平台的复现步骤，如果作者没实际执行过，
   就会出现"参数写错、输出对不上"的硬伤，而审核恰恰会照着敲。这条已经写成硬规矩：
   写进报告的命令，必须当场复现过一次。
8. **热更边界。** 协议驱动是每次 run 独立拉起的子进程，改它立即生效；
   插件自身的模块改了必须重启宿主（重装 bundle 只重跑 `apply`，不重新 `import`）。

## 7. 已知问题与限制

1. **改了插件源码必须重启宿主。** 重装 bundle 只重跑 `apply`，不重新 `import` 模块。
2. **exit code 不可信** → 见 6.2，`suspect` 机制兜底。
3. **worker 的 cwd 不保证。** 有的 CLI 会把 cwd 上溯到 git 根。简报里已要求"先显式 cd 回工作目录"；
   要硬隔离就把 cwd 指到非 git 目录，或放进容器。
4. **探活只是提示。** 有的 CLI `--version` 启动很慢，可能 `ready:false` 而实际可派；
   二进制存在（`available:true`）就允许 dispatch。
5. **远端适配器的边界。** 队列/任务建在平台上，fleet 只负责派与收，平台 UI 仍可看到并干预；
   超时退出时平台侧任务可能还在跑，fleet **不会**替你清理。
6. **插件日志在 `fleet.log`**，不在 journal。排障先看
   `$DSH_HOME/plugin-data/dsh-fleet/fleet.log`。
7. **运行记录有上限。** `keepRuns`（默认 50）之外的历史 run 在激活时连同日志一起删掉。
8. **重启只认「新 token URL 返回 200」。** 配套脚本先停崩溃循环、再清掉占用端口的非单元进程、
   然后起单元并验证 URL；`manual` 模式把端口交还手工启动，`dry-run` 只看不改。

## 8. 自测

```bash
node scripts/selftest.mjs     # 48 项：目录/简报/闭环/槽位/截止/停止/重试/重启接管/suspect/记录保留/MCP 与 HTTP 适配器
```

自测用 `scripts/stub-agent.mjs` 当假 worker，不花一个 token，也不碰任何外部 CLI。

## 9. 路线图

- ~~**适配器层**~~ 已完成：MCP（批次型）与 HTTP（任务型）两类协议驱动，
  平台型执行体和 CLI 型走同一个 `fleet_dispatch`。
- **交互式 TUI 适配器**：给只提供全屏界面的 CLI 用（打字 + 抓窗格），作为最后手段。
- **共享记忆**：把 `runs/<id>/` 的简报与结论按 `goal` 聚合成事实图（标题/摘要/证据三级），
  先别急着上数据库。
- **UI 面板**：实时看槽位、日志、一键停。

## 10. 安全边界

- 派出去的是**真实进程**，工作目录默认是当前会话工作区；`brief.md` 写明"破坏性动作先停下来说明"。
- worker 只拿到简报文本，不继承 dsh 的凭据；它自己的登录态由各自 CLI / 平台管。
- 模型侧被要求：汇报前必须读回日志，日志里没有的结论不许写。
- 插件不改任何执行体的命令与凭据 —— 那是配置，不是对话能改的东西。
- 对生产系统动手前，先用 `fleet_agents probe` 确认"派出去的是谁、会花多少时间、能碰到什么"。

## 免责声明 / Disclaimer

**中文**

1. **用途限定**：本插件用于把任务派发给外部执行体并监管其运行。它只做**调度**，不产生攻击能力，
   也不内置任何针对特定目标的载荷。请在**你自己拥有的系统**、或**已获得明确书面授权**的目标上使用。
2. **合规责任**：使用本插件进行的任何扫描、探测、利用、数据访问等行为，其合法性由**使用者本人**
   承担全部责任。严禁用于未授权入侵、数据窃取、破坏系统、规避监管等用途。
3. **外部执行体不受控**：被执行体（CLI、MCP 平台、REST 平台）产出的内容、执行的命令、消耗的算力
   与费用，均由使用者自行配置与承担。插件会明确标注"退出码不可信"与 `suspect` 状态，
   但**不保证**能识别所有失败形态。
4. **输出不可信**：worker 的日志与结论属于外部输入，可能包含错误、幻觉或注入内容。
   插件要求模型读回真实输出后再汇报，但使用者仍需自行核验关键结论。
5. **凭据**：`secrets.json` 与各执行体的登录态由使用者自行管理与保护，仓库内不含任何凭据。
6. **无担保**：本软件按 MIT 协议"按原样"提供，不附带任何明示或暗示的担保；
   因使用本软件造成的任何直接或间接损失（包括但不限于数据丢失、服务中断、法律纠纷、云费用），
   作者与贡献者不承担责任。
7. **终止即生效**：若你不接受上述任一条款，请不要安装或使用本插件。

**English (short — full version: [README.en.md](./README.en.md))**

This plugin only *schedules* external executors; it grants no offensive capability. Use it solely on
systems you own or for which you hold explicit written authorization. You are fully responsible for
the legality of every action your workers take, for the credentials you configure, and for reviewing
their output — worker output is untrusted input. Provided "as is" under MIT, without warranty of any
kind; the authors accept no liability for any damages arising from its use. If you do not accept these
terms, do not install or use this software.
