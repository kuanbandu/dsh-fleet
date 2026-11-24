# dsh-fleet · 让 Harness 变成指挥官

> 在 dsh 对话框里输入客户想要的方向 → 模型把方向拆成互不重叠的分工 → 插件把每份分工派给
> opencode / hermes / claude / codex 这类外部 agent CLI 在后台跑 → 模型回收结论与证据再综合汇报。
>
> 思想取自 [sapper-v2](https://github.com/N1nEmAn/sapper-v2)：**指挥官 / 军团 / 看门狗** 三件套。
> 在 dsh 里只用两个：指挥官就是你这个会话，插件负责军营与看门狗。

## 1. 为什么是"插件"而不是"又一个预设"

dsh 的模型只在被调用时才行动。要让"客户说一句话 → 下面一堆 agent 动起来"，缺的不是提示词，
而是一个**能被模型调用的能力**：它要能启动进程、分配槽位、盯截止时间、把输出收回来。
这正是 Host 插件的位置 —— 工具注册进 `ctx.tools`，模型自己决定何时派活。

```
用户: "帮我把这个仓库的 CI 修好，顺手把文档补上"
        │
        ▼
dsh 会话（指挥官）── fleet_agents  先看谁能干
        │            fleet_dispatch 拆成两份，并行派出
        ▼
┌───────────────────────────────┐
│ runs/<runId>/brief.md  简报    │   ← 总目标 + 自己的分工 + 纪律 + 交付格式
│ runs/<runId>/out.log   全过程  │
│ runs/<runId>/state.json 状态   │
└───────────────────────────────┘
        │  spawn(绝对路径, args)
        ▼
  opencode │ hermes │ claude │ codex …   ← 士兵：真正的力气活
        │
        ▼
dsh 会话 ── fleet_status / fleet_result 收结果 → 综合成给客户的结论
        ▲
        └── 看门狗：截止时间、失败重试、崩溃/重启后接管状态、槽位回收
```

## 2. 五个工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `fleet_agents` | 花名册 + 探活（`--version` / 服务 HTTP 探活） | `action: list\|probe` |
| `fleet_dispatch` | 派活，立刻返回 runId | `goal`（用户原话）、`agents[]`、`assignments[]`、`context`、`cwd`、`timeoutSec`、`waitSec` |
| `fleet_status` | 进度、耗时、退出码、日志尾部 | `runId`（可 `all`）、`waitSec`（内联等待，省 sleep） |
| `fleet_result` | 取一个 worker 的交付 | `runId`、`full`、`tailLines` |
| `fleet_stop` | 取消（SIGTERM → 8s → SIGKILL） | `runId` 或 `all`、`reason` |

设计约束（写死在插件里，不靠提示词祈祷）：

- **队列与槽位**：`maxConcurrent`（默认 4）控制并行数，多出来的排队，不炸机器；待执行上限 64。
- **截止时间**：每个 worker 都有 `timeoutSec`，到点 SIGTERM，8 秒后 SIGKILL，状态记 `timeout`。
- **失败重试**：`retryLimit`（默认 0），重试时上一轮的日志尾巴保留在同一个 `out.log` 里。
- **重启可接管**：状态落盘 `runs/<runId>/state.json`；Harness 重启后按 pid 重新接管（`adopted`），
  进程已死的记 `lost` 而不是假装成功。
- **简报即契约**：worker 拿到的 `brief.md` 明确要求按 `## 结论 / ## 证据 / ## 未完成` 三段交付，
  模型被要求在汇报前必须 `fleet_result` 读回真实输出。

## 3. 目录布局

```
$DSH_HOME/plugin-data/dsh-fleet/runs/
  r-20261124-123705-08e6/
    brief.md     派给它的完整简报
    out.log      stdout+stderr 全量（含每次 attempt 头）
    state.json   状态机：queued/running/done/failed/timeout/stopped/lost
```

## 4. 配置：接一个自己的 agent

> ⚠️ 本仓库里的 `cordis.patch.yml` 是**这台机器的实际运行配置**（含本机绝对路径和网关模型 id）。
> 仓库目前是私有的；要公开前，先把这些换回通用值（`command` 写裸名即可，插件会自己解析）。


`cordis.patch.yml` 里的 `config.agents` 按 `id` 覆盖内置条目，新 `id` 就是新增条目：

```yaml
- insert:
    - id: dsh-fleet
      name: dsh-fleet
      config:
        maxConcurrent: 4
        timeoutSec: 1800
        retryLimit: 0
        agents:
          - id: my-agent
            command: /opt/my-agent/bin/run     # 绝对路径最稳；裸名会查 PATH + 常见 bin 目录
            args: ["--prompt", "{prompt}"]     # 可用占位符：{prompt} {brief} {cwd} {runDir} {runId} {goal}
            timeoutSec: 900
            env: { MY_FLAG: "1" }
          - id: opencode
            command: /home/kali/.opencode/bin/opencode   # 钉住二进制路径（宿主 PATH 里没有它时必需）
```

占位符规则：

- `args` 里出现 `{prompt}` 或 `{brief}` → 简报走参数（CLI 友好）；
- 都不出现 → 简报写进 **stdin**（`exec`-style CLI 友好）；
- 环境变量里总会有 `FLEET_RUN_ID`、`FLEET_BRIEF`（简报路径），worker 可以自己回读命令。

## 5. 现在这台机器上的实测状态

| agent | 形态 | 实测 |
|---|---|---|
| `opencode` | CLI `run --auto` | ✅ v2.2.5，冒烟 12s 返回 `PONG fleet ok`；自检任务 42s 按三段格式交付 |
| `hermes` | CLI `-z` | ✅ v0.22.1+682，自检任务 49s 完成，结论/证据/未完成齐全。`--version` 慢（>25s），探活给 30s |
| `hermes-agent` | CLI `--query` | ✅ 补上 `--model` 后 26s 正常回话；**之前不配模型时它 exit 0 静默失败**（`Missing model`），见下方已知问题 |
| `claude` / `codex` | CLI | 本机未安装（装上即可用，无需改插件） |
| `cyberstrike` | **服务** `http://127.0.0.1:8081` | ✅ 探活通；它是 Go 平台 + MCP 工具面，不是 prompt CLI |
| `artex` | **服务** `http://127.0.0.1:8787` | ✅ 探活 200；planner/worker 平台，走它的 HTTP API |

> 关于 CyberStrike / ARTEX：它们不是"给一段提示词就完事"的 CLI，硬塞进 `cli` 适配器只会造假。
> 正确的接法是**适配器**（见路线图第二阶段），而不是把它们当 opencode 用。

## 6. 已知问题与限制

1. **改了插件源码必须重启宿主。** 重装 bundle 只会重跑 `apply`（配置生效），不会重新 `import` 模块——
   已实测两次。所以"改代码 → remove/install"是不够的，要 `dsh-restart.sh`。
2. **exit code 不可信。** 有 CLI（如 `hermes-agent` 未配模型时）进程正常退出、却在输出里写
   `Missing model` / `Completed: False`。插件因此对每次尝试做输出特征扫描，命中就把 run 标成
   `suspect`（状态仍是 `done`，但 `fleet_status` / `fleet_result` 会明确警告"别当成功"）。
   特征表故意收窄，不匹配普通 `HTTP 4xx`，免得把渗透 worker 打印目标 404 当失败。
   历史 run 在激活时按各自的日志回填一次，所以升级后旧记录也会被正确标记。
3. **worker 的 cwd 不保证。** `opencode` 会把 cwd 上溯到 git 根（自检时 `pwd` 变成了
   `/home/kali/deepseek-harness`）。简报里已要求"先显式 cd 回工作目录"；要硬隔离就把 cwd 指到
   非 git 目录，或放进容器。
4. **探活只是提示。** `hermes --version` 启动慢，可能 `ready:false` 而实际可派；二进制存在
   （`available:true`）就允许 dispatch。
5. **service 型 agent 只能探活不能 dispatch。** `cyberstrike`（HTTP 404 = 服务活着）、
   `artex`（HTTP 200）要等阶段二的 MCP/HTTP 适配器。
6. **运行记录有上限。** `keepRuns`（默认 50）之外的历史 run 在激活时连同日志一起删掉。

## 7. 自测

```bash
node scripts/selftest.mjs     # 34 项：目录/简报/闭环/槽位/截止/停止/重试/重启接管/suspect 识别/记录保留
```

自测用 `scripts/stub-agent.mjs` 当假 worker，不花一个 token，也不碰任何外部 CLI。

## 8. 路线图

- **阶段二 · 适配器**：`mcp`（CyberStrike 的 `batch_task_create/start/get`，`X-MCP-Token`）与
  `http`（ARTEX 的提交接口），让"平台型 agent"也能进同一个 `fleet_dispatch`。
- **阶段二 · tmux 适配器**：给只提供交互式 TUI 的 CLI 用（sapper 的做法：`send-keys` 打字 + 抓窗格）。
- **阶段三 · 共享记忆**：sapper 的分层事实图（标题/摘要/证据三级）。dsh 这里的对应物是
  `runs/<id>/` 的简报与结论，天然可以按 `goal` 聚合，先别急着上数据库。
- **阶段三 · UI**：一个「军团」面板（Web 插件），实时看槽位、日志、一键停。

## 9. 安全边界

- 派出去的是**真实进程**，工作目录默认是当前会话工作区；`brief.md` 里写明了"破坏性动作先停下来说明"。
- worker 拿到的只是简报文本，不继承 dsh 的凭据；它自己的登录态由各自 CLI 管。
- 模型侧被要求：汇报前必须读回日志，日志里没有的结论不许写。
- 本插件不改任何 agent 的命令与凭据 —— 那是配置，不是对话能改的东西。
