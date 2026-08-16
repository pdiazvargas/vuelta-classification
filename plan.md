# Plan: Vuelta a España Classification plugin

Handoff doc for whoever (human or Claude) picks this up next. The GC pipeline has now been verified end-to-end against the 2024 archive (see "Verified against live data" below) and matches the real historical 2024 Vuelta results. The 2026 Vuelta itself starts **2026-08-22** (today is 2026-08-15), so the live `year = 2026` path is still untested against real in-season data — only the pre-race fallback has been observed for 2026. Read this whole file before changing `transform.js`.

## Verified against live data (2026-08-15/16)

Ran `./bin/trmnlp serve` via Docker against the 2024 archive (temporarily hardcoding `year = 2024`) and inspected the rendered output for all four view sizes plus `trmnlp lint`:

- **GC `type` ambiguity resolved**: `itg` (Individual Time General) is the real cumulative GC — confirmed by fetching `/api/rankingType-2024-{5,10,15,21}` and observing it present at every stage with a near-full field and gaps growing monotonically. `icg` is an unrelated single-rider intermediate-checkpoint snapshot (only appears on some stages, `rankings.length === 1`) — it is **not** a GC variant. `transform.js` now filters for `type === "itg"` only; do not add `"icg"` back in.
- **Found and fixed a real join bug**: `riderById`/`teamById` were keyed by the bare `_id` hash, but `$rider`/`$team` pointer fields are `"{collection}-{year}:{hash}"` — the colon-prefixed form was never stripped, so every rider/team lookup silently missed and fell back to `Bib {number}`. Added a `pointerId()` helper that strips the prefix before every lookup. Confirmed fixed: rendered output now shows real names (e.g. 2024 final GC top 10: Roglič, O'Connor, Mas, Carapaz, Skjelmose, Gaudu, Lipowitz, Landa, Sivakov, Rodríguez — matches the actual historical result).
- **Gap formatting** (previously a TODO — raw `divided_by: 1000` seconds): `transform.js` now computes a `gap` field (`mm:ss` / `h:mm:ss`) via `formatGap()`, used by all four templates instead of doing math in Liquid.
- **`trmnlp lint` found dead custom fields**: `classification_type` and `distance_unit` were declared in `settings.yml`/`.trmnlp.yml` but never read anywhere (the `customField()` helper in `transform.js` was defined but never called, and this plugin doesn't show distances — that field looks copy-pasted from the sibling plugin). Removed both rather than fake-wiring them; `about_this_plugin` is the only custom field now. Re-add a real classification-type selector only once jersey `type` codes are actually mapped (see "Jersey classifications" below).
- Both the empty pre-race state (`year = 2026`, no completed stages yet) and the populated state render cleanly with no Liquid errors, across `full`/`half_horizontal`/`half_vertical`/`quadrant`.

Not yet done: no visual design pass (still the plain scaffold list — see item 5 below), and `stageResult`/jersey classifications are less exhaustively tested than `gc`.

## Context

Sibling plugin [`../vuelta-a-espana-stages`](../vuelta-a-espana-stages) already ships today's/tomorrow's stage (route, distance, elevation profile). It only surfaces the GC leader's name as a small pill — no full standings, no stage results. This plugin's job is to cover what that one doesn't: full GC standings, and (stretch) the most recent stage's result and jersey classifications.

Both plugins hit the same undocumented backend: `racecenter.lavuelta.es`, ASO's Race Center platform (same one Tour de France uses). No API key. `fetchJson` in the sibling's `transform.js` has a `/api/*` path allowlist regex worth keeping.

## What's in this scaffold already

- Full TRMNL plugin file layout (`.trmnlp.yml`, `bin/trmnlp`, `.github/workflows/trmnl.yml`, `src/settings.yml`), copied/adapted from the sibling repo.
- `src/transform.js` — **working**, not just a stub: fetches the stage list, figures out the last completed stage number, fetches GC rankings for that stage, and joins rider/team names via `allCompetitors`/`team` lookups (see "Join model" below). Also attempts a stage-result fetch. Falls back to empty arrays before the race starts.
- `src/shared.liquid` + four size templates — bare-bones ranked-list markup, **no design pass done**. Functional enough to preview real data shape, not meant to be final.
- No plugin id yet (never pushed to TRMNL). `push` job in the workflow is disabled (`if: false`) on purpose — see TODOs in `src/settings.yml` and `.github/workflows/trmnl.yml`.

## Verified API research

All of this was checked live on 2026-08-15 with `curl -A "<a real browser UA>"` — the API 000s/empties out without a User-Agent header on some routes. Since the 2026 race hasn't started, live testing used the **2024 and 2025 archives** (`racecenter.lavuelta.es/api/...-2024`, `...-2025`), which are still fully populated. Swap `2026` back in once the race starts.

### Stage list — `/api/stage-{year}` — confirmed, already used by sibling plugin

Always populated regardless of race status. 21 stage objects. Used here only to determine the last completed stage number.

### General classification — `/api/rankingType-{year}-{stageNumber}` — confirmed shape and semantics

**This is not the endpoint the sibling plugin's `transform.js` uses.** The sibling calls `/api/ranking-{year}` (no stage number) — that endpoint returned HTTP 204 in every test against 2023/2024/2025/2026, for every year, including completed races. It appears to be wrong/dead, or the sibling's `gc` array has simply never been non-empty in practice. **Don't copy that endpoint into this plugin — use `rankingType-{year}-{stageNumber}` instead**, reverse-engineered from `chunk-common.*.js` on the Race Center site itself (search it for `rankingType` bind definitions).

Response is an array of ranking *snapshots*, each tagged with a `type` field. Samples observed:

```
GET /api/rankingType-2024-1   → [{"type":"itt", "rankings":[...]}]     (stage 1, 2024 — was a TTT)
GET /api/rankingType-2024-21  → [{"type":"icg", "rankings":[...], "checkpoint":27, ...}]  (final stage)
GET /api/rankingType-2025-1   → [{"type":"ite", "rankings":[...], "firstCompetitorTime":...}]
```

Each `rankings[]` row looks like:
```json
{"position":1,"bib":218,"absolute":58980481,"relative":0,"bonus":0,"penality":0,"$rider":"allCompetitors-2024:3ccf1762..."}
```
`absolute`/`relative` are **milliseconds**. `relative` is the gap to the leader (0 for the leader). `$rider` is a foreign-key string, not embedded rider data — see join model.

**Resolved:** `type === "itg"` (Individual Time General) is the real cumulative GC — the minified frontend's `generalRanking` getter was right. Confirmed by fetching this endpoint for 2024 stages 5/10/15/21: `itg` is present at every stage with a near-full field (135-174 riders) and `relative` gaps that grow monotonically over the race. `icg` (seen in the stage-1/21 samples above) is a red herring — inspecting it directly shows `rankings.length === 1` and a `checkpoint` field, i.e. a single-rider intermediate-checkpoint snapshot, not a GC variant. `transform.js` now filters for `type === "itg"` only.

### Stage result ("stage leaders") — `/api/rankingTypeArrival-{year}-{stageNumber}` — confirmed shape, high confidence

This is the answer to the original question that kicked this off ("do we have stage leaders?") — the sibling plugin doesn't use it at all. Sample (2024, stage 21):
```json
[{"rankings":[{"position":1,"bib":105,"absolute":1588370,"relative":0,"$rider":"allCompetitors-2024:1ff04..."}, ...]}]
```
Looks like straightforward stage finish order with time gaps to the stage winner. Less ambiguous than the GC endpoint — worth trusting more, but still not exhaustively tested (only checked one stage/year combo).

### Jersey classifications — `/api/rankingTypeJerseys-{year}-{stageNumber}` — shape confirmed, **codes barely explored**

Sample (2024, stage 21) returned a single entry with `"type":"pmt"`. The frontend bundle references jersey-related identifiers `rankingTypeJerseys`, `jerseyBibs`, `w-rankings__jersey` but no full code table was found (would need to grep `chunk-common.*.js` harder, or watch the Race Center site's network tab during a live/replay session). **Treat points/mountains/youth classifications as fully unimplemented for now** — the `classification_type` custom field was removed from `settings.yml` entirely (it was declared but never read anywhere, which `trmnlp lint` flags as an error). Re-add it as a real `select` field only once jersey `type` codes are mapped and `transform.js` actually branches on it.

### Rider/team identity — `/api/allCompetitors-{year}` and `/api/team-{year}` — confirmed, solid

Rankings only carry a `bib` and a `$rider` pointer, no name. Join model:

1. `GET /api/allCompetitors-{year}` → array of riders keyed by `_id` (the bare hash, **no** `"allCompetitors-{year}:"` prefix — that prefix is only present on the `$rider` pointer field, not on `_id` itself), each with `firstname`, `lastname`, `bib`, `$team` (pointer into the teams list, same prefix quirk).
2. `GET /api/team-{year}` → array of teams keyed by `_id` (matches `$team` once the prefix is stripped), with `name`/`nameShort`.
3. Build `riderById: Map<_id, {name, team}>` once per run, then look up each ranking row's `$rider` against it via `pointerId()` (strips the `"{collection}-{year}:"` prefix before the `Map.get`).

This part of `transform.js` is implemented and was spot-checked manually against the 2024 archive — confirmed working (see "Verified against live data" at the top; a prefix-stripping bug here was found and fixed during that pass).

## Suggested next steps, in order

1. ~~Resolve the GC `type` ambiguity~~ — done, see "Verified against live data" above.
2. ~~Test the full pipeline against real data~~ — done; also caught and fixed the `$rider`/`$team` pointer-prefix join bug and a `trmnlp lint` failure from unused custom fields.
3. Decide whether `stageResult` (via `rankingTypeArrival`) ships in v1 or is a follow-up — it's a nice differentiator vs. the sibling plugin but doubles the endpoints to maintain. Currently still in the scaffold and rendering correctly against 2024 data, but less exhaustively tested than `gc`.
4. ~~Format `gapMs` properly~~ — done; `transform.js` now emits a pre-formatted `gap` (mm:ss / h:mm:ss) field, templates use it directly.
5. **Before finalizing the Liquid templates, load the `frontend-design` skill** and do a real design pass — current markup is a plain list, not styled to match the sibling plugin's minimalist framework-native look (TRMNL design system v3.2.0, sparing red accent, `.item`/`.value`/`.label` conventions — see the sibling's `src/full.liquid` for the pattern to follow).
6. ~~Test locally with `./bin/trmnlp serve`~~ — done, see "Verified against live data" above. Remember: `year` in `transform.js` must stay `2026` in committed code; only hardcode `2024`/`2025` transiently for local dev, and revert before pushing.
7. First deploy: run `trmnlp push` manually (no `--id`) to create the plugin, capture the id TRMNL assigns, then fill it into `src/settings.yml`'s `id` field and `.github/workflows/trmnl.yml`'s `trmnlp push --id <n>`, and flip that workflow's `if: false` back on.
8. Consider whether this should stay a separate plugin or get merged into the sibling as an additional custom field — not decided; the sibling's README currently only mentions "the race leader" as a pill, so a separate plugin was assumed here, but worth a gut-check with the user.

## Design constraints to carry over from the sibling plugin

- No colors beyond black/white/`#e2001a` (sparing red accent), matching TRMNL's e-ink-friendly minimalist framework v3.2.0.
- No remote image fetches for the `title_bar` icon — inline base64 SVG only (network requests can fail; see the sibling's `shared.liquid` comment).
- `sanitizeString`-style HTML-escaping on every user-facing string pulled from the API (rider names, team names) before rendering — the scaffold's `transform.js` already does this via a copy of the sibling's sanitizer.
