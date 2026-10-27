# flume 使用指南

flume 是零状态事件转运层：**验签 → 归一成统一 envelope → 喂进收件箱 → 转发唤醒**。

核心是 **flume + AgentInbox**：flume 负责接入和搬运，AgentInbox 负责去重、持久化、订阅、inbox 和 activation。事件源和唤醒器可替换；GitHub 和 herdr 是当前示例。

## 1. 快速安装

### 前置条件

- Node.js `^22.23.4 || ^24.22.1 || >=26.12.1`
- 一个可用的唤醒目标；当前示例是 herdr
- 能访问 flume 监听地址的事件源；当前示例是 GitHub

依赖和构建由 [`run-flume.sh`](../run-flume.sh) 在首次启动时自动完成。配置只有一处：脚本里的默认值，以及启动前设置的同名环境变量。没有 `~/.config/flume`，也没有第二份配置文件。

### 安装步骤

1. 按第 3 节写入 webhook secret。
2. 按第 3 节配置事件源 webhook。
3. 按第 3 节复制并配置 agent intake skill。
4. 启动：

```bash
FLUME_AGENTINBOX_INTAKE_SKILL=/path/to/your-agent/.agents/skills/workflow-event-intake/SKILL.md \
./run-flume.sh
```

脚本会自解析仓库路径、读取 secret，并在缺少依赖或构建产物时自动执行 `npm install` / `npm run build`。

## 2. 流程：一条 GitHub PR 事件

