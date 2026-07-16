/**
 * Mock hermes-agent dashboard service, for developing/demoing
 * hermes-stats-dash without a live agent.
 *
 * Mimics the pieces this app consumes: the ephemeral session token injected
 * into the root HTML (pre-v0.17 loopback auth), bearer-token enforcement on
 * /api/*, and plausible payload shapes for /api/status (incl. multiplex
 * profile topology + a busy/idle active_agents cycle), /api/analytics/usage,
 * /api/sessions, /api/cron/jobs, and /api/model/info.
 *
 *   node scripts/mock-hermes.mjs        # listens on :9119
 *
 * MOCK_AUTH=password simulates a v0.17+ dashboard behind the auth gate with
 * a password provider: no token in the root HTML, bearer tokens rejected,
 * /api/auth/providers + POST /auth/password-login mint hermes_session_*
 * cookies (credentials: admin / hermes, or MOCK_USER / MOCK_PASS).
 */
import http from 'node:http'
import crypto from 'node:crypto'

const PORT = Number(process.env.MOCK_PORT || 9119)
const TOKEN = crypto.randomBytes(24).toString('base64url')
const AUTH_MODE =
  process.env.MOCK_AUTH === 'password' || process.argv[2] === 'password'
    ? 'password'
    : 'token'
const MOCK_USER = process.env.MOCK_USER || 'admin'
const MOCK_PASS = process.env.MOCK_PASS || 'hermes'
const sessionCookies = new Set()

const MODELS = [
  'Hermes-4-405B',
  'Hermes-4-70B',
  'claude-sonnet-5',
  'gpt-5.2',
  'DeepHermes-3-Mini',
]

// Deterministic pseudo-random so the charts look stable across reloads.
function rand(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

function dailyRows(days) {
  const rows = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(now.getDate() - i)
    const seed = Math.floor(d.getTime() / 86400000)
    if (rand(seed) < 0.18) continue // some idle days
    const busy = 0.4 + rand(seed + 1) * (d.getDay() % 6 === 0 ? 0.4 : 1.6)
    rows.push({
      day: d.toISOString().slice(0, 10),
      input_tokens: Math.round(220_000 * busy),
      output_tokens: Math.round(55_000 * busy),
      cache_read_tokens: Math.round(900_000 * busy),
      reasoning_tokens: Math.round(30_000 * busy * rand(seed + 2)),
      estimated_cost: +(1.9 * busy).toFixed(4),
      actual_cost: 0,
      sessions: Math.max(1, Math.round(9 * busy)),
      api_calls: Math.round(140 * busy),
    })
  }
  return rows
}

function usage(days) {
  const daily = dailyRows(days)
  const sum = (k) => daily.reduce((a, r) => a + r[k], 0)
  const by_model = MODELS.map((m, i) => {
    const share = 1 / (i + 1.3)
    return {
      model: m,
      input_tokens: Math.round(sum('input_tokens') * share * 0.5),
      output_tokens: Math.round(sum('output_tokens') * share * 0.5),
      estimated_cost: +(sum('estimated_cost') * share * 0.5).toFixed(4),
      sessions: Math.max(1, Math.round(sum('sessions') * share * 0.4)),
      api_calls: Math.round(sum('api_calls') * share * 0.5),
    }
  })
  return {
    daily,
    by_model,
    totals: {
      total_input: sum('input_tokens'),
      total_output: sum('output_tokens'),
      total_cache_read: sum('cache_read_tokens'),
      total_reasoning: sum('reasoning_tokens'),
      total_estimated_cost: +sum('estimated_cost').toFixed(2),
      total_actual_cost: 0,
      total_sessions: sum('sessions'),
      total_api_calls: sum('api_calls'),
    },
    period_days: days,
  }
}

const SESSION_NAMES = [
  'Refactor gateway relay adapter',
  'Draft release notes for 0.18',
  'Debug telegram platform reconnect',
  'Summarize overnight PR shakedown',
  'Cron: nightly memory consolidation',
  'Explain dashboard_auth provider seam',
  'Kanban board triage',
  'Write e2e test for session routing',
]

function sessions(limit) {
  const now = Math.floor(Date.now() / 1000)
  const recent = SESSION_NAMES.map((name, i) => ({
    id: `sess_${(1000 + i).toString(36)}`,
    name,
    model: MODELS[i % MODELS.length],
    source: i === 4 ? 'cron' : 'api_server',
    input_tokens: Math.round(90_000 * rand(i + 7)),
    output_tokens: Math.round(20_000 * rand(i + 11)),
    message_count: 4 + Math.round(30 * rand(i + 3)),
    started_at: now - (i + 1) * 5400,
    last_active_at: now - i * 4900 - 600,
  }))
  // Deterministic multi-model history across ~90 days so the per-model
  // usage chart has something to draw. Model mix drifts over time.
  const history = []
  for (let d = 1; d <= 90; d++) {
    const daySeed = Math.floor((now - d * 86400) / 86400)
    if (rand(daySeed) < 0.15) continue
    const count = 1 + Math.round(6 * rand(daySeed + 5))
    for (let k = 0; k < count; k++) {
      const seed = daySeed * 13 + k
      const drift = d / 90 // older days lean toward the older models
      const pick = rand(seed + 17) + drift * 0.35
      const model = MODELS[Math.min(MODELS.length - 1, Math.floor(pick * MODELS.length)) % MODELS.length]
      const started = now - d * 86400 + Math.round(rand(seed + 23) * 80000)
      history.push({
        id: `sess_h${d}_${k}`,
        name: SESSION_NAMES[(d + k) % SESSION_NAMES.length],
        model,
        source: 'api_server',
        input_tokens: Math.round(120_000 * rand(seed + 29)),
        output_tokens: Math.round(28_000 * rand(seed + 31)),
        message_count: 3 + Math.round(24 * rand(seed + 37)),
        started_at: started,
        last_active_at: started + 1800,
      })
    }
  }
  const all = [...recent, ...history]
  return { sessions: all.slice(0, limit), total: all.length }
}

