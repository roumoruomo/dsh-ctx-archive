# Session archive

## What it does

It turns an offline copy of past sessions into a first-class resource the agent can consult on purpose, instead of leaving old transcripts pinned in the context window.

After installation two things change:

1. **The system prompt gains a `## Session archive` slot**: it tells the model where the archive root is, that each session has a sub-directory named after the first eight characters of its id, that each of those holds an `index.md` (date / turns / size / line count), and when to look things up versus when not to.
2. **A read-only `ctx_archive` tool appears**:

| action | purpose | arguments |
|---|---|---|
| `list` | List every session directory, each with the first 14 lines of its `index.md` | — |
| `search` | Case-insensitive literal line search across every `.md` in the archive | `query` |
| `read` | Read a line range of one file, with line numbers | `file`, `offset`, `limit` |

The tool is read-only: it writes no files, changes no session, and uses no network. `read`'s `file` must stay inside `root`; anything else is rejected.

## What data it needs

The plugin **does not create** archives; it consumes markdown archives that already exist. Default layout:

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

A hand-made archive works too, as long as two things hold: one directory per session under `root`, and `.md` files inside that record the conversation line by line in chronological order (`search` matches line by line, `read` returns line numbers).

## Configuration

Override the plugin's `config` in `cordis.patch.yml`:

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

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | When `false`, neither the prompt slot nor the tool is added |
| `root` | `<drive>:\archive` | Archive root; must already exist |
| `prime` | `false` | When `true`, appends "run `list` before answering anything outside this conversation" — stronger, but costs a sentence every turn |
| `order` | `12000` | Position in the prompt; larger is later. The official persona suffix sits at `10200` |
| `maxFiles` | `80` | Maximum `.md` files scanned per search |
| `maxHits` | `40` | Maximum matching lines returned per search |
| `maxReadLines` | `160` | Maximum lines per `read` |

## Hard mode: what "every turn" and "automatic rollback" actually mean

`prime` defaults to `true` (since 0.2.0). It does two things, with different mechanisms.

**The per-turn load-in is real.** The slot's `text` is a function, and the host calls it once every time it assembles the system prompt for a step:

```js
ctx.systemPrompt.section({ name: 'plugin:ctx-archive', order: 12000, text: () => guide(config) })
```

`guide()` synchronously reads the archive root (`readdirSync` + `statSync`, 5-second mtime cache), so the `Current inventory:` line reflects the archive as it is right then — add a session, update a day file, and the next turn's prompt already shows it. No model-initiated call is involved; this is part of the host's assembly.

**"Rollback" is structural, not an action.** This slot is not conversation history: it is a prompt fragment regenerated at assembly time. Last turn's copy was never written into the session record, so there is no accumulation to roll back. Each turn's load-in replaces the previous one.

**What it cannot do, stated plainly.** There is no hook here that *forces* a tool call. However hard the wording ("Answering such a question from memory alone is an error"), it is still a prompt, and a model may ignore it. The host has zero occurrences of `preTurn` / `beforeRequest` / `injectSystemPrompt`; genuinely forcing a tool call per turn means adding a host-side hook — a different route that edits the installation directory and is overwritten by upgrades. This plugin does not take that route. `prime: false` falls back to the soft mode (inventory only, no imperative).

**Cost.** A full slot is roughly 1.7 KB ≈ 700 tokens per turn, dominated by the inventory; `overviewSessions` controls how many sessions are shown (default 6). Make it smaller, or switch the whole thing off with `enabled: false`.

## Boundaries and limits

- **No automatic reading.** By default the tool is called only when the model decides it is needed. For "read before every turn", set `prime: true`; the price is a fixed extra sentence per turn (not the whole archive).
- **No compression.** The archive holds raw text, and dumping all of it into context is still expensive — which is why `read` caps the line count and `search` returns single lines.
- **No cross-machine access.** Only files that really exist under `root`; sessions on other devices or in other profiles are not there.
- **No session-store parsing.** Raw stores such as `.jsonl.zstd` are out of scope; building the archive is a separate concern.
- **Search is literal, not semantic.** Chinese matches character by character, so no tokenisation is required.

## Typical usage

```text
User: how did we settle that question last month?
Agent → ctx_archive { action: "search", query: "decided" }
     ← sess-0001\2026-01-12.md:412: ... go with option two, re-evaluate in two weeks ...
Agent → ctx_archive { action: "read", file: "sess-0001/2026-01-12.md", offset: 400, limit: 25 }
     ← the quoted passage, with line numbers
```

Two calls buy a citable passage, far cheaper than keeping that entire 84 KB day in context.
