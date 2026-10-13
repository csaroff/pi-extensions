# 📈 pi-progress — Keep Multi-Step Work Visible

[![npm](https://img.shields.io/npm/v/@narumitw/pi-progress)](https://www.npmjs.com/package/@narumitw/pi-progress)
[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi Progress shows users a focused, branch-aware progress list above Pi's editor.
It restores valid progress after reloads, branch navigation, and compaction without rewriting ordinary conversation history.

> [!WARNING]
> Remove `@narumitw/pi-todo` before installing this package.
> Loading both packages exposes two independent tools and widgets with competing progress guidance.

## ✨ Features

- Registers only `update_progress` with the canonical `steps[].text` payload.
- Keeps at most one step in progress and distinguishes blocked work from completion.
- Adapts the themed TUI widget to terminal height while prioritizing active and blocked steps.
- Shows a transient completion summary when every tracked step becomes complete.
- Lets users dismiss the widget without changing saved progress.
- Restores the latest valid state from current and historical session results on the active branch.
- Preserves an established pre-migration compaction boundary until its summary epoch ends.
- Provides one settings screen with saved display preferences and immediate widget updates.
- Sanitizes terminal and bidirectional controls before rendering model-provided text.
- Works without network access, subprocesses, credentials, or external services.

## 📦 Install

For a new persistent user installation:

```bash
pi install npm:@narumitw/pi-progress
```

Try the package without installing it permanently:

```bash
pi -e npm:@narumitw/pi-progress
```

Build and load an unbuilt repository checkout:

```bash
npm --workspace @narumitw/pi-progress run build
pi --no-extensions -e ./packages/pi-progress
```

The package declares the generated `dist/index.ts` entrypoint, so local package-directory loading requires a build first.
Pi extensions run with the user's permissions; install only trusted code.

### Migrate from pi-todo

First confirm the replacement is available:

```bash
npm view @narumitw/pi-progress version
```

If the command returns `404`, keep `pi-todo` installed.
Otherwise, exit Pi and migrate the same persistent scope in order.
For a user installation:

```bash
pi remove npm:@narumitw/pi-todo
pi install npm:@narumitw/pi-progress
```

For a project installation originally created with `pi install -l`, run from that project:

```bash
pi remove npm:@narumitw/pi-todo -l
pi install npm:@narumitw/pi-progress -l
```

Migrate each scope separately when both are configured.
For temporary npm loading, replace the source without running `pi remove`:

```bash
pi -e npm:@narumitw/pi-progress
```

For local checkout loading, update the checkout, build `packages/pi-progress`, and replace the old `-e` path.
Restart Pi after migration and do not load both package names.
To roll back, remove `pi-progress` from the same persistent scope or restore the old temporary/local source, then reinstall or load `pi-todo`.
Neither migration direction rewrites session or settings files.
Older packages cannot restore new version 5 results; after new updates, prefer a forward fix or resume a branch before the first version 5 update rather than relying on a downgrade to preserve current progress.

## 🚀 Quick start

Ask Pi to perform work with multiple meaningful steps.
The model uses `update_progress` to show what has been done, what is happening now, and what is planned next.
Its guidance recommends updates for meaningful progress changes, skips simple tasks and redundant updates, and does not make tool calls prerequisites for work or replies.

## 💬 Commands

`/progress` opens the main menu in TUI or RPC mode. It shows current widget state and offers Settings, Status, Help, and Clear widget.
Settings opens the same TUI settings screen as the direct route; RPC reports the file path. Status and Help are read-only views.
Back returns to the main menu; Ctrl+C closes the flow.

Direct routes remain available, with autocomplete:

- `/progress clear` hides the widget and cancels its completion-summary timer in TUI or RPC mode. Saved progress remains unchanged; the next update, branch navigation, or session start can show it again.
- `/progress settings` opens the display settings screen in TUI mode. RPC mode reports the settings path for manual editing.

Unknown subcommands and trailing arguments show usage without changing state.
Print and JSON modes reject the menu and both direct routes. These commands do not change conversation history.

## 🛠️ Tools

### `update_progress`

Each `update_progress` call replaces the complete current-work snapshot; this is not an exhaustive activity log.
An empty `steps` array intentionally clears the state, but finishing work does not require clearing completed steps.
The sole registered model tool accepts this exact payload:

```json
{
  "steps": [
    {
      "text": "Inspect the current implementation",
      "status": "completed"
    },
    {
      "text": "Verify behavior with focused tests",
      "status": "in_progress"
    },
    {
      "text": "Publish the package — waiting for approval",
      "status": "blocked"
    }
  ]
}
```

Statuses are `pending`, `in_progress`, `completed`, and `blocked`.
Every step contains only `text` and `status`. For blocked work, include what is needed to continue in the text; blocked does not mean completed.
The array supports at most 50 steps, text supports at most 503 grapheme clusters, and at most one step may be `in_progress`.
The runtime enforces this limit before schema validation because JSON Schema counts code points rather than grapheme clusters.
The text limit accommodates the old 300-character text plus ` — ` and a 200-character reason without truncation.
For compatibility, valid old-style blocked inputs merge `reason` into text; redundant non-blocked reasons are ignored before validation. New stored state never contains a separate reason.
Unknown fields are rejected.

Successful results store version 5 `{ steps: [{ text, status }] }` details.
New calls, results, context messages, widget output, and settings use Progress terminology only.

### Session and compaction behavior

Startup and tree navigation rebuild state from successful, valid results on the active branch.
The compatibility decoder accepts only these historical contracts:

- `update_progress` version 4 `{ steps: [{ text, status, reason? }] }`;
- `update_todo_list` version 3 `{ todos: [{ step, status, reason? }] }`;
- `update_todo_list` or `todo_widget` version 2 `{ todos: [{ step, status }] }`; and
- `update_todo_list` or `todo_widget` version 1 `{ items: [{ text, status }] }`.

Historical Todo names are read-only session inputs and are not registered as tool aliases.
Valid historical blocked reasons are merged into text as `text — reason`, after validation under their original limits; session history is never rewritten.
Wrong name/version combinations, malformed shapes, errored results, exceeded limits, and invalid invariants are ignored.
A later valid empty snapshot clears earlier state.

Upgrading or reloading into a changed tool definition or guidance, including this observational guidance, intentionally changes the model-visible prefix once; subsequent ordinary turns keep it stable.
The tool does not enable strict constrained sampling.
Ordinary turns rely on the retained matching tool call and result, including calls with ignored redundant reasons, so the extension does not prepend or rewrite model-visible history.
When leading compaction or branch summaries remove that evidence, the extension inserts one deterministic hidden Progress state message after the summaries.
A Progress version 4 or Todo boundary already established before upgrade remains byte-stable for that summary epoch, including after updates, clears, reloads, and branch navigation.
A later summary epoch uses only canonical Progress context for the then-current state.

In TUI mode, the widget appears above the editor and starts with a full-width themed separator.
Adaptive mode uses up to one third of terminal height, bounded between four and twelve rows.
It prioritizes the in-progress step, blocked steps, and pending steps before summarizing completed or hidden rows.
Completing every non-empty step shows a three-second summary, then hides the widget without clearing session state.
Updates, clears, tree navigation, replacement, and shutdown cancel stale summaries.
RPC mode publishes progress and completion summaries as string-line snapshots at 80 columns using the default 36-row budget because Pi does not expose client dimensions.
Print and JSON modes retain structured tool behavior without creating a widget.

## ⚙️ Settings

Canonical user settings are read from `<Pi agent directory>/pi-progress.json`, normally `~/.pi/agent/pi-progress.json`:

```json
{
  "enabled": true,
  "displayMode": "adaptive",
  "showCompleted": true,
  "maxVisibleItems": null,
  "showProgress": true
}
```

`displayMode` accepts `adaptive`, `expanded`, or `collapsed`.
`maxVisibleItems` accepts `null` or an integer from 1 through 50; the other fields are booleans with the defaults shown above.
Use `/progress settings` in TUI mode to edit these user settings. Enter or Space changes a value; the item limit opens a number input. Enter a whole number from 1 to 50, or leave it blank for no limit. Invalid input stays open for correction.
The screen uses the shared Kit frame with full-width top and bottom rules. When fewer than five rows remain for the screen, it omits the rules to retain the active setting or input field.
Each successful save applies immediately. Closing the screen cancels pending work, but a save already publishing can still finish and apply to the current session; completed saves are not undone. Ctrl+C always closes the screen.
A failed save reports an error and restores the displayed value. Invalid existing files must be repaired before saving.

Manual file changes take effect at the next session start, including `/reload`.
Reads and saves are ordered within one Pi process. Each save reads the latest valid document, preserves unknown fields, and publishes through a temporary file and rename; separate Pi processes are not coordinated.

Existing `pi-progress.json` files with a nested `widget` object remain supported; top-level fields override matching nested fields.
The extension no longer reads `pi-todo.json`. To retain those preferences, copy the five settings into `pi-progress.json` using the flat format above.
A missing file uses defaults. An invalid file uses defaults and reports its error in TUI and RPC modes.
Settings loading never creates, rewrites, moves, or deletes files, including the unused `pi-todo.json`.

## 🔒 Security and privacy

The extension reads the optional `pi-progress.json` user settings file and writes it only after an explicit settings change.
It does not start processes, access credentials, or make network requests.
Pi stores progress text in normal session tool results, so they follow the user's session persistence choices.
Terminal escape sequences, control characters, and bidirectional display controls are stripped only at the display boundary; stored tool payloads remain unchanged.

## 🚧 Limitations

- RPC widgets use fixed-size snapshots rather than adapting to the client viewport.
- The settings screen requires TUI mode; there is no manual progress editor.
- It reminds the model to update progress but cannot infer completion or force a tool call.
- Compatibility restores only the documented, valid historical result contracts from the active branch.
- Adaptive sizing uses terminal height rather than the exact remaining editor viewport.
- The widget has no independent scrolling.

## 🗂️ Package layout

```text
packages/pi-progress/
├── src/
│   ├── index.ts                       # Thin Pi entrypoint
│   ├── progress-widget.ts             # Tool/command registration and session/widget lifecycle
│   ├── progress-state.ts              # Validation, history decoding, and context reconciliation
│   ├── progress-renderer.ts           # Bounded sanitized widget rendering
│   ├── progress-menu.ts               # Kit main menu and read-only Status/Help views
│   ├── progress-settings-ui.ts        # Display settings screen and save lifecycle
│   └── settings.ts                    # Validated settings reads and atomic queued saves
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Deterministic runtime builder
└── test/                              # Contract, lifecycle, renderer, settings, and loader coverage
```

The generated runtime bundles only package-owned source and does not import back into `src`.

## 🔎 Keywords

Pi extension, coding agent, progress tracking, task progress, session widget, TypeScript Pi package.

## 📄 License

[MIT](./LICENSE)
