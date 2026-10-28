# dsh-session-push

给 DeepSeek Harness 的组合包（bundle）：让 Agent 能把一条消息**推送到另一个会话**（同一个或不同的工作区），并把对方的回复**读回来**。

## 目录

- [它能干什么](#它能干什么)
- [安装](#安装)
- [工具与参数](#工具与参数)
- [注意](#注意)

## 它能干什么

DSH 里每个会话是独立的，默认没法互相说话。装了这个包，Agent 就多出两个工具：

- `session_list`：列出这台机器上的会话（id、工作区、创建时间、标题）。
- `session_push`：把一段文字塞进指定会话，让它接着跑一轮；可选 `read` 参数把对方的回复带回来。

## 安装

从插件市场装（把索引 URL 添加进「插件 → 发现 → 索引源」），或者手动：

1. 把本目录拷到 `<profile>/node_modules/dsh-session-push`。
2. 在 `<profile>/cordis.patch.yml` 末尾追加：

```
- insert:
    - id: dsh-session-push
      name: dsh-session-push
      config: {}
```

3. 重启 Harness。

## 工具与参数

- `session_list`：`query`（按 id / 标题片段过滤，可选）、`workspace`（工作区路径片段，可选）。
- `session_push`：`session`（完整 id 或 id / 标题片段）、`text`、`read`（是否把回复读回来，默认 false）。
- 片段命中多个会话时不猜，把候选列出来让你重选。

## 注意

- 推送是用 `followup` 往目标会话排队一轮，目标会话如果正在跑，消息排在后面。
- 两个会话属于同一个 Harness 进程，跨 profile 不行。
