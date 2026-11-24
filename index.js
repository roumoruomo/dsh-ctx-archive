import { promises as fs } from 'node:fs'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'ctx-archive'
export const inject = ['tools', 'systemPrompt']

export const Config = z.object({
  enabled: z.boolean().default(true),
  root: z.string().default(''),
  prime: z.boolean().default(true),
  order: z.number().default(12000),
  maxFiles: z.number().default(80),
  maxHits: z.number().default(40),
  maxReadLines: z.number().default(160),
  overviewSessions: z.number().default(0),
  /** counts = 只报会话数/天数/最新日期；full = 另列每个会话前缀；none = 连计数都不报。 */
  overview: z.string().default('counts'),
  overviewTtlMs: z.number().default(5000),
  /** 需要 host-patch 才能生效：每步强制先给一次归档简报。补丁不在时此开关无副作用。 */
  hostForce: z.boolean().default(false),
  /** 简报里“最近说过什么”取哪个会话目录（归档根下的子目录名），留空则不取。 */
  selfSessionId: z.string().default(''),
})

const text = (value) => ({ schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] })

const overviewCache = new Map()

export function overview(config) {
  const now = Date.now()
  const cached = overviewCache.get(config.root)
  if (cached && now - cached.at < config.overviewTtlMs) return cached.value
  let value
  try {
    const dirs = readdirSync(config.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort()
    let totalDays = 0
    let newest = 0
    const rows = []
    for (const dir of dirs) {
      let files = 0
      let localNewest = 0
      try {
        for (const entry of readdirSync(path.join(config.root, dir), { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'index.md') continue
          files += 1
          const m = statSync(path.join(config.root, dir, entry.name)).mtimeMs
          if (m > localNewest) localNewest = m
        }
      } catch {
        continue
      }
      totalDays += files
      if (localNewest > newest) newest = localNewest
      if (rows.length < config.overviewSessions) {
        const stamp = localNewest ? new Date(localNewest).toISOString().slice(0, 10) : 'n/a'
        rows.push(`${dir}: ${files} day files, latest ${stamp}`)
      }
    }
    const latest = newest ? new Date(newest).toISOString().slice(0, 10) : 'n/a'
    if (dirs.length === 0) value = 'no archived sessions yet'
    else if (rows.length === 0) value = `${dirs.length} sessions, ${totalDays} day files, latest ${latest}`
    else value = `${dirs.length} sessions — ${rows.join('; ')}`
  } catch {
    value = 'archive root unreadable'
  }
  overviewCache.set(config.root, { at: now, value })
  return value
}

function guide(config) {
  const lines = [
    '## Session archive',
    '',
    "Markdown transcripts of this machine's earlier sessions are available to the `ctx_archive` tool. The absolute path stays on the host and is not shown here.",
    'Each session has its own directory named after the first eight characters of its id, and each directory has an `index.md` listing dates, turn counts, sizes and line counts.',
    `Current inventory: ${config.overview === 'none' ? 'hidden by plugin config' : overview(config)}.`,
    '',
    'Use the archive when the current conversation lacks an old detail (a file name, a command, a decision, a number). Do not load it otherwise: a whole day can be tens of thousands of tokens.',
    '',
    '- `ctx_archive` with `action: "list"` shows the available sessions and their date tables.',
    '- `ctx_archive` with `action: "search"` greps every archived line for one query and returns file, line number and the matching line.',
    '- `ctx_archive` with `action: "read"` reads a bounded line range of one archived file.',
    '',
    'Quote what you retrieve so the user can check it, and keep the returned fragment small — read the window around a hit instead of the file.',
  ]
  if (config.prime) {
    lines.push(
      '',
      '**Required before answering**: when a question depends on anything outside this conversation — an earlier session, a past command, a decision, a file path, a number — call `ctx_archive` (`list`, then `search` or `read`) and verify before you answer. Answering such a question from memory alone is an error, even when you believe you remember it.',
      'This section is rebuilt on every step, so the inventory above is current; earlier copies of this section are not history you need to re-read.',
    )
  }
  return lines.join('\n')
}

function redactOut(text, root) {
  let out = String(text)
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const user = process.env.USERNAME ?? ''
  if (root) out = out.split(root).join('<archive>')
  if (home) out = out.split(home).join('<home>')
  if (user && user.length > 1) out = out.split(user).join('<user>')
  out = out.replace(/--C-Users-[^\\/]+--/g, '<workspace>')
  out = out.replace(/--C-Users-[\w.-]+-[^\\/]+--/g, '<workspace>')
  out = out.replace(/session-([0-9a-f]{8})[0-9a-f-]{20,}/g, 'session-$1…')
  out = out.replace(/\b([0-9a-f]{8})[0-9a-f]{24}\b/g, '$1…')
  return out
}

async function readIndex(dir, maxLines, root) {
  const real = await fs.realpath(dir).catch(() => null)
  if (!real) return null
  const base = await fs.realpath(path.resolve(root)).catch(() => path.resolve(root))
  const norm = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  if (norm(real) !== norm(base) && !norm(real).startsWith(norm(base) + path.sep)) return null
  const file = path.join(real, 'index.md')
  const raw = await fs.readFile(file, 'utf8').catch(() => '')
  if (!raw) return null
  const rows = raw
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .filter((line) => !/^\s*(源|source)\s*[:：]/i.test(line))
    .filter((line) => !/[A-Za-z]:\\/.test(line))
  return rows.slice(0, maxLines).join('\n')
}

function within(root, candidate) {
  if (!candidate) return null
  const base = path.resolve(root)
  const resolved = path.resolve(base, candidate)
  const norm = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  return norm(resolved) === norm(base) || norm(resolved).startsWith(norm(base) + path.sep) ? resolved : null
}

async function realInside(root, target) {
  const norm = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = await fs.realpath(path.resolve(root)).catch(() => path.resolve(root))
  const real = await fs.realpath(target).catch(() => null)
  if (!real) return null
  return norm(real) === norm(base) || norm(real).startsWith(norm(base) + path.sep) ? real : null
}

async function collectMarkdown(root, maxFiles) {
  const out = []
  const queue = [root]
  while (queue.length && out.length < maxFiles) {
    const dir = queue.shift()
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) queue.push(full)
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
    }
  }
  return out
}

