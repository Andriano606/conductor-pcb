---
name: write-pcb-rule
description: Write a new PCB layout rule for Conductor PCB (a rules/*.json file with texts, thresholds, the engine `check` block and the two example diagrams), validate it, and add a checker kernel in pcbagent only when no existing kernel fits. Use when the user asks to add/create/write a rule, "додай правило", "нове правило", or describes a layout mistake the checker should catch.
---

# Write a PCB rule

A rule is **one JSON file** in `rules/` (bundled) or in the user rules dir
(`~/.config/conductor-pcb/rules/`). It carries everything: the texts people read, the
thresholds they can tune, the two diagrams, and the `check` block that tells the Python
engine (`~/Documents/Embedded/kicad-ai-layout/pcbagent/engine.py`) what to run.

## 1. Decide whether an existing kernel fits

Kernels are the generic measurements in `pcbagent/checks.py` (`Checker.check_<kernel>`).
List them: `grep -n "    def check_" ~/Documents/Embedded/kicad-ai-layout/pcbagent/checks.py`.
Each kernel reads its selectors/thresholds from `CheckConfig` (same file, top), so a **new rule
can reuse a kernel with different `args`**. Examples:

| want | kernel | emits | args |
|---|---|---|---|
| foreign tracks under an antenna | `tracks_under_crystal` | `TRACK_UNDER_CRYSTAL` | `{"crystal_ref_regex": "^ANT\\d+"}` |
| power net thinner than 0.5 mm | `power_width` | `POWER_TRACK_THIN` | `{"power_min_track_width": 0.5}` (or a param) |
| more than 1 via on I2C nets | `signal_stats` | `MANY_VIAS` | `{"signal_max_vias": 1}` |
| a KiCad DRC violation type | `kicad_drc` | `DRC_<TYPE>` | — (set `checker.engine` to `kicad-drc`) |

Only when nothing fits, add a kernel (step 4).

## 2. Write the file

Copy the closest existing rule and change every field. Required keys (schema:
`schema/rule.schema.json`, validation: `validateRule` in `src/shared/rules.ts`):

```jsonc
{
  "code": "TRACK_UNDER_ANTENNA",           // UPPER_SNAKE, unique; = the finding code
  "title": "…", "category": "signal",       // power|ground|signal|clock|manufacturing|mechanical|drc
  "severity": "error",                       // error|warning|info
  "summary": "one sentence",
  "description": "markdown: what is measured, in which units",
  "why": "markdown: the physics / manufacturing reason",
  "fix": "markdown: concrete steps",
  "params": [ { "key": "antenna_ref_regex", "label": "…", "type": "string", "default": "^ANT\\d+" } ],
  "checker": { "engine": "pcbagent", "function": "check_tracks_under_crystal", "measures": "…" },
  "check": { "kernel": "tracks_under_crystal", "emits": "TRACK_UNDER_CRYSTAL", "args": { "crystal_ref_regex": "^ANT\\d+" } },
  "tags": ["антена"], "references": [ { "title": "…", "url": "…" } ],
  "examples": { "bad": SCENE, "good": SCENE },
  "enabled": true
}
```

Rules:
- `params[].key` must be a `CheckConfig` field name; the user's value is written there before the kernel runs. `check.args` are written after params (they win) — use them for fixed selectors, params for things people tune.
- `check.emits` is the code the kernel produces internally; the engine re-tags it to `code`.
- Texts in Ukrainian, short, no fluff. `why` must give the physical reason, `fix` the concrete action.
- References only if you are sure they exist; no URL is better than a wrong one.

## 3. Draw the two scenes

`examples.bad` / `examples.good` are declarative scenes in mm rendered to SVG by
`src/renderer/src/components/BoardDiagram.tsx`. Items (see `SceneItem` in `src/shared/types.ts`):
`board`, `zone` (hatched, `layer` F|B, `net`), `part` (kind ic|cap|xtal|conn|res|generic),
`pad` (`th: true` for through-hole), `track` (`pts` [[x,y],…], `w`, `layer`, `bad: true` for a
magenta halo), `via` (`bad`), `label`, `dim` (dimension line with text), `mark` (red circle
+ text), `arrow`, `keepout`. Keep it to 6–12 items; the bad scene shows the mistake with a
`mark` or `bad` halo and a `dim` with the measured number; the good scene shows the same
place fixed. Canvas ~20–30 × 10–18 mm.

## 4. New kernel (only if needed)

In `pcbagent/checks.py`: add `CheckConfig` fields for its thresholds, add
`def check_<kernel>(self) -> list[Finding]` emitting `Finding(code=…, severity=…, title, detail,
fix, x, y, layer, items, net)`, and register it in `Checker.run()`'s function list. Add a
synthetic-board test in `tests/test_checks.py` (helpers `fp`, `pad`, `track`, `via`, `zone`,
`model`, `run`). Run `.venv/bin/python -m pytest -q tests`.

## 5. Validate and test

```bash
npm run validate-rules            # structure of every rules/*.json
npm test                          # tests/shared/rules-files.test.ts validates each bundled rule
```
The app watches the rules dirs — the new rule appears in «Правила» immediately; open it and
check both diagrams read well. If the user's project needs it, run the checker
(«Перевірити плату» or `python -m pcbagent.cli check`) and confirm the finding appears.
A user can also paste the JSON into «Імпортувати правило» in the app, which previews it
before saving.
