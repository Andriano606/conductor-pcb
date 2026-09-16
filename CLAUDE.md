# CLAUDE.md

## Що ми тут робимо (коротко)

Ембедери сказали, що автотрасування KiCad і Freerouting дає погані плати: DRC проходить, а
плата шумить. Замість чужого автороутера будуємо своє: **перевіряч плати з власною бібліотекою
правил і Claude, який ці правила виправляє**. Цикл такий:

1. Перевіряч (Python, `~/Documents/Embedded/kicad-ai-layout`) дивиться на відкриту в KiCad плату
   і видає знахідки з кодами (наприклад `DECOUPLING_FAR`, `PLANE_CUT`).
2. Кожна знахідка має правило в бібліотеці цього застосунку: пояснення, чому це важливо, як
   виправити, пороги і дві картинки «погано / добре». Пороги можна крутити глобально або для
   окремого проекту, а правила описують перевірку декларативно (блок `check`), без коду.
3. У чаті цього застосунку Claude через MCP-інструменти pcbagent править плату прямо в KiCad
   і перевіряє знову, доки помилок не лишиться. Інструкції для нього лежать не тут, а в
   конфігах `~/Documents/claude-configs/kicad-pcb-layout` та `kicad-pcb-rules`.

Цей репозиторій — десктопний застосунок Conductor PCB: проекти KiCad зліва, чат по центру,
бібліотека правил за кнопкою «Правила», локальний API для інтеграцій. Тестова плата:
`~/Desktop/stm32h753_led` (резервна копія старої розводки лежить поруч).

Guidance for Claude Code when working in this repository follows.

## What this is

**Conductor PCB** — a Linux desktop app (Electron + React + TypeScript, same skeleton as
`~/Documents/conductor-linux`) for KiCad boards. Three parts:

1. **Projects** (left sidebar): registered KiCad project folders (`.kicad_pro`/`.kicad_pcb`).
2. **Chat** (centre): headless `claude` sessions per project, one per **session tab** (the strip in the
   composer toolbar, ported from conductor-linux: «+» adds, «×» closes, double-click/right-click renames;
   `PcbProject.sessions[]`, the session id is the chat key). Claude checks and edits the
   board through the **pcbagent MCP server** (Python, `~/Documents/Embedded/kicad-ai-layout`),
   which talks to the running KiCad PCB editor over its IPC API.
3. **Rules library** (top-bar «Правила»): the catalog of layout rules with diagrams, thresholds
   and a local HTTP API (`127.0.0.1:4817`). The checker pulls rules from it and posts
   findings back. A rule file is the single source of truth: texts, params, diagrams **and the
   `check` block** (`{kernel, emits, args}`) that the Python rule engine (`pcbagent/engine.py`) runs.
   `params[].key` == `pcbagent.checks.CheckConfig` field; `check.kernel` == `Checker.check_<kernel>`.
   Two layers of scope, both persisted: **global** = bundled `rules/` + the user rules dir with `AppConfig.overrides`
   (which rules apply to every project by default, edited in the big «Глобальні правила» window opened from
   settings, `GlobalRulesModal`), and **per project** = the «Правила» tab, always scoped to the active project
   (`store.ruleScope` is derived from `activeProjectId`). A project is **pinned**: on creation (and once at startup
   for older projects, `pinUnpinnedProjects`) `PcbProject.ruleOverrides` gets a full copy of the global effective
   values, so later global changes never touch it; ↺ in the tab (`applyGlobalRulesToProject`) re-copies the current
   globals on demand. The card badge / ↺ state compare the project's effective values with the global ones
   (`rulesDifferingFromGlobal`). Rules imported in the tab are written to `<userData>/project-rules/<id>/`
   (`Rule.source === 'project'`, merged by `rulesRepo.loadedRules(projectId)`). The API takes `?project=<id>` on
   GET/PUT/DELETE. New rules: the `kicad-pcb-rules` Claude config (skill `pcb-rule-author`, in
   `~/Documents/claude-configs`), or «Імпортувати правило» in the app (JSON + preview; `ImportRuleModal` gets its scope).

UI strings are Ukrainian; code and comments English. Prerequisites: Node 20+, `claude` CLI on PATH,
KiCad 10 (AppImage) with the API server enabled, the kicad-ai-layout venv.

## Commands

```bash
npm install
npm run dev            # electron-vite dev (passes --no-sandbox; the SUID sandbox is not set up here)
npm run typecheck      # tsc: main+preload (tsconfig.node.json) and renderer (tsconfig.web.json)
npm test               # Vitest: shared logic, API, chat parser, renderer smoke, every rules/*.json
npm run build          # out/
npm run dist           # AppImage + deb in dist/; postdist re-installs the icon (scripts/install-desktop.sh)
npm run validate-rules # quick structural check of rules/*.json
```

Correctness gates: `npm test`, `npm run typecheck`, `npm run build`. No linter.
**Before every commit run the `verify-before-commit` skill** (`.claude/skills/verify-before-commit`):
new behaviour needs a test, the suite and the build must be green, never skip or delete a failing test.
Rebuilding the installed AppImage is the `rebuild-and-restart-app` skill — only when asked.
The app icon runs `scripts/launch.sh`, which starts the newest `dist/*.AppImage` and repackages it first
when sources are newer (tested in `tests/scripts/launch.test.ts`).

## Architecture

- `src/shared/` — types (`types.ts`), pure logic: `rules.ts` (validate, overrides, export, config merge),
  `projects.ts` (project discovery, system prompt for Claude). Fully unit-tested.
