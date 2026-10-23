# flume：外部事件 → 本地 agent 的打通架构

> 状态：v0.1 草案（2026-10-23）。flume 命名自渡槽——只负责把水从这头运到那头。
> 关联：projects/flume（实现）、holon-run/agentinbox（收件箱）、herdr-projects（agent loop）

## 0. 问题

herdr / codex / claude 等本地 agent loop 需要感知外部系统（内网 GitLab 的 MR、CI、评论）的事件，但不能靠 agent 自己轮询：轮询住在 agent 侧，每接一个系统就多一份 connector gravity（SDK、webhook、重试、回调路由全被吸进 runtime）。

结论：**事件翻译成一层薄桥，可靠性语义全部留给收件箱，唤醒决策留在 agent 侧。**

## 1. 四层所有权

```
外部系统        GitLab（内网）· 未来更多源
   │  webhook POST
   ▼
flume           验签 · 归一 · 喂入 · activation 转发   ← 零状态翻译层（本项目）
   │  agentinbox source event
   ▼
AgentInbox      stream · 订阅 · inbox · ack · activation   ← 可靠性语义
   │  webhook（activation_only）
   ▼
flume /activation  validation · forward（不读正文）
   │  POST activation_only
   ▼
herdr           唤醒门 · 等待表 · 授权门 · agent loop        ← 决策与执行
```

| 层 | 拥有什么 | 绝不拥有 |
|---|---|---|
| 外部系统 | 事件源、投递重试 | — |
| flume | webhook 入口、验签、归一化、activation_only 无状态转发 | 队列、重试、去重、持久化、唤醒决策 |
| AgentInbox | durable stream、native-id 去重、订阅过滤、inbox/ack、唤醒租约 | 业务判据 |
| herdr | wake_condition、授权、开 turn、任务语义 | 事件接入细节 |

### 红线（不许越界）

1. **flume 零状态**：不在内存外存任何东西。重试、去重、持久化是 AgentInbox 的活。flume 挂了 = 事件丢失窗口，这是刻意的取舍——换来的是永不长出第二份真相。
2. **唤醒 ≠ 授权**：AgentInbox 的 activation target 用 activation_only 模式，只叫醒不推正文；正文必须回 inbox read。开不开 turn 由 herdr 唤醒门按等待表判据决定。
3. **协议抄拓扑不抄**：接 AgentInbox 用它的 host/source/subscription 模型，不照搬它的实现；等待语义（等什么条件）留在 herdr 等待表，不搬进 subscription filter。

## 2. 事件生命周期（一条 MR 事件的一生）

1. GitLab 发出 merge_request.opened webhook → POST flume
2. flume 验 X-Gitlab-Token，解析 payload，归一成 envelope
3. flume 调 agentinbox source event，native-id 用 GitLab 的 event_uuid（天然去重）
4. AgentInbox 落 durable stream，按 subscription 匹配到目标 agent，写 inbox entry
5. AgentInbox 生成 activation_only payload，POST flume `/activation`
6. flume 校验并转发四个激活字段到 herdr 唤醒门（不转发正文）
7. 唤醒门查等待表 wake_condition：
   - 命中 → 过授权门 → 开 turn，agent inbox read 取正文，干完 ack --through <entryId> 销账
   - 未命中 → 不开 turn，条目留待，不烧钱

判据分叉在第 7 步。前六步纯搬运，不许长出判断。

### 2.1 唤醒链路真对接

`agentinbox source event` 只返回 append 结果，不返回 inbox entry id；
`newEntryCount` 和 `latestEntryId` 只有订阅匹配、写入 inbox 之后才存在。所以 flume
不能在 feed 返回时自己编一个 entry id，而是接收 AgentInbox 写箱后发出的 activation
webhook，再把它无状态转发给 herdr 唤醒门。

AgentInbox 的 webhook target 指向 flume：

```bash
agentinbox agent register --agent-id <herdr-agent> \
  --webhook-url http://<flume>:9420/activation \
  --webhook-activation-mode activation_only
```

flume 的转发目标由 `FLUME_HERDR_WAKE_URL` 指定，超时由
`FLUME_HERDR_WAKE_TIMEOUT`（默认 5 秒）指定。收到合法 activation 后，flume 只发出
一次下面的 HTTP 请求；它不排队、不重试、不落盘。

```http
POST <FLUME_HERDR_WAKE_URL>
Content-Type: application/json
Accept: application/json
X-Flume-Activation-Mode: activation_only

{
  "kind": "agentinbox.activation",
  "newEntryCount": 2,
  "latestEntryId": "entry-42",
  "summary": "2 new GitLab events"
}
```

AgentInbox 的原始 activation 还会带 `activationId`、`agentId`、`inboxId`、
`targetId` 等路由元数据；flume 只校验并转发唤醒门需要的四个字段。任何
`entries` / `items`（正文）出现时直接拒绝，不能把正文带进唤醒链路。

herdr 唤醒门把四个字段映射成等待表判据：

| activation 字段 | 等待表含义 |
|---|---|
| `kind` | 必须是 `agentinbox.activation`；其他 kind 不进入唤醒链路 |
| `newEntryCount` | 「等什么」：`> 0` 才叫醒并允许开 turn；`0` 是空激活，不调用唤醒门 |
| `latestEntryId` | 「等到什么算完成」：agent 回 `inbox read` 取正文，处理完执行 `ack --through <latestEntryId>` |
| `summary` | 只用于显示与日志，不参与授权判断，也不能替代 inbox 正文 |

