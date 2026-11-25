# flume

零状态事件转运层：把外部系统的事件**验签 → 归一成统一 envelope → 喂进收件箱或投递 exec**。命名自渡槽：只负责把水从这头运到那头。

默认是 **flume + AgentInbox**：flume 负责接入和搬运，AgentInbox 负责去重、持久化、订阅、inbox 和 activation。设置 `FLUME_FEED_EXEC` 后，flume 把统一 envelope 通过 stdin 交给任意投递 CLI；flume 不知道目标服务是什么，也不启动 AgentInbox。

[使用指南 → docs/USAGE.md](docs/USAGE.md) · [架构 → docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [Adapter 与扩展 → docs/ADAPTERS.md](docs/ADAPTERS.md) · [卸载 → docs/REMOVAL.md](docs/REMOVAL.md)

## 理念与目标

本地 agent 需要感知外部系统的事件。把轮询吸进 agent runtime，每接一个系统都会带上 webhook、重试、去重和回调路由。

flume 把接入、可靠性和业务判断拆开：

```text
事件源 → flume → AgentInbox → 唤醒器 / agent
```

- **flume 只负责接入**：验签、归一、写入收件箱、转发唤醒。
- **AgentInbox 负责可靠性**：去重、持久化、订阅匹配、inbox/ack、activation 租约。
- **agent 侧负责后续处理**：读取事件，并自行决定分类、执行和确认方式。
- **事件源和唤醒器可替换**：adapter、URL 或唤醒脚本按部署选择。

队列、重试、持久化和业务过滤由 AgentInbox 承担，是否开 turn 由 agent 侧判断。

## 快速安装

需要 Node.js `^22.23.4 || ^24.22.1 || >=26.12.1`。AgentInbox 模式还需要 source id 和唤醒目标；使用 `FLUME_FEED_EXEC` 时不需要唤醒目标。

依赖和构建由 [`run-flume.sh`](run-flume.sh) 在首次启动时自动完成。

先完成下面的“配置”：

1. 写入 GitHub webhook secret。
2. 配置 GitHub webhook。
3. 复制 `.env.example` 为 `.env`，填入本机配置。

然后启动：

```bash
./run-flume.sh
```

脚本会自动安装依赖、构建并启动 flume。默认模式下启动或连接 AgentInbox；设置 `FLUME_FEED_EXEC` 后不启动 AgentInbox。

<a id="event-flow"></a>
## 流程：投递事件并唤醒 agent

GitHub 只是一个事件源示例；其他 adapter 使用同一条链路。

1. 事件源发出 webhook，例如 GitHub `pull_request.opened` → `POST /github`。
2. flume 验签并归一成 `{source, event, subject, native_id, occurred_at, payload}`。
3. 默认模式写入 AgentInbox；设置 `FLUME_FEED_EXEC` 时改为交给配置的投递 CLI。
4. AgentInbox 模式可调用 flume `/activation`；flume 校验激活字段并执行 `FLUME_WAKE_URL` 或 `FLUME_WAKE_EXEC`。
5. 被唤醒的 agent 按自己的方式读取和处理事件。是否分类、建任务、调用工具、回写或 ack，都由 agent 的实现决定。

```text
事件源
  → flume 验签 / 归一
  → AgentInbox 或 generic delivery CLI
  → 可选 activation
  → 唤醒 agent
```

边界：**flume 只负责传输和叫醒，不规定 agent 的任务模型、执行流程或确认方式。**

## 配置

默认值在 [`run-flume.sh`](run-flume.sh)。本机配置写入仓库根目录 `.env`，脚本启动时用 `source` 加载；同名 shell 变量会被 `.env` 覆盖。

```bash
cp .env.example .env
chmod 600 .env
$EDITOR .env
```

`.env` 已被 Git 忽略，权限必须为 `600`。模板 `.env.example` 只列变量；密钥优先放 Keychain。

| 变量 | 默认值 | 用途 |
| :--- | :--- | :--- |
| `FLUME_ADAPTERS` | `github` | 启用的事件源，逗号分隔：`github`、`gitlab` 或 `github,gitlab` |
| `AGENTINBOX_SOURCE_ID` | 默认模式必填 | AgentInbox 的 source id；设置 `FLUME_FEED_EXEC` 后不需要 |
| `FLUME_FEED_EXEC` | 未设置 | 通用投递命令；envelope JSON 从 stdin 传入，不绑定目标服务 |
| `FLUME_FEED_TIMEOUT_MS` | `15000` | 投递 exec 的超时；目标服务处理较慢时调大 |
| `FLUME_GITHUB_SECRET` | 从 Keychain 读取 | GitHub webhook secret；非 macOS 或本地测试时可直接用环境变量 |
| `FLUME_GITLAB_TOKEN` | 未设置 | 仅在启用 `gitlab` adapter 时需要 |
| `FLUME_BIND` | `0.0.0.0` | 监听地址；只允许本机访问时改 `127.0.0.1` |
| `FLUME_PORT` | `19420` | 监听端口；修改后 webhook URL 要同步修改 |
| `FLUME_WAKE_URL` | 未设置 | URL 模式：向外部 HTTP endpoint POST 激活字段；设置后不使用 exec |
| `FLUME_WAKE_EXEC` | 未设置 | exec 模式：执行任意脚本，完整 prompt 作为最后参数；Shepherdr 写 `hc space <id>` |
| `FLUME_AGENTINBOX_AGENT_ID` | 未设置 | agent 在 AgentInbox 中的 agent id，用于读取和确认 inbox |

AgentInbox 的 source 和订阅由部署配置；flume 侧集中设置 `FLUME_ADAPTERS`、webhook secret 和唤醒目标。

### 通用投递 exec

`FLUME_FEED_EXEC` 是一个与目标服务无关的投递命令。flume 只把归一后的 envelope JSON 写到它的 stdin：

```bash
FLUME_FEED_EXEC="/path/to/your-delivery-cli --some-arg"
```

投递目标服务、消息队列或审计系统由这个 CLI 自己决定；flume 不包含任何目标服务的 SDK、endpoint 或字段映射。

例如一个从 stdin 接收 JSON 的 agent CLI：

```bash
FLUME_FEED_EXEC="/usr/local/bin/agent-intake --format json"
FLUME_FEED_TIMEOUT_MS=120000
```

flume 只负责验签、归一和投递；目标 CLI 负责持久化、路由和后续 agent 处理。`FLUME_FEED_TIMEOUT_MS` 默认 15000ms，目标处理较慢时可调大；命令返回非零或超时时，webhook 收到 502。

只使用 `FLUME_FEED_EXEC` 时不启动 AgentInbox，也不需要 `FLUME_WAKE_EXEC`。前者负责事件投递，后者负责 AgentInbox activation 的唤醒，两者不能互相替代。

启动后可检查当前 delivery 模式：

```bash
curl -s http://127.0.0.1:19420/healthz
# {"ok":true,"delivery":"exec"}
```

投递目标由这个 CLI 自己决定；flume 不包含目标服务的 SDK、endpoint 或字段映射。

### 唤醒目标

通知 agent 只有 URL 和 exec 两种配置模式，不绑定具体 agent 实现。exec 是执行脚本并把
prompt 作为参数，不是 stdio：不会向 stdin 写内容。参数按空格拆分，不经过 shell。
`.env` 中值含空格必须带引号。`FLUME_WAKE_URL` 与 `FLUME_WAKE_EXEC` 同时设置会在启动时报错。

- **exec / agent CLI**：如果 CLI 接受 prompt 作为最后一个参数，可以写 `FLUME_WAKE_EXEC="claude"` 或
  `FLUME_WAKE_EXEC="codex"`；需要固定工作目录、权限或其他参数时，用包装脚本更稳妥。
- **exec / 任意脚本**：例如 `FLUME_WAKE_EXEC="/path/to/notify --target ops"`。命令按空格拆分，
  完整唤醒 prompt 作为最后一个参数传入，可直接替换通知实现。
- **exec / Shepherdr 示例**：`FLUME_WAKE_EXEC="hc space <space-id>"` 会让 flume 查找该
  space 的 live Assistant 并发送 prompt。space id 可从 `hc get <Assistant> --json`
  返回的 `herdr.coordinator.space` 或 `herdr.space` 标签读取，或由 Shepherdr 提供。
  `space` 是 flume 的约定，不是 `hc` 子命令；只有可执行文件名精确为 `hc` 时启用。
- **URL**：设置 `FLUME_WAKE_URL=<URL>`，POST 四字段并带
  `X-Flume-Activation-Mode: activation_only`。

唤醒 prompt 只携带激活字段和通用处理提示，不指定 skill、任务模型或执行流程；每次唤醒有 10 秒上限。

### GitHub webhook secret

macOS 示例从系统钥匙串读取：

```text
service=flume-github-webhook account=flume
```

写入 secret（输入只用于 Keychain，随后从 shell 环境清除）：

```bash
printf 'GitHub webhook secret: '
read -rs FLUME_GITHUB_SECRET
echo
security add-generic-password -U \
  -a flume -s flume-github-webhook -w "$FLUME_GITHUB_SECRET"
unset FLUME_GITHUB_SECRET
```

不使用 macOS 时，启动前直接设置 `FLUME_GITHUB_SECRET` 即可。

### GitHub webhook

在仓库的 **Settings → Webhooks → Add webhook** 中配置：

| 项 | 值 |
| :--- | :--- |
| Payload URL | `http://<flume-host>:19420/github` |
| Content type | `application/json` |
| Secret | 与钥匙串中的 `flume-github-webhook` 一致 |
| SSL verification | URL 是 HTTP 时关闭 |
| Events | Pull requests、Pull request reviews、Pull request review comments、Issue comments、Issues；按需加 Pushes / Workflow runs |

保存后点 **Recent Deliveries → Redeliver**；返回 `2xx` 即已接入。Webhook URL 使用 GitHub 能访问到的 flume 主机地址。

flume 验签使用 `X-Hub-Signature-256`，并以 `X-GitHub-Delivery` 作为 `native_id`。同一投递重复 redeliver 时，由 AgentInbox 或所选投递目标负责去重。

### agent 处理

flume 不要求 agent 安装某个 skill，也不规定任务系统、分类方式或 playbook。被唤醒后，agent 按自己的实现读取事件并决定后续动作；使用 AgentInbox 时，ack 范围也由 agent 自己根据实际处理结果决定。

仓库内置 `templates/workflow-event-intake/` 作为可选的事件处理 skill 模板，提供读取、分类、路由和 ack 的通用起点。可以复制后修改，也可以用自定义 skill 完全替换；名称和加载方式由 agent 自己决定，flume 不绑定它。

## 扩展适配

新增来源只需要一个 flume adapter：

1. 在 `src/adapters/<name>.ts` 实现 `NAME`、`SECRET_ENV`、`verify`、`normalize`。
2. 注册到 `src/adapters/index.ts`，并把来源名加入 `FLUME_ADAPTERS`。
3. 在 `run-flume.sh` 里补这个来源的 secret 读取。
4. 加 `verify` / `normalize` / `native_id` 的测试。

事件归一后由 AgentInbox 或 generic delivery CLI 接收；agent 如何处理不需要修改 adapter。当前支持：

| 系统 | Webhook 路径 | Secret |
| :--- | :--- | :--- |
| GitHub（示例） | `POST /github` | `FLUME_GITHUB_SECRET` |
| GitLab | `POST /gitlab` | `FLUME_GITLAB_TOKEN` |

完整示例见 [`docs/ADAPTERS.md`](docs/ADAPTERS.md)。GitLab 作为可选 adapter 保留。

## 常驻运行

前台运行直接执行 `./run-flume.sh`；需要 macOS 登录自启时再配置用户级 LaunchAgent。

把仓库里的 plist 链接到 `~/Library/LaunchAgents` 即可，launchd 会从该目录加载用户级 job。

仓库里的 [`deploy/com.flume.plist`](deploy/com.flume.plist) 就是 flume 进程的 launchd 入口，label 固定为 `com.flume`。事件源不影响 job 名称；本机配置写入 `.env`。

加载：

```bash
mkdir -p logs
ln -sf "$PWD/deploy/com.flume.plist" \
  "$HOME/Library/LaunchAgents/com.flume.plist"
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.flume.plist"
```

日志在 `logs/flume.launchd.log` 和 `logs/flume.launchd.err.log`。重启和卸载见 [`docs/USAGE.md`](docs/USAGE.md) 与 [`docs/REMOVAL.md`](docs/REMOVAL.md)。

launchd 只加载 flume 的 `com.flume` job。默认 AgentInbox 模式下，flume 会 attach 或启动 daemon；使用 `FLUME_FEED_EXEC` 时不启动 AgentInbox。agent 的生命周期和处理模型由部署方自行管理。
