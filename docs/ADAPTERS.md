# Adapters

## 当前支持

| 系统 | Webhook 路径 | Secret 环境变量 | 事件 |
| :--- | :--- | :--- | :--- |
| GitLab | `POST /gitlab` | `FLUME_GITLAB_TOKEN` | Merge request、Pipeline、Note、Push、Issue，其他事件归一为 `<object_kind>.received` |

`/healthz` 和 `/activation` 是 core 端点，不属于 adapter。

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
- adapter 内不排队、不重试、不落盘、不做订阅过滤、不决定唤醒。

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

在 `run-flume.sh` 中加默认值或 keychain 读取。缺少 `SECRET_ENV` 时 flume 不会启动：

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

## 不需要改的地方

`core.ts`、`feed.ts`、`envelope.ts` 和唤醒链路都不需要动。请求体上限 8MB，
payload 必须是 JSON object。
