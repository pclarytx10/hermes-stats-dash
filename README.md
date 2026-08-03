# hermes-stats-dash

[hermes-workspace](https://github.com/outsourc-e/hermes-workspace) was a
browser-based front end for [hermes-agent](https://github.com/NousResearch/hermes-agent) —
chat, dashboard, the works. The launch of the official Hermes desktop client
made most of that HTML-interface work redundant: the desktop app is now the
supported way to chat with and manage a Hermes agent, and it shipped its own
login flow, which is also what pushed hermes-agent's dashboard off the old
simple-key auth and onto the `dashboard_auth` provider framework (OAuth /
OIDC / password) in v0.17.

What the desktop client doesn't cover is a lightweight, always-on view of
**hermes' usage** — token counts over time, sessions, top models — or of
**the llama.cpp engine underneath it** — live throughput, slot occupancy,
whether requests are queueing. That gap is what this project fills: a small,
standalone two-tab dashboard.

- **Usage** — demand-side accounting from hermes' own rollups: what hermes
  sent, extracted from hermes-workspace's dashboard capability and trimmed
  to the stats surface.
- **Engine** — supply-side telemetry read straight from a llama.cpp server's
  `/metrics`, `/slots`, and `/props`, plus recorded history from a small
  companion collector.

**These are different populations, not two views of the same number.**
llama.cpp sees every client on the endpoint, hermes included; hermes sees
models Usage cannot, including ones not served by this llama.cpp instance at
all. The dashboard says so explicitly (a one-line note above the tabs, and
in the Engine header badge's wording) rather than implying one is a subset
of the other — see [§1 of the design
doc](docs/engine-telemetry-plan.md#1-project-statement) for the full
reasoning.

Zero runtime dependencies. Node ≥ 18.

## What this shows

### Usage tab

- **Token counts over time** — stacked daily token columns, switchable
  between **By type** (input / output / reasoning, cache reads in the tooltip)
  and **By profile** (one segment per profile, tail folded into "Other").
  Both views share the same daily total and a table-view twin
- **Usage by model** — smooth per-model curves of daily token volume
  (top models get fixed colors, the tail folds into "Other"); derived from
  the sessions list since the usage endpoint has no model × day breakdown
- **Gateway activity** — live busy/idle badge, in-flight `active_agents`,
  active sessions, cron jobs, gateway mode (explained below), and the set of
  configured profiles with their live gateways highlighted
- **Totals** — tokens, sessions, API calls, cost for the selected window
- **Top models** — token volume, sessions, and API calls per model
- **Recent sessions** — latest activity with model and token counts

### Engine tab

- **Live panel** — prefill and generation throughput (both a short live
  reading off `/slots` progress and a settled on-completion figure from
  `/metrics` counters), prompt-cache reuse, server state (idle / prefilling
  / generating / queued), a per-slot table, and an endpoint + model identity
  line (URL, model file, build, `n_ctx`)
- **History panel** — a range picker (15m/1h/6h/24h/7d/all) over data the
  collector has recorded, a canvas strip chart, a window summary (average
  throughput, token volumes, mean busy slots, sample coverage), and a CSV
  export. A server restart mid-window renders as a break, not a false spike;
  a collector outage renders as a visible gap, not a silent zero
- **Multi-engine** — an engine picker when more than one is configured;
  switching discards in-memory state, since neither counters nor epochs are
  comparable across endpoints
- **Honest degradation** — llama.cpp builds vary: some `/slots` responses
  omit prompt-token fields entirely, some report `next_token` as a
  one-element array instead of an object. The server feature-detects both
  per poll and the UI says so (e.g. "Unavailable: this build's `/slots` does
  not report `n_prompt_tokens_cache`") rather than silently showing a zero

### Engine health badge

A small badge in the shared header, visible from the Usage tab, answering
one question: *is the engine underneath currently a bottleneck?* It's keyed
on `requests_deferred`, not slot occupancy — a fully-busy engine is normal
(**Full**, amber); a *queueing* engine (**Queued**, red, shows the count) is
the one state that actually explains a slow session. Other states: **Idle**,
**Active**, **Not responding** (a `/metrics` timeout — itself weak evidence
of load, reported as its own state), **Unreachable**, and **Stale** (no
successful poll in 90s — shown rather than a confidently wrong old state).
Hidden entirely with no engine configured. Wording never says "your
requests" — it names the endpoint and notes load may include other clients.
Clicking it opens the Engine tab.

Zero collector dependency: the badge's route (`GET /api/engine/health`)
reads only `llamaUrl`, so it works even with the collector not installed —
only the History panel needs the collector.

Both light and dark themes; the light/dark toggle is shared across both
pages and both tabs.

## How it works

`server.mjs` is a single-file server: static file serving plus a handful of
JSON API routes, all fanning out in parallel to upstreams and nulling a
section on failure rather than failing the whole request.

### Usage routes

| Route | Fans out to |
|---|---|
| `GET /api/overview?days=N` | `/api/analytics/usage` (once per profile, merged), `/api/profiles/sessions`, `/api/status`, `/api/cron/jobs`, `/api/model/info` — see [Cross-profile aggregation](#cross-profile-aggregation) below |
| `GET /api/settings` / `POST /api/settings` | reads/writes `~/.hermes-stats-dash/config.json` |
| `POST /api/test` | probes a hermes dashboard URL + credentials, used by the Setup page |

### Engine routes

| Route | Behaviour |
|---|---|
| `GET /api/engine/live?engine=<id>` | Fans out to the engine's `/metrics`, `/slots`, `/props` in parallel. Parses the Prometheus text server-side (so the frontend never touches raw upstream shapes) and returns feature-detection flags (`hasPromptFields`, `nextTokenShape`) alongside the parsed data. Each of the three sections nulls independently on failure |
| `GET /api/engine/history?engine=<id>&from=&to=&points=` | Validated, clamped proxy to the collector's `/history` |
| `GET /api/engine/range?engine=<id>` | Proxy to the collector's `/range`, for the "all" range button |
| `GET /api/engine/health?engine=<id>` | The badge's data source. `/metrics` only, 3s timeout, `total_slots` cached from `/props` for 5 minutes |
| `GET /api/engines` | `[{id, label}, ...]` for the tab's engine picker |
| `POST /api/engine/test` | Ad-hoc reachability probe for the Setup page's per-engine row (llama-server + collector, independent of saved config) |

Every upstream call uses a short timeout (`UPSTREAM_TIMEOUT_MS`, 10s for
Usage and the live/history/range engine routes; 3s for the health badge) so
a stalled upstream degrades a section to null rather than hanging the
request — `/metrics` and `/slots` are answered off llama-server's own task
queue and can block for seconds under heavy decode.

`public/index.html` is the whole frontend for both tabs (vanilla JS + SVG
for the Usage charts, canvas for the Engine strip charts — 400+ columns is
more than SVG wants to redraw every poll). No build step.

### Cross-profile aggregation

Every hermes profile has its own session DB, and `/api/analytics/usage` is
single-profile — so on a multi-profile install the default-scoped numbers
undercount the whole workspace. `buildOverview` reads the profile list from
`/api/status`, fans out one `usage` call **per profile**, and sums hermes'
authoritative rollups (daily token rows, per-model breakdown, and totals).
Summing the server-side SQL rollups is more accurate than re-deriving from a
capped session list, and a profile that errors or has no DB yet is simply
skipped, so a partial fan-out still aggregates. The status line shows
`stats across N/M profiles`, and the recent-sessions + per-model views draw
from the cross-profile `/api/profiles/sessions` list (each row tagged with
its owning profile). The one dimension hermes has no endpoint for —
per-day-**per-model** volume — is still derived from that session list, so it
is an approximation over the sampled window while the token totals and
per-model totals come from the authoritative rollups.

### Gateway activity & profiles

The activity card combines hermes' `/api/status` topology with a
cross-profile session scan:

- **Active sessions** — the reliable "what's running now" signal, from
  `/api/profiles/sessions` filtered by each row's `is_active` flag. This
  scans **every** profile, which matters under `gateway_mode: multiple`:
  a live session on a non-default profile is invisible to the default
  gateway's own `active_sessions` count, so relying on `/api/status` alone
  (as the first cut did) shows nothing. Each active session is listed with
  its profile, model, message count, and age; the badge reads **Active** when
  any session is live.
- **In-flight turns** (`active_agents`) — running main gateway turns + cron
  jobs + API runs; drives the **Busy** badge. **Sub-agents are not counted
  here.** hermes runs `delegate_task` sub-agents in-process under the parent
  session — they create no child session rows (`parent_session_id` is never
  set on the wire) and no endpoint exposes them, so a session busy with
  sub-agents shows `0` in-flight turns while still appearing as an active
  session. The card says so explicitly rather than implying the gateway is
  idle.
- **`gateway_mode`** — how profiles map to gateway processes:
  | Mode | Meaning |
  |---|---|
  | `single` | One gateway serving one profile |
  | `multiplex` | One gateway serving several profiles |
  | `multiple` | An independent gateway per profile |
  | `none` | No gateway process running |
- **Profiles** — every configured profile. Those with a live gateway are
  tagged **live** (from `gateways[]`, only returned on a **loopback /
  `--insecure`** bind); behind the v0.17+ auth gate that detail is withheld,
  so the card instead tags profiles that have an **active session** from the
  cross-profile scan.

## Run

```sh
npm start          # serves http://127.0.0.1:8788
```

With a hermes-agent dashboard running locally on the default port, that's
it for the Usage tab. For a remote or auth-gated hermes, or to configure an
Engine tab, open `/setup.html`.

No hermes handy? `node scripts/mock-hermes.mjs` fakes one on :9119
(`node scripts/mock-hermes.mjs password` simulates a v0.17+ auth-gated
dashboard — credentials `admin` / `hermes`).

## Configuration

Everything is configurable from the **Setup page** (`/setup.html`), saved to
`~/.hermes-stats-dash/config.json` (owner-only `0600` — it can hold hermes
credentials; engine entries hold none).

### Hermes connection (Usage tab)

Remote URL, credentials, a **Test connection** button that reports
reachability / auth mode / whether a credential was cached, and a way to
forget cached tokens. Saved settings take precedence over the environment:

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8788` | Port for this app |
| `HOST` | `127.0.0.1` | Bind address (see below) |
| `HERMES_DASHBOARD_URL` | `http://127.0.0.1:9119` | hermes-agent dashboard service |
| `HERMES_DASHBOARD_TOKEN` | – | Bearer token (v0.17+ token-auth seam) |
| `HERMES_DASHBOARD_COOKIE` | – | Session cookie (v0.17+ interactive auth) |
| `HERMES_DASHBOARD_USERNAME` / `_PASSWORD` | – | Password-provider login (v0.17+) |

### Engines (Engine tab)

A **list** — the real deployment this was built for has two llama.cpp
servers with different models, builds, and context sizes. Each entry:

```json
{
  "engines": [
    { "id": "nfcmini",   "label": "nfcmini · Qwen3.6-35B",
      "llamaUrl": "http://127.0.0.1:8080",
      "collectorUrl": "http://127.0.0.1:8081" },
    { "id": "mini795s7", "label": "mini795s7 · Gemma-4-E4B",
      "llamaUrl": "http://10.0.0.65:8080",
      "collectorUrl": "http://10.0.0.65:8081" }
  ]
}
```

`llamaUrl` is required; `collectorUrl` is optional — without it the Engine
tab's live panel and health badge still work, but the History panel shows an
install prompt instead of a chart. The Setup page's **Engines** card lets
you add/remove/edit rows and **Test connection** each one (reachability,
whether `/metrics` is enabled, whether the collector answers) before saving.

For a single-engine deployment with no saved config, these two env vars are
an equivalent fallback:

| Env var | Purpose |
|---|---|
| `LLAMA_SERVER_URL` | e.g. `http://127.0.0.1:8080` |
| `LLAMA_COLLECTOR_URL` | e.g. `http://127.0.0.1:8081` (optional) |

**Address choice for a remote engine:** prefer a LAN IP over mDNS
(`*.local`) — mDNS resolution costs ~100ms per call, negligible for a human
clicking a page but wasteful for something polled every few seconds.
Tailscale would be preferable (authenticated, encrypted) if it works between
the two hosts; if not, a plaintext LAN hop is what this dashboard assumes.

## Engine tab prerequisite: the telemetry collector

The Engine tab's **live** panel and the **health badge** need only
`llamaUrl` — a llama.cpp server started with `--metrics` is enough. The
**History** panel additionally needs a collector: a small, dependency-free
Python process that polls `/metrics` and `/slots` on an interval, writes one
row per poll to SQLite, and serves a read-only JSON API (`/range`,
`/history`) that this dashboard proxies.

A reference copy of the collector lives at [`docs/collect.py`](docs/collect.py)
(see [`docs/engine-telemetry-plan.md`](docs/engine-telemetry-plan.md) for
the full design rationale). It is **not** run by `server.mjs` — deploy it
separately, once per llama.cpp host:

```sh
mkdir -p ~/llamacpp-telemetry
cp docs/collect.py ~/llamacpp-telemetry/collect.py
python3 ~/llamacpp-telemetry/collect.py \
  --db ~/llamacpp-telemetry/telemetry.db \
  --server http://127.0.0.1:8080 \
  --interval 5 \
  --port 8081
```

Stdlib only, no dependencies, works on any Python 3. In production, run it
as a **systemd user unit** so it survives logout and restarts on crash:

```ini
# ~/.config/systemd/user/llamacpp-telemetry.service
[Unit]
Description=llama-server telemetry collector
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 %h/llamacpp-telemetry/collect.py \
  --db %h/llamacpp-telemetry/telemetry.db \
  --server http://127.0.0.1:8080 \
  --interval 5 \
  --port 8081
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now llamacpp-telemetry.service
loginctl enable-linger "$USER"   # keeps user units running after logout
```

### Collector bind address (`--bind`)

This is a **per-collector deployment choice**, independent of anything this
dashboard does. This dashboard reaches a collector through its own proxy
regardless of the collector's bind address — a collector open to the LAN is
still reachable through the proxy, it's just *also* directly reachable,
which matters if anything besides this dashboard needs it:

- **`--bind 0.0.0.0`** (default) — reachable from any host on the LAN.
  Needed if a standalone telemetry page, another dashboard instance, or any
  other direct client should be able to reach it.
- **`--bind 127.0.0.1`** — reachable only from the same host. Appropriate
  once this dashboard is the collector's only caller and it runs on the same
  machine as the collector (the common case for the "local" engine in a
  multi-engine setup — see the example config above, where the co-located
  engine dials `127.0.0.1` and the remote one dials a LAN IP).

The collector has **no authentication of its own**. `--bind 0.0.0.0` means
anything on the LAN can read the recorded history; `127.0.0.1` avoids that
at the cost of the flexibility above. Neither this dashboard nor
`docs/collect.py` enforces one choice — pick per deployment.

Verify a collector is up: `curl http://<collector-host>:8081/range` should
return `{"from":..., "to":..., "rows":N, ...}`.

## Running this dashboard as a service

`npm start` is fine for trying it out, but it dies with the terminal
session it started in. To keep it running:

```ini
# ~/.config/systemd/user/hermes-stats-dash.service
[Unit]
Description=hermes-stats-dash
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/hermes-stats-dash
ExecStart=/usr/bin/node %h/hermes-stats-dash/server.mjs --remote
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now hermes-stats-dash.service
```

Drop `--remote` from `ExecStart` (or change it to `--host <addr>`) to bind
somewhere other than every interface — see [Local vs. remote
access](#local-vs-remote-access) below.

## Local vs. remote access

By default the server binds **`127.0.0.1`** — reachable only from the same
machine. To let other devices reach it, open the bind address:

```sh
npm start -- --remote            # bind 0.0.0.0 (all interfaces)
npm start -- --host 100.x.y.z    # bind a specific address, e.g. a Tailscale IP
HOST=0.0.0.0 npm start           # same via env var
```

Precedence: `--host` › `--remote`/`-r` › `HOST` › loopback default.

> ⚠ This server has **no authentication of its own** and can hold the
> upstream dashboard credentials you configure. When bound to a non-loopback
> address it prints a warning — only expose it on a trusted network (a
> Tailscale/VPN address, not `0.0.0.0` on a public interface).

## Authentication — the hermes v0.17 change

hermes-agent **v0.17** replaced the dashboard's simple-key login with the
`dashboard_auth` provider framework. This app supports both worlds, resolved
in this order:

1. **Bearer token** — sent as `Authorization: Bearer …`. This is the v0.17+
   non-interactive seam (`dashboard_auth/token_auth.py`) intended for
   service-to-service callers like this one. Note it only authorizes routes
   hermes has registered as token-authable; if your build hasn't registered
   the analytics routes, use one of the modes below.
2. **Session cookie** — a cookie copied from a browser after logging in
   through a v0.17+ provider (Nous OAuth, self-hosted OIDC, or basic
   password), for dashboards bound to a non-loopback host.
3. **Username / password** — for gateways whose dashboard sits behind a
   password provider. The server discovers the provider via
   `GET /api/auth/providers`, logs in with `POST /auth/password-login`,
   caches the minted `hermes_session_*` cookies, and re-logs-in
   automatically when a request comes back 401 (session expiry or restart).
4. **Loopback token scrape (default)** — when the dashboard binds to
   `127.0.0.1` (no auth gate), hermes still injects an ephemeral
   `window.__HERMES_SESSION_TOKEN__` into its root HTML — the pre-v0.17
   "simple key". The server scrapes it on demand, caches it, and re-scrapes
   once on a 401 (the token rotates every dashboard restart). No
   configuration needed.

This auth model applies to the Usage tab's hermes connection only. The
Engine tab's llama.cpp and collector connections have no auth of their own
(see [Collector bind address](#collector-bind-address---bind) above) —
that is a property of the upstream, not something this app adds.

## Provenance

- Aggregation pattern, endpoint list, and loopback token scrape:
  `hermes-workspace/src/server/dashboard-aggregator.ts`,
  `src/server/gateway-capabilities.ts`,
  `src/routes/api/dashboard/overview.ts`
- Upstream API shapes and auth model: `hermes-agent/hermes_cli/web_server.py`
  (`/api/analytics/usage`, `/api/sessions`) and
  `hermes-agent/hermes_cli/dashboard_auth/`
- Engine tab: direct successor to a standalone `llamacpp-telemetry.html`
  page (kept in service, unmodified, alongside this tab — see
  [`docs/engine-telemetry-plan.md`](docs/engine-telemetry-plan.md) §1).
  Live-rate math (slot-progress differencing, prompt-cache reuse tracking,
  decode-counter fallback) and the collector (`docs/collect.py`) are ported
  from that page and its companion service.
