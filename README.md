# Claude History Manager

A Windows desktop app for browsing, inspecting and **safely editing** the conversations Claude Code
(CLI and the Claude desktop app's Code tab) keeps under `%USERPROFILE%\.claude\projects`.

## Quick start

Requires [Node.js](https://nodejs.org) (18 or newer). Double-click:

| File | What it does |
|---|---|
| `Start.bat` | Launches the app. On first run it installs dependencies; it rebuilds only when the source changed. |
| `Rebuild and Start.bat` | Clean reinstall + rebuild, then launches. Use if something seems off. |
| `Update.bat` | `git pull`, reinstall, rebuild. |
| `Build Portable EXE.bat` | Builds a single portable `release\Claude History Manager <version>.exe` you can copy anywhere (no Node needed to run it). |

## What it does

- **Sidebar**: every project folder, its sessions (titles from the desktop app, `/rename`, or the first
  prompt), a live badge for sessions a running Claude process has open, and the project's memory files.
- **Transcript view** styled like Claude Code: prompts, replies, thinking, tool calls with their results,
  Edit diffs, images, subagent transcripts.
- **Context** toggle: attachments (system reminders, hook output, skill listings), system records, and the
  API request log.
- **View payload** on any `API request` record rebuilds the exact `messages` array that was sent to the API,
  marking what Claude Code injected (CLAUDE.md, memory, reminders) versus what was in the chat.
- **Records** view: every JSONL line, raw.

## Editing

Click the pencil on any row (or **Edit result** on a tool call):

- **Content** tab: per-block editors for user/assistant text, thinking, tool name + every tool argument,
  tool result text (what the model sees) and `toolUseResult` (Claude Code's own display copy, with a
  *Sync from content* button), attachments, timestamps, cwd, model. Add, remove or reorder blocks.
- **Raw JSON** tab: the whole record, every field.

Changes are **staged** first (yellow marker); nothing touches disk until *Review & save*.

Other actions: **Fork here** (new session that ends at a record, for changing route), **Replace** (plain text /
path-aware / regex across every string in the session, with preview), **Backups** (restore any earlier version).

### Deleting without breaking the conversation

The trash button opens a preview of exactly what will be removed:

- On a prompt: **This exchange** (the prompt and everything Claude did in response, up to your next prompt),
  **Only this prompt**, or **Everything from here to the end**.
- Anywhere else: **Only this** or **Everything from here to the end**.
- Tool calls and their results always go together: removing one pulls in its partner (shown as *linked*).
- Undo on a removed row restores the whole group it was removed with.

### Save checks

*Review & save* rebuilds the conversation as it will look after your changes and checks it before anything is
written:

- every tool call still has its result right after it, and every result answers a call
- the conversation still starts with a user message, and no message is left empty

Only problems **your change introduces** count; if there are any, saving is blocked unless you explicitly choose
*Save anyway*. The same check runs again in the background process right before the file is replaced.

**Thinking blocks**: each one carries a signature that covers everything before it in the conversation, so
any change to an earlier message (an edit, a removal, a path rewrite) invalidates every later thinking block.
Depending on the account, the API then rejects them or passes stale reasoning to Claude. Saving, Replace and
Import/Clone therefore offer to remove the thinking blocks after the first change (on by default). Every message
and tool call stays; Claude only loses its earlier private reasoning. Thinking before the change is kept.

### Other safety nets

- A full copy of the transcript is saved before every write
  (`%APPDATA%\Claude History Manager\backups`, last 25 per session), restorable from the app.
- Writes go to a temp file that is swapped in atomically; unchanged lines stay byte-identical.
- Save is refused if the file changed on disk after it was loaded (Claude still writing to it).
- The app only writes inside `~/.claude/projects` (plus its own backup folder).
- Sessions open in a running Claude process are flagged: that process keeps its own copy in memory, so close
  it before editing and resume afterwards.

## Moving conversations between machines

1. Hover a project in the sidebar → **Export** → pick sessions (+ subagents, saved tool output, memory) → `.zip` bundle.
2. On the other PC: **Import bundle** → set the working directory there. Text rewrite rows are pre-filled
   (old project folder → new folder, the encoded `~/.claude/projects` folder name, old home → new home), and
   you can add any other replacements. Path-aware mode also catches `/` vs `\`, JSON-escaped `\\` and
   git-bash `/d/...` forms.
3. Resume from the new folder with `claude --resume`.

**Clone / relocate** in the session toolbar does the same on this machine (for example to continue a
conversation in another checkout).

## Development

```
npm install
npm start          # build + launch
npm run dist       # portable .exe in release/
npm run selftest   # data-layer tests; set CLAUDE_CONFIG_DIR to a COPY of a .claude folder first
```

`CLAUDE_CONFIG_DIR` points the app at another `.claude` folder (handy for experimenting on a copy).
`scripts/validate-file.ts` prints the conversation checks for one transcript (read-only).

- `src/main`: Electron main process. `scanner.ts` (projects/sessions/titles), `session.ts` (streaming JSONL
  index, saves, backups, fork, replace, API request rebuild), `integrity.ts` (single-pass edit applier,
  chain re-linking, thinking cleanup, conversation validation), `replace.ts`, `transfer.ts` (export/import),
  `memory.ts`.
- `src/renderer`: React UI (`components/SessionView.tsx`, `RowView.tsx`, `Inspector.tsx`, `SafetyModals.tsx`,
  `Modals.tsx`, `removal.ts`, …).
- `scripts/selftest.ts`: end-to-end checks of the data layer.