等待表合同可表示为：

```json
{
  "waitFor": {"kind": "agentinbox.activation", "newEntryCountAtLeast": 1},
  "newEntryCount": 2,
  "latestEntryId": "entry-42",
  "summary": "2 new GitLab events",
  "completeWhen": {"kind": "inbox.ack", "through": "entry-42"}
}
```

**唤醒 ≠ 授权。** flume 只把 activation 交给唤醒门，不决定是否开 turn；唤醒门命中后
仍要过授权门，正文仍要回 `inbox read`。唤醒门返回非 2xx 时 flume 向 AgentInbox 回
502，由 AgentInbox 的投递机制重试。

## 3. 归一 envelope

flume 内部唯一事件形状，adapter 负责把各家 payload 折成它：

```json
{
  "native_id": "供应商投递 UUID，去重键",
  "event": "merge_request.opened",
  "occurred_at": "2026-10-23T07:00:00+08:00",
  "source": "gitlab",
  "subject": "group/project!123",
  "payload": { }
}
```

- native_id：必须稳定。同一投递多次到达 → 同一 id → AgentInbox 自动 dedupe。
- event：<对象>.<动作>，订阅过滤按它匹配。
- subject：人可读的对象定位（MR / issue / pipeline），等待表判据用它对齐。

## 4. 工作模式

### 4.1 接入一个新系统 = 写一个 adapter

```
src/adapters/<system>.py   →   verify(req) + normalize(req) -> Envelope
```

core 不动。adapter 只做两件事：验签、折 envelope。**不许在 adapter 里排队、重试、落盘。**

### 4.2 无 webhook 的系统

轮询不消失，但被隔离：单独 poller 进程拉取 → 折 envelope → 喂 flume 的统一入口。agent 侧永远不碰轮询。

### 4.3 部署约束

- flume 与 AgentInbox daemon **同机**（AgentInbox HTTP API 只监听 loopback/unix socket）
- GitLab webhook 指向 flume 的内网口；token 走环境变量，不进仓库
- herdr 在哪，这套就部署在哪；`FLUME_HERDR_WAKE_URL` 是 herdr 唤醒门的入口

### 4.4 AgentInbox 侧一次性配置

```bash
agentinbox host add local_event flume
agentinbox source add <host_id> events gitlab
agentinbox subscription add <source_id> --agent-id <herdr-agent>
agentinbox agent register --agent-id <herdr-agent> \
  --webhook-url http://<flume>:9420/activation \
  --webhook-activation-mode activation_only
```

source 共享、subscription 私有——**别一个 PR 一个 source**。

## 5. 明确不做的事

- 不做第二套投递（队列/重试/死信）——AgentInbox 已有
- 不做事件存储/回放——durable stream 已有
- 不做业务过滤（只关心我的 MR）——subscription 已有
- 不做唤醒策略（退避/租约/攒批）——AgentInbox 通知策略 + herdr 授权门已有

## 6. 接入 runbook（内网 GitLab）

### 6.1 AgentInbox 一次性配置

```bash
agentinbox daemon start
agentinbox host add local_event flume            # → hst_...
agentinbox source add <host_id> events gitlab    # → src_...，填进 AGENTINBOX_SOURCE_ID
agentinbox agent register --agent-id <herdr-agent> \
  --webhook-url http://<flume>:9420/activation \
  --webhook-activation-mode activation_only
agentinbox subscription add <source_id> --agent-id <herdr-agent>
```

已实测参数面：`agentinbox source event <sourceId> --native-id --event --occurred-at --metadata-json --payload-json`。无 `--subject`，subject 走 `--metadata-json`。

### 6.2 启动 flume

```bash
cd projects/flume
FLUME_GITLAB_TOKEN=<token> \
AGENTINBOX_SOURCE_ID=<src_id> \
FLUME_HERDR_WAKE_URL=http://<herdr唤醒门> \
PYTHONPATH=src python3 -m flume
# 默认 127.0.0.1:9420；给 GitLab 打时 FLUME_BIND=0.0.0.0
```

### 6.3 GitLab webhook 配置清单

群组或项目 → Settings → Webhooks：

| 项 | 值 |
|---|---|
| URL | `http://<flume机器内网IP>:9420/gitlab` |
| Secret token | 与 `FLUME_GITLAB_TOKEN` 一致 |
| 触发事件 | Merge request / Pipeline / Comments / Push |
| SSL verification | 内网 HTTP 可关 |
| 冒烟 | 点 Push events 测试 → 期望 `202 {"accepted":1}` |

### 6.4 链路验证三步

```bash
# 1. flume 吃进去
curl -X POST http://127.0.0.1:9420/gitlab -H "X-Gitlab-Token: $TOKEN" -d @sample-mr.json
# 2. AgentInbox 看到
agentinbox inbox read --agent-id <herdr-agent>
# 3. herdr 唤醒门收到 activation_only 的四个字段（只叫醒，不推正文）
```

判据：inbox 出现 entry + herdr 唤醒门收到 `kind: agentinbox.activation`，且
`newEntryCount` / `latestEntryId` 与 inbox 一致。两条都到，链路才算通。
