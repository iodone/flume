# flume 架构与设计

> 状态：设计定稿（2026-10-23）。
> flume = 渡槽：只负责把水从这头运到那头。
> 技术形态：Node/TS，与 AgentInbox 同生态，单一入口 `flume start`。

---

## 0. 问题

herdr / codex / claude 等本地 agent loop 需要感知外部系统（内网 GitLab 的 MR、CI、评论）的事件，但不能靠 agent 自己轮询：轮询住在 agent 侧，每接一个系统就多一份 connector gravity（SDK、webhook、重试、回调路由全被吸进 runtime）。

解法：**事件翻译成一层薄桥，可靠性语义全部留给收件箱，唤醒决策留在 agent 侧。**

## 1. 四层所有权

```
外部系统        GitLab（内网）· 未来更多源
   │  webhook POST
   ▼
flume           验签 · 归一 · 喂入          ← 零状态翻译层 + 单一入口
   │  POST /sources/{id}/events
   ▼
AgentInbox      stream · 订阅 · inbox · ack · activation   ← 可靠性语义
   │  webhook（activation_only）
   ▼
herdr           唤醒门 · 等待表 · 授权门 · agent loop        ← 决策与执行
```

| 层 | 拥有什么 | 绝不拥有 |
| :--- | :--- | :--- |
| 外部系统 | 事件源、投递重试 | — |
| flume | webhook 入口、验签、归一化、进程入口 | 队列、重试、去重、持久化 |
| AgentInbox | durable stream、native-id 去重、订阅过滤、inbox/ack、唤醒租约 | 业务判据 |
| herdr | wake_condition、授权、开 turn、任务语义 | 事件接入细节 |

## 2. 三条红线

1. **flume 零状态**：不在内存外存任何东西。重试、去重、持久化是 AgentInbox 的活。flume 挂了 = 事件丢失窗口，这是刻意的取舍——换来的是永不长出第二份真相。
2. **唤醒 ≠ 授权**：activation target 用 activation_only 模式，只叫醒不推正文；正文必须回 inbox read。开不开 turn 由 herdr 唤醒门按等待表判据决定。
3. **协议抄拓扑不抄**：接 AgentInbox 用它的 host/source/subscription 模型，不照搬它的实现；等待语义（等什么条件）留在 herdr 等待表，不搬进 subscription filter。

## 3. 事件生命周期

一条 MR 事件的一生：

1. GitLab 发出 `merge_request.opened` webhook → POST flume
2. flume 验 `X-Gitlab-Token`，解析 payload，归一成 envelope
3. flume 打 `POST /sources/{id}/events`，native-id 用 GitLab 投递 UUID（天然去重）
4. AgentInbox 落 durable stream，按 subscription 匹配到目标 agent，写 inbox entry
5. AgentInbox 以 activation_only webhook 唤醒 herdr 唤醒门
6. 唤醒门查等待表 wake_condition：
   - 命中 → 过授权门 → 开 turn，agent inbox read 取正文，干完 ack --through 销账
   - 未命中 → 不开 turn，条目留待，不烧钱

判据分叉在第 6 步。前三步纯搬运，不许长出判断。

## 4. 归一 envelope

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

| 字段 | 要求 |
| :--- | :--- |
| native_id | 必须稳定：同一投递重试 → 同一 id → AgentInbox 自动 dedupe |
| event | <对象>.<动作>，订阅过滤按它匹配 |
| occurred_at | ISO8601，取事件自身时间戳 |
| source | 系统名（= adapter 的 NAME） |
| subject | 人可读对象定位，等待表判据用它对齐 |
| payload | 供应商原始 payload，不裁剪 |

## 4.5 知识接线：herdr 怎么知道要用 AgentInbox

**答案：不注入。知识常驻，唤醒只传指针。**

| 机制 | 内容 | 时机 |
| :--- | :--- | :--- |
| 常驻知识 | agentinbox 操作规程（read / ack --through / 不用 --all）写进 herdr 的 rules_file（AGENTS.md）或 skill | 一次性接线 |
| 流动数据 | 事件指针（entryId / subject / summary） | 每次唤醒 |

三条理由：

1. **Runner 无记忆**：run 的唯一记忆是任务系统、代码库、编排器三样。唤醒时临时注入的操作指南不在这三样里 = 隐性知识，迟早丢
2. **activation_only 契约**：唤醒 payload 里塞操作手册就变成「推内容」，唤醒 ≠ 授权的边界当场烂掉
3. **知识与数据分家**：规程是常驻知识，事件是流动数据。混在一次注入里，知识要靠运气活到下一次 run

开 turn 的 brief 最多带一个 `entryId` 数据指针——那是路由信息，不是说明书。

## 5. 技术形态

### 5.1 Node/TS 同生态

| 理由 | 说明 |
| :--- | :--- |
| 系统只有一个运行时 | AgentInbox 本体钉死 Node；再引入第二个运行时是系统级负债 |
| 与上游同生态 | 终局是把 gitlab adapter 贡进 AgentInbox（其 adapter 层就是 TS）。TS 写的翻译层是可搬运资产 |
| 一条命令安装 | npm dependency 把 AgentInbox 一起带到，用户只面对一个入口 |

### 5.2 单一入口：flume start（ensure ≠ own）

AgentInbox 的 npm 包只有 bin（CLI/daemon 入口），没有可 import 的库面——它是进程不是库。所以「同源」= 同生态、同安装面、最终上游化；**不是** import 它的内部模块或融成一个仓库。

`flume start` 语义：

```
1. 探 ~/.agentinbox/agentinbox.sock
   ├─ 活着 → attach，不碰它的生命周期
   └─ 没有 → spawn `agentinbox serve` 子进程，own 它
2. 开 webhook 门（FLUME_BIND:FLUME_PORT）
3. 退出只收自己 spawn 的子进程
```

