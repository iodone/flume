# Adapters

## 当前支持

| 系统 | Webhook 路径 | Secret 环境变量 | 事件 |
| :--- | :--- | :--- | :--- |
| GitHub（示例） | `POST /github` | `FLUME_GITHUB_SECRET` | Pull request、Review、Review comment、Issue、Issue comment、Push、Workflow run |
| GitLab（可选） | `POST /gitlab` | `FLUME_GITLAB_TOKEN` | Merge request、Pipeline、Note、Push、Issue，其他事件归一为 `<object_kind>.received` |

用 `FLUME_ADAPTERS` 选择启用的来源（逗号分隔）。启用来源注册路由并校验 secret；
其他路径返回 404。

`/healthz` 和 `/activation` 由 core 提供。

Adapter 分两层：

| 层 | 位置 | 负责 |
| :--- | :--- | :--- |
| flume adapter | `src/adapters/<name>.ts` | webhook 验签、归一成 envelope |
| agent source policy | 你的 agent workspace 里的 `sources/<name>.md` | envelope 到 intent、task 映射、命令 |

flume adapter 只保证 `source` 和 `event` 稳定；review / feedback / issue 的语义
由 agent 侧的 intake skill 解释。新增来源时两层可以独立扩展。模板在
`templates/workflow-event-intake/`，复制到 agent workspace 后按部署配置 source policy。

### GitHub adapter

- 验签：`X-Hub-Signature-256`（兼容 `X-Hub-Signature`），HMAC-SHA256。
- 去重：`X-GitHub-Delivery` 作为 `native_id`。
- 事件：`pull_request.*`、`pull_request_review.*`、
  `pull_request_review_comment.*`、`issue.*`、`issue_comment.*`、`push`、
  `workflow_run.*`。
- 合并：`pull_request.closed` 且 `pull_request.merged=true` 归一为
  `pull_request.merged`。

## 契约

一个 adapter 只需要四个导出：

```typescript
export const NAME = "jira";
export const SECRET_ENV = "FLUME_JIRA_TOKEN";
export function verify(headers, body, secret): boolean;
export function normalize(headers, body, document): Envelope;
```

- `NAME` 同时是路由段：`POST /jira`。全局唯一。
- `SECRET_ENV` 自动进入启动必填名单，缺失时进程以退出码 2 结束。
- `verify` 只做验签：`true` 放行，`false` 返回 401。
- `normalize` 只做归一：返回 `Envelope`；抛 `EnvelopeError` 返回 400。
- 排队、重试、落盘、订阅过滤和唤醒决策由 AgentInbox 与唤醒器承担。

## Envelope 字段

| 字段 | 规则 |
| :--- | :--- |
| `native_id` | 同一投递必须稳定；优先用上游事件 ID，没有则对 raw body 做 SHA-256 |
| `event` | 稳定的事件名，建议 `<system>.<action>` |
| `occurred_at` | 上游时间戳，ISO8601；允许 `parseTimestamp` 归一 |
| `source` | 等于 `NAME` |
| `subject` | 人可读资源标识，例如 `group/project!123` |
| `payload` | 原始 JSON object |

## 扩展步骤

### 1. 新建 adapter

`src/adapters/jira.ts`：

```typescript
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { Envelope, type JsonObject } from "../envelope.js";

export const NAME = "jira";
export const SECRET_ENV = "FLUME_JIRA_TOKEN";

export function verify(
  headers: IncomingHttpHeaders,
  _body: Buffer,
  secret: string | undefined,
): boolean {
  if (!secret) {
    return false;
  }
  const provided = Buffer.from(String(headers["x-jira-token"] ?? ""));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function normalize(
  _headers: IncomingHttpHeaders,
  body: Buffer,
  document: JsonObject,
): Envelope {
  return new Envelope({
    native_id: String(
      document.id ?? createHash("sha256").update(body).digest("hex"),
    ),
    event: `jira.${String(document.action ?? "updated")}`,
    occurred_at: String(document.updated_at ?? new Date().toISOString()),
    source: NAME,
    subject: String(document.issue_key ?? "jira"),
    payload: document,
  });
}
```

### 2. 注册

`src/adapters/index.ts`：

```typescript
import * as gitlab from "./gitlab.js";
import * as jira from "./jira.js";

const ADAPTERS: readonly Adapter[] = [gitlab, jira];
```

### 3. 配置 secret

在 `run-flume.sh` 中加默认值或 keychain 读取，或把值写入 `.env.local`。`SECRET_ENV` 是启动必填项，缺失时进程以退出码 2 结束：

```bash
export FLUME_JIRA_TOKEN="${FLUME_JIRA_TOKEN:-$(security find-generic-password -a flume -s flume-jira-webhook -w)}"
```

### 4. 加测试

`test/jira.test.ts` 至少覆盖：

- `verify`：正确 token、错误 token、缺 token
- `normalize`：典型 payload → envelope
- `native_id`：同一投递稳定，不同投递不同
- `event` / `subject`：关键分支

```bash
npm test
```

### 5. 联调

启动服务后直接向 `<NAME>` 路径投递：

```bash
curl -sS -X POST http://127.0.0.1:19420/jira \
  -H 'Content-Type: application/json' \
  -H 'X-Jira-Token: <secret>' \
  --data-binary @sample-jira.json \
  -w '\nstatus=%{http_code}\n'
```

期望：`202 {"accepted":1}`。401 是 token 错，400 是 payload/envelope 不合法，
502 是 AgentInbox 拒收。联调建议使用测试 source，避免污染正式 inbox。

## 扩展边界

扩展只涉及 adapter 和 source policy；`core.ts`、`feed.ts`、`envelope.ts` 和唤醒链路
保持稳定。请求体上限 8MB，payload 必须是 JSON object。
