# 撤除 flume 接线

按顺序停止新事件、删除 webhook、停止 flume、清理本地凭据。命令中的
`<flume-host>`、`<port>`、`<agent-id>` 等替换成你的部署值。

## 1. 删除事件源 webhook

删除指向本 flume 的 webhook，项目上的其他 hook 保留。

GitHub：仓库 **Settings → Webhooks**，删除 Payload URL 为
`http://<flume-host>:<port>/github` 的 hook。

GitLab：项目 **Settings → Webhooks**，删除 URL 为
`http://<flume-host>:<port>/gitlab` 的 hook。

确认 hook 列表符合预期。

## 2. 停止 flume

常驻部署的 job 是 `com.flume`：

```bash
launchctl bootout "gui/$(id -u)/com.flume" 2>/dev/null || true
```

确认端口已关闭：

```bash
curl -sS --max-time 2 http://127.0.0.1:<port>/healthz
# 预期：连接失败，curl 返回非 0

lsof -nP -iTCP:<port> -sTCP:LISTEN
```

如果是前台运行，只在对应终端按 `Ctrl-C`。按 PID 或 launchd 停止进程；宽泛的
`pkill node` 会影响同机其他 Node / AgentInbox 进程。

## 3. 移除自启入口

```bash
unlink "$HOME/Library/LaunchAgents/com.flume.plist"
```

确认 job 已移除：

```bash
launchctl print "gui/$(id -u)/com.flume" 2>&1 | head
# 预期：Could not find service
```

AgentInbox daemon 由 flume 启动或 attach：由 flume 启动的子进程会随 flume 退出；
本机原有的共享 daemon 会继续运行。

## 4. 清理专用 AgentInbox 路由

该 source、subscription 或 agent 专供本部署时，执行这一步；共享配置保留：

```bash
agentinbox agent target list <agent-id>
agentinbox subscription list --source-id "<source-id>"
```

按实际 ID 删除：

```bash
agentinbox agent target remove <agent-id> <target-id>
agentinbox subscription remove <subscription-id>
agentinbox agent remove <agent-id>
```

共享的 `~/.agentinbox` 继续供其他 agent 使用；本部署的 durable stream 按保留策略
自然过期。

## 5. 撤销 Secret

事件源删除后，再从 Keychain 删除对应 secret：

```bash
# GitHub
security delete-generic-password -a flume -s flume-github-webhook

# GitLab
security delete-generic-password -a flume -s flume-gitlab-webhook
```

如果 secret 写在 `.env`，同时删除该文件。

## 6. 清理日志与仓库

确认日志不再需要后：

```bash
rm -f logs/flume.launchd.log logs/flume.launchd.err.log
```

仓库用于再次启动和升级；运行态数据在 AgentInbox、日志和 Keychain 中。共享的
`~/.agentinbox` 和其他项目的 LaunchAgent 保留。

## 7. 撤除后确认

```bash
launchctl print "gui/$(id -u)/com.flume" 2>&1 | grep -q 'Could not find service'
curl -sS --max-time 2 http://127.0.0.1:<port>/healthz
```

第一条退出码为 `0`，第二条连接失败，表示本地 flume 已撤除。