- `src/main/` — Electron main:
  - `store.ts` `<userData>/config.json` (rules config **and** projects, settings, claude args, tool paths);
    migrates from the old `pcb-rules-library` config once.
  - `rulesRepo.ts` bundled `rules/` + user rules dir, watched; `api.ts` local HTTP API (`handle()` is testable without a socket).
  - `claudeChat.ts` — port of conductor-linux's chat (no subagents/workflows): spawns
    `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio [--resume] --mcp-config <file> <claudeArgs>`
    through the login shell (no app-side system prompt: board-work instructions come from the `kicad-pcb-layout` Claude config, skill `pcb-layout-fix`, enabled per project via ⚙ in the composer), parses NDJSON (`handleLine`), keeps a `ChatItem[]` transcript per session tab
    (persisted in `<userData>/chats/<sessionId>.json`; a migrated project's first session reuses the project id), turns `can_use_tool` control requests into
    `ChatPending` (permission / AskUserQuestion), streams sequenced `chat:event`s to the renderer. The
    `initialize` handshake supplies slash commands and models (`meta` event); `/model` and effort are
    picked in the composer and applied by restarting the session with `--model/--effort` (persisted on the `ChatSession`).
    Attachments: files go as `Файл: <path>` lines, images as base64 image blocks.
  - `projects.ts` — add/remove projects, MCP config file per project (`<userData>/mcp/<id>.json`),
    session tabs (`createChatSession`/`closeChatSession`/`renameChatSession`, pure helpers in `src/shared/projects.ts`,
    `migrateSessions` on config load), start/restart a session's chat (`startSessionChat`), open pcbnew, KiCad status, run the checker CLI.
    **Claude config profiles** (ported from conductor-linux): `AppConfig.claudeProfiles` is a global list of
    source folders (skills/commands/agents/CLAUDE.md/settings); each project enables a subset
    (`PcbProject.claudeConfigProfileIds`). `configMerge.ts` builds `<userData>/claude-configs/<projectId>` from
    `~/.claude` + the overlays and the chat is spawned with `CLAUDE_CONFIG_DIR` pointing there (`StartOpts.env`).
  - `usagePoller.ts` — runs `claude -p --output-format json "/usage"` every 30 s, parses the windows, persists
    them in `AppConfig.lastUsage`, pushes `claude:usage`; the sidebar's bottom-left `UsageMeters` renders them.
  - Prompt library: `AppConfig.customPrompts`, `$PCB_PROJECT_NAME/$PCB_PROJECT_DIR/$PCB_BOARD_FILE` variables
    (`src/shared/promptVars.ts`), the 📖 dropdown in the composer inserts them substituted.
- `src/preload/index.ts` — the single typed `window.api`.
- `src/renderer/src/` — zustand `store.ts` (rules, config, projects, view, `activeSessionByProject` in localStorage) + `chatStore.ts` (transcript mirror per session);
  `App.tsx` = `ProjectSidebar` (left) · `TopBar` (Чат / Правила tabs) · centre = `ChatView` (one session tab, `SessionTabs` strip in its toolbar) or the rules view
  (`RuleView` + `RuleSidebar` on the right); `BoardDiagram` renders a rule's `Scene` to SVG.
  «Перевірити плату» opens `CheckBoardsModal`: every `.kicad_pcb` under the project dir (`listBoards`, persisted as
  `PcbProject.boards`) with a toggle (choice persisted in `checkBoards`). `runChecks` (main) checks them one at a time:
  KiCad serves its API from a single editor, so an open board is checked in place, a closed one is opened by the app and
  closed afterwards only when no other pcbnew runs, otherwise it is `skipped` with a reason. Progress streams as
  `check:progress`; the result (`MultiCheckResult`) lands in `store.checkResult` and `CheckReportModal` shows one tab per
  board, «Вставити файл у чат» staging that board's `pcb_report[-<board>].md` (stem from `reportStemFor`) as a composer
  attachment of the visible session (not sent). The checker CLI grew `--board`, `--stem` and a `docs` subcommand for this.
  The left sidebar's project row expands into its board list (open-in-KiCad per board, last counts).
- `rules/*.json` — one file per rule (schema in `schema/rule.schema.json`); the `examples.bad/good` scenes are the diagrams.

## Python side (kicad-ai-layout)

`pcbagent/kicad_io.py` (board snapshot via kicad-python), `checks.py` (measurement kernels `check_<name>` → `Finding(code)`),
`engine.py` (loads rule files/dir/URL, runs each enabled rule's kernel with its params/args, re-tags codes/severities;
`tests/test_engine.py` proves parity with the old hardcoded `Checker.run()`, `tests/test_checks_baseline.py` pins every kernel),
`router.py` (A* grid router), `fixes.py` (GND via planner, route jobs), `mcp_server.py` (tools for Claude),
`cli.py` (`python -m pcbagent.cli check --json --post <dir>`, what the «Перевірити плату» button runs).
Tests: `.venv/bin/python -m pytest -q tests`. KiCad must be started as `AppImage pcbnew <board>` (not via the
project manager) for the API to see the board.

## Linux gotchas

- `pkill -f '<pattern>'` kills the Bash tool's own shell when the pattern appears in the command line
  (exit 144). Kill by pid or build the pattern from pieces.
- Electron runs with `--no-sandbox` here (dev script and the desktop entry).
- `claude` is spawned via `$SHELL -ilc` so PATH comes from the login shell; AppImage leak vars are stripped in `env.ts`.
