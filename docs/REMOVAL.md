# 撤除 flume 接线

按顺序停止新事件、删除 webhook、停止 flume、清理本地凭据。命令中的
`<flume-host>`、`<port>`、`<agent-id>` 等替换成你的部署值。

## 1. 删除事件源 webhook

只删除指向本 flume 的 webhook，不要改项目上的其他 hook。

GitHub：仓库 **Settings → Webhooks**，删除 Payload URL 为
`http://<flume-host>:<port>/github` 的 hook。

GitLab：项目 **Settings → Webhooks**，删除 URL 为
`http://<flume-host>:<port>/gitlab` 的 hook。

确认项目上不再有指向该 flume 的 hook。

## 2. 停止 flume

常驻部署只有一个 job：

```bash
launchctl bootout "gui/$(id -u)/com.flume" 2>/dev/null || true
```

确认端口已关闭：

```bash
curl -sS --max-time 2 http://127.0.0.1:<port>/healthz
# 预期：连接失败，而不是 {"ok":true}

lsof -nP -iTCP:<port> -sTCP:LISTEN
```

如果是前台运行，只在对应终端按 `Ctrl-C`。不要用宽泛的 `pkill node`；同机可能有
其他 Node / AgentInbox 进程。

## 3. 移除自启入口

```bash
unlink "$HOME/Library/LaunchAgents/com.flume.plist"
```

确认 job 已不存在：

```bash
launchctl print "gui/$(id -u)/com.flume" 2>&1 | head
# 预期：Could not find service
```

当前没有 AgentInbox launchd job，也没有 wake gate job。若 AgentInbox daemon 是由
flume 自举的子进程，停止 flume 后它会一起退出；若本机原本就有共享 daemon，它会
继续运行。

## 4. 清理 AgentInbox 路由（仅限专用配置）

如果该 source、subscription 或 agent 还服务其他系统，跳过这一步。只删除本部署
专用的配置：

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

不要删除共享的 `~/.agentinbox`。历史 durable stream 可以按保留策略自然过期，不需要
为了撤除而清库。

## 5. 撤销 Secret

事件源删除后，再从 Keychain 删除对应 secret：

```bash
# GitHub
security delete-generic-password -a flume -s flume-github-webhook

# GitLab
security delete-generic-password -a flume -s flume-gitlab-webhook
```

## 6. 清理日志与仓库

确认日志不再需要后：

```bash
rm -f logs/flume.launchd.log logs/flume.launchd.err.log
```

仓库本身可以保留；它不是运行态依赖。不要删除共享的 `~/.agentinbox` 或其他项目的
LaunchAgent。

## 7. 撤除后确认

```bash
launchctl print "gui/$(id -u)/com.flume" 2>&1 | grep -q 'Could not find service'
curl -sS --max-time 2 http://127.0.0.1:<port>/healthz
```

第一条退出码为 `0`，第二条连接失败，表示本地 flume 已撤除。
