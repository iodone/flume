# flume

零状态事件转运层：把外部系统的事件**验签 → 归一成统一 envelope → 喂进 agent 收件箱 → 转发唤醒**。命名自渡槽：只负责把水从这头运到那头。

事件源、收件箱和唤醒器都是可替换的角色；GitLab、AgentInbox 和 herdr 只是当前的一组实现。flume 不定义这些产品，也不把它们的模型写进项目定义。

[使用指南 → docs/USAGE.md](docs/USAGE.md) · [架构与替换点 → docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [卸载 → docs/REMOVAL.md](docs/REMOVAL.md)

## 目的与意义

本地 agent 需要感知外部系统的事件，但不能把轮询、SDK、webhook、重试和回调路由都
吸进 runtime。connector gravity 一旦进入 agent 侧，每接一个系统就多一份长期维护
成本。

flume 把这些事件搬到 agent 的收件箱。agent 侧不再轮询外部系统；可靠性语义交给收件箱，唤醒后的判断留在 agent 侧。

```text
事件源 ──事件──▶ flume ──统一 envelope──▶ 收件箱
                 验签·归一·喂入                 │
                                                │ 收件箱通知
                                                ▼
agent 唤醒器 ◀──flume 只转发唤醒── flume /activation
```

flume 只做四件事：**验签**、**归一**、**喂入收件箱**、**转发唤醒**。它不排队、
不重试、不持久化，也不决定是否开 turn。

当前接线（2026-10-26，试点，不是项目定义）：内网 GitLab（`git.n.xiaomi.com`）
发 webhook → flume → AgentInbox source event → herdr `activation_only` 唤醒门。
`src/adapters/index.ts` 的 `Adapter` 注册表目前只有 `gitlab`；`src/core.ts` 的
`FeedFunction` 当前喂给 AgentInbox；`src/activation.ts` 当前转发给 herdr。三处
替换边界与尚未完全解耦的部分见[架构文档](docs/ARCHITECTURE.md)。

## 快速安装

Node.js 版本与当前的 `@holon-run/agentinbox` 实现保持一致：`^22.23.4 || ^24.22.1 || >=26.12.1`。Node.js 23.x / 25.x 不在依赖声明的支持范围内。

从仓库根目录安装为全局 `flume` 命令：

```bash
npm ci          # 安装 devDependencies；prepack 的 tsc 要用
npm i -g .      # 安装为全局 flume 命令
flume --help
```

**期望输出**

```text
Usage: flume start
```

当前仓库尚未发布，不要用 `npm install -g flume` 安装，否则会拿到 npm 上的同名包。
如果全局 bin 不在 `PATH`，用 `npm prefix -g` 查看前缀后将其加入 `PATH`；也可改用
`npm i -g . --prefix "$HOME/.local"`，命令会装到 `~/.local/bin/flume`。
需要登录常驻时，按
[USAGE 的常驻安装一节](docs/USAGE.md#常驻安装launchd)配置 LaunchAgent。

## 快速启动

以下命令演示**当前接线**：GitLab 事件源、AgentInbox 收件箱、herdr 唤醒器。先在
同一个 shell 中启动 AgentInbox daemon，并创建示例使用的 GitLab source：

```bash
agentinbox daemon start
HOST_ID="$(agentinbox host add local_event flume-quickstart | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).hostId')"
export AGENTINBOX_SOURCE_ID="$(agentinbox source add "$HOST_ID" events gitlab | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).sourceId')"
export FLUME_GITLAB_TOKEN=local-smoke-token
flume start
```

保持这个终端运行；本流程会输出 `agentinbox attached`。在另一个终端确认 HTTP 入口：

```bash
curl -sS http://127.0.0.1:9420/healthz
```

**期望输出**

```json
{"ok":true}
```

投递一条最小的 GitLab Merge Request webhook：

```bash
curl -sS -X POST http://127.0.0.1:9420/gitlab \
  -H 'Content-Type: application/json' \
  -H 'X-Gitlab-Token: local-smoke-token' \
  -H 'X-Gitlab-Event: Merge Request Hook' \
  -H 'X-Gitlab-Event-UUID: local-smoke-mr-1' \
  --data-binary '{"object_kind":"merge_request","project":{"path_with_namespace":"group/project"},"object_attributes":{"iid":123,"action":"open","state":"opened","updated_at":"2026-10-26 09:00:00 UTC"}}' \
  -w '\nstatus=%{http_code}\n'
```

**期望输出**

```text
{"accepted":1}
status=202
```

## 配置清单

全部通过环境变量配置。常驻部署可用权限为 `600` 的 `FLUME_ENV_FILE` 补充变量；缺必填项
时进程直接以退出码 2 失败。token 不进仓库、日志、响应体、plist 或命令行。下表中的
AgentInbox、GitLab 和 herdr 名称都属于当前实现，不是通用转运层的固定术语。

| 变量 | 是否必填 | 说明 | 默认值 |
| :--- | :--- | :--- | :--- |
| `AGENTINBOX_SOURCE_ID` | 是 | 当前收件箱 AgentInbox 的目标 source | 无 |
| `FLUME_GITLAB_TOKEN` | 是 | 当前事件源 adapter 的 GitLab webhook Secret token | 无 |
| `FLUME_BIND` | 否 | 监听地址；接内网 GitLab 时用 `0.0.0.0` | `127.0.0.1` |
| `FLUME_PORT` | 否 | 监听端口 | `9420` |
| `FLUME_HERDR_WAKE_URL` | 否 | 当前唤醒器 herdr 唤醒门的绝对 HTTP(S) URL | 未配置 |
| `FLUME_HERDR_WAKE_TIMEOUT` | 否 | 唤醒门调用超时，单位秒 | `5` |
| `FLUME_ENV_FILE` | 否 | 权限必须为 `600` 的 `KEY=value` 文件 | 未配置 |
| `FLUME_AGENTINBOX_AUTOSTART` | 否 | `0` 表示只等待并 attach 独立 AgentInbox daemon，不自举 | `1` |

修改位置：前台运行改 shell 环境变量，常驻运行改 `FLUME_ENV_FILE` 指向的文件。各变量的
完整语义、安全边界和常驻配置见 [`docs/USAGE.md` 的配置详解](docs/USAGE.md#配置详解)。
