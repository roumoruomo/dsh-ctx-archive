# dsh-ctx-archive

> **The archive is your own raw conversation.** This plugin only reads markdown under `root` on the local machine: nothing is uploaded, nothing goes over the network, no host file is written.
> Before sharing an archive directory or wiring it into a publishing pipeline, make sure its contents are safe to expose.

A host plugin for DeepSeek Harness: it turns exported session transcripts into a read-only resource the agent can consult on demand, and **re-injects a one-paragraph archive briefing on every step**.

- Adds a `## Session archive` slot to the system prompt: archive location, live inventory (session count, day files per session, latest date), and a hard rule that facts outside this conversation must be verified before being answered.
- Registers a read-only `ctx_archive` tool: `list` / `search` / `read`.

That slot is computed by `text: () => guide(config)` on every step, so the inventory is always current — and it is never appended to conversation history, so there is no "rollback" step to perform.

It does not build archives, does not modify sessions, does not use the network, and does not touch host files inside the installation directory. Before installing, make sure `root` already contains a real markdown archive (one directory per session, each with an `index.md`).

## Install

From a local directory:

```text
Plugins → Add plugin → select this directory
```

Or as a bundle:

```js
plugin_manager({ action: 'install_bundle', target: '<plugin-dir>' })
```

## Configuration

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

Full reference: `docs/DETAIL.en.md`.

## Compatibility

- `dsh` `>=0.2.1-rc.1 <0.3.0`, profiles `desktop` / `web`
- Uses the host-provided `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery` and `systemPrompt` services; no bundled dependencies
- Host-only plugin: no client code, no build step

## Optional: host patch (not part of the installer)

`optional/host-patch/` is a **separately installed** host hook that turns the briefing into per-step *input* instead of a *prompt* — the model cannot route around it.

It edits `<install-dir>\resources\app\dsh\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js`:

- A DSH upgrade overwrites it; re-run `node apply.mjs` afterwards
- It anchors on a literal string, so on a new version run `node apply.mjs --dry-run` first; `anchor : 0 hit(s)` means the anchor has drifted and it must not be installed
- Costs an extra 300–500 tokens per step
- Undo with `node revert.mjs` (or `--restore` from the backup)

**Do not install it by default.** Readers who only want the plugin can ignore this section; the published tarball does not contain these files.

## License

MIT

## Default behaviour (0.4.0+)

- `maskNames: true`: session directories are shown as `<sid-N>`, and the same substitution is applied inside the `list` table; `read` accepts `<sid-1>/2026-01-12.md` while still accepting the real directory name.
- `overview: none`: the prompt slot does not report how many sessions exist or their dates, so "how many sessions does this machine have" is not leaked.
- Tool output passes through `redactOut`: archive root, home directory, user name, workspace name and full session IDs are replaced with placeholders.
- Only `ctx_archive` return values enter the context; the prompt slot is recomputed every step but is never written into conversation history.
