/**
 * hermes-stats-dash — standalone statistics dashboard for hermes-agent.
 *
 * A single-file aggregation server, extracted from the hermes-workspace
 * dashboard capability (src/server/dashboard-aggregator.ts +
 * src/routes/api/dashboard/overview.ts) and trimmed to the stats surface:
 * token counts over time, sessions, and top models.
 *
 * It fans out to the hermes-agent dashboard service (default :9119):
 *   GET /api/status                 — gateway/platform status
 *   GET /api/analytics/usage?days=N — daily token counts, by-model rollup, totals
 *   GET /api/sessions               — recent sessions
 *   GET /api/model/info             — active model
 * Each section is independent: if one upstream call fails the section is
 * null and the UI hides that card, mirroring the workspace behaviour.
 *
 * Auth (hermes-agent >= 0.17 changed dashboard login from a simple key to
 * the dashboard_auth provider framework):
 *   1. Bearer token — the v17+ token-auth seam (service-to-service routes
 *      registered via register_token_route).
 *   2. Session cookie — captured after logging in through a v17+ auth
 *      provider (Nous OAuth / self-hosted OIDC / basic password) for
 *      dashboards bound to a non-loopback host.
 *   3. Username/password — performs the v17+ password-provider login
 *      (POST /auth/password-login) itself, caches the resulting session
 *      cookies, and re-logs-in when they expire (401).
 *   4. Loopback fallback — scrape the ephemeral session token the dashboard
 *      injects into its root HTML (window.__HERMES_SESSION_TOKEN__). This is
 *      the pre-v17 "simple key" path and still works on 127.0.0.1 binds.
 *      The scraped token is cached (in memory and in the config file) and
 *      re-scraped whenever a request comes back 401 — it rotates on every
 *      dashboard restart.
 *
 * Settings precedence (same convention as hermes-workspace overrides):
 *   saved config (~/.hermes-stats-dash/config.json, written by /setup.html)
 *   > environment (HERMES_DASHBOARD_URL / _TOKEN / _COOKIE)
 *   > defaults.
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT || 8788)
const UPSTREAM_TIMEOUT_MS = 10_000
// /api/analytics/usage is a SQL aggregation over a whole profile's session DB
// and gets slower the wider the window: on a large default profile a 90-day
// call routinely passes 10s. It needs its own budget, because a dropped
// profile is not a cosmetic gap — the unified tab subtracts hermes' tokens
// from the engine's total, so an undercounted profile silently inflates the
// "other clients" residual.
const ANALYTICS_TIMEOUT_MS = 45_000

// Bind host. Loopback-only by default so the stats server — which proxies
// upstream credentials and has no auth of its own — isn't reachable off the
// machine unless explicitly opened up.
//   --remote / -r          → bind 0.0.0.0 (all interfaces)
//   --host <addr> / HOST   → bind a specific address
const argv = process.argv.slice(2)
function argValue(...names) {
  for (const name of names) {
    const i = argv.indexOf(name)
    if (i !== -1 && argv[i + 1]) return argv[i + 1]
  }
  return null
}
const HOST =
  argValue('--host') ||
  (argv.includes('--remote') || argv.includes('-r') ? '0.0.0.0' : null) ||
  process.env.HOST ||
  '127.0.0.1'
const isLoopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1'

function trimSlash(u) {
  return String(u || '').trim().replace(/\/+$/, '')
}

// ── Persistent config ───────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.hermes-stats-dash')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeConfig(next) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
    // The file can hold credentials — keep it owner-only.
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    })
  } catch (err) {
    console.warn(`[config] failed to persist ${CONFIG_FILE}: ${err?.message || err}`)
  }
}

let config = readConfig()

const ENV_URL = trimSlash(process.env.HERMES_DASHBOARD_URL || '') || 'http://127.0.0.1:9119'
const dashboardUrl = () => trimSlash(config.dashboardUrl || ENV_URL)
const urlSource = () =>
  config.dashboardUrl ? 'saved' : process.env.HERMES_DASHBOARD_URL ? 'env' : 'default'
const staticToken = () =>
  (config.token || process.env.HERMES_DASHBOARD_TOKEN || '').trim()
const tokenSource = () =>
  config.token ? 'saved' : process.env.HERMES_DASHBOARD_TOKEN ? 'env' : null
const staticCookie = () =>
  (config.cookie || process.env.HERMES_DASHBOARD_COOKIE || '').trim()
const cookieSource = () =>
  config.cookie ? 'saved' : process.env.HERMES_DASHBOARD_COOKIE ? 'env' : null
const staticUsername = () =>
  (config.username || process.env.HERMES_DASHBOARD_USERNAME || '').trim()
const staticPassword = () =>
  config.password || process.env.HERMES_DASHBOARD_PASSWORD || ''
const passwordSource = () =>
  config.password ? 'saved' : process.env.HERMES_DASHBOARD_PASSWORD ? 'env' : null

// ── Engine (llama.cpp) config ────────────────────────────────────────
//
// A list of { id, label, llamaUrl, collectorUrl }. No entry holds
// credentials, so none needs redaction in sanitizedSettings(). Falls back to
// a single env-configured engine (LLAMA_SERVER_URL / LLAMA_COLLECTOR_URL) for
// a bare deployment with no saved config.

const ENV_LLAMA_URL = trimSlash(process.env.LLAMA_SERVER_URL || '')
const ENV_COLLECTOR_URL = trimSlash(process.env.LLAMA_COLLECTOR_URL || '')

function sanitizeEngineEntry(e) {
  if (!e || typeof e !== 'object') return null
  const id = String(e.id || '').trim()
  const llamaUrl = trimSlash(e.llamaUrl || '')
  if (!id || !/^https?:\/\//.test(llamaUrl)) return null
  const collectorUrl = trimSlash(e.collectorUrl || '')
  return {
    id,
    label: String(e.label || '').trim() || id,
    llamaUrl,
    collectorUrl: /^https?:\/\//.test(collectorUrl) ? collectorUrl : '',
    // hermes model names served by this engine. Nothing is attributed to an
    // engine without an explicit entry here — the suggester proposes, the
    // operator decides. Deduped case-insensitively; order is not meaningful.
    models: dedupeModels(e.models),
  }
}

function dedupeModels(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const m of raw) {
    const name = String(m || '').trim()
    if (!name || name.length > 200) continue
    const k = name.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(name)
    if (out.length >= 32) break
  }
  return out
}

function engines() {
  if (Array.isArray(config.engines)) {
    const list = config.engines.map(sanitizeEngineEntry).filter(Boolean)
    if (list.length) return list
  }
  if (ENV_LLAMA_URL) {
    return [{ id: 'default', label: 'llama.cpp', llamaUrl: ENV_LLAMA_URL, collectorUrl: ENV_COLLECTOR_URL }]
  }
  return []
}

// No id → the first configured engine (the tab's default). An unknown id →
// null, so the caller can 404 rather than silently falling back.
function engineById(id) {
  const list = engines()
  if (!list.length) return null
  if (!id) return list[0]
  return list.find((e) => e.id === id) || null
}

// ── Scraped session-token cache (loopback / pre-v17 mode) ───────────

// Accepts both the current and legacy variable names the dashboard has
// injected across versions (window.__HERMES_SESSION_TOKEN__ et al).
const SESSION_TOKEN_REGEX =
  /window\._+(?:CLAUDE|HERMES)_+SESSION_+TOKEN__+\s*=\s*["']([^"']+)["']/

function cachedSessionToken(base) {
  return config.cachedSessionTokenUrl === base ? config.cachedSessionToken || '' : ''
}

function storeSessionToken(base, token) {
  if (token) {
    config.cachedSessionToken = token
    config.cachedSessionTokenUrl = base
  } else {
    delete config.cachedSessionToken
    delete config.cachedSessionTokenUrl
  }
  writeConfig(config)
}

async function scrapeSessionToken(base) {
  // The token is injected on `/` (root), not on the raw built index.html.
  try {
    const res = await fetch(`${base}/`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!res.ok) return ''
    const html = await res.text()
    return html.match(SESSION_TOKEN_REGEX)?.[1]?.trim() || ''
  } catch {
    return ''
  }
}

// ── Password-provider login (v0.17+ interactive auth, non-OAuth) ────

function cachedLoginCookie(base) {
  return config.cachedLoginCookieUrl === base ? config.cachedLoginCookie || '' : ''
}

function storeLoginCookie(base, cookie) {
  if (cookie) {
    config.cachedLoginCookie = cookie
    config.cachedLoginCookieUrl = base
  } else {
    delete config.cachedLoginCookie
    delete config.cachedLoginCookieUrl
  }
  writeConfig(config)
}

/**
 * Log in against the dashboard's password provider and return the session
 * Cookie header value. Provider discovery goes through the public
 * /api/auth/providers route; login is POST /auth/password-login, which on
 * success sets hermes_session_at / _rt / _provider cookies (possibly
 * __Secure-/__Host- prefixed over HTTPS). Throws Error with a
 * human-readable message on failure.
 */