**ensure ≠ own**：daemon 是共享基础设施，codex / claude / herdr 都可能是它的租户。确保活着是服务，占有生命周期是越权。

### 5.3 feed：唯一接缝

唯一接缝在 feed 一个模块，两种取向：

| 取向 | 通道 | 取舍 |
| :--- | :--- | :--- |
| HTTP（默认） | POST /sources/{id}/events，unix socket | 快一个数量级；resource-oriented HTTP 面是声明 stable 的 |
| CLI（后备） | spawn agentinbox source event | 最朴素，容错兜底 |

换收件箱、换通道，只动这一个模块。adapter、envelope、core 一行不改。

### 5.4 不 fork、不上插件

- fork = 把耦合钉在实现上，此后永久 rebase 税。实测 AgentInbox 的存储边界在大版本里推倒重来过，fork 的 diff 跟不动
- 它的远程模块扩展面已 deprecated，官方扩展口就是 local_event host——flume 走的正是它设计的用法
- 上游 PR 是终局不是今天。flume 先把 envelope 形状、归一表、native_id 语义在真实事件里趟出来，搬进上游时心里有底

桥胖了（多 adapter 到几千行）就是自毁检查点：要么上游化，要么承认它不是桥。

## 6. 工作模式

### 6.1 接入一个新系统 = 写一个 adapter

```
src/adapters/<system>.ts   →   verify() + normalize() -> Envelope
```

core 不动。adapter 只做两件事：验签、折 envelope。不许在 adapter 里排队、重试、落盘、过滤。

### 6.2 无 webhook 的系统

轮询不消失，但被隔离：单独 poller 进程拉取 → 折 envelope → 喂 flume 统一入口。agent 侧永远不碰轮询。

### 6.3 部署

- flume 与 AgentInbox daemon 同机（其 HTTP API 只监听 loopback/unix socket）
- GitLab webhook 指向 flume 的内网口；token 走环境变量，不进仓库
- herdr 在哪，这套就部署在哪；唤醒门 URL 是 herdr coordinator 的入口

AgentInbox 侧一次性配置：

```bash
agentinbox host add local_event flume
agentinbox source add <host_id> events gitlab
agentinbox agent register --agent-id <herdr-agent> --webhook-url <唤醒门>
agentinbox subscription add <source_id> --agent-id <herdr-agent>
```

source 共享、subscription 私有——别一个 PR 一个 source。

## 7. 落地路径

### 阶段一：核心通道（先把 GitLab 打通）

- envelope + gitlab adapter（验签 / 归一 / native_id 稳定性）
- feed 打通 unix socket HTTP（CLI 后备）
- 单一入口 flume start（ensure ≠ own）
- 端到端验收：假 MR 事件 → 202 → inbox entry → 唤醒门命中

### 阶段二：接 herdr（唤醒变决策）

- 唤醒门接 activation payload
- 等待表 wake_condition 判据对齐 subject / event
- 授权门落位：唤醒 ≠ 授权的运行时体现
- 端到端验收：真实 GitLab 事件 → 唤醒 → 判据命中才开 turn

### 阶段三：扩展与上游化

- 第二个 adapter（Jira / 告警 / 其他），验证「core 不动」的承诺
- 无 webhook 源接隔离 poller
- envelope 形状稳定后，向 AgentInbox 上游提 gitlab source PR，flume 转为过渡层

## 8. 实施要点

### 目录

```
projects/flume/
  package.json          # dependency: @holon-run/agentinbox；bin: flume
  docs/ARCHITECTURE.md  # 本文件
  src/
    index.ts            # 入口：start / ensure daemon / 开门
    core.ts             # HTTP 门面：verify -> normalize -> feed
    envelope.ts         # Envelope 形状与校验
    feed.ts             # 唯一接缝：HTTP 默认 / CLI 后备
    adapters/
      index.ts          # 注册表
      gitlab.ts
  test/
```

### adapter 契约（四符号）

```typescript
export const NAME = "jira";                    // 路由段 POST /jira，全局唯一
export const SECRET_ENV = "FLUME_JIRA_TOKEN";  // secret 环境变量名
export function verify(headers, body, secret): boolean;   // true 放行，false 回 401
export function normalize(headers, body, document): Envelope;
```

SECRET_ENV 自动进必填名单，缺了直接 exit 2，不带病启动。

### 错误码

| 码 | 含义 |
| :--- | :--- |
| 202 | accepted，已喂入 |
| 400 | 非 JSON / envelope 不合法 |
| 401 | token 错 |
| 413 | body 超 8MB |
| 502 | AgentInbox 没收下（不重试，交上游投递重试） |

### 测试三类

1. normalize 纯函数：典型 payload → envelope（重点 native_id 稳定性、event 命名）
2. 端到端冒烟：mock feed，POST 假 webhook，断言 202 与喂入参数
3. 错误路径：401 / 400 / 502 / 413

### 配置

| 变量 | 默认 | 说明 |
| :--- | :--- | :--- |
| AGENTINBOX_SOURCE_ID | 必填 | 目标 source |
| FLUME_GITLAB_TOKEN | 必填 | GitLab webhook secret |
| FLUME_BIND | 127.0.0.1 | 给内网打时改 0.0.0.0 |
| FLUME_PORT | 9420 | 监听端口 |

token 不进仓库、不进日志、不进响应体。

## 9. 明确不做的事

- 不做第二套投递（队列/重试/死信）——AgentInbox 已有
- 不做事件存储/回放——durable stream 已有
- 不做业务过滤——subscription 已有
- 不做唤醒策略（退避/租约/攒批）——AgentInbox 通知策略 + herdr 授权门已有
- 不 import AgentInbox 内部模块、不 fork、不融仓库
