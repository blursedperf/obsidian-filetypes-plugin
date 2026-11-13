# Filetypes

**Filetypes** is a fast, lightweight, and strictly local Obsidian plugin for capturing notes and tasks to target files or headings, and creating notes from templates using dynamic variables.

## Why this suite exists

I created this suite of Obsidian plugins and the DoomEsque theme so that I can be 100 percent certain there are no network calls or traffic: everything runs 100 percent offline, so I can use Obsidian for my notes in open-book law exams.

- Nothing in the suite makes a network request. Every test run checks the source, built bundle and styles with `scripts/offline-audit.mjs`, which fails on any network API (`fetch`, `XMLHttpRequest`, WebSocket, `requestUrl`, ...).
- Obsidian itself has separate online features. For a fully offline setup, also turn off automatic updates, Sync and Publish, and don't browse community plugins during the exam.

The suite:

- [DoomEsque](https://github.com/blursedperf/obsidian-theme-doomesque) (theme)
- [DoomEsque Settings](https://github.com/blursedperf/obsidian-doomesque-settings)
- **Filetypes**
- [Inline Autocomplete](https://github.com/blursedperf/obsidian-inline-autocomplete)
- [Inline Schema Expander](https://github.com/blursedperf/obsidian-inline-schema-expander)
- [Links in New Tabs](https://github.com/blursedperf/obsidian-links-in-new-tabs)
- [Pomodoro Flashcards](https://github.com/blursedperf/obsidian-pomodoro-flashcards)
- [Whole-Tree Search](https://github.com/blursedperf/obsidian-whole-tree-search)

## Features

- **Unified Template Picker**: Run **Filetypes: Select from all templates** from the Command Palette (or bind it to a hotkey) to search across all configured template actions and markdown files in your templates folder.
  - Press `Enter` to create a new note in its designated folder.
  - Press `Shift + Enter` to insert the rendered template directly at the cursor in your active note.
- **Convert Selection to Filetype Note**: Select any text in the editor and trigger **Filetypes: Convert selection to filetype note** (via hotkey, command palette, or editor context menu) to bring up the filetype picker modal. Creates a note placed directly in the destination folder configured for that filetype.
  - Automatically derives the note title from the first line or heading of the selection.
  - Replaces the selection in the current note with a markdown link (configurable in settings).
  - Preserves full multi-line content into the new note, or places it precisely using `{{SELECTION}}`.
- **Per-Template & Per-Action Destination Folders**: Specify target folders for each template or capture action, with root vault fallback.
- **Smart Quick Capture**: Append to the end of a note, prepend immediately below frontmatter (preserving YAML metadata), or insert directly under an existing or newly created heading.
- **Safe Active Note Editing**: When capturing to the currently focused note, edits are applied directly through Obsidian's Editor API to preserve cursor position, selection, and code folding.
- **Dynamic Variables & Interactive Prompts**:
  - `{{VALUE}}`, `{{NAME}}`, `{{TITLE}}`: Prompts for primary note title or task text.
  - `{{SELECTION}}`, `{{CONTENT}}`: Inserts the selected editor text when converting selection to a note.
  - `{{VALUE:Custom Prompt}}`: Prompts for custom metadata fields (e.g. `{{VALUE:Project}}`, `{{VALUE:Assignee}}`).
  - `{{DATE}}` (`YYYY-MM-DD`), `{{DATE:format}}` (e.g. `{{DATE:YYYY/MM/DD}}`), and `{{TIME}}` (`HH:mm`).

## Privacy & Security

- **Zero Network Calls (100% Offline)**: Filetypes does not make any network requests, load external scripts or styles, communicate with remote servers, or collect any telemetry or analytics. All operations run locally inside your Obsidian environment.
- **Offline audit**: Every test run checks the source, built bundle and styles with `scripts/offline-audit.mjs`, which fails on any network API (`fetch`, `XMLHttpRequest`, WebSocket, `requestUrl`, workers, dynamic `import()`, ...), dynamic code (`eval`, `new Function`), raw HTML injection, or remote CSS (`@import`, non-`data:` `url()`).
- **Vault-Confined Path Sanitization**: All file and folder paths are sanitized against directory traversal (`..`) and illegal filesystem characters across Windows, macOS, Linux, iOS, and Android. No file operations can access anything outside your active vault.
- **Safe DOM Practices**: No unsafe DOM injection (`innerHTML`, `outerHTML`, or `eval`). All UI elements are rendered using Obsidian's native UI APIs and design tokens.

## Commands

- **Filetypes: Convert selection to filetype note**: Opens the modal to convert the selected editor text into a new note placed in that filetype's folder (can be bound to any hotkey in **Settings → Hotkeys**).
- **Filetypes: Select from all templates**: Opens the unified fuzzy picker to create a note or insert a template into the active editor.
- **Filetypes: Run action**: Opens the action picker to run any configured template or capture workflow.
- **Filetypes: Run: `<Name>`**: Individual commands automatically registered for any filetype action with the command palette toggle enabled.

## Installation

### From Obsidian Community Plugins
1. Open **Settings → Community plugins**.
2. Turn off **Restricted mode**.
3. Select **Browse** and search for **Filetypes**.
4. Click **Install**, then **Enable**.

### Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [GitHub Release](https://github.com/blursedperf/obsidian-filetypes-plugin/releases).
2. Create a folder named `filetypes` inside your vault's `.obsidian/plugins/` directory: `<vault>/.obsidian/plugins/filetypes/`.
3. Copy the downloaded files into that folder.
4. Reload Obsidian, open **Settings → Community plugins**, and enable **Filetypes**.

## License

MIT License. See [LICENSE](LICENSE) for details.
