# dsh-vision

给 DeepSeek Harness 的组合包（bundle）：**自己读不了图的模型，借一个能读图的多模态模型看图**。

## 目录

- [它能干什么](#它能干什么)
- [安装](#安装)
- [配置](#配置)
- [注意](#注意)

## 它能干什么

纯文本模型看不到图片。这个包注册一个 `describe_image` 工具：把本地图片路径交给候选模型里第一个支持图像输入的模型，让它用中文描述画面、文字和布局，把结果返回来。

```js
describe_image({ path: 'C:/tmp/shot.jpg', question: '这页写了什么？' })
```

也可以一次传多张（`paths`），或者用 `model` 指定模型。

## 安装

从插件市场装，或手动把本目录拷到 `<profile>/node_modules/dsh-vision`，然后在 `<profile>/cordis.patch.yml` 追加：

```
- insert:
    - id: dsh-vision
      name: dsh-vision
      config: {}
```

重启 Harness 生效。

## 配置

两种写法，都在 patch 的 `config` 里：

- `models`：候选模型 id 列表，按顺序挑第一个能读图的；不填用插件内置列表。
- `provider`：指定 provider；不填就跟着当前默认模型走。

## 注意

- 图片走的是 prompt 附件通道，同一个模型在不同 provider 下对图文混排的支持不一样：有些会直接报错，有些会把图片当文本。
- 只有 `inputModalities` 里含 `image` 的模型能用；不支持的模型会被跳过并在返回里说明。
