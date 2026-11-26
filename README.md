# dsh-ctx-archive

> English: [README.en.md](README.en.md) · 中文完整版: [README.zh.md](README.zh.md)

> **归档内容是你自己的原始对话。** 本插件只在本机读取 `root` 下的 markdown，不上传、不联网、不写宿主文件。
> 把归档目录分享给他人、或接入自己的发布流程前，请先确认其中的内容可以公开。


给 DeepSeek Harness 的 Host 插件：把导出的历史会话变成 Agent 可按需查阅的只读资源，并**每一步重新注入一次归档简报**。

- 系统提示注入一节 `## Session archive`：归档位置、实时清单（会话数、每会话天数、最新日期）、硬性要求「涉及本对话之外的事实先查证再回答」
- 注册只读工具 `ctx_archive`：`list` / `search` / `read`

这一节由 `text: () => guide(config)` 每步重算，所以清单始终是最新的，且不写进对话历史——不需要"回退"这个动作。

不生成归档、不改会话、不联网、不改安装目录里的宿主文件。装之前请确认 `root` 下有实际的 markdown 归档（每个会话一个目录 + `index.md`）。

## 安装

本地目录：

```text
Plugins → Add plugin → 选择本目录
```

或以 bundle 方式：

```js
plugin_manager({ action: 'install_bundle', target: '<plugin-dir>' })
```

## 配置

```yaml
- id: ctx-archive
  config:
    enabled: true
    root: '<drive>:\archive'
    prime: true
    overview: none
    maskNames: true
    order: 12000
    maxFiles: 80
    maxHits: 40
    maxReadLines: 160
```

完整说明见 `docs/DETAIL.md`。

## 兼容性

- `dsh` `>=0.2.1-rc.1 <0.3.0`，`profiles: desktop / web`
- 依赖宿主自带的 `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`、`systemPrompt` 服务，无需自带依赖
- 纯 Host 插件，无 Client 代码，无构建步骤

## 可选：宿主补丁（不在安装包里）

`optional/host-patch/` 是一套**单独安装**的宿主钩子，用来把归档简报变成每一步的「输入」而不是「提示」——模型绕不开。

它会修改 `<安装目录>\resources\app\dsh\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js`：

- DSH 升级会覆盖掉，需要重新 `node apply.mjs`
- 靠字符串锚点定位，换版本先跑 `node apply.mjs --dry-run`，看到 `anchor : 0 hit(s)` 就说明锚点漂移、不要装
- 每步多 300–500 token
- 撤销：`node revert.mjs`（或 `--restore` 用备份）

**默认不要装。** 只想用插件的人忽略这一节即可；发布包（tgz）里不含这些文件。

## 许可

MIT

## 默认行为（0.4.0）

- `maskNames: true`：会话目录名显示为 `<sid-N>`，`list` 表体里的目录名同样替换；`read` 接受 `<sid-1>/2026-01-12.md`，也仍接受真实目录名。
- `overview: none`：提示节不报告会话数量与日期，避免外发「这台机器上有几个会话」。
- 工具输出经过 `redactOut`：归档根路径、家目录、用户名、工作区名、完整会话 ID 全部替换为占位符。
- 只有 `ctx_archive` 的返回值会进入上下文；提示节每步重算，但不写进会话历史。