// Multiplex topology: one default gateway serving several profiles, plus a
// standalone "research" gateway on its own ports.
const PROFILES = ['default', 'work', 'research', 'sandbox']

function statusPayload() {
  // Alternate busy/idle on a ~20s cycle so both states are observable.
  const agents = Math.floor(Date.now() / 1000) % 20 < 8 ? 2 : 0
  return {
    version: '0.18.2-mock',
    gateway_running: true,
    gateway_state: 'running',
    gateway_platforms: { api_server: {}, telegram: {}, discord: {} },
    active_agents: agents,
    gateway_busy: agents > 0,
    gateway_drainable: true,
    active_sessions: 3 + (agents ? 1 : 0),
    profiles: PROFILES,
    gateway_mode: 'multiplex',
    gateways: [
      { profile: 'default', ports: { api_server: 9119 }, served_profiles: ['default', 'work', 'sandbox'] },
      { profile: 'research', ports: { api_server: 9120 } },
    ],
  }
}

function cronJobs() {
  return [
    { id: 'j1', name: 'nightly-memory-consolidation', state: 'idle', schedule: '0 3 * * *' },
    { id: 'j2', name: 'hourly-inbox-sweep', state: 'running', schedule: '0 * * * *' },
    { id: 'j3', name: 'weekly-digest', state: 'paused', schedule: '0 9 * * 1' },
  ]
}

const MODEL_INFO = {
  provider: 'nous',
  model: 'Hermes-4-405B',
  context_length: 131072,
  capabilities: { tools: true, vision: false, reasoning: true },
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks)))
      } catch {
        resolve({})
      }
    })
  })
}

function hasValidSessionCookie(req) {
  const cookies = (req.headers.cookie || '').split(';').map((c) => c.trim())
  return cookies.some((c) => {
    const [name, value] = c.split('=')
    return name === 'hermes_session_at' && sessionCookies.has(value)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const send = (status, body, type = 'application/json', headers = {}) => {
    res.writeHead(status, { 'content-type': type, ...headers })
    res.end(type === 'application/json' ? JSON.stringify(body) : body)
  }

  if (url.pathname === '/') {
    // Gated mode serves the login page — no ephemeral token in the HTML.
    if (AUTH_MODE === 'password') {
      return send(200, '<!doctype html><html><body>mock hermes login page</body></html>', 'text/html')
    }
    return send(
      200,
      `<!doctype html><html><head><script>window.__HERMES_SESSION_TOKEN__ = "${TOKEN}";</script></head><body>mock hermes dashboard</body></html>`,
      'text/html',
    )
  }
  if (AUTH_MODE === 'password' && url.pathname === '/api/auth/providers') {
    return send(200, {
      providers: [{ name: 'basic', display_name: 'Password', supports_password: true }],
    })
  }
  if (AUTH_MODE === 'password' && req.method === 'POST' && url.pathname === '/auth/password-login') {
    const body = await readBody(req)
    if (body.provider !== 'basic') return send(404, { detail: 'Unknown provider' })
    if (body.username !== MOCK_USER || body.password !== MOCK_PASS) {
      return send(401, { detail: 'Invalid credentials' })
    }
    const at = crypto.randomBytes(18).toString('base64url')
    sessionCookies.add(at)
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': [
        `hermes_session_at=${at}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
        `hermes_session_rt=${crypto.randomBytes(18).toString('base64url')}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=86400`,
        `hermes_session_provider=basic; Path=/; SameSite=Lax; Max-Age=86400`,
      ],
    })
    return res.end(JSON.stringify({ ok: true, next: '/' }))
  }
  if (url.pathname.startsWith('/api/')) {
    const authed =
      AUTH_MODE === 'password'
        ? hasValidSessionCookie(req) // bearer tokens no longer valid behind the gate
        : req.headers.authorization === `Bearer ${TOKEN}`
    if (!authed) {
      return send(401, { error: 'unauthenticated', detail: 'Unauthorized' })
    }
    if (url.pathname === '/api/status') return send(200, statusPayload())
    if (url.pathname === '/api/model/info') return send(200, MODEL_INFO)
    if (url.pathname === '/api/cron/jobs') return send(200, cronJobs())
    if (url.pathname === '/api/sessions') {
      const limit = Math.max(1, Number(url.searchParams.get('limit')) || 20)
      return send(200, sessions(limit))
    }
    if (url.pathname === '/api/analytics/usage') {
      const days = Math.max(1, Number(url.searchParams.get('days')) || 30)
      return send(200, usage(days))
    }
    return send(404, { detail: 'Not Found' })
  }
  send(404, { detail: 'Not Found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    AUTH_MODE === 'password'
      ? `mock hermes dashboard on http://127.0.0.1:${PORT} (auth gate: ${MOCK_USER} / ${MOCK_PASS})`
      : `mock hermes dashboard on http://127.0.0.1:${PORT} (token ${TOKEN.slice(0, 8)}…)`,
  )
})
