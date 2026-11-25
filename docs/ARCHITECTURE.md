# flume 架构与设计

flume 是零状态事件转运层：**验签 → 归一成统一 envelope → 投递 → 可选唤醒 agent**。它只负责把水从事件源运到目标，不规定目标如何处理事件。

## 1. 角色与边界

```text
事件源 → flume → AgentInbox 或 generic delivery CLI → agent
```

| 角色 | 负责 |
| :--- | :--- |
| flume | webhook 接入、验签、归一、投递、activation 转发、进程入口 |
| AgentInbox | 默认模式下的去重、持久化、订阅、inbox/ack 和 activation |
| generic delivery CLI | 自行决定事件持久化、路由和后续处理 |
| agent | 被唤醒后按自己的实现读取和处理事件 |
| 事件源 | 按自身机制产生 webhook 和重试 |
| 唤醒器 | 通过 URL 或 exec 把 activation 变成一次 agent 调用 |

flume 不规定 agent 的任务模型、分类方式、执行 playbook 或确认流程。仓库内置 `templates/workflow-event-intake/` 作为可选的事件处理 skill 模板，提供读取、分类、路由和 ack 的通用起点；可以复制后修改，也可以用自定义 skill 完全替换。skill 名称和加载方式由 agent 自己决定。

## 2. 两种投递模式

### 2.1 默认：AgentInbox

```text
POST /github 或 /gitlab
  → 验签、归一 envelope
  → POST AgentInbox /sources/{sourceId}/events
  → 去重、订阅、写 inbox
  → 可选 POST flume /activation
  → 唤醒 agent
```

AgentInbox 负责可靠性和去重。`AGENTINBOX_SOURCE_ID` 在此模式下必填。

### 2.2 `FLUME_FEED_EXEC`

```text
POST /github 或 /gitlab
  → 验签、归一 envelope
  → spawn 配置的 CLI
  → envelope JSON 写入 stdin
```

该模式不启动 AgentInbox，也不需要 activation 配置。目标 CLI 退出码非零或超时时，flume 对 webhook 返回 502。

`FLUME_FEED_TIMEOUT_MS` 默认 15000ms；`GET /healthz` 返回：

```json
{ "ok": true, "delivery": "exec" }
```

默认 AgentInbox 模式的 `delivery` 为 `agentinbox`。

## 3. 一条事件的生命周期

1. 事件源向已启用的 adapter 路径发出 webhook。
2. flume 读取最多 8 MiB，校验 secret 和 JSON object。
3. adapter 把 payload 归一成 envelope。
4. flume 将 envelope 写入 AgentInbox 或 generic delivery CLI。
5. 投递成功后返回 `202 {"accepted":1}`。
6. AgentInbox 模式可继续发送 activation；generic exec 模式的后续处理由目标 CLI 自己决定。
7. 被唤醒的 agent 按自己的实现读取、处理和确认事件。

## 4. activation 与唤醒

activation 只包含四个字段：

```json
{
  "kind": "agentinbox.activation",
  "newEntryCount": 2,
  "latestEntryId": "entry-42",
  "summary": "2 new events"
}
```

- `kind` 固定为 `agentinbox.activation`。
- `newEntryCount` 是非负整数；`0` 不执行唤醒。
- `latestEntryId` 和 `summary` 是激活元数据，不是事件正文。
- 不允许携带 `entries` / `items` 等正文。
- `/activation` 只接受 loopback 请求。

唤醒方式互斥：

- `FLUME_WAKE_URL`：POST 四字段，并带 `X-Flume-Activation-Mode: activation_only`。
- `FLUME_WAKE_EXEC`：直接执行程序，完整 prompt 是最后一个参数，不写 stdin，不经过 shell。

prompt 只携带激活元数据和通用处理提示，不指定 skill、任务模型或 ack 工作流。每次唤醒有 10 秒上限；失败时返回 502，由上游激活机制负责重试。

可执行文件名精确为 `hc` 且参数为 `space <space-id>` 时，flume 可使用 Assistant 发现约定：列出 live 终端、读取 herdr 标签并发送 prompt。其他 CLI 不需要遵循该约定；只要接受 prompt 作为最后参数即可，例如 `claude` 或 `codex`。

## 5. Envelope

```json
{
  "native_id": "delivery-123",
  "event": "pull_request.opened",
  "occurred_at": "2026-10-23T07:00:00+00:00",
  "source": "github",
  "subject": "owner/repo#42",
  "payload": {}
}
```

| 字段 | 要求 |
| :--- | :--- |
| `native_id` | 同一投递重试必须稳定；没有上游 ID 时对 raw body 做 SHA-256 |
| `event` | `<对象>.<动作>`；无明确动作时用 `<对象>.received`，例如 `push.received` |
| `occurred_at` | ISO8601，取事件自身时间戳 |
| `source` | 等于 adapter 的 `NAME` |
| `subject` | 人可读的仓库或资源标识 |
| `payload` | 事件源原始 JSON object |

去重由 AgentInbox 或所选投递目标负责。flume 只保证 `native_id` 稳定。

## 6. 实现接缝

### 6.1 HTTP 与 adapter

`src/core.ts` 负责请求校验、路由、读取 body 和投递。adapter 实现：

```typescript
export const NAME = "jira";
export const SECRET_ENV = "FLUME_JIRA_TOKEN";
export function verify(headers, body, secret): boolean;
export function normalize(headers, body, document): Envelope;
```

在 `src/adapters/index.ts` 注册，并用 `FLUME_ADAPTERS` 启用。`SECRET_ENV` 自动成为启动必填项。

### 6.2 feed

`FeedFunction` 的形状是 `feedFn(envelope, { sourceId })`。默认实现位于 `src/feed.ts`，AgentInbox 使用 Unix socket HTTP，失败时可回退到 AgentInbox CLI。

部署时使用 `FLUME_FEED_EXEC` 即可切换到任意 stdin CLI，不需要修改代码。嵌入 `createFlumeServer` 时也可以直接注入 `feedFn`。

### 6.3 wake

`src/activation.ts` 提供 `dispatchActivation` 和 `dispatchWakeExec`，分别对应 URL 和 exec。两者只负责唤醒，不承载事件正文或业务授权。

## 7. 启动与进程模型

`./run-flume.sh` 负责：

1. 解析仓库路径和 Node.js 环境。
2. 读取权限为 `600` 的 `.env`。
3. 按启用的 adapter 读取 secret。
4. 缺少依赖或构建产物时执行 `npm install` / `npm run build`。
5. 执行 `node dist/src/cli.js start`。

默认 AgentInbox 模式下，flume attach 已有 daemon 或启动并持有 daemon；`FLUME_FEED_EXEC` 模式不启动 AgentInbox。

macOS 可使用 `deploy/com.flume.plist` 配置用户级 LaunchAgent，label 为 `com.flume`。agent 的生命周期由部署方自行管理。

## 8. 错误与验证

| 状态 | 含义 |
| :--- | :--- |
| 202 | 事件已投递或 activation 已接受 |
| 400 | 非 JSON、envelope 非法或 activation 字段非法 |
| 401 | webhook secret/token 错误 |
| 403 | 非 loopback 请求 `/activation` |
| 413 | webhook body 超过 8 MiB |
| 502 | 投递或唤醒失败 |
| 503 | activation 合法但未配置唤醒目标 |

测试至少覆盖 adapter 的验签、归一和稳定 `native_id`，以及 core 的投递、activation 和 health 行为：

```bash
npm run lint
npm test
npm run smoke
```
