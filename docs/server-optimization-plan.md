# Server response and architecture — optimization plan

## 1. Why

The stats server was built one tab at a time, and each tab's endpoint fetches
everything it needs from upstream on every request. That was the right call
while the surface was small. It now has four tabs, a health badge and several
pollers, and the cost of that design shows in three places:

- **Upstream load grows with the number of viewers.** Every open browser tab
  repeats the full hermes fan-out, including `/api/analytics/usage`, which is a
  SQL aggregation over a whole profile's session DB with a 45s timeout.
- **Payloads are larger than the page uses**, and nothing is compressed.
- **Some polls stack or arrive out of order** when upstream is slower than the
  poll interval.

This plan lists the changes in priority order. Nothing here changes what the
dashboard reports; every item is about cost, latency or robustness.

## 2. Biggest wins

### 2.1 Cache and share upstream calls

`/api/overview` runs every 30s per open tab. Each run makes four hermes calls
(`/api/status`, `/api/model/info`, `/api/cron/jobs`, `/api/profiles/sessions`)
plus one `/api/analytics/usage` call per profile. `/api/usage/unified` repeats
most of that every 60s. The `max-age=5` cache header in `sendJson` only helps a
single browser; two viewers double the upstream load.

- Put a small in-memory cache in front of `dashJson` and `proxyCollectorJson`,
  keyed by path: a TTL of about 30–60s for analytics and sessions, a few
  seconds for live metrics.
- Let concurrent callers share one in-flight request for the same key. The
  overview and unified endpoints then share `/api/status` and
  `usage?days=N` for free.
- **Stronger version:** have the server refresh upstream on its own schedule
  and serve clients the latest snapshot, optionally pushed over SSE. Upstream
  load then no longer depends on how many people are watching.

### 2.2 One login at a time

On a cold start or after a 401, phase 1 of `buildOverview` sends four
`dashJson` calls at once. Each one finds no cached cookie in `authHeaders` and
calls `passwordLogin` on its own — four parallel logins. `passwordLogin`
already treats 429 as a real outcome, so this can trip the dashboard's rate
limit. Loopback mode has the same problem with root-HTML scrapes, and every
path also rewrites the config file synchronously.

- Have all callers await one shared in-flight login (or scrape) promise, and
  write the config once when it settles.

### 2.3 Trim the overview payload

`buildOverview` returns `sessions: profileSessions` raw — up to 500 rows — but
`renderSessions` shows `.slice(0, 8)`. `summarizeActiveSessions` and
`aggregateModelDaily` already run server-side, so the browser needs nothing
else from the full list.

- Return only the top 8 rows, with just the fields the table renders.

### 2.4 Compression and browser caching

`sendJson` and `serveStatic` send no gzip or brotli. `index.html` is 163 KB
and is read from disk on every request, with no ETag or cache-control.

- Compress the files in `public/` once at startup and keep them in memory;
  serve with an ETag.
- Gzip JSON responses over about 1 KB with `zlib`. No new dependencies.

## 3. Latency

### 3.1 Parallelize the unified build

`buildUnifiedUsage` runs status → hermes usage and sessions → engine side, in
that order. The engine side needs only `dayList`, which is `windowDays(days)`
and depends on nothing upstream.

- Run `buildEngineSide` alongside the hermes calls. Saves a full collector
  round trip.
- Cache the profile list, which rarely changes, so the per-profile usage calls
  in both endpoints no longer wait on `/api/status` first.

### 3.2 Cache empty engine days

`engineDailyTokens` caches a closed day only when the collector returned rows
for it. A day the collector recorded nothing is never cached, so it counts as
"needed" on every request — and because the history query starts at
`needed[0] - 1`, one empty day 80 days back makes every request pull roughly
80 days of history.

- Cache an explicit "no data" marker for closed days inside the collector's
  recorded range.

### 3.3 Cheapen `/range`

The collector's `/range` handler runs `COUNT(*)`, `SUM(ok)` and
`COUNT(prompt_tokens)` over the entire `samples` table. At a 5s interval that
is about 17k rows a day, 1.5M+ for a 90-day collector. The server calls it on
every unified request and on Engine tab loads.

- Cache the result server-side for about 60s, or
- have the collector keep running counts in its `meta` table.

## 4. Load on the engine and proxy

### 4.1 Engine live polling

`buildEngineLive` fetches `/metrics`, `/slots` and `/props` every 4s per
viewer.

- `/props` is effectively static; reuse the existing `propsCache`.
- `/metrics` and `/slots` go through llama-server's task queue and block under
  heavy decode (see `docs/collect.py`). Dashboard polling adds to that on top
  of the collector's own 5s poll. Sharing one fetch across viewers (§2.1)
  keeps it at one fetch regardless of open tabs.
- While the Engine tab is open, derive the health badge from the tab's 4s
  poll instead of a separate `/metrics` call every 20s.

### 4.2 LiteLLM metrics parsing

LiteLLM's `/metrics/` output grows with every combination of key, team, user
agent and client IP. `parsePromLabeled` runs the label regex over every line,
every 4s, per viewer — and each scrape is itself recorded as a request on the
proxy.

- Skip lines whose metric name is not one of the families in
  `LITELLM_PROXY_COUNTERS`, `LITELLM_PROXY_HISTOGRAMS`,
  `LITELLM_DEP_COUNTERS` or the deployment gauges, before extracting labels.
- In `reduceLitellmMetrics`, replace the per-row loop over the histogram map
  with a lookup table (`<base>_sum` / `<base>_count` → key) built once.
- Cache the reduced result for about 3s so all viewers share one scrape.

## 5. Frontend polling

### 5.1 Stacked and out-of-order polls

`refresh()` (Hermes tab), `pollEngineLive` and `pollLbLive` run on
`setInterval` with no in-flight check. With analytics allowed up to 45s and a
30s poll, requests can stack, and a slow reply for an old day range can
overwrite a newer one.

- Schedule the next poll with `setTimeout` only after the current one settles.
- Cancel with `AbortController` on range change or tab switch, and ignore any
  reply whose request id is not the latest.

### 5.2 Usage-tab range clicks dropped

`refreshUnified` returns early when a request is in flight. A range click
during a load updates `uDays`, but the reply that renders is for the old
range, and the next fetch only happens on the following 60s poll.

- Same fix as §5.1: abort the in-flight request and start a new one.

## 6. Smaller items

- **Redundant daily series.** `hermes.daily`, `engine.daily` and
  `reconciled.daily` overlap heavily in the unified payload. Trim only if the
  page does not use all three.
- **Module split.** At ~2.5k lines, `server.mjs` would be easier to work on as
  modules (auth, hermes, engine, litellm, unified, http) with zero
  dependencies kept.
- **Control characters in `index.html`.** The `PROFILE_OTHER_KEY` sentinel is
  a raw control character, which makes `file` report the page as data and
  plain `grep` treat it as binary. Write it as a `'\u0000'`-style escape.

## 7. Suggested order

1. §2.1 and §2.2 together — shared cache and single shared login. Most benefit
   for the least code.
2. §2.3, §2.4 — small, contained payload wins.
3. §5.1, §5.2 — frontend polling fixes.
4. §3 and §4 as follow-ups.
