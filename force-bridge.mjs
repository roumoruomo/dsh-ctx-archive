/**
 * 宿主钩子适配层（配合 host-patch/apply.mjs 使用）
 *
 * 补丁在 dsh-agent-loop 的 preStep 里查 globalThis.__dshCtxArchiveForce，
 * 有就调用它，并把返回的文本作为一条 developer 消息塞进本步输入。
 * 本文件负责注册这个函数：每步产出「归档简报」。
 *
 * 只有在插件配置里打开 hostForce 才会注册——补丁不在时，注册也没人调。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const KEY = '__dshCtxArchiveForce'
const TTL = 30_000

let cached = { at: 0, text: '' }

function dayFiles(sessionDir) {
  try {
    return readdirSync(sessionDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort()
  } catch {
    return []
  }
}

/** 最近 N 天的「你说了什么」标题，用来提醒模型“旧事在盘上，先查再说”。 */
function recentUserLines(root, sessionId, cap = 6) {
  let name = sessionId
  if (name !== '' && !existsSync(join(root, name))) {
    const prefix = name.slice(0, 8)
    try {
      const match = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
        .map((d) => d.name)[0]
      if (match !== undefined) name = match
    } catch {
      /* 归档根读不了就当作没有 */
    }
  }
  const dir = join(root, name)
  const days = dayFiles(dir).slice(-2)
  const lines = []
  let pending = ''
  for (const day of days) {
    let raw = ''
    try {
      raw = readFileSync(join(dir, day), 'utf8').replace(/^\uFEFF/, '')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      if (line.startsWith('### ')) {
        pending = line.slice(3).trim()
        continue
      }
      if (pending !== '' && line.trim() !== '' && !line.startsWith('·')) {
        lines.push(`${day.slice(0, 10)} ${line.trim().slice(0, 60)}`)
        pending = ''
      }
      if (lines.length >= cap) break
    }
    if (lines.length >= cap) break
  }
  return lines
}

function briefing(config) {
  const root = config.root
  let sessions = []
  try {
    sessions = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return '## Pre-answer archive check\nThis machine has a local session archive, but it is not readable right now. Answer without it and say so.'
  }

  const totalDays = sessions.reduce((n, sid) => n + dayFiles(join(root, sid)).length, 0)
  const parts = [
    '## Pre-answer archive check',
    config.overview === 'none'
      ? 'A local session archive is available.'
      : `A session archive on this machine holds ${sessions.length} sessions and ${totalDays} day files.`,
    'Before answering anything that happened before this message — a past task, a decision, a file path, a number — call `ctx_archive` (`search`, then `read`) and check. Recalling it from memory counts as guessing.'
  ]
  const recent = Number(config.recentPrompts ?? 0)
  if (recent > 0) {
    const lines = recentUserLines(root, config.selfSessionId ?? '', recent)
    if (lines.length > 0) {
      parts.push('Recent prompts on disk (orientation only):')
      for (const line of lines) parts.push(`- ${line}`)
    }
  }
  return parts.join('\n')
}

export function installForceBridge(config, logger) {
  const build = () => {
    if (Date.now() - cached.at < TTL && cached.text !== '') return cached.text
    try {
      const text = briefing(config)
      cached = { at: Date.now(), text }
      return text
    } catch (error) {
      logger?.warn?.(`ctx-archive: briefing failed: ${String(error)}`)
      return ''
    }
  }

  globalThis[KEY] = () => build()
  return () => {
    if (globalThis[KEY]) delete globalThis[KEY]
  }
}

export function bridgeInstalled() {
  return typeof globalThis[KEY] === 'function'
}
