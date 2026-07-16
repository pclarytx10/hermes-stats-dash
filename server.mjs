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
async function dashJson(apiPath, { retried = false } = {}) {
  const base = dashboardUrl()
  try {
    const res = await fetch(`${base}${apiPath}`, {
      headers: { accept: 'application/json', ...(await authHeaders(base)) },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (res.status === 401 && !staticToken() && !staticCookie() && !retried) {
      storeLoginCookie(base, '')
      if (!(staticUsername() && staticPassword())) storeSessionToken(base, '')
      return dashJson(apiPath, { retried: true })
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
  const profiles =
    Array.isArray(status?.profiles) && status.profiles.length ? status.profiles : ['default']
  const usages = await Promise.all(
    profiles.length === 1 && profiles[0] === 'default'
      ? [dashJson(`/api/analytics/usage?days=${days}`)]
      : profiles.map((p) =>
          dashJson(`/api/analytics/usage?days=${days}&profile=${encodeURIComponent(p)}`)),
  )
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
