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
usage stats — token counts over time, sessions, top models — the kind of
thing you want open in a tab or on a second screen rather than tucked inside
the full app. That gap is what this project fills: a small, standalone
statistics dashboard, extracted from hermes-workspace's dashboard
capability and trimmed to just the stats surface:

- **Token counts over time** — stacked daily input / output / reasoning
  tokens (cache reads in the tooltip and table view)
- **Usage by model** — smooth per-model curves of daily token volume
  (top models get fixed colors, the tail folds into "Other"); derived from
  the sessions list since the usage endpoint has no model × day breakdown
- **Totals** — tokens, sessions, API calls, cost for the selected window
- **Top models** — token volume, sessions, and API calls per model
- **Recent sessions** — latest activity with model and token counts
- **Setup page** (`/setup.html`) — point the app at a local or remote
  hermes, test the connection/auth, and persist everything to
  `~/.hermes-stats-dash/config.json` (mode `0600`)

Zero runtime dependencies. Node ≥ 18.

## How it works

`server.mjs` is a ~200-line port of hermes-workspace's server-side
`dashboard-aggregator`: one `GET /api/overview?days=N` endpoint that fans out
in parallel to the hermes-agent **dashboard service** (default
`http://127.0.0.1:9119`):

| Upstream endpoint | Feeds |
|---|---|
| `/api/analytics/usage?days=N` | daily token chart, totals, top models |
| `/api/sessions?limit=10&order=recent` | recent sessions card |
| `/api/status` | status line |
| `/api/model/info` | active model in the status line |

Each section is independent — a failed upstream call nulls that section and
the UI hides the card, same as the workspace dashboard. `public/index.html`
is the whole frontend (vanilla JS + SVG, light/dark via
`prefers-color-scheme`).

## Run

```sh
npm start          # serves http://127.0.0.1:8788
```

With a hermes-agent dashboard running locally on the default port, that's
it. For a remote or auth-gated hermes, open `/setup.html`.

No hermes handy? `node scripts/mock-hermes.mjs` fakes one on :9119
(`node scripts/mock-hermes.mjs password` simulates a v0.17+ auth-gated
dashboard — credentials `admin` / `hermes`).

## Configuration

Everything is configurable from the **Setup page** (`/setup.html`): remote
URL, credentials, a **Test connection** button that reports reachability /
auth mode / whether a credential was cached, and a way to forget cached
tokens. Saved settings live in `~/.hermes-stats-dash/config.json`
(owner-only `0600` — it can hold credentials) and take precedence over the
environment:

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8788` | Port for this app |
| `HOST` | `127.0.0.1` | Bind address (see below) |
| `HERMES_DASHBOARD_URL` | `http://127.0.0.1:9119` | hermes-agent dashboard service |
| `HERMES_DASHBOARD_TOKEN` | – | Bearer token (v0.17+ token-auth seam) |
| `HERMES_DASHBOARD_COOKIE` | – | Session cookie (v0.17+ interactive auth) |
| `HERMES_DASHBOARD_USERNAME` / `_PASSWORD` | – | Password-provider login (v0.17+) |

### Local vs. remote access

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

## Authentication — the v0.17 change

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

## Provenance

- Aggregation pattern, endpoint list, and loopback token scrape:
  `hermes-workspace/src/server/dashboard-aggregator.ts`,
  `src/server/gateway-capabilities.ts`,
  `src/routes/api/dashboard/overview.ts`
- Upstream API shapes and auth model: `hermes-agent/hermes_cli/web_server.py`
  (`/api/analytics/usage`, `/api/sessions`) and
  `hermes-agent/hermes_cli/dashboard_auth/`