主序列图只在 README 维护：[一条 GitHub PR 事件的完整时序](../README.md#event-flow)。

这里补充每一步的细节。GitHub 是事件源示例；换成其他 adapter 后，flume、AgentInbox 和 agent 侧的处理方式不变。

场景：`owner/repo#42` 由 `ada` 打开，你是 requested reviewer。

1. GitHub 发出 `pull_request.opened`，`POST /github`。
2. flume 用 `X-Hub-Signature-256` 验签，归一成 `{source:"github", event:"pull_request.opened", subject:"owner/repo#42", payload:{...}}`。
3. flume 调用 AgentInbox source event 接口；AgentInbox 按 `X-GitHub-Delivery` 去重、匹配 subscription、写入 inbox entry。
4. AgentInbox 向 flume `POST /activation`，只带 `kind/newEntryCount/latestEntryId/summary`，不带正文。
5. flume 校验字段后执行唤醒命令；prompt 只带 `agentId`、`newEntryCount` 和 intake skill 路径，不包含 PR 正文。
6. coordinator 醒来后读取 inbox，按 `envelope.source` 加载 `sources/github.md`。
7. source policy 把事件映射成 `REVIEW_REQUEST`：PR 作者不是你，你是 requested reviewer 或 assignee，且不是 draft。
8. coordinator 在任务系统建 review task；brief 包含 PR URL、head sha、author、base branch、entry id、dedupe key，并指定项目自己的 `review` playbook。
9. review worker 建 worktree、读取人类评论和 diff、按项目流程分析代码、写 review 文档；是否发 review comment 由授权决定。不 approve、不 request changes、不 merge。
10. coordinator 只 `ack --through` 自己实际审过的 entry。

如果 `ada` 后来提交了 review：

- `pull_request_review.submitted`（`approved` / `changes_requested` / `commented`）→ `FEEDBACK`。
- `pull_request_review_comment.created` 或 PR 上的 `issue_comment.created` → `FEEDBACK`。
- coordinator 按 `headRefName` 找回对应 task；task 空闲时把原文 `tell` 过去，不自动 merge。

## 3. 配置

所有默认值都在 [`run-flume.sh`](../run-flume.sh)。需要变更时直接改脚本，或在启动前设置同名环境变量。这样前台启动、launchd 和 CI 走同一个入口，不依赖某个用户目录。

| 变量 | 默认值 | 用途 |
| :--- | :--- | :--- |
| `FLUME_ADAPTERS` | `github` | 启用的事件源，逗号分隔：`github`、`gitlab` 或 `github,gitlab` |
| `AGENTINBOX_SOURCE_ID` | 见 `run-flume.sh` | AgentInbox 的 source id；用来把事件写进同一个 source 并匹配订阅，通常不用改 |
| `FLUME_GITHUB_SECRET` | 从 Keychain 读取 | GitHub webhook secret；非 macOS 或本地测试时可直接用环境变量 |
| `FLUME_GITLAB_TOKEN` | 未设置 | 仅在启用 `gitlab` adapter 时需要 |
| `FLUME_BIND` | `0.0.0.0` | 监听地址；只允许本机访问时改 `127.0.0.1` |
| `FLUME_PORT` | `19420` | 监听端口；修改后 webhook URL 要同步修改 |
| `FLUME_HERDR_WAKE_AGENT` | 见 `run-flume.sh` | 唤醒器使用的 coordinator agent，不是 workspace 名 |
| `FLUME_AGENTINBOX_AGENT_ID` | 见 `run-flume.sh` | coordinator 在 AgentInbox 中的 agent id，用于读取和确认 inbox |
| `FLUME_AGENTINBOX_INTAKE_SKILL` | **必填，无内置默认** | 指向你自己配置过的 `SKILL.md`；flume 只传路径，不执行；缺失时拒绝启动 |
| `HERDR_BIN_PATH` | 见 `run-flume.sh` | 唤醒器可执行文件路径；换唤醒器时不使用 |
| `FLUME_HERDR_WAKE_TIMEOUT` | `10` | 唤醒命令超时，单位秒 |
| `FLUME_HERDR_WAKE_URL` | 未设置 | 仅对接外部 HTTP 唤醒器；当前 herdr 示例不需要 |

AgentInbox 的 source 和订阅属于内部接线，正常运行不需要用户操作；通常只改 `FLUME_ADAPTERS`、webhook secret 和 `FLUME_AGENTINBOX_INTAKE_SKILL`。

例如临时换端口：

```bash
FLUME_PORT=19421 ./run-flume.sh
```

### GitHub webhook secret

macOS 示例从系统钥匙串读取：

```text
service=flume-github-webhook account=flume
```

写入 secret（输入不会进入 shell 历史）：

```bash
printf 'GitHub webhook secret: '
read -rs FLUME_GITHUB_SECRET
echo
security add-generic-password -U \
  -a flume -s flume-github-webhook -w "$FLUME_GITHUB_SECRET"
unset FLUME_GITHUB_SECRET
```

轮换时先更新钥匙串和 GitHub Webhook Secret，再重启 flume：

```bash
security delete-generic-password -a flume -s flume-github-webhook
```

不使用 macOS 时，启动前直接设置 `FLUME_GITHUB_SECRET` 即可。secret 不写入仓库、日志或 plist。

### GitHub webhook

打开仓库的 **Settings → Webhooks → Add webhook**：

1. Payload URL 填 `http://<flume-host>:19420/github`。
2. Content type 选 `application/json`。
3. Secret 填钥匙串里的同一个 secret。
4. 勾选 Pull requests、Pull request reviews、Pull request review comments、Issue comments、Issues；按需加 Pushes / Workflow runs。
5. URL 是明文 HTTP 时关闭 SSL verification。
6. 保存后点 **Recent Deliveries → Redeliver**，确认返回 `2xx`。

URL 必须是 GitHub 能访问到的地址，不能写 `127.0.0.1`。如果改了 `FLUME_PORT`，端口也要同步。

flume 验签使用 `X-Hub-Signature-256`，并以 `X-GitHub-Delivery` 作为 `native_id`。同一投递重复 redeliver 会由 AgentInbox 去重。

### agent intake skill

flume 不附带可直接生效的 intake skill，也不把 `templates/` 当成默认策略。模板只用于参考和复制；每个部署必须自己配置。

1. 复制模板到 agent workspace：

   ```bash
   cp -R templates/workflow-event-intake \
     /path/to/your-agent/.agents/skills/
   ```

2. 编辑 `sources/github.md`，填 `GITHUB_LOGIN`、`TASK_CLI`、`TASK_REPO`、`TASK_PREFIX`、`REVIEW_WORKSPACE`，并按你的任务系统调整命令。
3. 设置 `FLUME_AGENTINBOX_INTAKE_SKILL` 指向复制后的 `SKILL.md`。
4. 重启 flume，让新路径进入 activation prompt。

skill 的职责：

1. `agentinbox inbox read` 读未 ack 条目，最多 50 条。
2. 按 `envelope.source` 分组，加载 `sources/<source>.md`。
3. 把事件映射成 intent：`REVIEW_REQUEST` / `FEEDBACK` / `ISSUE_UPDATE` / `LIFECYCLE` / `NOISE`。
4. 按 intent 路由：
   - `REVIEW_REQUEST` → 在任务系统建 review task 并派工
   - `FEEDBACK` → 找回已有 task，原始文本 `tell` 过去
   - `ISSUE_UPDATE` → 找回已关联 task；新 issue 只入队
   - `LIFECYCLE` → 更新或关闭 task
   - `NOISE` → 只 ack
5. `ack --through` 最后一条实际审过的 entry。

intake 只决定“做不做、做哪个 task”，不复制 review 步骤。真正的 review 由任务自己的 `review` playbook 执行；反馈继续由原 task 自己的 playbook 执行。

GitHub 的参考映射（按你的配置修改 `sources/github.md`）：

| GitHub 事件 | intent | 动作 |
| :--- | :--- | :--- |
| 我是 requested reviewer/assignee 的 open PR | `REVIEW_REQUEST` | 建 review task 并立即派工 |
| 我的 PR 出现 review / review comment / issue comment | `FEEDBACK` | 找回 task，原文交给 agent；不自动 merge |
| 我的 PR 被 approve / changes requested / dismiss | `FEEDBACK` | 把 review state 和 head sha 交给 task |
| 已关联 task 的 issue 变动 | `ISSUE_UPDATE` | 把原始变动交给对应 task；新 issue 只入队 |
| merged / closed | `LIFECYCLE` | 更新或关闭 task |
| push、workflow_run、重复投递 | `NOISE` | 审阅后 ack |

### GitLab（可选）

GitLab 是第二个 adapter 示例：

```bash
FLUME_ADAPTERS=gitlab \
FLUME_GITLAB_TOKEN='<token>' \
FLUME_AGENTINBOX_INTAKE_SKILL=/path/to/your-agent/.agents/skills/workflow-event-intake/SKILL.md \
./run-flume.sh
```

webhook 指向 `POST /gitlab`。完整 adapter 说明见 [`ADAPTERS.md`](ADAPTERS.md)。

## 4. 启动与验证

```bash
FLUME_AGENTINBOX_INTAKE_SKILL=/path/to/your-agent/.agents/skills/workflow-event-intake/SKILL.md \
./run-flume.sh
```

首次启动且本机没有 AgentInbox daemon 时：

```text
flume: listening on 0.0.0.0:19420; agentinbox started at /Users/<user>/.agentinbox/agentinbox.sock
```

已有 daemon 时：

```text
flume: listening on 0.0.0.0:19420; agentinbox attached at /Users/<user>/.agentinbox/agentinbox.sock
```

保持进程运行，另开终端检查：

```bash
curl -sS http://127.0.0.1:19420/healthz
```

```json
{"ok":true}
```

然后按顺序验证：

1. GitHub webhook 的 **Redeliver** 返回 `2xx`。
2. 日志里能看到 `accepted event=…` 和 `woke …`。
3. coordinator 空闲后，任务系统里出现由 inbox 聚合出的 task。
4. 处理完成后 `agentinbox inbox read --agent-id <agent-id> --limit 10` 应该为空；没 ack 的条目说明 coordinator 还没审完。

本地冒烟测试不会读取真实 AgentInbox：

```bash
npm run smoke
```

期望最后一行是 `smoke: passed`。

## 5. 常驻运行

`launchd` 不是必须的。前台运行只需要 `./run-flume.sh`；只有 macOS 登录自启才需要用户级 LaunchAgent。

`~/Library/LaunchAgents` 是 launchd 扫描用户级 job 的固定位置，所以那里必须有一个 plist 或指向仓库 plist 的软链。它不是第二份配置，配置仍在 `run-flume.sh` 和环境变量里。

仓库里的 `deploy/com.flume.plist` 就是 flume 进程的 launchd 入口，label 固定为 `com.flume`。事件源不影响 job 名称；切换 GitHub / GitLab 只改 `EnvironmentVariables`：

```bash
# ProgramArguments=/absolute/path/to/flume/run-flume.sh
# FLUME_ADAPTERS=github   # 或 gitlab
# FLUME_AGENTINBOX_INTAKE_SKILL=/path/to/your-agent/.agents/skills/workflow-event-intake/SKILL.md
mkdir -p logs
ln -sf "$PWD/deploy/com.flume.plist" \
  "$HOME/Library/LaunchAgents/com.flume.plist"
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.flume.plist"
```

查看状态和日志：

```bash
launchctl print "gui/$(id -u)/com.flume" | grep -E 'state =|pid ='
curl -fsS http://127.0.0.1:19420/healthz
tail -f logs/flume.launchd.log
tail -f logs/flume.launchd.err.log
```

升级后重启：

```bash
git pull
launchctl kickstart -k "gui/$(id -u)/com.flume"
```

停止并移除自启：

```bash
launchctl bootout "gui/$(id -u)/com.flume" 2>/dev/null || true
unlink "$HOME/Library/LaunchAgents/com.flume.plist"
```

`~/.agentinbox` 可能被其他 agent 共用；确认不再需要后再删除。完整撤除见 [`REMOVAL.md`](REMOVAL.md)。

## 6. AgentInbox 与唤醒语义

AgentInbox 写 inbox 后向 flume `/activation` 发送：

```json
{
  "kind": "agentinbox.activation",
  "newEntryCount": 2,
  "latestEntryId": "entry-local-smoke",
  "summary": "2 new GitHub events"
}
```

flume 只接受上述四个字段。`newEntryCount == 0` 返回 `202 {"accepted":0}`，不唤醒；大于 `0` 时执行唤醒命令。

prompt 只包含配置中的 `agentId`、经过校验的 `newEntryCount`、intake skill 路径和固定指令，不包含事件正文。`latestEntryId` 和 `summary` 只用于日志。coordinator 收到后用 AgentInbox skill 读取 inbox，并读取 `FLUME_AGENTINBOX_INTAKE_SKILL` 指向的策略文件；事件内容仍必须回 AgentInbox 读取。

如果设置 `FLUME_HERDR_WAKE_AGENT=""` 并改用 `FLUME_HERDR_WAKE_URL`，flume 会向该 URL POST 四个字段并带 `X-Flume-Activation-Mode: activation_only`。这是非 herdr 唤醒器的兼容模式，不是当前示例路径。

## 7. Adapters

当前支持 GitHub 和 GitLab：

| 系统 | 路由 | Secret 环境变量 | 事件 |
| :--- | :--- | :--- | :--- |
| GitHub（示例） | `POST /github` | `FLUME_GITHUB_SECRET` | Pull request、Review、Review comment、Issue、Issue comment、Push、Workflow run |
| GitLab | `POST /gitlab` | `FLUME_GITLAB_TOKEN` | Merge request、Pipeline、Note、Push、Issue；其他事件归一为 `<object_kind>.received` |

新增 adapter 的完整示例见 [`ADAPTERS.md`](ADAPTERS.md)。快速步骤：

1. 在 `src/adapters/<name>.ts` 导出 `NAME`、`SECRET_ENV`、`verify`、`normalize`。
2. 在 `src/adapters/index.ts` 的 `ADAPTERS` 注册。
3. 在 `run-flume.sh` 注入对应的 secret。
4. 在 agent workspace 的 intake skill 里增加 `sources/<name>.md`。
5. 补 `verify`、`normalize`、`native_id` 稳定性测试。
6. 向 `POST /<NAME>` 投递样例，确认 `202 {"accepted":1}`。

adapter 只验签和折 envelope，不排队、不重试、不落盘、不做订阅过滤、不决定唤醒。

## 8. 端点

| 方法 | 路径 | 结果 |
| :--- | :--- | :--- |
| `POST` | `/github` | `202 {"accepted":1}`；401 签名错；400 非法 envelope；413 超过 8 MiB；502 喂入失败 |
| `POST` | `/gitlab` | 同上；仅在启用 `gitlab` adapter 时可用 |
| `POST` | `/activation` | `202 {"accepted":1}` 已唤醒；`202 {"accepted":0}` 空激活；400 带正文或字段非法；502 唤醒失败；503 未配置唤醒目标 |
| `GET` | `/healthz` | `200 {"ok":true}` |

flume 不重试：事件失败交给事件源重投，activation 失败交给 AgentInbox 重投。

## 9. 排错

| 现象 | 检查 |
| :--- | :--- |
| 启动提示 Keychain 读取失败 | 确认 `service=flume-github-webhook account=flume` 存在且非空；或直接设置 `FLUME_GITHUB_SECRET` |
| 启动提示 intake skill 不存在 | 检查 `FLUME_AGENTINBOX_INTAKE_SKILL` 是否是复制后的 `SKILL.md` 绝对路径 |
| `healthz` 不通 | 看 `logs/flume.launchd.err.log`；确认 `FLUME_PORT` 和进程是否启动 |
| GitHub 显示 `Connection refused` | 确认 `FLUME_BIND=0.0.0.0`、端口一致、主机防火墙和路由可达 |
| GitHub Delivery 超时 | GitHub 到 flume 主机没有可达路由；不要用 `127.0.0.1` 作为 Webhook URL |
| `401 {"error":"invalid token"}` | GitHub Webhook Secret 与 Keychain 中的值不一致 |
| `502 {"error":"feed failed"}` | `AGENTINBOX_SOURCE_ID` 不存在或 AgentInbox 拒收 |
| `502 {"error":"wake gate failed"}` | 唤醒命令失败；检查 agent 名、`HERDR_BIN_PATH` 和超时 |
| 返回 `202` 但 inbox 为空 | AgentInbox source 没有订阅到目标 agent |
| inbox 有条目但 agent 没醒 | 检查 `FLUME_HERDR_WAKE_AGENT`、唤醒器可执行文件和 `/activation` 日志 |
| 请求返回 `413 {"error":"body too large"}` | webhook body 超过 8 MiB |

验证时优先使用 GitHub 的 Redeliver 或真实 PR 事件，不要只在本机 curl `/healthz`。
