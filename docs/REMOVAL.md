# 撤除当前接线

本文撤除当前试点：`olap/miergo` → flume → AgentInbox → herdr-projects coordinator。
先停止新事件进入，再清理接收端和本地凭据。

## 1. 删除 GitLab Webhook

先确认这是唯一指向本 flume 的项目级 hook：

<https://git.n.xiaomi.com/olap/miergo/-/hooks>

本次试点的 hook ID 是 `694791`，URL 是
`http://10.224.202.16:19420/gitlab`。在 UI 中删除，或执行：

```bash
glab api --hostname git.n.xiaomi.com --method DELETE \
  projects/262378/hooks/694791
```

确认项目上不再有指向该 flume 的 hook：

```bash
glab api --hostname git.n.xiaomi.com projects/262378/hooks |
  jq '.[] | {id,url}'
```

不要删除项目上原有的其他 webhook。

## 2. 停止 flume

常驻部署只有一个 job：

```bash
launchctl bootout "gui/$(id -u)/com.flume.gitlab" 2>/dev/null || true
```

确认端口已关闭：

```bash
curl -sS --max-time 2 http://10.224.202.16:19420/healthz
# 预期：连接失败，而不是 {"ok":true}

lsof -nP -iTCP:19420 -sTCP:LISTEN
```

如果是前台运行，只在对应终端按 `Ctrl-C`。不要用宽泛的 `pkill node`；同机可能有
其他 Node / AgentInbox 进程。

## 3. 移除自启入口

```bash
unlink "$HOME/Library/LaunchAgents/com.flume.gitlab.plist"
```

确认 job 已不存在：

```bash
launchctl print "gui/$(id -u)/com.flume.gitlab" 2>&1 | head
# 预期：Could not find service
```

当前没有 AgentInbox launchd job，也没有 wake gate job。若 AgentInbox daemon 是由
flume 自举的子进程，停止 flume 后它会一起退出；若本机原本就有共享 daemon，它会
继续运行。

## 4. 清理 AgentInbox 路由（仅限专用配置）

如果该 source、subscription 或 agent 还服务其他系统，跳过这一步。只删除本试点专用
的配置：

```bash
agentinbox agent target list herdr-main
agentinbox subscription list --source-id "$AGENTINBOX_SOURCE_ID"
```

按实际 ID 删除：

```bash
agentinbox agent target remove herdr-main <targetId>
agentinbox subscription remove <subscriptionId>
agentinbox agent remove herdr-main
```

不要删除共享的 `~/.agentinbox`。历史 durable stream 可以按保留策略自然过期，不需要
为了撤除而清库。

## 5. 撤销 Secret

GitLab hook 删除后，再从 Keychain 删除 token：

```bash
security delete-generic-password \
  -a flume -s flume-gitlab-webhook
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
test -z "$(glab api --hostname git.n.xiaomi.com projects/262378/hooks |
  jq -r '.[] | select(.url == "http://10.224.202.16:19420/gitlab") | .id')"

launchctl print "gui/$(id -u)/com.flume.gitlab" 2>&1 | grep -q 'Could not find service'
```

两条命令退出码均为 `0` 表示 webhook 和本地自启入口都已撤除。
