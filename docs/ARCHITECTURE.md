# flume 架构与设计

> 定位：零状态事件转运层——**验签 → 归一成统一 envelope → 喂进 agent 收件箱 →
> 转发唤醒**。flume = 渡槽：只负责把水从这头运到那头。

核心是 **flume + AgentInbox**。事件源和唤醒器是可替换角色；GitHub 和 herdr 是当前示例。

## 0. 问题

本地 agent loop 需要感知外部系统的事件。把轮询放在 agent 侧，每接一个系统就会
把 SDK、webhook、重试、去重和回调路由吸进 runtime，形成
connector gravity。

flume 把这些事件翻译成一层薄桥：可靠性语义交给 AgentInbox，业务判断留在 agent
侧，唤醒交给可替换的唤醒器。

## 1. 核心与可替换角色

```text
事件源 → flume → AgentInbox → 唤醒器 / agent
```

| 角色 | 是否核心 | 负责 |
| :--- | :--- | :--- |
| flume | 核心 | 验签、归一、无状态喂入、唤醒转发、进程入口 |
| AgentInbox | 核心 | 去重、持久化、订阅匹配、inbox/ack、activation |
| 事件源 | 可替换 | 产生事件并按自身机制投递；当前示例是 GitHub |
| 唤醒器 | 可替换 | 把 activation 变成一次 agent turn；当前示例是 herdr |
| agent 侧 | 部署决定 | 读 inbox、决定是否建 task、按自己的 playbook 执行 |

GitHub 和 herdr 是当前示例；adapter 和唤醒器都按部署替换，核心处理链路不变。

## 2. 分层与所有权

```text
事件源                  Adapter（示例：GitHub、GitLab）
   │  webhook
   ▼
flume                   验签 · 归一 · 喂入
   │  feedFn(envelope, { sourceId })
   ▼
AgentInbox              去重 · 持久化 · 订阅 · inbox · activation
   │  activation_only webhook
   ▼
flume                   校验四字段 · 调用唤醒器
   │  wake
   ▼
agent 侧                coordinator 读 inbox · intake · task orchestration
```

| 层 | 负责 | 边界由谁承担 |
| :--- | :--- | :--- |
| 事件源（示例 GitHub） | 产生事件、按自身机制投递重试 | — |
| flume | 接收、验签、归一、无状态喂入、唤醒转发、进程入口 | 队列、重试、去重、持久化、唤醒决策由 AgentInbox 承担 |
| AgentInbox | durable stream、native-id 去重、订阅过滤、inbox/ack、唤醒租约 | 业务判据由 agent 侧承担 |
| agent 侧 | turn 队列；`workflow-event-intake` 的 read/classify/route/ack；任务执行层的编排 | 事件接入细节由 flume / AgentInbox 承担 |

## 3. 三条红线

1. **flume 零状态**：状态写入 AgentInbox，重试、去重和持久化也由它承担。
   flume 挂掉会留下事件丢失窗口，这是为“永不长出第二份真相”付出的代价。
2. **唤醒 ≠ 授权**：activation 只带四个唤醒字段；正文回 AgentInbox `inbox read`。
   是否处理、是否建 task 由 agent 侧按 inbox 内容判断。
3. **复用 AgentInbox 的模型**：使用 host/source/subscription 拓扑，实现留在
   AgentInbox；等待语义留在唤醒器和 agent 侧。

## 4. 一条事件的生命周期

