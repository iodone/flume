# flume

外部 webhook → AgentInbox 事件的零状态翻译层。命名自渡槽：只负责把水从这头运到那头。

架构合同：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 是什么

```
外部系统 ──webhook POST──▶ flume ──agentinbox source event──▶ AgentInbox
                        验签·归一·喂入                │
                                                      │ activation_only
                                                      ▼
                                      flume /activation ──▶ herdr 唤醒门
```

flume 做三件事，且只做三件事：

1. **验签**：按 adapter 校验来源（GitLab 用 `X-Gitlab-Token`）
2. **归一**：把各家 payload 折成统一的 envelope（`native_id` / `event` / `occurred_at` / `source` / `subject` / `payload`）
3. **喂入**：调一次 `agentinbox source event`，把事件交给收件箱

另有一条无状态旁路：AgentInbox 的 activation_only webhook 打到 flume `/activation`，
flume 校验 `kind/newEntryCount/latestEntryId/summary` 后转发给 herdr 唤醒门。它不读、
不转发 `entries` / `items`，也不决定要不要开 turn。

## 红线（与合同一致）

1. **flume 零状态**：不在内存外存任何东西。重试、去重、持久化是 AgentInbox 的活。flume 挂了 = 事件丢失窗口，这是刻意的取舍——换来的是永不长出第二份真相。
2. **唤醒 ≠ 授权**：AgentInbox 的 activation target 用 activation_only 模式，只叫醒不推正文；正文必须回 `inbox read`。开不开 turn 由 herdr 唤醒门按等待表判据决定。
3. **协议抄拓扑不抄**：接 AgentInbox 用它的 host/source/subscription 模型，不照搬它的实现；等待语义（等什么条件）留在 herdr 等待表，不搬进 subscription filter。

## 前置依赖

