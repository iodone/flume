# 撤除内网 GitLab 接入

按下面的顺序撤除，先停止新事件进入，再清理接收端。不要先删本地状态：否则 Webhook
在撤除窗口内仍会投递并产生失败重试。

## 1. 删除 `olap/miergo` 项目级 Webhook

先在 GitLab UI 核对这是唯一指向本 flume 的 hook：

<https://git.n.xiaomi.com/olap/miergo/-/hooks>

本次试点的 hook ID 是 `694791`，URL 是
`http://10.224.202.16:19420/gitlab`。在 UI 中点击 **Delete**，或执行：

```bash
glab api --hostname git.n.xiaomi.com --method DELETE \
  projects/262378/hooks/694791
```

确认五个事件开关已经随 hook 删除，项目上不再有指向
`10.224.202.16:19420` 的 webhook：

```bash
glab api --hostname git.n.xiaomi.com projects/262378/hooks |
  jq '.[] | {id,url,merge_requests_events,pipeline_events,note_events,issues_events,push_events}'
```

不要删除或修改项目上原有的其他 webhook。

## 2. 停止接收进程

本次部署用两个用户级 LaunchAgent 常驻：

```bash
launchctl bootout "gui/$(id -u)" com.xiaomi.flume.gitlab 2>/dev/null || true
launchctl bootout "gui/$(id -u)" com.xiaomi.flume.wakegate 2>/dev/null || true
```

确认端口已经关闭：

```bash
curl -sS --max-time 2 http://10.224.202.16:19420/healthz
# 预期：curl 连接失败，而不是 {"ok":true}

lsof -nP -iTCP:19420 -sTCP:LISTEN
lsof -nP -iTCP:18924 -sTCP:LISTEN
```

如果 flume 是用前台命令启动的，直接在该终端按 `Ctrl-C`。不要用宽泛的
`pkill node`，同机可能还有别的 Node/AgentInbox 服务。

## 3. 清理 AgentInbox 路由（可选但推荐）

只删除本试点专用的 target、subscription 和 agent。先查出 ID：

```bash
agentinbox agent target list herdr-main
agentinbox subscription list --source-id "$AGENTINBOX_SOURCE_ID"
```

然后按实际 ID 删除：

```bash
agentinbox agent target remove herdr-main <targetId>
agentinbox subscription remove <subscriptionId>
agentinbox agent remove herdr-main
```

如果该 agent 或 subscription 还服务别的 source，不要删除；只撤销
`olap/miergo` 的 webhook 和 flume 接收端口即可。

## 4. 撤销 Secret

GitLab hook 删除后，flume 已经无法再收到该 token 的请求。确认没有其他部署复用后，
从系统钥匙串删除：

```bash
security delete-generic-password -a flume -s flume-gitlab-webhook
```

不要再从 shell 历史或日志里寻找 token；轮换记录只保留“何时被撤销”，不保留明文。

## 5. 撤除后确认

```bash
test -z "$(glab api --hostname git.n.xiaomi.com projects/262378/hooks |
  jq -r '.[] | select(.url == "http://10.224.202.16:19420/gitlab") | .id')"
```

命令退出码为 `0` 表示项目上没有残留的本 flume hook。AgentInbox 中已有历史 event
可以按保留策略过期为垃圾回收，不需要为了撤除删除 durable stream。
