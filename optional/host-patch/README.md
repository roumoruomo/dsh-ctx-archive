# host-patch · 每步强制查归档

这是给 `dsh-ctx-archive` 用的**宿主钩子**，单独存放、单独安装、单独撤销。插件本身不依赖它；它也不改插件的逻辑。

## 它做什么

在 `@deepseek-ai/dsh-agent-loop` 的 `preStep()` 里开一个口子：

```
toolSet 解析完成 → [补丁开的口子] → 系统提示装配 → 本步请求发出
```

口子里查 `globalThis.__dshCtxArchiveForce`，存在就调它，把返回的文本包成一条 `developer` 消息塞进本步输入。也就是说：**每一步开头，归档简报都已经在模型眼前了**，不需要模型自己想起来去调工具。

调用失败、返回空、宿主没装插件——三种情况都静默跳过，不会让这一步失败。

## 为什么不用插件里的 `ctx.systemPrompt.section()`

那一节已经能每步注入（`text` 是函数，装配时执行），但它是**提示**：模型可以无视。补丁这个口子是**输入**：简报作为一条消息进了本步的 `messages`，和用户的话在同一层。

代价也说清楚：这是改安装目录（`<安装目录>\resources\app\...`），DSH 升级会覆盖掉，得重装；补丁靠字符串锚点定位，宿主改了这个函数就得重新对锚点。

## 安装

```powershell
node apply.mjs --dry-run      # 先看锚点命中几次（要恰好 1 次）
node apply.mjs                # 写入，自动备份 + 语法检查，失败自动回滚
```

打完补丁，去插件配置里把 `hostForce` 打开：

```yaml
- id: ctx-archive
  name: dsh-ctx-archive
  config:
    hostForce: true
    selfSessionId: <你的会话 id，可留空>   # 见下方「隐私边界」
```

然后**完全退出** DSH 再打开。

## 验证

打开后随便问一句跟今天无关的旧事（"上次那个 5.4 最后怎么处理的"）。如果回答里带上了具体文件名或日期，说明简报进了；如果它开始 `ctx_archive search`，更好。

看日志也行：`hostForce` 打开时插件会打一行 `ctx-archive: host force bridge installed`；补丁生效后每一步都会消费一次简报，`acp_status` 里 tool 输出占比会略微上升（每步约 300–500 token）。

## 撤销

```powershell
node revert.mjs                        # 精确摘除补丁段
node revert.mjs --restore <备份路径>    # 用备份整体覆盖
```

两条路都跑语法检查，通过才落盘。撤销后把 `hostForce` 关掉即可——bridge 还在注册，但没人调用。

## 备份在哪

`apply.mjs` 会把原文件复制成 `index.js.ctx-archive.<时间戳>.bak`，和宿主文件同目录。升级 DSH 后这些备份会跟着被替换，所以想长期保留就自己挪走。

## 适用版本

对 `@deepseek-ai/dsh-agent-loop` 的 `preStep()` 里这段锚点：

```js
const toolSet = await this.loopCtx.tools.resolve({
    agent: this,
    modelSelection: selection,
    signal
});
```

本机验证过：`0.2.2-rc.5`，锚点 1 次命中，打完 `node --check` 通过，apply → revert 往返哈希一致（`3295486eeb29`）。

换了版本先跑 `--dry-run`，看到 `anchor : 0 hit(s)` 就是锚点漂了，别硬装。