完整时序图只在 README 维护：[一条 GitHub PR 事件的完整时序](../README.md#event-flow)。

1. 事件源发出 webhook；当前示例是 GitHub 的 `pull_request.opened` → `POST /github`。
2. flume 验签，把 payload 归一成 envelope。
3. flume 调用 AgentInbox source event 接口；`native_id` 使用上游投递 ID。
4. AgentInbox 落 durable stream，按 subscription 匹配 agent，写入 inbox entry。
5. AgentInbox 向 flume `POST /activation`，只带
   `kind/newEntryCount/latestEntryId/summary`。
6. flume 校验字段，调用配置的唤醒器。
7. agent coordinator 收到唤醒后：
   - `inbox read` 取正文（有界批次）
   - 按 source policy 把事件映射成 intent
   - 只把可执行事件建/更新为 task
   - `ack --through` 只确认已审过的条目

前六步只做搬运和叫醒。`read / 进件 / ack` 归 agent 侧；worker 只处理 task brief，
AgentInbox 细节留在 coordinator。

## 5. activation 到 agent

inbox entry id 由 AgentInbox 生成：source event 写入后，AgentInbox 通过 activation
带上 `newEntryCount` 和 `latestEntryId`。flume 等这次写入完成后唤醒 agent。

当前示例路径是执行唤醒器命令：

```text
wake <coordinator-agent> "<固定唤醒文本>"
```

prompt 只包含配置中的 `agentId`、经过校验的 `newEntryCount`、intake skill 路径和
固定指令；`latestEntryId` 和 `summary` 留在 flume 日志中。flume 把 skill 路径交给
agent，由 agent 加载执行。coordinator 用 AgentInbox skill 读取 inbox，再读取
`FLUME_AGENTINBOX_INTAKE_SKILL` 指向的策略文件。

agent 侧分三层：

```text
coordinator
  └─ workflow-event-intake        dispatcher：read → classify → route → ack
      ├─ sources/<source>.md      source policy：事件到 intent、命令、去重键
      └─ task execution layer     playbook、角色、门槛、verdict
          └─ review playbook      review 的具体流程
```

intake 只决定“做不做、做哪个 task”：`REVIEW_REQUEST` 建 task 并派工，
`FEEDBACK` 找回已有 task 并把原文交回去，`ISSUE_UPDATE` 交回已有 task 或入队，
`LIFECYCLE` 更新/关闭 task，`NOISE` 只 ack。review 的判据和步骤归任务执行层的
`review` playbook。策略可以显式允许 review task 派工；approve / merge / close
由人类明确指令触发。

flume 仓库提供 `templates/workflow-event-intake/` 作为起点。复制到 agent workspace，
修改 `sources/github.md`（或新增 source policy），再把
`FLUME_AGENTINBOX_INTAKE_SKILL` 指向复制后的 `SKILL.md`。activation payload 出现
`entries` / `items` 等正文时，flume 返回 400。

`FLUME_HERDR_WAKE_AGENT` 指定当前 herdr 示例中的 coordinator agent 名；workspace
名独立配置。超时由 `FLUME_HERDR_WAKE_TIMEOUT` 控制。

### 5.1 HTTP 唤醒兼容模式

如果未设置 `FLUME_HERDR_WAKE_AGENT`，但设置了 `FLUME_HERDR_WAKE_URL`，flume 会
POST 四字段并带 `X-Flume-Activation-Mode: activation_only`：

```http
POST <FLUME_HERDR_WAKE_URL>
Content-Type: application/json
X-Flume-Activation-Mode: activation_only

{
  "kind": "agentinbox.activation",
  "newEntryCount": 2,
  "latestEntryId": "entry-42",
  "summary": "2 new GitHub events"
}
```

这是外部 HTTP 唤醒器的兼容接口；herdr 示例走命令唤醒。两种模式都只尝试一次，
失败交给 AgentInbox 重试。

| activation 字段 | agent 侧语义 |
| :--- | :--- |
| `kind` | 必须是 `agentinbox.activation` |
| `newEntryCount` | `> 0` 才唤醒；`0` 是空激活 |
| `latestEntryId` | `inbox read` 后执行 `ack --through <latestEntryId>` |
| `summary` | 只用于显示与日志；授权依据来自 inbox |

唤醒器失败时 flume 向 AgentInbox 返回 502，由 AgentInbox 的投递机制重试。

## 6. envelope

flume 内部唯一事件形状，adapter 负责把各家 payload 折成它：

```json
{
  "native_id": "供应商投递 UUID，去重键",
  "event": "pull_request.opened",
  "occurred_at": "2026-10-23T07:00:00+08:00",
  "source": "github",
  "subject": "owner/repo#42",
  "payload": {}
}
```

| 字段 | 要求 |
| :--- | :--- |
| `native_id` | 同一投递重试必须稳定；没有上游 ID 时对 raw body 做 SHA-256 |
| `event` | `<对象>.<动作>`，订阅过滤按它匹配 |
| `occurred_at` | ISO8601，取事件自身时间戳 |
| `source` | 系统名，等于 adapter 的 `NAME` |
| `subject` | 人可读对象定位，例如 `owner/repo#42` |
| `payload` | 供应商原始 JSON |

`native_id` 服务于收件箱去重，`event` 服务于订阅过滤，`subject` 服务于 coordinator
按项目/资源聚合。

## 7. 实现与接缝

### 7.1 入口与进程模型

用户只面对一个入口：

```bash
./run-flume.sh
```

脚本负责：

1. 解析仓库根目录并准备 Node.js PATH。
2. 按 `FLUME_ADAPTERS` 从环境或 Keychain 读取对应 secret。
3. 默认设置 source、绑定地址、端口和唤醒目标。
4. 缺少依赖或构建产物时执行 `npm install` / `npm run build`。
5. `exec node dist/src/cli.js start`。

启动时 flume 探测 `~/.agentinbox/agentinbox.sock`：

- 已有 daemon → attach，沿用其生命周期。
- 需要 autostart → spawn `agentinbox serve` 并 owned。
- autostart 关闭 → 等待已有 daemon，超时退出。

生产环境使用一个用户级 LaunchAgent，label 固定为 `com.flume`。事件源不影响 job
名称；GitHub / GitLab 由 `FLUME_ADAPTERS` 选择。AgentInbox 的生命周期由 flume
管理：flume 启动时 attach 已有 daemon，或启动并持有自己的 daemon。

### 7.2 feed 接缝

`src/core.ts` 暴露 `FeedFunction`：`feedFn(envelope, { sourceId })`。
`src/feed.ts` 是当前 AgentInbox 默认实现，HTTP 优先、CLI 兜底：

| 通道 | 实现 | 取舍 |
| :--- | :--- | :--- |
| HTTP（默认） | `POST /sources/{id}/events`，unix socket | 快；HTTP 面相对稳定 |
| CLI（后备） | spawn `agentinbox source event` | 最朴素，容错兜底 |

CLI 使用默认 feed；嵌入 `createFlumeServer` 时可以注入别的 feed。

### 7.3 替换点

| 角色 | 接口或落点 | 换实现要做什么 | 当前示例 |
| :--- | :--- | :--- | :--- |
| 事件源 | `src/adapters/index.ts` 的 `Adapter` | 实现 `NAME` / `SECRET_ENV` / `verify` / `normalize`，加入 `ADAPTERS` 和 `FLUME_ADAPTERS` | `github`、`gitlab`；路由为 `/NAME` |
| 收件箱 | `src/core.ts` 的 `FeedFunction`，默认 `src/feed.ts` | 嵌入时注入 `feedFn`；换 CLI 默认还要改入口和配置 | AgentInbox |
| 唤醒器 | `src/activation.ts` 的 `dispatchHerdrPrompt` / `dispatchActivation` | 改 `activation.ts`；外部 HTTP 唤醒器可先用 URL 模式 | herdr；`dispatchHerdrPrompt` 直连 |

事件源使用 `Adapter` 接口；收件箱通过 `FeedFunction` 注入；唤醒器通过
`dispatchHerdrPrompt` 或 HTTP 模式接入。三个接缝按当前接口扩展。

### 7.4 实现边界

- fork 会把耦合钉在实现上，后续持续承担 rebase 成本。
- AgentInbox 的远程模块扩展面已 deprecated；当前走 local_event host 的受支持用法。
- 新 adapter 先在真实事件中验证 envelope、归一表和 `native_id` 语义。

## 8. 扩展 adapter

新增一个事件源只需要：

```typescript
export const NAME = "jira";
export const SECRET_ENV = "FLUME_JIRA_TOKEN";
export function verify(headers, body, secret): boolean;
export function normalize(headers, body, document): Envelope;
```

然后在 `src/adapters/index.ts` 注册。`SECRET_ENV` 自动进入启动必填名单。
adapter 负责验签和折 envelope；排队、重试、落盘、过滤和唤醒决策由 AgentInbox
与唤醒器承担。

测试至少覆盖：

1. `normalize` 典型 payload → envelope。
2. `native_id` 同一投递稳定、不同投递不同。
3. `event` / `subject` 关键分支。
4. token 正确、错误和缺失。

完整代码示例见 [`ADAPTERS.md`](ADAPTERS.md)。

## 9. 错误码与测试

| 码 | 含义 |
| :--- | :--- |
| 202 | 已接收 / 已唤醒 |
| 400 | 非 JSON、envelope 非法、activation 带正文或字段非法 |
| 401 | token 错 |
| 403 | 非 loopback 访问 `/activation` |
| 413 | body 超过 8 MiB |
| 502 | AgentInbox 拒收，或唤醒命令 / HTTP 目标失败 |
| 503 | activation 合法但未配置唤醒目标 |

测试分四类：

1. adapter 纯函数：payload → envelope，重点 `native_id` 和事件命名。
2. HTTP 门面：mock feed，断言 202 与喂入参数。
3. 错误路径：400 / 401 / 413 / 502。
4. activation：直接唤醒命令、HTTP 兼容模式、四字段合同和正文拒收。

## 10. 职责边界

- 队列、重试和死信由 AgentInbox 负责。
- 事件存储与回放由 AgentInbox durable stream 负责。
- 业务过滤由 AgentInbox subscription 负责。
- 唤醒策略（退避、租约、攒批）由 AgentInbox 通知策略和唤醒器 turn 调度负责。
- 事件源变更通过 webhook → AgentInbox activation 驱动。
- flume 通过 AgentInbox 的公开 host/source API 集成，仓库、依赖和发布保持独立。
