# Unified Usage tab — reconciling hermes and engine token counts

## 1. Why

The dashboard currently answers two questions in two places. The Usage tab
answers *what did hermes do* (demand side, hermes' own records). The Engine tab
answers *what did this llama.cpp endpoint do* (supply side, the endpoint's own
counters). Both are correct; neither is the number a self-hoster actually wants,
which is **how much work happened in total, and how much of it was mine**.

Asking that question of the existing tabs means eyeballing two sets of totals
with different denominators and mentally subtracting one from the other. The
subtraction is the interesting part and the dashboard should do it.

### Relationship to `engine-telemetry-plan.md`

That plan lists as an explicit non-goal:

> **Not** unifying the two into a single set of numbers. They have different
> denominators; a combined "tokens" figure would be wrong.

This project deliberately reverses that decision, and the reversal is only
defensible because of §3 below. A combined figure *is* wrong if it double-counts
hermes' engine traffic or silently equates two different prompt-token
definitions. The unified tab exists precisely to do the de-duplication
explicitly, name which lane is exact, and show the residual as its own series
rather than folding it invisibly into a total.

The attribution boundary from that plan is unchanged and still governs: **neither
traffic set contains the other**. What changes is that the overlap is now
computed and displayed instead of left to the reader.

---

## 2. The reconciliation model

```
H_e = hermes tokens on engine-hosted models       (hermes' records)
H_o = hermes tokens on every other provider       (cloud, other local models)
E   = engine tokens, all clients                  (collector history)

Engine (other clients) = max(0, E − H_e)
Total                  = H_o + H_e + max(0, E − H_e)
```

Worked example, the case that motivated the tab: hermes reports 1M tokens
against the engine-hosted model, the engine reports 2M tokens processed.
`H_e` = 1M, `H_o` = 0, `E` = 2M → **Hermes 1M · Engine 1M · Total 2M**. The
engine's 2M is not shown as 2M anywhere, because 1M of it *is* the hermes 1M.

### The residual is a real quantity, not an error term

`max(0, E − H_e)` is traffic from other clients on the LAN or tailnet —
`llama-server` binds `0.0.0.0:8080` with no auth, so this is expected to be
non-zero and is worth watching in its own right. It is labelled
**Engine · other clients**, never "unaccounted" or "overhead".

### When the residual clamps

`H_e > E` is possible and always means something is wrong or approximate:

1. the model map attributes a hermes model to this engine that does not run
   there (fix the map);
2. the collector has gaps in the window, so `E` is undercounted (coverage
   strip shows this) — the most likely cause on a deployment whose collector
   holds days of history against a 30- or 90-day window;
3. a profile dropped out of the hermes fan-out, so `H_e` is wrong in the other
   direction (reported as `hermes.complete: false`);
4. the two denominators have drifted apart after an upgrade on either side —
   see §3, which rests on a measurement rather than a contract.

The UI raises a named reconciliation warning naming the most probable cause
rather than silently showing zero.

---

## 3. Denominators — which lane is exact

| Lane | hermes counts | llama.cpp counts | Reconcilable |
|---|---|---|---|
| Generation / output | tokens the model produced | `tokens_predicted_total` | **Exactly** |
| Prefill / input | `input_tokens` — prompt tokens actually processed | `prompt_tokens_total` — tokens actually prefilled | **Yes, measured** |

### What this section originally said, and why it was wrong

The plan assumed hermes' `input_tokens` was a whole billed prompt, cache hits
included, and that llama.cpp's KV-prefix reuse would leave the engine counting
~10× less for identical traffic. The prescribed correction was
`input_tokens − cache_read_tokens`.

The live data refuted the premise on the first run of `/api/usage/unified`.
Over a 7-day window this deployment reports **24.6M input tokens against 374.5M
cache reads** — fifteen times larger. `cache_read_tokens` is a sibling field,
not a component of `input_tokens`; hermes reports input already net of whatever
the provider served from cache. Applying the planned correction clamps every
prefill figure to zero and destroys the lane.

**What is implemented instead: no correction at all.** Both sides already count
tokens actually processed — hermes excludes what the provider served from
cache, llama.cpp excludes what its prefix reuse skipped. They are on the same
denominator by construction.

A useful side effect: hermes evidently *does* receive cached-token accounting
from this llama.cpp provider, which is what makes the two counters comparable.

**Consequences for the UI:**

- Both lanes are labelled exact. The tab reports measured agreement between
  hermes' engine-attributed prefill and the collector's `prompt_tokens_total`
  for the same window, so drift is visible rather than assumed away.
- Cache reads remain on the tab as their own figure. On this deployment they
  are the largest number in the system and saying nothing about them would be
  the misleading choice.

**Phase 7 is no longer needed for correctness.** Recording
`n_prompt_tokens_cache` in `collect.py` would let the tab show the engine's own
cache-hit rate next to hermes' — a nice-to-have, not a fix.

---

## 4. Data sources and their limits

### hermes side

`/api/analytics/usage` returns an authoritative `by_model` rollup (SQL over the
full session DB, merged across profiles by `mergeUsage`) and an authoritative
`daily` rollup — but **`daily` has no model dimension**, which is what the split
needs. `by_model` has no day dimension, and no `cache_read_tokens` field at all.

Resolution, in order of authority:

1. **Window totals** come from `by_model`, split by the model map. Exact.
2. **Daily series** takes the authoritative `daily` totals and apportions each
   day between engine-hosted and other using the per-day model mix derived from
   the session list (`aggregateModelDaily`). Chart sums therefore equal tile
   totals by construction.
3. A day with no session rows falls back to the window-level mix and is flagged
   `estimated`.
4. `cache_read_tokens` and `reasoning_tokens` exist only per-day, not
   per-model, so they are apportioned between the two sides by the same ratio
   and reported alongside the lanes rather than inside them.

The session list is capped (`limit=500`), so on a 90-day window it may not reach
the window start. The route reports `attribution_coverage` — oldest session
timestamp vs window start — and the UI states the shortfall rather than
implying full coverage.

### engine side

The collector stores one row per poll (~5s) with monotonic counters. Daily
totals are built by requesting `/history` at **hourly** buckets
(`points = days × 24`, ≤ 2160, inside both the collector's and this server's
4000 clamp), differencing consecutive buckets, and folding the deltas into
**UTC days** to match hermes' `day` strings.

- `epoch` change between a pair → server restart, skip the pair (never
  difference across a restart into a false spike).
- `ok=0` buckets → the day is marked partial. Never rendered as zero.
- No `--metrics` on that server → generation falls back to `SUM(gen_delta)`
  (slot-derived) and prefill reports unavailable.
- Collector DB starts after the window start → the window is clipped and the
  coverage strip says so.

**Multi-engine:** token counts are summed across every engine that has a
collector, with a per-engine breakdown retained in the payload. This is a
deliberate, narrow exception to the "never aggregate engines" rule in the
engine plan: *rates* across two different models and context sizes do not sum
into anything meaningful, but *token counts* do.

### Caching

A closed UTC day's counters cannot change, so per-engine daily deltas for closed
days are cached indefinitely; only the current day re-fetches (60s TTL). A
90-day view costs one full scan on first load and almost nothing thereafter,
which matters because the tab shares the dashboard's 30s refresh.

---

## 5. Cost avoidance

Local inference has no per-token API cost, so the interesting figure is what the
same work would have cost on a comparable hosted model.

**Comparator: Google Gemini 3.5 Flash**, chosen as the nearest commercially
hosted equivalent to a Qwen 3.6 35B A3B class model on this deployment.
Published list price (Google AI for Developers, verified August 2026):

| | per 1M tokens |
|---|---|
| Input | $1.50 |
| Output | $9.00 |
| Cached input | $0.15 |

```
avoided = (H_e_input / 1e6 × input_rate) + (H_e_output / 1e6 × output_rate)
```

Scoped to `H_e` — hermes' own engine-hosted work. Other clients' traffic on the
endpoint is not hermes' avoided spend; it is shown separately as an
endpoint-wide figure in the tile's sub-line.

**Honesty requirements, enforced in the UI copy:**

- Rates are configurable (`config.comparator`), defaulted to the above, and the
  tile names the comparator model and the fact that it is list price.
- "Avoided" is API list price only. It excludes electricity, hardware
  amortisation, and operator time, and the tile says so.
- It is not a quality-equivalence claim. Different model, different outputs.

---

## 6. Plan

### Phase 1 — Tab shell

- [ ] Rename the existing Usage panel to **Hermes**, hash `#hermes`.
- [ ] New empty **Usage** panel, tab order `Usage | Hermes | Engine`, Usage the
      default on an empty hash. `#engine` deep links keep working.
- [ ] Move the shared `.attribution-note` out of the header into the Usage
      panel, rewritten for the three-way split.
- [ ] Usage owns its own range state and refresh timer, paused when the tab is
      hidden or the document is backgrounded — the same discipline the Engine
      tab already uses.

**Acceptance:** the Hermes tab behaves exactly as the Usage tab does today;
tab switching starts and stops the right timers, verified in the network panel.

### Phase 2 — Model → engine mapping

- [ ] `models: []` on each engine entry, validated in `sanitizeEngineEntry`.
- [ ] `GET /api/engine/model-suggest` — ranks hermes `by_model` names against
      the engine's `/props` `model_path` basename. Suggestion only; nothing is
      ever attributed without a saved mapping.
- [ ] Per-engine chip editor in `setup.html` with one-click adoption of
      suggestions.

**Acceptance:** a model is attributed if and only if it is in a saved map; the
suggester ranks the right `.gguf` first on this deployment; an unmapped but
plausible model surfaces a dismissible hint on the Usage tab.

### Phase 3 — `/api/usage/unified?days=N`, hermes side

- [ ] `by_model` split into `H_e` / `H_o` using the map. Authoritative totals.
- [ ] Daily series apportioned from the session model mix, `estimated` flag per
      day, sums equal to the totals.
- [ ] Prefill lane = `input_tokens` unmodified (see §3); `cache_read_tokens`
      apportioned alongside it as its own reported figure.
- [ ] `attribution_coverage` reported.

**Acceptance:** with the engine side stubbed out, hermes totals on the unified
route match the Hermes tab's totals exactly for the same window.

### Phase 4 — `/api/usage/unified`, engine side

- [ ] Hourly `/history` fetch → UTC daily deltas, epoch and `ok=0` handling.
- [ ] Multi-engine sum plus per-engine breakdown.
- [ ] Closed-day cache, 60s current-day TTL.
- [ ] Coverage metadata: first recorded sample, % ok samples, restarts spanned.

**Acceptance:** a 90-day window returns in under a second warm; a window
spanning a restart shows no spike; stopping a collector degrades that engine to
a coverage gap without failing the route.

### Phase 5 — Usage tab UI

- [ ] Tiles: Total (hero, `Total / Hermes / Engine` segmented), hermes' share of
      engine traffic, local vs cloud split of hermes work, cost avoided.
- [ ] Three-series smooth-line chart (`smoothPath`), optional total line,
      crosshair and keyboard tooltip, table view, CSV export.
- [ ] Lane toggle: `Combined | Prefill | Generation`, exactness labelled.
- [ ] Coverage strip: days without engine data hatched, never zero.
- [ ] Reconciliation health line naming the probable cause of a clamp.
- [ ] Busiest day / daily average / peak; per-engine breakdown table when more
      than one engine is summed.

**Acceptance:** the worked example in §2 renders as Hermes 1M · Engine 1M ·
Total 2M; correct in light and dark; no console errors; a missing collector
degrades to a hermes-only view with an explanatory note.

### Phase 6 — Docs

- [ ] README section for the tab, the reconciliation formula, the model map, the
      comparator rate, and the §3 limits.

**Acceptance:** someone who has not read this document can tell, from the README
and the UI alone, which lane is exact and why the engine number shrank.

### Phase 7 — Optional, not in v1

- [ ] `collect.py` records `n_prompt_tokens_cache`, so the engine's own
      cache-hit rate can sit next to hermes'. No longer a correctness fix —
      see §3.

---

## 7. Non-goals

- **Not** attributing engine load to individual hermes sessions. `/slots`
  exposes `id_task`, which has no path back to a hermes session id. Unchanged
  from the engine plan.
- **Not** replacing either existing tab. The Hermes and Engine tabs keep their
  own denominators and their own detail; the unified tab is a third view, not a
  merge.
- **Not** inferring the model map. Suggested, never assumed.
- **Not** claiming cost avoidance is savings. It is a list-price comparison
  against a different model.

---

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Prefill denominators drift apart after a hermes or llama.cpp upgrade | Moderate — §3 rests on a measurement, not a contract | Tab reports measured hermes-vs-collector agreement for the window, so drift shows up as a widening gap instead of a silent error |
| Model map drifts as models are renamed or moved | Moderate | Map is explicit and editable; unmapped-but-plausible models surface a hint rather than failing silently |
| Session cap truncates the 90-day daily split | Certain at high volume | `attribution_coverage` reported and stated in the UI; window totals stay authoritative regardless |
| 90-day collector scan is slow on the shared refresh cycle | Moderate | Closed days immutable and cached; only the current day re-fetches |
| Cost avoidance read as money saved | High, it is the most quotable number | Named comparator, list-price wording, explicit exclusion of power and hardware |
| Summing engines contradicts the engine plan | Certain, by design | Narrow exception documented here and in the README: counts sum, rates do not |
