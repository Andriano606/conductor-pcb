# Conductor PCB

Десктопний застосунок (Electron + React + TypeScript) для роботи з платами KiCad разом із Claude.

- **Проекти** (ліворуч): папки з проектами KiCad. «+» додає папку з файлом `.kicad_pro`.
- **Чат** (у центрі): окрема сесія `claude` на кожен проект. Ви кажете, що змінити, Claude
  перевіряє й править плату через MCP-сервер pcbagent (`~/Documents/Embedded/kicad-ai-layout`),
  який працює з відкритим редактором KiCad через його API. Кнопки: «Відкрити в KiCad»,
  «Перевірити плату» (запускає перевіряч і показує підсумок у списку проектів), «Нова розмова».
- **Правила** (кнопка зверху): бібліотека правил трасування з діаграмами «погано / добре»,
  порогами й локальним HTTP API. Перевіряч бере звідти пороги й повертає знахідки.

Вимоги: Node 20+, `claude` CLI у PATH, KiCad 10 (AppImage) з увімкненим сервером API,
віртуальне середовище kicad-ai-layout. Плату треба відкривати як `AppImage pcbnew <файл>`
(кнопка «Відкрити в KiCad» робить саме це), через менеджер проектів API плату не бачить.

## Запуск

```bash
npm install
npm run dev        # розробка з hot reload
npm run build      # збірка в out/
npm run dist       # AppImage + deb у dist/
npm test           # vitest: логіка правил, API, діаграма, валідність усіх rules/*.json
npm run typecheck
npm run validate-rules   # швидка структурна перевірка rules/*.json без збірки
scripts/install-desktop.sh   # ярлик у меню після npm run dist
```

## Де що лежить

| Шлях | Що |
|---|---|
| `rules/*.json` | вбудовані правила, по одному файлу на правило |
| `schema/rule.schema.json` | JSON Schema файлу правила |
| `~/.config/conductor-pcb/rules/` | правила користувача (той самий `code` заміняє вбудоване) |
| `~/.config/conductor-pcb/config.json` | конфіг: проекти, аргументи claude, шляхи до python/kicad-cli/KiCad, папка правил, порт API, перевизначення порогів |
| `~/.config/conductor-pcb/chats/<project>.json` | транскрипти чатів |
| `src/shared/` | типи й чиста логіка (валідація, накладання перевизначень, експорт для перевіряча) |
| `src/main/` | Electron main: конфіг, правила з наглядом за папками, HTTP API, IPC, `claudeChat.ts` (headless claude, stream-json), `projects.ts` (проекти, MCP-конфіг, запуск KiCad, перевіряч) |
| `src/renderer/` | React: сайдбар проектів, чат, верхня панель, картка правила, SVG-діаграма зі сцени, налаштування |

## Формат правила

```jsonc
{
  "code": "DECOUPLING_FAR",          // = код знахідки, який видає перевіряч
  "title": "…", "category": "power", "severity": "warning",
  "summary": "…", "description": "markdown", "why": "markdown", "fix": "markdown",
  "params": [ { "key": "decoupling_max_dist_small", "label": "…", "unit": "мм", "default": 3.0 } ],
  "checker": { "engine": "pcbagent", "function": "check_decoupling", "measures": "…" },
  "tags": [], "references": [ { "title": "…", "url": "…" } ],
  "examples": { "bad": Scene, "good": Scene },
  "enabled": true
}
```

`params[].key` — це назва поля в `pcbagent.checks.CheckConfig`. Блок `check` каже рушію
перевірок, що запускати: `kernel` — вимірювальне ядро (`Checker.check_<kernel>` у pcbagent),
`emits` — внутрішній код знахідки цього ядра, який належить правилу, `args` — фіксовані
селектори (регулярні вирази, пороги, які не показуються користувачу). Одне ядро може
живити кілька правил: `tracks_under_crystal` з `args.crystal_ref_regex = "^ANT\\d+"` дає
правило про доріжки під антеною без жодного рядка Python.

Пороги, рівень і увімкнення можна змінити глобально або **для окремого проекту**
(селектор «Пороги для» у списку правил; API приймає `?project=<id>`). Нове правило
можна імпортувати з JSON («⤓» у списку правил) з превʼю перед збереженням, або
попросити Claude Code написати його скілом `write-pcb-rule`.

**Сцена** (`examples.bad/good`) — декларативний опис фрагмента плати в міліметрах, який
рендериться в SVG: `board`, `zone`, `part`, `pad`, `track` (з `bad: true` для підсвітки),
`via`, `label`, `dim` (розмірна лінія), `mark` (червоне коло), `arrow`, `keepout`.
Повний список полів у `src/shared/types.ts` (`SceneItem`).

## Локальний API

Піднімається на `http://127.0.0.1:4817` (порт у налаштуваннях).

```
GET   /api/health
GET   /api/rules                 усі правила з ефективними порогами (?enabled=1, ?category=power)
GET   /api/rules/<CODE>
PUT   /api/rules/<CODE>          створити/замінити користувацьке правило (тіло = JSON правила)
DELETE /api/rules/<CODE>         видалити користувацьке правило
GET   /api/config
PATCH /api/config                напр. {"overrides":{"PLANE_CUT":{"enabled":false,"params":{"plane_cut_warn_len":20}}}}
GET   /api/export/pcbagent       плоскі пороги + ignore_codes + severities для перевіряча
POST  /api/findings              звіт перевіряча {board, generated, findings:[{code, severity, title, …}]}
GET   /api/findings              останній збережений звіт
GET   /api/projects              зареєстровані проекти KiCad
GET   /api/chat/<projectId>      стан чату проекту (повідомлення, busy, очікуване питання)
POST  /api/chat/<projectId>/send {"text": "…"}  надіслати повідомлення Claude цього проекту
POST  /api/chat/<projectId>/interrupt
```

Інтеграція з перевірячем у два рядки:

```bash
curl -s localhost:4817/api/export/pcbagent > ~/Desktop/board/pcbagent.rules.json   # пороги в проект
curl -s -X POST localhost:4817/api/findings -H 'Content-Type: application/json' -d @pcb_report.json   # знахідки назад
```

Після `POST /api/findings` у сайдбарі біля кожного правила з'являється лічильник знахідок,
а в картці правила — список конкретних місць на платі.

## Як додати правило

1. Скопіюйте будь-який файл з `rules/` у `~/.config/pcb-rules-library/rules/NEW_CODE.json`.
2. Змініть `code`, тексти, пороги, намалюйте сцени.
3. Застосунок підхопить файл сам; помилки валідації видно в налаштуваннях.
4. Щоб правило реально перевірялося, додайте функцію в `pcbagent/checks.py`, яка видає
   `Finding(code="NEW_CODE", …)` і читає пороги з `CheckConfig` за ключами з `params`.
