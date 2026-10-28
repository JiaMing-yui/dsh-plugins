# 大肥鱼的 DSH 插件

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的组合包（bundle）合集，同时是一份插件市场索引（格式 1）。

## 目录

- [里面的插件](#里面的插件)
- [怎么用这个索引](#怎么用这个索引)
- [仓库结构](#仓库结构)
- [自己发一个版本](#自己发一个版本)

## 里面的插件

- `dsh-session-push`：把一条消息推送到另一个 DSH 会话，并能读回对方的回复。
- `dsh-vision`：让读不了图的模型借多模态模型看图（`describe_image` 工具）。

## 怎么用这个索引

DSH 里打开**插件 → 发现 → 索引源 → 添加**，填这个仓库里 `index.json` 的 raw 地址：

```
https://raw.githubusercontent.com/<you>/dsh-plugins/main/index.json
```

添加后「发现」页就会列出上面两个包，点开确认即可安装。安装走 pnpm 的 git spec，pin 到具体 commit。

> 索引由第三方提供，安装后的插件以自己的权限运行——只添加你信任的来源。

## 仓库结构

```
index.json                         市场索引（生成物，不要手改）
scripts/build-index.mjs            索引生成器
packages/<name>/package.json       组合包清单，声明 dsh.bundle.patch
packages/<name>/cordis.patch.yml   插入插件行
packages/<name>/lib/index.js       插件本体
packages/<name>/locale/*.json      中英文标题与描述
packages/<name>/icon.svg           图标
```

## 自己发一个版本

改完插件再发版，顺序不能反：

1. 改 `packages/<name>` 下的代码，`package.json` 的 `version` 加一位。
2. `git add -A && git commit -m "..."`（这次提交包含代码）。
3. `node scripts/build-index.mjs --url https://github.com/<you>/<repo>`
   —— 它把当前 HEAD 当作安装用的 commit 写进索引。
4. `git add index.json && git commit -m "index: <name>@<version>"`，然后 push。

索引里的 commit 指向的是第 2 步那次提交，所以索引必须后提交。
