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
flume           验签 · 归一 · 喂入        ← 零状态翻译层（本项目）
   │  agentinbox source event
   ▼
AgentInbox      stream · 订阅 · inbox · ack · activation   ← 可靠性语义
   │  webhook（activation_only）
   ▼
herdr           唤醒门 · 等待表 · 授权门 · agent loop        ← 决策与执行
```

| 层 | 拥有什么 | 绝不拥有 |
|---|---|---|
| 外部系统 | 事件源、投递重试 | — |
| flume | webhook 入口、验签、归一化 | 队列、重试、去重、持久化 |
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
5. AgentInbox 以 activation_only webhook 唤醒 herdr 唤醒门
6. 唤醒门查等待表 wake_condition：
   - 命中 → 过授权门 → 开 turn，agent inbox read 取正文，干完 ack --through <entryId> 销账
   - 未命中 → 不开 turn，条目留待，不烧钱

判据分叉在第 6 步。前三步纯搬运，不许长出判断。

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
- herdr 在哪，这套就部署在哪；唤醒门 URL 是 herdr coordinator 的入口

### 4.4 AgentInbox 侧一次性配置

```bash
agentinbox host add local_event flume
agentinbox source add <host_id> events gitlab
agentinbox subscription add <source_id> --agent-id <herdr-agent>
agentinbox agent register --agent-id <herdr-agent> --webhook-url <唤醒门>
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
agentinbox agent register --agent-id <herdr-agent> --webhook-url http://<herdr唤醒门>
agentinbox subscription add <source_id> --agent-id <herdr-agent>
```

已实测参数面：`agentinbox source event <sourceId> --native-id --event --occurred-at --metadata-json --payload-json`。无 `--subject`，subject 走 `--metadata-json`。

### 6.2 启动 flume

```bash
cd projects/flume
FLUME_GITLAB_TOKEN=<token> AGENTINBOX_SOURCE_ID=<src_id> PYTHONPATH=src python3 -m flume
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
# 3. 唤醒门被打到（activation_only，只叫醒不推正文）
```

判据：inbox 出现 entry + 唤醒门收到 `kind: agentinbox.activation`。两条都到，链路才算通。
