# 会话归档 / Session archive

## 它做什么

把「历史会话的离线副本」变成 Agent 能主动查阅的一等资源，而不是把旧对话一直顶在上下文里。

安装后有两处变化：

1. **系统提示多一节 `## Session archive`**：告诉模型归档根目录在哪、每个会话一个以 id 前八位命名的子目录、每个子目录里有 `index.md`（日期 / 轮次 / 体积 / 行数），以及什么时候该查、什么时候不该查。
2. **多一个只读工具 `ctx_archive`**：

| action | 作用 | 参数 |
|---|---|---|
| `list` | 列出所有会话目录，各带 `index.md` 前 14 行 | — |
| `search` | 在归档的所有 `.md` 里逐行做大小写不敏感的字面检索 | `query` |
| `read` | 读取某个文件的一段行区间，带行号 | `file`、`offset`、`limit` |

工具是只读的：不写文件、不改会话、不联网。`read` 的 `file` 必须落在 `root` 内，越界直接报错。

## 依赖什么数据

插件**不生成**归档，它只消费已经存在的 markdown 归档。默认布局：

```text
<drive>:\archive\
  sess-0001\
    index.md
    2026-01-12.md
    2026-01-13.md
    ...
  <sid8>\
    index.md
    ...
```

自制归档也可以，只要满足两点：`root` 下每个会话一个目录；目录里的 `.md` 按时间顺序逐行记录对话（`search` 逐行匹配，`read` 按行号返回）。

## 配置

在 `cordis.patch.yml` 里覆盖本插件的 `config`：

```yaml
- id: ctx-archive
  config:
    enabled: true
    root: '<drive>:\archive'
    prime: false
    order: 12000
    maxFiles: 80
    maxHits: 40
    maxReadLines: 160
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时既不加提示节，也不注册工具 |
| `root` | `<drive>:\archive` | 归档根目录，必须是已存在的目录 |
| `prime` | `false` | `true` 时在提示节里追加一句「回答涉及上下文之外的事之前，先 `list`」——更强，但每轮都多一句 |
| `order` | `12000` | 提示节的顺序位；越大越靠后。官方 persona 后缀在 `10200` |
| `maxFiles` | `80` | 一次检索最多扫描的 `.md` 数量 |
| `maxHits` | `40` | 一次检索最多返回的命中行数 |
| `maxReadLines` | `160` | 单次 `read` 的行数上限 |

## 硬模式：每轮调用与"自动回退"的真相

`prime` 默认 `true`（0.2.0 起）。它做两件事，机制不同：

**每轮"调入"是真的。** 提示节的 `text` 是一个函数，宿主每步装配系统提示时都会调用它一次：

```js
ctx.systemPrompt.section({ name: 'plugin:ctx-archive', order: 12000, text: () => guide(config) })
```

`guide()` 里会同步读一遍归档根目录（`readdirSync` + `statSync`，5 秒 mtime 缓存），所以每次注入的 `Current inventory:` 都是当时的真实清单——新增了归档、某天文件更新了，下一轮提示里就变了。不需要模型主动去"调用"，这是宿主装配流程的一部分。

**"回退"是结构性的，不需要动作。** 这一节不是对话历史，是每次装配时重新生成的系统提示片段：上一轮那份文本从未被写进会话记录，所以没有"积累"可回退。每轮的"调入"都顶掉上一轮，天然是滑动的。

**它做不到的事，说清楚。** 这里没有"强制执行工具调用"的钩子——提示写得再硬（"Answering such a question from memory alone is an error"）仍然是提示，模型有不遵守的可能。宿主里 `preTurn` / `beforeRequest` / `injectSystemPrompt` 均为 0 处；真正的"每轮强制跑一次工具"要在宿主侧加钩子，那是改安装目录、升级会被覆盖的另一条路，本插件不走。`prime: false` 可退回软模式（只有清单，无硬指令）。

**成本。** 完整一节约 1.7 KB ≈ 700 token／轮，其中清单占大头；`overviewSessions` 控制显示会话数（默认 6）。嫌贵就调小，或用 `enabled: false` 整个关掉。

## 边界与限制

- **不自动读**。默认只在模型判断需要时调用工具；要「每轮先读」就把 `prime` 设成 `true`，代价是每轮固定多一句提示（不是整篇归档）。
- **不做压缩**。归档里是原文，整篇倒进上下文仍然很贵——这也是 `read` 限制行数、`search` 只回单行的原因。
- **不跨机器**。只认 `root` 下真实存在的文件；别的设备、别的 profile 的会话不在里面。
- **不解析会话库**。`.jsonl.zstd` 之类的原始库不在本插件的职责内，归档器是另一件事。
- **检索是字面匹配**，不是语义检索；中文按字符匹配，不需要分词。

## 典型用法

```text
用户：上个月那个问题当时是怎么定的？
Agent → ctx_archive { action: "search", query: "决定" }
     ← sess-0001\2026-01-12.md:412: ... 先按方案二走，两周后再评估 ...
Agent → ctx_archive { action: "read", file: "sess-0001/2026-01-12.md", offset: 400, limit: 25 }
     ← 带行号的原文片段
```

两次调用换来的是一段可引用的原文，代价远低于把那一整天的 84 KB 挂在上下文里。
