#!/usr/bin/env node
/**
 * dsh-ctx-archive 宿主钩子补丁 · 撤销
 *
 * 从宿主文件里摘掉补丁段；优先精确摘除（不依赖备份），
 * 备份缺失时也能干净还原。
 *
 * 用法：
 *   node revert.mjs                     # 自动找宿主
 *   node revert.mjs --file <index.js>   # 指定宿主文件
 *   node revert.mjs --restore <bak>     # 用指定备份整体覆盖
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const MARK = '/* [dsh-ctx-archive] forced pre-step archive lookup */'
const ANCHOR = `const toolSet = await this.loopCtx.tools.resolve({
			agent: this,
			modelSelection: selection,
			signal
		});`

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}

function findHost() {
  const explicit = flag('file')
  if (explicit) return explicit
  for (const root of [
    'D:/dsh/resources/app/dsh/node_modules',
    'C:/Program Files/DeepSeek Harness/resources/app/dsh/node_modules',
    join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/app/dsh/node_modules')
  ]) {
    const candidate = join(root, '@deepseek-ai/dsh-agent-loop/lib/index.js')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const target = findHost()
if (!target || !existsSync(target)) {
  console.error('[x] 找不到宿主文件，用 --file <路径> 指定。')
  process.exit(2)
}

const restore = flag('restore')
if (restore) {
  if (!existsSync(restore)) {
    console.error(`[x] 备份不存在：${restore}`)
    process.exit(2)
  }
  copyFileSync(restore, target)
  console.log(`[ok] 已用备份覆盖：${restore}`)
  process.exit(0)
}

const source = readFileSync(target, 'utf8')
if (!source.includes(MARK)) {
  console.log('[=] 没有找到补丁标记，无需撤销。')
  process.exit(0)
}

const start = source.indexOf(`\t\t${MARK}`)
if (start === -1) {
  console.error('[x] 找到标记但定位不到起始行，请用 --restore <备份> 还原。')
  process.exit(2)
}
const stopToken = 'lookup failure must not break the step */ }'
const stop = source.indexOf(stopToken, start)
if (stop === -1) {
  console.error('[x] 补丁段不完整，请用 --restore <备份> 还原。')
  process.exit(2)
}

const end = source.indexOf('\n', stop + stopToken.length)
const cleaned = source.slice(0, start) + source.slice(end + 1)
writeFileSync(target, cleaned, 'utf8')

try {
  execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' })
} catch (error) {
  console.error('[x] 撤销后语法检查失败，请用 --restore <备份> 还原。')
  console.error(String(error.stderr ?? error).slice(0, 600))
  process.exit(4)
}

const anchors = cleaned.split(ANCHOR).length - 1
console.log(`[ok] 补丁段已摘除，锚点命中 ${anchors} 次（应为 1）。`)
console.log(`     ${target}`)
console.log('     完全退出 DeepSeek Harness 再打开，撤销才进运行期。')