| 依赖 | 版本 | 用途 | 没有它会怎样 |
| :--- | :--- | :--- | :--- |
| Python | 3.11+ | 运行 flume 本体 | 启动即失败 |
| [AgentInbox](https://github.com/holon-run/agentinbox) CLI | 1.x | 喂入目标（`source event`） | feed 502，事件进不去 |
| AgentInbox daemon | 与 CLI 同版 | 接住事件、去重、分发、唤醒 | 同上 |
| Node.js | 22.23.4+ / 24 LTS | 跑 AgentInbox（它自身的依赖） | 装不了 AgentInbox |
| [uxc](https://github.com/holon-run/uxc) | 0.15.3+ | 仅当 AgentInbox 要接 GitHub/飞书/邮箱源时需要 | flume 本身不依赖；只是那类源配不了 |

说明：

- flume **只依赖 Python 标准库**，无第三方包；`pyproject.toml` 里 `dependencies` 为空是故意的。
- flume 与 AgentInbox daemon **必须同机部署**——AgentInbox 的 HTTP API 只监听 loopback / unix socket。
- 网络可达性：外部系统的 webhook 要能 POST 到 flume 的监听口（内网 GitLab 直接给内网 IP；跨网段时走隧道/relay）。

安装 AgentInbox：

```bash
npm install -g @holon-run/agentinbox
agentinbox daemon start
agentinbox daemon status        # 确认 running: true
```

## 使用流程

### 一次性：AgentInbox 侧建源

```bash
# 1. 建宿主（共享配置单元，一个就够）
agentinbox host add local_event flume            # → hst_...

# 2. 建 source（事件流，一个外部系统一个）
agentinbox source add <hst_id> events gitlab     # → src_...

# 3. 注册 agent 并挂唤醒 target（activation_only）
agentinbox agent register --agent-id <herdr-agent> \
  --webhook-url http://<flume>:9420/activation \
  --webhook-activation-mode activation_only

# 4. 订阅（agent 级过滤——source 共享，subscription 私有，别一个 PR 一个 source）
agentinbox subscription add <src_id> --agent-id <herdr-agent>
```

### 每次启动：起 flume

```bash
cd projects/flume

AGENTINBOX_SOURCE_ID=<src_id> \
FLUME_GITLAB_TOKEN=<token> \
FLUME_HERDR_WAKE_URL=http://<herdr唤醒门> \
PYTHONPATH=src python3 -m flume
# 默认 127.0.0.1:9420；给内网 GitLab 打时加 FLUME_BIND=0.0.0.0

# 或安装后
pip install -e . && flume
```

缺必填项进程直接退出（exit 2），不带病启动。

### 外部系统侧：配置 webhook（以内网 GitLab 为例）

群组或项目 → Settings → Webhooks：

| 项 | 值 |
| :--- | :--- |
| URL | `http://<flume内网IP>:9420/gitlab` |
| Secret token | 与 `FLUME_GITLAB_TOKEN` 一致 |
| 触发事件 | Merge request / Pipeline / Comments / Push |
| SSL verification | 内网 HTTP 可关 |
| 冒烟 | 点 Push events 测试 → 期望 `202 {"accepted":1}` |

### 验证链路

```bash
# 1. flume 吃进去
curl -X POST http://127.0.0.1:9420/gitlab -H "X-Gitlab-Token: $TOKEN" -d @sample-mr.json
# 2. AgentInbox 看到
agentinbox inbox read --agent-id <herdr-agent>
# 3. herdr 唤醒门收到 activation_only 的四个字段（只叫醒，不推正文）
```

判据：inbox 出现 entry + 唤醒门收到 `kind: agentinbox.activation`。两条都到，链路才算通。

## 配置

全部走环境变量，token 不进仓库、不进日志、不进响应体。

| 变量 | 默认 | 说明 |
| :--- | :--- | :--- |
| `AGENTINBOX_SOURCE_ID` | 必填 | 目标 source（共享一个 source） |
| `FLUME_GITLAB_TOKEN` | 必填 | GitLab webhook secret token |
| `FLUME_BIND` | `127.0.0.1` | 部署给内网 GitLab 打时改 `0.0.0.0` |
| `FLUME_PORT` | `9420` | 监听端口 |
| `AGENTINBOX_BIN` | `agentinbox` | AgentInbox CLI 路径 |
| `FLUME_HERDR_WAKE_URL` | 空 | herdr 唤醒门 HTTP(S) 地址；为空时 `/activation` 回 503 |
| `FLUME_HERDR_WAKE_TIMEOUT` | `5` | 唤醒门请求超时（秒） |

## 端点

| 方法 | 路径 | 结果 |
| :--- | :--- | :--- |
| `POST` | `/<adapter>`，如 `/gitlab` | `202 {"accepted":1}` 已喂入 · `400` 非 JSON / envelope 不合法 · `401` token 错 · `502` AgentInbox 没收下 · `413` body 超 8MB |
| `POST` | `/activation` | `202 {"accepted":1}` 已唤醒 · `202 {"accepted":0}` 空激活 · `400` payload 不合法或带正文 · `502` 唤醒门失败 · `503` 未配置唤醒门 |
| `GET` | `/healthz` | `200 {"ok":true}` |

**不重试**：`502` 交给上游自己的投递重试；同一投递重试时 `native_id` 不变，AgentInbox 自动 dedupe。

## 事件归一（内置 gitlab adapter）

| GitLab hook | event | subject |
| :--- | :--- | :--- |
| Merge Request Hook | `merge_request.<action>`（open→opened、merge→merged、close→closed…，缺 action 用 state） | `group/project!123` |
| Pipeline Hook | `pipeline.<status>`（success/failed/running…） | `group/project#88` |
| Note Hook | `note.created` | 被评论对象的 `group/project!123` 或 `#iid` |
| Push Hook | `push` | `group/project` |
| 其他 | `<object_kind>.received` | `group/project` |

`native_id` 优先取 `X-Gitlab-Event-UUID`，其次 `X-Gitlab-Webhook-UUID`；都没有时对 raw body 做 sha256——同一投递重试得到同一 id。

## 新增 adapter

一个 adapter = 一个外部系统的翻译器。core 不动，`adapters/` 加一个文件即可。

### 1. 写 `src/flume/adapters/<system>.py`

必须导出四个符号：

```python
NAME = "jira"                      # 路由段：POST /jira 打到这里，必须全局唯一
SECRET_ENV = "FLUME_JIRA_TOKEN"    # 该系统的 secret 走哪个环境变量

def verify(headers, body, secret) -> bool:
    """验签。返回 True=放行，False=core 回 401。token 永不进日志。"""

def normalize(headers, body, document) -> Envelope:
    """把 payload 折成 envelope。document = json.loads(body)。"""
```

`SECRET_ENV` 声明的环境变量会被 `Config` 自动收进必填名单——adapter 一注册、启动就必须有它，缺了 exit 2。

### 2. Envelope 字段约定

| 字段 | 要求 |
| :--- | :--- |
| `native_id` | **必须稳定**：同一投递重试 → 同一 id。优先取供应商投递 UUID，其次对 raw body 做 sha256。这是去重键 |
| `event` | `<对象>.<动作>`，如 `issue.created`、`deployment.finished`。订阅过滤按它匹配 |
| `occurred_at` | ISO8601。取事件自身的时间戳，别用收到时间 |
| `source` | 系统名（= `NAME`） |
| `subject` | 人可读对象定位（`project!123`、`cluster/app`），herdr 等待表判据用它对齐 |
| `payload` | 原样放供应商 payload，不做裁剪 |

### 3. 注册

`src/flume/adapters/__init__.py` 的 `_MODULES` 加一项：

```python
from . import gitlab, jira
_MODULES = (gitlab, jira,)
```

路由 `POST /jira` 自动生效，启动日志的 `adapters:` 列表会列出它。

### 4. 配置与 webhook

- secret 走 `SECRET_ENV` 声明的环境变量（如 `FLUME_JIRA_TOKEN`），与外部系统的 webhook secret 对齐
- 外部系统 webhook URL 指到 `http://<flume>:9420/<system>`
- 新系统的事件源要不要单独 `agentinbox source add`：**要**。一个系统一个 source，agent 侧再各自 subscription

### 5. 测试

`test/` 下至少覆盖三条：

1. `normalize` 纯函数：典型 payload → envelope 断言（尤其 `native_id` 稳定性、`event` 命名）
2. 端到端冒烟：mock `flume.feed.subprocess.run`，POST 假 webhook，断言 202 + feed 参数正确
3. 错误路径：token 错 401、坏 body 400、feed 炸 502

照 `test/test_gitlab.py` 的结构写即可。

### 纪律

adapter 只有两件事：**验签、折 envelope**。**不许排队、重试、落盘、过滤、唤醒、判据判断**。任何一条冒出来，删掉它，那是 AgentInbox 或 herdr 的活。

## 测试

```bash
cd projects/flume && python3 -m unittest discover -s test -v
```

当前 26 个用例，含 gitlab normalize 纯函数、端到端冒烟、错误路径，以及
activation_only 唤醒门调用与等待表判据。

## 明确不做的事

- 不做第二套投递（队列/重试/死信）——AgentInbox 已有
- 不做事件存储/回放——durable stream 已有
- 不做业务过滤（只关心我的 MR）——subscription 已有
- 不做唤醒策略（退避/租约/攒批）——AgentInbox 通知策略 + herdr 授权门已有
