# Adapters

flume adapter 只负责事件源的 webhook 验签和 envelope 归一。事件进入 AgentInbox 或 generic delivery CLI 后，后续处理由 agent 自己决定。

## 当前支持

| 系统 | Webhook 路径 | Secret 环境变量 | 事件示例 |
| :--- | :--- | :--- | :--- |
| GitHub | `POST /github` | `FLUME_GITHUB_SECRET` | `pull_request.*`、review、issue、comment、`push.received`、`workflow_run.*` |
| GitLab | `POST /gitlab` | `FLUME_GITLAB_TOKEN` | `merge_request.*`、`pipeline.*`、`note.created`、`push.received`，其他事件使用 `<object_kind>.received` |

用 `FLUME_ADAPTERS` 选择启用的来源（逗号分隔）。未启用的路径返回 404。

## 契约

一个 adapter 只需要四个导出：

```typescript
export const NAME = "jira";
export const SECRET_ENV = "FLUME_JIRA_TOKEN";
export function verify(headers, body, secret): boolean;
export function normalize(headers, body, document): Envelope;
```

- `NAME` 同时是路由段：`POST /jira`，全局唯一。
- `SECRET_ENV` 自动进入启动必填名单，缺失时进程以退出码 2 结束。
- `verify` 只做验签：`true` 放行，`false` 返回 401。
- `normalize` 只做归一：返回 `Envelope`；抛 `EnvelopeError` 返回 400。

## Envelope 字段

| 字段 | 规则 |
| :--- | :--- |
| `native_id` | 同一投递必须稳定；优先使用上游事件 ID，没有则对 raw body 做 SHA-256 |
| `event` | 使用 `<object>.<action>`；无明确动作时用 `<object>.received` |
| `occurred_at` | 上游时间戳，归一为 ISO8601 |
| `source` | 等于 `NAME` |
| `subject` | 人可读资源标识，例如 `group/project!123` |
| `payload` | 原始 JSON object |

去重由 AgentInbox或所选投递目标负责，flume 只保证 `native_id` 稳定。

## 扩展步骤

1. 在 `src/adapters/<name>.ts` 实现四个导出。
2. 在 `src/adapters/index.ts` 注册。
3. 把来源名加入 `FLUME_ADAPTERS`，并在 `run-flume.sh` 中补 secret 读取。
4. 增加验签、归一和稳定 `native_id` 的测试。
5. 用真实或测试 webhook 验证 `POST /<NAME>`。

事件归一后，不需要为新来源修改 agent 的处理流程。agent 可以自行解释 envelope，也可以使用仓库内置的 `templates/workflow-event-intake/` skill 模板；该模板可以复制修改，也可以被自定义 skill 完全替换。

## 验证

```bash
npm run lint
npm test
npm run smoke
```

请求体上限为 8 MiB，payload 必须是 JSON object。投递失败返回 502，secret 错误返回 401，未知或未启用 adapter 返回 404。
