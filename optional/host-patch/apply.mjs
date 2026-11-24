#!/usr/bin/env node
/**
 * dsh-ctx-archive 宿主钩子补丁 · 安装
 *
 * 在 @deepseek-ai/dsh-agent-loop 的 preStep 里开一个口子：
 * 解析完 toolSet、装配系统提示之前，允许插件通过
 * globalThis.__dshCtxArchiveForce 真正执行一次 ctx_archive 工具，
 * 并把结果作为一条 developer 消息塞进本步输入。
 *
 * 用法：
 *   node apply.mjs                      # 自动找宿主
 *   node apply.mjs --file <index.js>    # 指定宿主文件（演练/测试）
 *   node apply.mjs --dry-run            # 只探测锚点，不写
 *
 * 退出码：0 成功 / 2 锚点不匹配 / 3 已打过 / 4 语法检查失败
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const MARK = '/* [dsh-ctx-archive] forced pre-step archive lookup */'
const ANCHOR = `const toolSet = await this.loopCtx.tools.resolve({
			agent: this,
			modelSelection: selection,
			signal
		});`

const INJECT = `${ANCHOR}
		${MARK}
		try {
			const forceLookup = globalThis.__dshCtxArchiveForce;
			if (typeof forceLookup === "function") {
				const brief = await forceLookup({
					agent: this,
					toolSet,
					turn: position.turn,
					step: position.step,
					signal
				});
				if (brief != null && brief !== "")
					claimed.push(createDeveloperMessage({
						source: { kind: "ctx-archive" },
						content: [{ type: "text", text: String(brief) }]
					}));
			}
		} catch { /* [dsh-ctx-archive] lookup failure must not break the step */ }`

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}
const dryRun = args.includes('--dry-run')

function findHost() {
  const explicit = flag('file')
  if (explicit) return explicit
  const roots = [
    'D:/dsh/resources/app/dsh/node_modules',
    'C:/Program Files/DeepSeek Harness/resources/app/dsh/node_modules',
    join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/app/dsh/node_modules')
  ]
  for (const root of roots) {
    const candidate = join(root, '@deepseek-ai/dsh-agent-loop/lib/index.js')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const target = findHost()
if (!target || !existsSync(target)) {
  console.error('[x] 找不到宿主文件 @deepseek-ai/dsh-agent-loop/lib/index.js')
  console.error('    用 --file <路径> 指定，或在安装目录下运行。')
  process.exit(2)
}

const source = readFileSync(target, 'utf8')
const hits = source.split(ANCHOR).length - 1

console.log(`target : ${target}`)
console.log(`size   : ${source.length} bytes`)
console.log(`anchor : ${hits} hit(s)`)

if (source.includes(MARK)) {
  console.log('[=] 已经打过这个补丁，不需要重复安装。')
  process.exit(3)
}
if (hits !== 1) {
  console.error(`[x] 锚点命中 ${hits} 次，期望恰好 1 次 —— 宿主版本可能变了，请重新核对。`)
  process.exit(2)
}
if (dryRun) {
  console.log('[ok] dry-run：锚点可用，未写入。')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${target}.ctx-archive.${stamp}.bak`
copyFileSync(target, backup)
const patched = source.replace(ANCHOR, INJECT)
writeFileSync(target, patched, 'utf8')

const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12)
try {
  execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' })
} catch (error) {
  copyFileSync(backup, target)
  console.error('[x] 打完补丁语法检查失败，已回滚。')
  console.error(String(error.stderr ?? error).slice(0, 600))
  process.exit(4)
}

console.log(`[ok] 补丁已写入。备份：${backup}`)
console.log(`     before ${hash(backup)} → after ${hash(target)}`)
console.log('     完全退出 DeepSeek Harness 再打开，补丁才进运行期。')
console.log('     撤销：node revert.mjs')
console.log(`     目录：${dirname(target)}`)