async function passwordLogin(base, username, password) {
  let providers = []
  try {
    const res = await fetch(`${base}/api/auth/providers`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (res.ok) providers = (await res.json())?.providers || []
  } catch {
    /* provider listing is best-effort; fall through to the guess below */
  }
  const candidates = providers.filter((p) => p?.supports_password).map((p) => p.name)
  // A pre-auth-gate or misconfigured dashboard may not list providers;
  // "basic" is the bundled password provider's name.
  if (!candidates.length) candidates.push('basic')

  let lastError = 'no password provider accepted the credentials'
  for (const provider of candidates) {
    const res = await fetch(`${base}/auth/password-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ provider, username, password }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (res.ok) {
      const setCookies =
        typeof res.headers.getSetCookie === 'function'
          ? res.headers.getSetCookie()
          : []
      const pairs = setCookies
        .map((c) => c.split(';')[0].trim())
        .filter((pair) => pair.includes('=') && pair.split('=')[1] !== '')
      if (!pairs.length) throw new Error('login succeeded but no session cookies were set')
      return { cookie: pairs.join('; '), provider }
    }
    if (res.status === 404) {
      lastError = 'no password provider registered on this dashboard'
      continue // try the next candidate
    }
    if (res.status === 401) throw new Error('invalid username or password')
    if (res.status === 429) throw new Error('rate limited — too many login attempts, try again shortly')
    if (res.status === 503) throw new Error('auth provider unreachable (upstream 503)')
    lastError = `login failed (HTTP ${res.status})`
  }
  throw new Error(lastError)
}

// ── Authenticated upstream fetch ────────────────────────────────────

async function authHeaders(base) {
  if (staticToken()) return { authorization: `Bearer ${staticToken()}` }
  if (staticCookie()) return { cookie: staticCookie() }
  if (staticUsername() && staticPassword()) {
    let cookie = cachedLoginCookie(base)
    if (!cookie) {
      try {
        const login = await passwordLogin(base, staticUsername(), staticPassword())
        cookie = login.cookie
        storeLoginCookie(base, cookie)
      } catch (err) {
        console.warn(`[auth] password login failed: ${err?.message || err}`)
        return {}
      }
    }
    return { cookie }
  }
  // A login cookie cached by a successful setup-page test is usable even
  // before the credentials themselves are saved.
  const loginCookie = cachedLoginCookie(base)
  if (loginCookie) return { cookie: loginCookie }
  let token = cachedSessionToken(base)
  if (!token) {
    token = await scrapeSessionToken(base)
    if (token) storeSessionToken(base, token)
  }
  return token ? { authorization: `Bearer ${token}` } : {}
}

function authMode() {
  if (staticToken()) return 'bearer-token'
  if (staticCookie()) return 'session-cookie'
  if (staticUsername() && staticPassword()) return 'password-login'
  if (cachedLoginCookie(dashboardUrl())) return 'password-login (cached cookie only)'
  return cachedSessionToken(dashboardUrl()) ? 'loopback-session-token' : 'none'
}

/**
 * Authenticated GET against the dashboard service. On 401 the cached
 * credential is assumed stale (session expired or dashboard restarted),
 * dropped, and re-acquired once — a fresh password login in password mode,
 * a fresh root-HTML scrape in loopback mode. Returns parsed JSON or null —
 * never throws.
 */
async function dashJson(apiPath, { retried = false, timeoutMs } = {}) {
  const base = dashboardUrl()
  try {
    const res = await fetch(`${base}${apiPath}`, {
      headers: { accept: 'application/json', ...(await authHeaders(base)) },
      signal: AbortSignal.timeout(timeoutMs ?? UPSTREAM_TIMEOUT_MS),
    })
    if (res.status === 401 && !staticToken() && !staticCookie() && !retried) {
      storeLoginCookie(base, '')
      if (!(staticUsername() && staticPassword())) storeSessionToken(base, '')
      return dashJson(apiPath, { retried: true, timeoutMs })
    }
    if (!res.ok) {
      console.warn(`[upstream] ${apiPath} -> ${res.status}`)
      return null
    }
    return await res.json()
  } catch (err) {
    console.warn(`[upstream] ${apiPath} failed: ${err?.message || err}`)
    return null
  }
}

// ── Overview aggregation ────────────────────────────────────────────

function clampInt(raw, { def, min, max }) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/**
 * Per-day, per-model token volume, derived from the sessions list — the
 * usage endpoint's daily rollup has no model dimension, but each session
 * row carries model, token counts, and a start timestamp. A session's
 * tokens are attributed to its start day.
 */
function aggregateModelDaily(sessionsPayload, days) {
  const rows = Array.isArray(sessionsPayload)
    ? sessionsPayload
    : sessionsPayload?.sessions || []
  const cutoff = Date.now() / 1000 - days * 86400
  const byKey = new Map()
  for (const s of rows) {
    const started = Number(s.started_at || s.created_at || 0)
    const model = s.model
    const tokens = Number(s.input_tokens || 0) + Number(s.output_tokens || 0)
    if (!model || !started || started < cutoff || tokens <= 0) continue
    const day = new Date(started * 1000).toISOString().slice(0, 10)
    const key = `${day}\u0000${model}`
    byKey.set(key, (byKey.get(key) || 0) + tokens)
  }
  return [...byKey].map(([key, tokens]) => {
    const [day, model] = key.split('\u0000')
    return { day, model, tokens }
  })
}

/**
 * Compact cron rollup for the activity card. Mirrors the field-name
 * tolerance of the workspace aggregator: jobs may arrive as a bare array or
 * `{jobs: [...]}`, and state lives under `state` or `status`.
 */
function summarizeCron(cronPayload) {
  let jobs = cronPayload
  if (cronPayload && !Array.isArray(cronPayload) && Array.isArray(cronPayload.jobs)) {
    jobs = cronPayload.jobs
  }
  if (!Array.isArray(jobs)) return null
  let paused = 0
  let running = 0
  for (const j of jobs) {
    const state = String(j?.state ?? j?.status ?? '').toLowerCase()
    if (state === 'paused') paused += 1
    else if (state === 'running') running += 1
  }
  return { total: jobs.length, paused, running }
}

/**
 * Cross-profile "what's running right now". hermes' /api/status is scoped to
 * a single gateway/profile, and under gateway_mode "multiple" each profile
 * has its own gateway — so a live session on a non-default profile never
 * shows up in the default status's active_sessions count. /api/profiles/sessions
 * aggregates every profile's session DB and tags each row with `is_active`,
 * which is the reliable cross-profile signal.
 *
 * Caveat surfaced to the UI: hermes does NOT expose individual sub-agents
 * (`delegate_task` / async delegations) over HTTP — they run in-process under
 * the parent session, create no child session rows, and are counted by no
 * endpoint. So this reports active *sessions*, not the sub-agents inside them.
 */
function summarizeActiveSessions(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.sessions
  if (!Array.isArray(rows)) return null
  const now = Date.now() / 1000
  const active = rows
    .filter((s) => (s?.is_active === true || (s?.is_active == null && !s?.ended_at))
      && !s?.ended_at
      && (s?.source || '') !== 'cron')
    .map((s) => {
      const lastActive = Number(s.last_active || s.last_active_at || s.started_at || 0)
      return {
        profile: s.profile || 'default',
        model: s.model || null,
        message_count: Number(s.message_count || 0),
        source: s.source || null,
        last_active: lastActive,
        age_seconds: lastActive ? Math.max(0, Math.round(now - lastActive)) : null,
        title: s.title || s.display_name || s.preview || s.id || 'session',
      }
    })
    // A session flagged is_active but idle for a long time is likely stale;
    // keep it but let the client de-emphasize via age.
    .sort((a, b) => (b.last_active || 0) - (a.last_active || 0))
  const byProfile = {}
  for (const s of active) byProfile[s.profile] = (byProfile[s.profile] || 0) + 1
  return { total: active.length, by_profile: byProfile, sessions: active.slice(0, 12) }
}

/**
 * Merge per-profile `/api/analytics/usage` payloads into one aggregate. Each
 * hermes profile has its own session DB (and under gateway_mode "multiple",
 * its own gateway), and `/api/analytics/usage` is single-profile — so the
 * whole-workspace picture is the sum across profiles. Summing hermes'
 * authoritative rollups (computed by SQL over each full DB) is more accurate
 * than re-deriving from a capped session list. Nulls (a profile that failed
 * or has no DB yet) are skipped, so a partial fan-out still aggregates.
 */
const DAILY_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens',
  'reasoning_tokens', 'estimated_cost', 'actual_cost', 'sessions', 'api_calls']
const MODEL_FIELDS = ['input_tokens', 'output_tokens', 'estimated_cost', 'sessions', 'api_calls']
const TOTAL_FIELDS = ['total_input', 'total_output', 'total_cache_read', 'total_reasoning',
  'total_estimated_cost', 'total_actual_cost', 'total_sessions', 'total_api_calls']

function mergeUsage(usages, days) {
  const valid = usages.filter((u) => u && typeof u === 'object' && !Array.isArray(u))
  if (!valid.length) return null

  const dailyMap = new Map()
  for (const u of valid) {
    for (const row of u.daily || []) {
      if (!row?.day) continue
      const cur = dailyMap.get(row.day) || { day: row.day }
      for (const f of DAILY_FIELDS) cur[f] = (cur[f] || 0) + Number(row[f] || 0)
      dailyMap.set(row.day, cur)
    }
  }
  const daily = [...dailyMap.values()].sort((a, b) => (a.day < b.day ? -1 : 1))

  const modelMap = new Map()
  for (const u of valid) {
    for (const m of u.by_model || []) {
      const key = m?.model || 'unknown'
      const cur = modelMap.get(key) || { model: key }
      for (const f of MODEL_FIELDS) cur[f] = (cur[f] || 0) + Number(m[f] || 0)
      modelMap.set(key, cur)
    }
  }
  const by_model = [...modelMap.values()].sort(
    (a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens),
  )

  const totals = {}
  for (const u of valid) {
    for (const f of TOTAL_FIELDS) totals[f] = (totals[f] || 0) + Number(u.totals?.[f] || 0)
  }
  return { daily, by_model, totals, period_days: days }
}

/**
 * Fan out `/api/analytics/usage` across every profile in the status payload.
 * Each hermes profile has its own session DB, and the endpoint is
 * single-profile, so the whole-workspace picture is the sum. Returns the
 * profile list alongside the per-profile payloads (index-aligned, null where a
 * profile failed) — callers that only want the aggregate pass the payloads
 * straight to mergeUsage().
 */
async function fetchProfileUsages(days, status) {
  const profiles =
    Array.isArray(status?.profiles) && status.profiles.length ? status.profiles : ['default']
  const opts = { timeoutMs: ANALYTICS_TIMEOUT_MS }
  const usages = await Promise.all(
    profiles.length === 1 && profiles[0] === 'default'
      ? [dashJson(`/api/analytics/usage?days=${days}`, opts)]
      : profiles.map((p) =>
          dashJson(`/api/analytics/usage?days=${days}&profile=${encodeURIComponent(p)}`, opts)),
  )
  const missing = profiles.filter((_, i) => !usages[i] || typeof usages[i] !== 'object')
  return { profiles, usages, missing, complete: missing.length === 0 }
}

async function buildOverview(days) {
  // Phase 1: everything that doesn't depend on the profile list.
  const [status, model, cron, profileSessions] = await Promise.all([
    dashJson('/api/status'),
    dashJson('/api/model/info'),
    dashJson('/api/cron/jobs'),
    // Large enough sample to cover the per-model chart window across profiles.
    dashJson('/api/profiles/sessions?limit=500&order=recent'),
  ])

  // Phase 2: fan out usage per profile and merge. Fall back to the default
  // (unscoped) call if the profile list is unavailable.
  const { profiles, usages } = await fetchProfileUsages(days, status)
  const usage = mergeUsage(usages, days)
  const profilesWithData = usages.filter((u) => u && typeof u === 'object').length

  // Per-profile daily token totals for the "by profile" view of the token
  // chart. Tokens = input + output + reasoning, matching the stack total of
  // the "by type" view so the two views sum to the same daily height.
  const usageByProfile = profiles
    .map((p, i) => {
      const u = usages[i]
      if (!u || typeof u !== 'object' || !Array.isArray(u.daily)) return null
      const daily = u.daily.map((r) => ({
        day: r.day,
        tokens: Number(r.input_tokens || 0) + Number(r.output_tokens || 0) + Number(r.reasoning_tokens || 0),
      }))
      const total = Number(u.totals?.total_input || 0) + Number(u.totals?.total_output || 0) +
        Number(u.totals?.total_reasoning || 0)
      return { profile: p, daily, total }
    })
    .filter((x) => x && x.total > 0)

  const sessionRows = Array.isArray(profileSessions)
    ? profileSessions
    : profileSessions?.sessions || null

  return {
    status,
    usage,
    usage_by_profile: usageByProfile,
    sessions: profileSessions,
    model,
    cron: summarizeCron(cron),
    active: summarizeActiveSessions(profileSessions),
    model_daily: sessionRows ? aggregateModelDaily(profileSessions, days) : null,
    meta: {
      dashboard_url: dashboardUrl(),
      days,
      auth_mode: authMode(),
      profiles_total: profiles.length,
      profiles_with_data: profilesWithData,
      aggregated_across_profiles: profiles.length > 1,
      generated_at: new Date().toISOString(),
    },
  }
}

// ── Engine (llama.cpp) telemetry ────────────────────────────────────
//
// Fans out to a llama-server (/metrics, /slots, /props) and, optionally, its
// telemetry collector (see docs/collect.py — a separate Python/systemd
// process, not run by this server). Prometheus text is parsed here, not in
// the browser, so the frontend gets a stable shape regardless of llama.cpp
// build, and build-specific quirks (next_token as a one-element array on
// some builds, missing prompt-token fields on others) are feature-detected
// once, server-side.

const HEALTH_TIMEOUT_MS = 3_000

function clampFloat(raw, { def, min, max }) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

function parseProm(text) {
  const out = {}
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line || line[0] === '#') continue
    const sp = line.lastIndexOf(' ')
    if (sp < 0) continue
    let name = line.slice(0, sp).trim()
    const val = Number(line.slice(sp + 1))
    const br = name.indexOf('{')
    if (br >= 0) name = name.slice(0, br)
    if (name.startsWith('llamacpp:')) name = name.slice(9)
    if (Number.isFinite(val)) out[name] = val
  }
  return out
}

// Fetch with a timeout, classifying the failure so callers (and eventually
// the UI) can tell "server said no" from "server didn't answer in time" from
// "nothing is listening there" — those are different situations.
async function upstreamFetch(url, { timeoutMs, headers } = {}) {
  try {
    const res = await fetch(url, {
      headers: { accept: '*/*', ...(headers || {}) },
      signal: AbortSignal.timeout(timeoutMs ?? UPSTREAM_TIMEOUT_MS),
    })
    return { res, error: null }
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    return { res: null, error: timedOut ? 'timeout' : 'unreachable' }
  }
}

// A 501/400 from /metrics means the server was started without --metrics —
// a capability limit, not an outage (mirrors docs/collect.py's handling).
async function fetchMetrics(engine, timeoutMs) {
  const { res, error } = await upstreamFetch(`${engine.llamaUrl}/metrics`, { timeoutMs })
  if (error) return { metrics: null, error }
  if (res.status === 501 || res.status === 400) return { metrics: null, error: 'metrics_disabled' }
  if (!res.ok) return { metrics: null, error: `http_${res.status}` }
  const parsed = parseProm(await res.text())
  if (!('requests_processing' in parsed)) return { metrics: null, error: 'unexpected_response' }
  return { metrics: parsed, error: null }
}

async function fetchSlots(engine, timeoutMs) {
  const { res, error } = await upstreamFetch(`${engine.llamaUrl}/slots`, { timeoutMs })
  if (error) return { slots: null, error }
  if (!res.ok) return { slots: null, error: `http_${res.status}` }
  let json
  try {
    json = await res.json()
  } catch {
    return { slots: null, error: 'invalid_json' }
  }
  if (!Array.isArray(json)) return { slots: null, error: 'unexpected_response' }
  return { slots: json, error: null }
}

async function fetchProps(engine, timeoutMs) {
  const { res, error } = await upstreamFetch(`${engine.llamaUrl}/props`, { timeoutMs })
  if (error) return { props: null, error }
  if (!res.ok) return { props: null, error: `http_${res.status}` }
  let json
  try {
    json = await res.json()
  } catch {
    return { props: null, error: 'invalid_json' }
  }
  const dgs = json?.default_generation_settings || {}
  return {
    props: {
      model_path: json?.model_path || null,
      build_info: json?.build_info || null,
      total_slots: Number.isFinite(Number(json?.total_slots)) ? Number(json.total_slots) : null,
      n_ctx: Number.isFinite(Number(dgs?.n_ctx)) ? Number(dgs.n_ctx) : null,
      endpoint_metrics: !!json?.endpoint_metrics,
    },
    error: null,
  }
}

// Two build-specific quirks this project has already hit (see the plan doc):
// next_token arrives as a one-element array on some builds, a bare object on
// others; some builds' /slots omits the prompt-token fields entirely. Detect
// both from a live sample rather than assuming either shape.
function detectSlotFeatures(slots) {
  if (!Array.isArray(slots) || !slots.length) return { hasPromptFields: false, nextTokenShape: 'none' }
  let hasPromptFields = false
  let nextTokenShape = 'none'
  for (const s of slots) {
    if (s && (s.n_prompt_tokens != null || s.n_prompt_tokens_processed != null || s.n_prompt_tokens_cache != null)) {
      hasPromptFields = true
    }
    if (nextTokenShape === 'none' && s && 'next_token' in s) {
      nextTokenShape = Array.isArray(s.next_token) ? 'array' : 'object'
    }
  }
  return { hasPromptFields, nextTokenShape }
}

// Normalizes next_token to a plain object regardless of build shape, so the
// frontend never branches on it.
function normalizeSlots(slots) {
  if (!Array.isArray(slots)) return slots
  return slots.map((s) => {
    if (!s || typeof s !== 'object') return s
    let nt = s.next_token
    if (Array.isArray(nt)) nt = nt.length ? nt[0] : null
    return { ...s, next_token: nt && typeof nt === 'object' ? nt : {} }
  })
}

async function buildEngineLive(engine) {
  const [m, s, p] = await Promise.all([
    fetchMetrics(engine, UPSTREAM_TIMEOUT_MS),
    fetchSlots(engine, UPSTREAM_TIMEOUT_MS),
    fetchProps(engine, UPSTREAM_TIMEOUT_MS),
  ])
  return {
    engine: { id: engine.id, label: engine.label, llama_url: engine.llamaUrl },
    metrics: m.metrics,
    metrics_error: m.error,
    slots: normalizeSlots(s.slots),
    slots_error: s.error,
    props: p.props,
    props_error: p.error,
    features: detectSlotFeatures(s.slots),
    generated_at: new Date().toISOString(),
  }
}

// total_slots comes from /props, which doesn't change on the timescale the
// health badge polls at — cache it so the badge's own request stays cheap
// (its whole point is to be the cheapest call in the system).
const propsCache = new Map() // engine id -> { total_slots, ts }
const PROPS_CACHE_TTL_MS = 5 * 60_000

async function cachedTotalSlots(engine) {
  const cached = propsCache.get(engine.id)
  if (cached && Date.now() - cached.ts < PROPS_CACHE_TTL_MS) return cached.total_slots
  const { props } = await fetchProps(engine, HEALTH_TIMEOUT_MS)
  const total_slots = props?.total_slots ?? cached?.total_slots ?? null
  propsCache.set(engine.id, { total_slots, ts: Date.now() })
  return total_slots
}

/**
 * The engine health badge's one data source. Keyed on requests_deferred, not
 * slot occupancy (see the plan doc's §"Engine health badge") — a saturated
 * engine is normal, a queueing one is the state worth surfacing. "Stale" is
 * not computed here: it's a function of how long ago the caller last got a
 * good answer, which only the polling client knows.
 */
async function buildEngineHealth(engine) {
  const [{ metrics, error }, total_slots] = await Promise.all([
    fetchMetrics(engine, HEALTH_TIMEOUT_MS),
    cachedTotalSlots(engine),
  ])
  const base = {
    engine: { id: engine.id, label: engine.label, llama_url: engine.llamaUrl },
    total_slots,
    requests_processing: null,
    requests_deferred: null,
    generated_at: new Date().toISOString(),
  }
  if (error === 'timeout') return { ...base, state: 'not_responding' }
  if (error) return { ...base, state: 'unreachable', reason: error }
  const processing = Number(metrics.requests_processing || 0)
  const deferred = Number(metrics.requests_deferred || 0)
  let state
  if (deferred > 0) state = 'queued'
  else if (total_slots != null && processing >= total_slots) state = 'full'
  else if (processing > 0) state = 'active'
  else state = 'idle'
  return { ...base, requests_processing: processing, requests_deferred: deferred, state }
}

async function proxyCollectorJson(engine, path, query) {
  if (!engine.collectorUrl) {
    return { status: 404, body: { error: 'no collector configured for this engine' } }
  }
  const qs = query ? `?${query}` : ''
  const { res, error } = await upstreamFetch(`${engine.collectorUrl}${path}${qs}`, {
    timeoutMs: UPSTREAM_TIMEOUT_MS,
  })
  if (error) return { status: 502, body: { error: `collector ${error}` } }
  if (!res.ok) return { status: 502, body: { error: `collector http ${res.status}` } }
  try {
    return { status: 200, body: await res.json() }
  } catch {
    return { status: 502, body: { error: 'collector returned invalid JSON' } }
  }
}

/**
 * Ad-hoc probe for the setup page's per-engine "Test connection" — takes
 * URLs straight from the form, not from saved config, so it works before
 * Save is pressed.
 */
async function testEngine(body) {
  const llamaUrl = trimSlash(body.llamaUrl || '')
  const collectorUrl = trimSlash(body.collectorUrl || '')
  const out = { llama: { ok: false, url: llamaUrl } }
  if (!/^https?:\/\//.test(llamaUrl)) {
    out.llama.error = 'URL must start with http:// or https://'
    return out
  }
  const t0 = Date.now()
  const { error } = await fetchMetrics({ llamaUrl }, 5_000)
  out.llama.latency_ms = Date.now() - t0
  if (!error) {
    out.llama.ok = true
    out.llama.metrics_enabled = true
  } else if (error === 'metrics_disabled') {
    out.llama.ok = true
    out.llama.metrics_enabled = false
    out.llama.detail = 'reachable, but started without --metrics'
  } else {
    out.llama.error = error
  }
  if (collectorUrl) {
    if (!/^https?:\/\//.test(collectorUrl)) {
      out.collector = { ok: false, url: collectorUrl, error: 'URL must start with http:// or https://' }
    } else {
      const t1 = Date.now()
      const { res, error: cErr } = await upstreamFetch(`${collectorUrl}/range`, { timeoutMs: 5_000 })
      if (cErr) {
        out.collector = { ok: false, url: collectorUrl, error: cErr, latency_ms: Date.now() - t1 }
      } else if (!res.ok) {
        out.collector = { ok: false, url: collectorUrl, error: `http_${res.status}`, latency_ms: Date.now() - t1 }
      } else {
        const j = await res.json().catch(() => null)
        out.collector = { ok: true, url: collectorUrl, latency_ms: Date.now() - t1, rows: j?.rows ?? null }
      }
    }
  }
  return out
}

// ── Model → engine attribution ──────────────────────────────────────
//
// The unified Usage tab has to know which hermes models ran on which engine,
// because that overlap is the only part of the two token populations that
// would otherwise be double-counted. hermes names a model however its provider
// config says; llama-server reports a filesystem path. Nothing infers the link
// at request time — an operator saves it once, helped by the suggester below.

/**
 * Reduce a model name to a comparison key: last path segment (hermes writes
 * `provider/model`, llama.cpp writes an absolute path), no `.gguf`, no
 * punctuation. "…/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf" → "qwen3 6 35b a3b ud q4 k m".
 */
function modelKey(name) {
  return String(name || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.gguf$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * 0..1 similarity between two model keys. Exact match and containment are
 * scored above token overlap so a quantisation or suffix difference ranks
 * below a true match but still surfaces as a candidate.
 */
function modelMatchScore(a, b) {
  const ka = modelKey(a)
  const kb = modelKey(b)
  if (!ka || !kb) return 0
  if (ka === kb) return 1
  if (ka.includes(kb) || kb.includes(ka)) return 0.8
  const ta = new Set(ka.split(' '))
  const tb = new Set(kb.split(' '))
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  const union = ta.size + tb.size - shared
  return union > 0 ? 0.7 * (shared / union) : 0
}

const MODEL_SUGGEST_FLOOR = 0.3

/**
 * Rank the hermes models this workspace has actually used against the model
 * file a llama-server reports at /props. Takes URLs from the request body, not
 * saved config, so Setup can suggest for an engine row before it is saved.
 */
async function suggestEngineModels(body) {
  const llamaUrl = trimSlash(body.llamaUrl || '')
  if (!/^https?:\/\//.test(llamaUrl)) {
    return { error: 'URL must start with http:// or https://' }
  }
  const [{ props, error }, status] = await Promise.all([
    fetchProps({ llamaUrl }, 5_000),
    dashJson('/api/status'),
  ])
  if (error) return { error: `llama-server ${error}`, model_path: null, candidates: [] }
  const modelPath = props?.model_path || null
  if (!modelPath) {
    return { error: 'this server does not report a model path at /props', model_path: null, candidates: [] }
  }

  // A wide window on purpose: a model that hasn't been used this month is
  // exactly the one an operator forgets to map.
  const { usages, missing } = await fetchProfileUsages(90, status)
  const merged = mergeUsage(usages, 90)
  const known = merged?.by_model || []
  // A profile that failed took its models with it, so "no match" would be a
  // lie about what hermes has run. Say which profiles are missing instead.
  const partial = missing.length
    ? `${missing.length} profile${missing.length === 1 ? '' : 's'} did not answer (${missing.join(', ')}) — ` +
      'a model used only there will not appear below'
    : null
  if (!known.length) {
    return {
      model_path: modelPath,
      candidates: [],
      note: partial || 'hermes reported no model usage in the last 90 days to match against',
    }
  }

  const candidates = known
    .map((m) => ({
      model: m.model || 'unknown',
      score: Number(modelMatchScore(m.model, modelPath).toFixed(3)),
      tokens: Number(m.input_tokens || 0) + Number(m.output_tokens || 0),
    }))
    .filter((c) => c.score >= MODEL_SUGGEST_FLOOR)
    .sort((a, b) => b.score - a.score || b.tokens - a.tokens)
    .slice(0, 5)

  return { model_path: modelPath, candidates, note: partial }
}

/**
 * model key → engine id, over every configured engine. A model mapped to two
 * engines is kept on the first (config order): its tokens must be subtracted
 * from exactly one engine's total or the reconciliation double-counts.
 */
function engineModelIndex() {
  const index = new Map()
  for (const e of engines()) {
    for (const m of e.models || []) {
      const k = modelKey(m)
      if (k && !index.has(k)) index.set(k, e.id)
    }
  }
  return index
}

// ── Unified usage: the hermes side ──────────────────────────────────
//
// See docs/unified-usage-plan.md §3–4. Two rules govern everything here:
//
//   1. Window totals are authoritative (hermes' own SQL rollups). The daily
//      series is apportioned, then scaled so it sums to those totals — a chart
//      that disagrees with the tile above it is worse than no chart.
//   2. Both lanes count tokens actually processed. hermes' input_tokens is
//      already net of cache reads (cache_read_tokens is a separate, much
//      larger field) and llama.cpp's prompt_tokens_total is already net of KV
//      prefix reuse — see finishSide() for the measurement that settled this.

const COMPARATOR_DEFAULT = {
  model: 'Gemini 3.5 Flash',
  input_per_m: 1.5,
  output_per_m: 9.0,
  cached_input_per_m: 0.15,
  source: 'https://ai.google.dev/gemini-api/docs/pricing',
  verified: '2026-08',
}

function comparator() {
  const c = config.comparator && typeof config.comparator === 'object' ? config.comparator : {}
  const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : def)
  const custom =
    c.model != null || c.input_per_m != null || c.output_per_m != null || c.cached_input_per_m != null
  return {
    model: String(c.model || '').trim() || COMPARATOR_DEFAULT.model,
    input_per_m: num(c.input_per_m, COMPARATOR_DEFAULT.input_per_m),
    output_per_m: num(c.output_per_m, COMPARATOR_DEFAULT.output_per_m),
    cached_input_per_m: num(c.cached_input_per_m, COMPARATOR_DEFAULT.cached_input_per_m),
    source: custom ? null : COMPARATOR_DEFAULT.source,
    verified: custom ? null : COMPARATOR_DEFAULT.verified,
    is_default: !custom,
  }
}

// UTC day keys for the window, oldest first. UTC because the engine side is
// built by folding epoch-stamped collector rows into days, and the two series
// have to line up index-for-index.
function windowDays(days) {
  const now = new Date()
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(end - i * 86400_000).toISOString().slice(0, 10))
  }
  return out
}

// A hermes model name that looks like a local weights file but is mapped to no
// engine. Not proof of anything — it drives a "you may want to map this" hint,
// never an attribution.
function looksLocallyHosted(name) {
  const n = String(name || '')
  return /\.gguf$/i.test(n) || /\bq[2-8][_-]?k?(_[a-z]+)?\b/i.test(n)
}

const emptySide = () => ({ input: 0, output: 0, reasoning: 0, cache_read: 0, cost: 0 })

function finishSide(s) {
  // Prefill is input_tokens as hermes reports it, with no cache correction.
  //
  // The plan's §3 assumed hermes' input_tokens was a full billed prompt that
  // had to have cache reads subtracted to reach llama.cpp's denominator. The
  // live data says otherwise: over 7 days this deployment reports 24.6M input
  // against 374.5M cache reads — 15× larger, so cache_read_tokens is plainly a
  // sibling field, not a component of input. Subtracting it clamps every
  // prefill figure to zero and destroys the lane.
  //
  // Both sides therefore already count "tokens actually processed": hermes
  // excludes what its provider served from cache, llama.cpp excludes what its
  // KV prefix reuse skipped. Same denominator, no correction. Phase 4 checks
  // that empirically against the collector's own prompt_tokens counter.
  const prefill = s.input
  const generation = s.output + s.reasoning
  return {
    input: Math.round(s.input),
    output: Math.round(s.output),
    reasoning: Math.round(s.reasoning),
    cache_read: Math.round(s.cache_read),
    prefill: Math.round(prefill),
    generation: Math.round(generation),
    tokens: Math.round(prefill + generation),
    cost: Number(s.cost.toFixed(4)),
  }
}

/**
 * Split hermes' usage into engine-hosted and everything else.
 *
 * `usage` is the merged multi-profile rollup; `sessions` is the cross-profile
 * session list, used only to derive the per-day mix between the two sides —
 * the daily rollup has no model dimension and by_model has no day dimension,
 * so neither alone can produce a split daily series.
 */
function buildHermesSide(days, usage, sessions) {
  const index = engineModelIndex()
  const dayList = windowDays(days)

  // 1. Authoritative window split, from by_model.
  const engTot = emptySide()
  const othTot = emptySide()
  const byEngine = new Map()
  const unmapped = []
  for (const m of usage?.by_model || []) {
    const name = m.model || 'unknown'
    const input = Number(m.input_tokens || 0)
    const output = Number(m.output_tokens || 0)
    const engineId = index.get(modelKey(name))
    const target = engineId ? engTot : othTot
    target.input += input
    target.output += output
    target.cost += Number(m.estimated_cost || 0)
    if (engineId) {
      const cur = byEngine.get(engineId) || { engine_id: engineId, input: 0, output: 0, models: [] }
      cur.input += input
      cur.output += output
      cur.models.push(name)
      byEngine.set(engineId, cur)
    } else if (looksLocallyHosted(name) && input + output > 0) {
      unmapped.push({ model: name, tokens: input + output })
    }
  }
  // by_model fixes the *ratio* between the two sides; hermes' `totals` block
  // fixes the *magnitude*. They are separately computed upstream and disagree
  // by ~1% on this deployment — and `totals` is what the Hermes tab's hero
  // tile shows, so anchoring to it keeps the two tabs from contradicting each
  // other over the same window. Falls back to by_model if totals is absent.
  const shareOf = (a, b) => (a + b > 0 ? a / (a + b) : 0)
  const shareIn = shareOf(engTot.input, othTot.input)
  const shareOut = shareOf(engTot.output, othTot.output)
  const T = usage?.totals || {}
  const totalIn = Number(T.total_input || 0) || engTot.input + othTot.input
  const totalOut = Number(T.total_output || 0) || engTot.output + othTot.output
  const authEngineIn = totalIn * shareIn
  const authOtherIn = totalIn * (1 - shareIn)
  const authEngineOut = totalOut * shareOut
  const authOtherOut = totalOut * (1 - shareOut)
  const grand = totalIn + totalOut
  const windowShare = grand > 0 ? (authEngineIn + authEngineOut) / grand : 0

  // Per-engine rows ride the same anchoring, so they sum to the engine side.
  const scaleIn = engTot.input > 0 ? authEngineIn / engTot.input : 0
  const scaleOut = engTot.output > 0 ? authEngineOut / engTot.output : 0

  // 2. Per-day mix, from session-level model attribution.
  const mix = new Map()
  for (const r of aggregateModelDaily(sessions, days)) {
    const cur = mix.get(r.day) || { engine: 0, other: 0 }
    if (index.has(modelKey(r.model))) cur.engine += r.tokens
    else cur.other += r.tokens
    mix.set(r.day, cur)
  }

  // 3. Apportion the authoritative daily rollup by that mix.
  const src = new Map((usage?.daily || []).map((r) => [r.day, r]))
  const rows = dayList.map((day) => {
    const d = src.get(day) || {}
    const m = mix.get(day)
    const mTotal = m ? m.engine + m.other : 0
    const share = mTotal > 0 ? m.engine / mTotal : windowShare
    const input = Number(d.input_tokens || 0)
    const output = Number(d.output_tokens || 0)
    const reasoning = Number(d.reasoning_tokens || 0)
    const cache = Number(d.cache_read_tokens || 0)
    return {
      day,
      // No session rows for this day: the split is the window's, not the
      // day's. Flagged so the UI can mark it rather than imply it was measured.
      estimated: !(mTotal > 0),
      engine: { input: input * share, output: output * share,
        reasoning: reasoning * share, cache_read: cache * share },
      other: { input: input * (1 - share), output: output * (1 - share),
        reasoning: reasoning * (1 - share), cache_read: cache * (1 - share) },
    }
  })

  // 4. Scale the apportioned series onto the authoritative totals, so the
  //    chart and the tiles cannot disagree. Factors sit near 1 — they correct
  //    misattribution between the two sides, not magnitude.
  const sum = (side, field) => rows.reduce((a, r) => a + r[side][field], 0)
  const factor = (side, field, target) => {
    const have = sum(side, field)
    return have > 0 ? target / have : 0
  }
  const scales = {
    engine: { input: factor('engine', 'input', authEngineIn), output: factor('engine', 'output', authEngineOut) },
    other: { input: factor('other', 'input', authOtherIn), output: factor('other', 'output', authOtherOut) },
  }
  for (const r of rows) {
    for (const side of ['engine', 'other']) {
      r[side].input *= scales[side].input
      r[side].output *= scales[side].output
    }
  }

  // 5. Totals come back out of the scaled rows, so one number feeds both.
  const acc = { engine: emptySide(), other: emptySide() }
  for (const r of rows) {
    for (const side of ['engine', 'other']) {
      acc[side].input += r[side].input
      acc[side].output += r[side].output
      acc[side].reasoning += r[side].reasoning
      acc[side].cache_read += r[side].cache_read
    }
  }
  acc.engine.cost = engTot.cost
  acc.other.cost = othTot.cost

  const daily = rows.map((r) => ({
    day: r.day,
    estimated: r.estimated,
    engine: finishSide({ ...r.engine, cost: 0 }),
    other: finishSide({ ...r.other, cost: 0 }),
  }))

  const engineTotals = finishSide(acc.engine)
  const cmp = comparator()
  const avoided =
    (engineTotals.input / 1e6) * cmp.input_per_m + (engineTotals.output / 1e6) * cmp.output_per_m

  return {
    days: dayList,
    daily,
    totals: { engine: engineTotals, other: finishSide(acc.other) },
    by_engine: [...byEngine.values()].map((e) => ({
      ...e,
      input: Math.round(e.input * scaleIn),
      output: Math.round(e.output * scaleOut),
      tokens: Math.round(e.input * scaleIn + e.output * scaleOut),
    })),
    unmapped_local_models: unmapped.sort((a, b) => b.tokens - a.tokens).slice(0, 8),
    cost_avoided: { amount: Number(avoided.toFixed(2)), comparator: cmp },
  }
}

/**
 * How far back the session list actually reaches. The per-day split is derived
 * from it, so a window wider than the list is a window whose early days are
 * split by the window-level ratio — which the UI has to say out loud.
 */
function attributionCoverage(sessions, days, limit) {
  const rows = Array.isArray(sessions) ? sessions : sessions?.sessions
  if (!Array.isArray(rows)) return { available: false }
  let oldest = null
  for (const s of rows) {
    const t = Number(s.started_at || s.created_at || 0)
    if (t > 0 && (oldest === null || t < oldest)) oldest = t
  }
  const windowStart = Date.now() / 1000 - days * 86400
  return {
    available: true,
    sessions_seen: rows.length,
    capped: rows.length >= limit,
    oldest_session: oldest,
    covers_window: oldest !== null && oldest <= windowStart,
    covered_days: oldest === null ? 0 : Math.min(days, Math.ceil((Date.now() / 1000 - oldest) / 86400)),
  }
}

async function buildUnifiedUsage(days) {
  const status = await dashJson('/api/status')
  // Wider than the overview's sample: this list is what splits the daily
  // series between the two sides, so its reach bounds the split's accuracy.
  const sessionLimit = Math.min(2000, Math.max(500, days * 25))
  const [{ usages, profiles, missing }, sessions] = await Promise.all([
    fetchProfileUsages(days, status),
    dashJson(`/api/profiles/sessions?limit=${sessionLimit}&order=recent`),
  ])
  const usage = mergeUsage(usages, days)
  const hermes = buildHermesSide(days, usage, sessions)

  return {
    hermes: {
      ...hermes,
      // A dropped profile understates hermes and inflates the residual, so
      // this is a correctness flag for the reconciliation, not a status line.
      complete: missing.length === 0,
      profiles_total: profiles.length,
      profiles_missing: missing,
      attribution_coverage: attributionCoverage(sessions, days, sessionLimit),
    },
    meta: {
      days,
      dashboard_url: dashboardUrl(),
      engines_configured: engines().length,
      engines_mapped: engines().filter((e) => (e.models || []).length).length,
      generated_at: new Date().toISOString(),
    },
  }
}

// ── Settings & connection test ──────────────────────────────────────

function sanitizedSettings() {
  return {
    dashboard_url: dashboardUrl(),
    url_source: urlSource(),
    has_token: !!staticToken(),
    token_source: tokenSource(),
    has_cookie: !!staticCookie(),
    cookie_source: cookieSource(),
    username: staticUsername() || null,
    has_password: !!staticPassword(),
    password_source: passwordSource(),
    has_cached_session_token: !!cachedSessionToken(dashboardUrl()),
    has_cached_login_cookie: !!cachedLoginCookie(dashboardUrl()),
    auth_mode: authMode(),
    config_file: CONFIG_FILE,
    engines: engines(),
    comparator: comparator(),
  }
}

function applySettings(body) {
  const prevUrl = dashboardUrl()
  if (typeof body.dashboardUrl === 'string') {
    const next = trimSlash(body.dashboardUrl)
    if (next && !/^https?:\/\//.test(next)) {
      return { error: 'Dashboard URL must start with http:// or https://' }
    }
    if (next) config.dashboardUrl = next
    else delete config.dashboardUrl
  }
  if (body.clearToken) delete config.token
  else if (typeof body.token === 'string' && body.token.trim())
    config.token = body.token.trim()
  if (body.clearCookie) delete config.cookie
  else if (typeof body.cookie === 'string' && body.cookie.trim())
    config.cookie = body.cookie.trim()
  let credsChanged = false
  if (body.clearPassword) {
    credsChanged = !!(config.username || config.password)
    delete config.username
    delete config.password
  } else {
    if (typeof body.username === 'string' && body.username.trim()) {
      credsChanged ||= config.username !== body.username.trim()
      config.username = body.username.trim()
    }
    if (typeof body.password === 'string' && body.password) {
      credsChanged ||= config.password !== body.password
      config.password = body.password
    }
  }
  if (body.clearCachedToken || dashboardUrl() !== prevUrl) {
    delete config.cachedSessionToken
    delete config.cachedSessionTokenUrl
  }
  if (body.clearCachedToken || credsChanged || dashboardUrl() !== prevUrl) {
    delete config.cachedLoginCookie
    delete config.cachedLoginCookieUrl
  }
  if (Array.isArray(body.engines)) {
    const seen = new Set()
    const next = []
    for (const raw of body.engines) {
      const e = sanitizeEngineEntry(raw)
      if (!e) return { error: 'Each engine needs an id and a llamaUrl starting with http:// or https://' }
      if (seen.has(e.id)) return { error: `Duplicate engine id "${e.id}"` }
      seen.add(e.id)
      next.push(e)
    }
    config.engines = next
  }
  if (body.resetComparator) {
    delete config.comparator
  } else if (body.comparator && typeof body.comparator === 'object') {
    const c = body.comparator
    const rate = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null)
    const model = String(c.model || '').trim()
    const input = rate(c.input_per_m)
    const output = rate(c.output_per_m)
    if (!model) return { error: 'Comparator needs a model name' }
    if (input === null || output === null) {
      return { error: 'Comparator input and output rates must be numbers ≥ 0' }
    }
    config.comparator = {
      model,
      input_per_m: input,
      output_per_m: output,
      cached_input_per_m: rate(c.cached_input_per_m) ?? 0,
    }
  }
  writeConfig(config)
  return { settings: sanitizedSettings() }
}

/**
 * Probe a hermes dashboard with the effective credentials (explicit form
 * values first, then saved/env, then the loopback token scrape) and report
 * what worked. Never throws.
 */
async function testConnection(body) {
  const base = trimSlash(body.dashboardUrl || dashboardUrl())
  if (!/^https?:\/\//.test(base)) {
    return { ok: false, url: base, error: 'URL must start with http:// or https://' }
  }
  const sameUrl = base === dashboardUrl()
  const token = (body.token || '').trim() || (sameUrl ? staticToken() : '')
  const cookie = (body.cookie || '').trim() || (sameUrl ? staticCookie() : '')
  const username = (body.username || '').trim() || (sameUrl ? staticUsername() : '')
  const password = body.password || (sameUrl ? staticPassword() : '')
  const out = {
    ok: false,
    url: base,
    reachable: false,
    version: null,
    auth: { ok: false, mode: null, detail: null },
    token_cached: false,
    login_cookie_cached: false,
    latency_ms: null,
  }
  const t0 = Date.now()

  // Reachability: /api/status is public on stock hermes; a 401 still proves
  // a hermes-shaped service answered.
  try {
    const res = await fetch(`${base}/api/status`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    out.reachable = true
    if (res.ok) {
      const j = await res.json().catch(() => null)
      out.version = j?.version || null
    }
  } catch (err) {
    out.error = `Unreachable: ${err?.cause?.message || err?.message || err}`
    out.latency_ms = Date.now() - t0
    return out
  }

  // Auth: probe a protected stats route — the one this app actually needs.
  const probe = (headers) =>
    fetch(`${base}/api/analytics/usage?days=1`, {
      headers: { accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  try {
    if (token) {
      const res = await probe({ authorization: `Bearer ${token}` })
      out.auth = res.ok
        ? { ok: true, mode: 'bearer-token', detail: null }
        : { ok: false, mode: 'bearer-token', detail: `HTTP ${res.status}` }
    } else if (cookie) {
      const res = await probe({ cookie })
      out.auth = res.ok
        ? { ok: true, mode: 'session-cookie', detail: null }
        : { ok: false, mode: 'session-cookie', detail: `HTTP ${res.status}` }
    } else if (username && password) {
      try {
        const login = await passwordLogin(base, username, password)
        const res = await probe({ cookie: login.cookie })
        if (res.ok) {
          out.auth = {
            ok: true,
            mode: 'password-login',
            detail: `provider "${login.provider}"`,
          }
          storeLoginCookie(base, login.cookie)
          out.login_cookie_cached = true
        } else {
          out.auth = {
            ok: false,
            mode: 'password-login',
            detail: `login succeeded but the stats route returned HTTP ${res.status}`,
          }
        }
      } catch (err) {
        out.auth = {
          ok: false,
          mode: 'password-login',
          detail: err?.message || String(err),
        }
      }
    } else {
      let res = await probe({})
      if (res.ok) {
        out.auth = { ok: true, mode: 'open', detail: 'no auth required' }
      } else if (res.status === 401) {
        const scraped = await scrapeSessionToken(base)
        if (!scraped) {
          out.auth = {
            ok: false,
            mode: null,
            detail:
              'Auth required and no session token found in the root HTML — ' +
              'the dashboard is likely behind the v0.17+ auth gate. Provide ' +
              'a username/password, a bearer token, or a session cookie.',
          }
        } else {
          res = await probe({ authorization: `Bearer ${scraped}` })
          if (res.ok) {
            out.auth = { ok: true, mode: 'loopback-session-token', detail: null }
            storeSessionToken(base, scraped)
            out.token_cached = true
          } else {
            out.auth = {
              ok: false,
              mode: 'loopback-session-token',
              detail: `scraped token rejected (HTTP ${res.status})`,
            }
          }
        }
      } else {
        out.auth = { ok: false, mode: null, detail: `HTTP ${res.status}` }
      }
    }
  } catch (err) {
    out.auth = { ok: false, mode: null, detail: err?.message || String(err) }
  }
  out.ok = out.reachable && out.auth.ok
  out.latency_ms = Date.now() - t0
  return out
}

// ── HTTP server ─────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function sendJson(res, status, body, cache = false) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cache
      ? 'private, max-age=5, stale-while-revalidate=20'
      : 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 64 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath
  const file = path.join(__dirname, 'public', path.normalize(rel))
  if (!file.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403).end('Forbidden')
    return
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
      return
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    })
    res.end(data)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  try {
    if (req.method === 'GET' && url.pathname === '/api/overview') {
      const days = clampInt(url.searchParams.get('days'), { def: 30, min: 1, max: 365 })
      sendJson(res, 200, await buildOverview(days), true)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/usage/unified') {
      const days = clampInt(url.searchParams.get('days'), { def: 30, min: 1, max: 365 })
      sendJson(res, 200, await buildUnifiedUsage(days), true)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      sendJson(res, 200, sanitizedSettings())
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const result = applySettings(await readJsonBody(req))
      sendJson(res, result.error ? 400 : 200, result)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/test') {
      sendJson(res, 200, await testConnection(await readJsonBody(req)))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/engines') {
      sendJson(res, 200, { engines: engines().map(({ id, label }) => ({ id, label })) })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/engine/live') {
      const engine = engineById(url.searchParams.get('engine'))
      if (!engine) { sendJson(res, 404, { error: 'no engine configured' }); return }
      sendJson(res, 200, await buildEngineLive(engine))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/engine/health') {
      const engine = engineById(url.searchParams.get('engine'))
      if (!engine) { sendJson(res, 200, { engine: null, state: 'hidden' }); return }
      sendJson(res, 200, await buildEngineHealth(engine))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/engine/range') {
      const engine = engineById(url.searchParams.get('engine'))
      if (!engine) { sendJson(res, 404, { error: 'no engine configured' }); return }
      const { status, body } = await proxyCollectorJson(engine, '/range')
      sendJson(res, status, body)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/engine/history') {
      const engine = engineById(url.searchParams.get('engine'))
      if (!engine) { sendJson(res, 404, { error: 'no engine configured' }); return }
      const now = Date.now() / 1000
      const to = clampFloat(url.searchParams.get('to'), { def: now, min: 0, max: now + 86400 })
      const from = clampFloat(url.searchParams.get('from'), { def: to - 3600, min: 0, max: to })
      const points = clampInt(url.searchParams.get('points'), { def: 600, min: 10, max: 4000 })
      const { status, body } = await proxyCollectorJson(engine, '/history', `from=${from}&to=${to}&points=${points}`)
      sendJson(res, status, body)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/engine/test') {
      sendJson(res, 200, await testEngine(await readJsonBody(req)))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/engine/model-suggest') {
      const result = await suggestEngineModels(await readJsonBody(req))
      sendJson(res, result.error && !result.model_path ? 400 : 200, result)
      return
    }
  } catch (err) {
    sendJson(res, 400, { error: err?.message || 'bad request' })
    return
  }
  if (req.method === 'GET') {
    serveStatic(res, url.pathname)
    return
  }
  res.writeHead(405).end()
})

server.listen(PORT, HOST, () => {
  const shown = isLoopback ? '127.0.0.1' : HOST
  console.log(`hermes-stats-dash listening on http://${shown}:${PORT} (bind ${HOST})`)
  console.log(`  upstream dashboard: ${dashboardUrl()} (${urlSource()})`)
  console.log(`  auth: ${authMode()}`)
  if (!isLoopback) {
    console.log(
      '  ⚠ remote mode: bound to a non-loopback address. This server has ' +
        'no auth of its own and can hold upstream credentials — only expose ' +
        'it on a trusted network (e.g. Tailscale), never the public internet.',
    )
  }
})
