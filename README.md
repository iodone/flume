# flume

外部 webhook → AgentInbox 事件的零状态翻译层。命名自渡槽：只负责把水从这头运到那头。

[使用指南 → docs/USAGE.md](docs/USAGE.md) · [架构 → docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [卸载 → docs/REMOVAL.md](docs/REMOVAL.md)

## 这个项目是什么

本地 agent 需要感知内网 GitLab 等外部系统的事件，但不能把轮询、SDK、webhook、重试和
回调路由都吸进 runtime。connector gravity 一旦进入 agent 侧，每接一个系统就多一份
长期维护成本。

flume 把这些外部事件翻译成 AgentInbox 的 source event。agent 侧不再轮询外部系统；
可靠性语义交给 AgentInbox，唤醒决策留在 herdr。

```text
外部系统 ──webhook POST──▶ flume ──source event──▶ AgentInbox
                        验签·归一·喂入                    │
                                                          │ activation_only
                                                          ▼
herdr ◀──只转发四字段── flume /activation
```

flume 只做四件事：**验签**、**归一**、**喂入 AgentInbox**、**转发 activation_only
唤醒**。它不排队、不重试、不持久化，也不决定是否开 turn。

当前状态（2026-10-26）：已接入内网 GitLab（`git.n.xiaomi.com`）的项目级 webhook，
正在 `olap/miergo` 试点；MR、评论、Push 和 Pipeline 事件已完成端到端验证。
设计合同见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 快速安装

Node.js 版本与 `@holon-run/agentinbox` 保持一致：
`^22.23.4 || ^24.22.1 || >=26.12.1`。Node.js 23.x / 25.x 不在依赖声明的支持范围内。

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

在同一个 shell 中先启动 AgentInbox daemon，并创建示例使用的 GitLab source：

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

## 如何配置

全部通过环境变量配置。常驻部署可用权限为 `600` 的 `FLUME_ENV_FILE` 补充变量；缺必填项
时进程直接以退出码 2 失败。token 不进仓库、日志、响应体、plist 或命令行。

| 变量 | 是否必填 | 说明 | 默认值 |
| :--- | :--- | :--- | :--- |
| `AGENTINBOX_SOURCE_ID` | 是 | AgentInbox 目标 source | 无 |
| `FLUME_GITLAB_TOKEN` | 是 | GitLab webhook 的 Secret token | 无 |
| `FLUME_BIND` | 否 | 监听地址；接内网 GitLab 时用 `0.0.0.0` | `127.0.0.1` |
| `FLUME_PORT` | 否 | 监听端口 | `9420` |
| `FLUME_HERDR_WAKE_URL` | 否 | herdr 唤醒门的绝对 HTTP(S) URL | 未配置 |
| `FLUME_HERDR_WAKE_TIMEOUT` | 否 | 唤醒门调用超时，单位秒 | `5` |
| `FLUME_ENV_FILE` | 否 | 权限必须为 `600` 的 `KEY=value` 文件 | 未配置 |
| `FLUME_AGENTINBOX_AUTOSTART` | 否 | `0` 表示只等待并 attach 独立 daemon，不自举 | `1` |

修改位置：前台运行改 shell 环境变量，常驻运行改 `FLUME_ENV_FILE` 指向的文件。各变量的
完整语义、安全边界和常驻配置见 [`docs/USAGE.md` 的配置详解](docs/USAGE.md#配置详解)。