const DEFAULTS = {
  enabled: true,
  root: '',
  maxFiles: 80,
  maxHits: 40,
  maxReadLines: 160,
  overview: 'none',
  overviewSessions: 0,
  recentPrompts: 0,
  hostForce: false,
  maskNames: true,
}

export function apply(ctx, config) {
  const base = { ...DEFAULTS, ...config }
  const cfg = base.root === '' ? { ...base, root: process.env.DSH_CTX_ARCHIVE ?? '' } : base
  // 会话目录名 → <sid-N> 的稳定别名（进程内），发布版默认开启，避免把“有多少个会话”外发。
  const aliasById = new Map()
  const aliasOf = (dir) => {
    if (!cfg.maskNames) return dir
    if (!aliasById.has(dir)) aliasById.set(dir, `<sid-${aliasById.size + 1}>`)
    return aliasById.get(dir)
  }
  const unalias = (file) => {
    const match = /^<sid-(\d+)>([\\/].*)?$/.exec(file)
    if (!match) return file
    const dir = [...aliasById.entries()].find(([, alias]) => alias === `<sid-${match[1]}>`)?.[0]
    return dir ? path.join(dir, match[2] ?? '') : null
  }
  ctx.systemPrompt.section({
    name: 'plugin:ctx-archive',
    order: config.order,
    text: () => (cfg.enabled ? guide(cfg) : ''),
  })

  // host-patch 装好之后，这一步才真正“强制”：每一步开头寄存器被宿主调用一次，
  // 产出的简报作为 developer 消息进入本步输入，不写进会话历史。
  if (cfg.enabled && cfg.hostForce) {
    const disposers = []
    ctx.effect?.(() => () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* 卸载时的清理失败不该阻断卸载 */
        }
      }
    })
    import('./force-bridge.mjs')
      .then(({ installForceBridge }) => {
        disposers.push(installForceBridge(cfg, ctx.logger))
        ctx.logger?.info?.('ctx-archive: host force bridge installed')
      })
      .catch((error) => {
        ctx.logger?.warn?.(`ctx-archive: hostForce 需要同目录的 force-bridge.mjs（${String(error)}）`)
      })
  }

  ctx.tools.register(
    defineTool({
      name: 'ctx_archive',
      description:
        'Search and read the archived markdown transcripts of earlier sessions on this machine. Read-only. Use `list` to see sessions and their date tables, `search` for one query across archived lines, `read` for a bounded line range of one file.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'search', 'read'],
          description: 'list = sessions and date tables; search = grep archived lines; read = one file, bounded range.',
        },
        query: { type: 'string', description: 'Required for search: literal text, case-insensitive.' },
        file: { type: 'string', description: 'Required for read: absolute path, or a path relative to the archive root.' },
        offset: { type: 'number', description: 'For read: 1-based first line. Defaults to 1.' },
        limit: { type: 'number', description: 'For read: how many lines. Capped by the plugin config.' },
      },
      output: text(),
      async execute(args, exec) {
        const root = cfg.root
        if (!cfg.enabled) throw new Error('ctx-archive is disabled by its config (enabled: false)')
        if (!root) throw new Error('ctx-archive: set config.root (or DSH_CTX_ARCHIVE) to the archive directory')
        const stat = await fs.stat(root).catch(() => null)
        if (!stat || !stat.isDirectory()) {
          throw new Error('archive root not found — check config.root or the DSH_CTX_ARCHIVE environment variable')
        }

        if (args.action === 'list') {
          const dirs = (await fs.readdir(root, { withFileTypes: true }).catch(() => []))
            .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
            .map((entry) => entry.name)
            .sort()
          if (!dirs.length) return 'No archived sessions yet.'
          const blocks = []
          for (const dir of dirs) {
            const table = await readIndex(path.join(root, dir), 14, root)
            const alias = aliasOf(dir)
            const body = table ?? '(no index.md)'
            blocks.push(`### ${alias}\n${cfg.maskNames ? body.split(dir).join(alias) : body}`)
          }
          return redactOut(blocks.join('\n\n'), root)
        }

        if (args.action === 'search') {
          const query = (args.query ?? '').trim()
          if (!query) throw new Error('search needs a query')
          const needle = query.toLowerCase()
          const files = await collectMarkdown(root, cfg.maxFiles)
          const hits = []
          for (const file of files) {
            if (exec.signal?.aborted) throw new Error('cancelled')
            const stat2 = await fs.stat(file).catch(() => null)
            if (!stat2 || stat2.size > 4 * 1024 * 1024) continue
            const raw = await fs.readFile(file, 'utf8').catch(() => '')
            if (!raw) continue
            const lines = raw.split(/\r?\n/)
            for (let i = 0; i < lines.length; i += 1) {
              if (!lines[i].toLowerCase().includes(needle)) continue
              const rel = path.relative(root, file)
              const head = rel.split(path.sep)[0]
              const shown = cfg.maskNames ? rel.replace(head, aliasOf(head)) : rel
              hits.push(`${shown}:${i + 1}: ${lines[i].slice(0, 200)}`)
              if (hits.length >= cfg.maxHits) break
            }
            if (hits.length >= cfg.maxHits) break
          }
          if (!hits.length) return `No archived line contains ${JSON.stringify(query)} (scanned ${files.length} files).`
          return redactOut(hits.join('\n'), root)
        }

        const wanted = unalias(args.file ?? '')
        if (!wanted) throw new Error('read needs a path inside the archive root')
        const target = within(root, wanted)
        if (!target) throw new Error('read needs a path inside the archive root')
        const real = await realInside(root, target)
        if (!real) throw new Error('read needs a path inside the archive root')
        const raw = await fs.readFile(real, 'utf8').catch(() => null)
        if (raw === null) throw new Error(`cannot read ${args.file}`)
        const lines = raw.split(/\r?\n/)
        const start = Math.max(1, Math.floor(args.offset ?? 1))
        const count = Math.min(Math.max(1, Math.floor(args.limit ?? 60)), cfg.maxReadLines)
        const slice = lines.slice(start - 1, start - 1 + count)
        const rel = path.relative(root, real)
        const head = rel.split(path.sep)[0]
        const alias = aliasOf(head)
        const shown = cfg.maskNames ? rel.replace(head, alias) : rel
        const body = slice.map((line, i) => `${start + i}: ${line}`).join('\n')
        const safe = cfg.maskNames ? body.split(head).join(alias) : body
        return redactOut(`${shown} (${lines.length} lines)\n${safe}`, root)
      },
    }),
    { when: () => cfg.enabled },
  )
}
