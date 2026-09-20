#!/usr/bin/env python3
"""Long-run telemetry collector for llama-server.

Polls /metrics and /slots on a fixed interval, writes one row per poll into
SQLite, and serves a read-only JSON history API for the telemetry page.

The /metrics counters are monotonic, so history is reconstructed by differencing
any two rows. Per-slot n_decoded is not monotonic (it resets per request), so the
per-interval decoded delta is resolved here, while the previous slot state is
still in hand, and stored alongside each row.

With --litellm it also polls a LiteLLM proxy's Prometheus endpoint on the same
interval, into its own tables and its own /litellm/* API. That is a second,
independent population: LiteLLM counts requests it *routed*, llama-server counts
work it *did*, and one proxy fans out across several llama-servers. The two are
kept apart here for the same reason the dashboard keeps them on separate tabs.

stdlib only, no dependencies.
"""

import argparse
import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
  ts                  REAL PRIMARY KEY,
  epoch               INTEGER NOT NULL DEFAULT 0,
  ok                  INTEGER NOT NULL DEFAULT 1,
  prompt_tokens       REAL,
  prompt_seconds      REAL,
  predicted_tokens    REAL,
  predicted_seconds   REAL,
  n_decode            REAL,
  n_tokens_max        REAL,
  busy_per_decode     REAL,
  requests_processing REAL,
  requests_deferred   REAL,
  gen_delta           REAL,
  slots_generating    INTEGER,
  slots_prefilling    INTEGER,
  slots_idle          INTEGER
);
CREATE INDEX IF NOT EXISTS samples_ts ON samples(ts);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

-- LiteLLM proxy-wide counters, one row per poll. Mirrors `samples`: monotonic
-- counters stored raw, history reconstructed by differencing.
CREATE TABLE IF NOT EXISTS litellm_samples (
  ts                  REAL PRIMARY KEY,
  epoch               INTEGER NOT NULL DEFAULT 0,
  ok                  INTEGER NOT NULL DEFAULT 1,
  requests_total      REAL,
  requests_failed     REAL,
  in_flight           REAL,
  input_tokens        REAL,
  output_tokens       REAL,
  total_tokens        REAL,
  api_latency_sum     REAL,
  api_latency_count   REAL,
  ttft_sum            REAL,
  ttft_count          REAL,
  total_latency_sum   REAL,
  total_latency_count REAL,
  queue_sum           REAL,
  queue_count         REAL,
  overhead_sum        REAL,
  overhead_count      REAL
);
CREATE INDEX IF NOT EXISTS litellm_samples_ts ON litellm_samples(ts);

-- Per-deployment counters — the load-balancing view. One row per poll per
-- deployment (model_id), summed over every other label: api_key_hash, team,
-- user_agent and friends multiply the series without saying anything about
-- which box served the request, which is the only question this table answers.
CREATE TABLE IF NOT EXISTS litellm_deployments (
  ts          REAL NOT NULL,
  model_id    TEXT NOT NULL,
  epoch       INTEGER NOT NULL DEFAULT 0,
  api_base    TEXT,
  model_name  TEXT,
  requests    REAL,
  success     REAL,
  failure     REAL,
  cooled_down REAL,
  state       REAL,
  lpot_sum    REAL,
  lpot_count  REAL,
  PRIMARY KEY (ts, model_id)
);
CREATE INDEX IF NOT EXISTS litellm_deployments_ts ON litellm_deployments(ts);
"""

COLS = ["ts", "epoch", "prompt_tokens", "prompt_seconds", "predicted_tokens",
        "predicted_seconds", "n_decode", "n_tokens_max", "busy_per_decode",
        "requests_processing", "gen_delta", "slots_generating",
        "slots_prefilling", "slots_idle", "n", "n_ok"]

LL_COLS = ["ts", "epoch", "requests_total", "requests_failed", "in_flight",
           "input_tokens", "output_tokens", "total_tokens",
           "api_latency_sum", "api_latency_count", "ttft_sum", "ttft_count",
           "total_latency_sum", "total_latency_count", "queue_sum",
           "queue_count", "overhead_sum", "overhead_count", "n", "n_ok"]

LL_DEP_COLS = ["ts", "model_id", "epoch", "api_base", "model_name", "requests",
               "success", "failure", "cooled_down", "state", "lpot_sum",
               "lpot_count", "n"]


def parse_prom(text):
    out = {}
    for line in text.splitlines():
        s = line.strip()
        if not s or s[0] == "#":
            continue
        sp = s.rfind(" ")
        if sp < 0:
            continue
        name, raw = s[:sp].strip(), s[sp + 1:]
        br = name.find("{")
        if br >= 0:
            name = name[:br]
        if name.startswith("llamacpp:"):
            name = name[9:]
        try:
            out[name] = float(raw)
        except ValueError:
            pass
    return out


LABEL_RE = re.compile(r'([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"')


def is_placeholder(v):
    """LiteLLM writes a placeholder rather than omitting a label it has no value
    for: the literal string "None" (Python str(None)) on some metric families,
    the empty string on others. Taken at face value they become a phantom
    deployment named "None" in the routing table."""
    return not v or v == "None"


def is_inference(labels):
    """Was this proxy-level request an inference call, or LiteLLM's own
    housekeeping? requested_model is empty on /metrics/, /v1/models, /health and
    friends. It matters: a model-list call and this collector's own scrape are
    both recorded as *failed* proxy requests, so counting them naively makes an
    idle proxy read as a 100% error rate."""
    return (not is_placeholder(labels.get("requested_model"))
            or not is_placeholder(labels.get("model_id")))


def parse_prom_labeled(text):
    """Prometheus text -> [(name, {label: value}, float)].

    parse_prom() above throws labels away, which is fine for llama-server (its
    series are unlabelled) and useless for LiteLLM, where the label set *is* the
    data: model_id says which box served the request. Values with a label that
    fails to parse are skipped rather than merged under a wrong key.
    """
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s[0] == "#":
            continue
        sp = s.rfind(" ")
        if sp < 0:
            continue
        name, raw = s[:sp].strip(), s[sp + 1:]
        try:
            value = float(raw)
        except ValueError:
            continue
        labels = {}
        br = name.find("{")
        if br >= 0:
            body, name = name[br + 1:].rstrip("}"), name[:br]
            for k, v in LABEL_RE.findall(body):
                labels[k] = v.replace('\\"', '"').replace("\\\\", "\\").replace("\\n", "\n")
        out.append((name, labels, value))
    return out


def next_tok(slot):
    """next_token is a one-element list on some builds, a bare object on others."""
    nt = slot.get("next_token")
    if isinstance(nt, list):
        nt = nt[0] if nt else None
    return nt if isinstance(nt, dict) else {}


class Collector:
    def __init__(self, db_path, base, interval, timeout, litellm=None, litellm_key=None):
        self.base = base.rstrip("/")
        self.interval = interval
        self.timeout = timeout
        # LiteLLM's Prometheus endpoint is mounted as a sub-app at /metrics, so
        # the bare path 307s to /metrics/ — ask for the slash directly rather
        # than paying a redirect every poll. The key is the proxy's master key
        # (or a virtual key): the endpoint is behind the same auth as the API.
        self.litellm = litellm.rstrip("/") if litellm else None
        self.litellm_key = litellm_key or ""
        self.db = sqlite3.connect(db_path, timeout=30)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(SCHEMA)
        self.db.commit()
        self.slot_prev = {}
        self.metrics_ok = True
        self.litellm_ok = True
        self.litellm_start = None        # process_start_time_seconds, for restarts
        row = self.db.execute(
            "SELECT epoch FROM litellm_samples WHERE ok=1 ORDER BY ts DESC LIMIT 1"
        ).fetchone()
        self.litellm_epoch = int(row[0]) if row else 0
        # Resume from the newest row, not MAX(n_decode) — a prior restart means the
        # all-time maximum belongs to an older epoch and would fake another restart.
        row = self.db.execute(
            "SELECT epoch, n_decode FROM samples WHERE ok=1 ORDER BY ts DESC LIMIT 1"
        ).fetchone()
        self.epoch = int(row[0]) if row else 0
        self.last_decode = row[1] if row else None

    def get(self, path, timeout=None):
        # /metrics and /slots are answered off llama-server's task queue, so under heavy
        # decode they block well past the poll interval. Time out generously rather than
        # recording a false outage; a slow poll just delays the next one.
        req = urllib.request.Request(self.base + path, headers={"Accept": "*/*"})
        with urllib.request.urlopen(req, timeout=timeout or self.timeout) as r:
            return r.read().decode("utf-8", "replace")

    def get_litellm(self, path, timeout=None):
        headers = {"Accept": "*/*"}
        if self.litellm_key:
            headers["Authorization"] = "Bearer " + self.litellm_key
        req = urllib.request.Request(self.litellm + path, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout or self.timeout) as r:
            return r.read().decode("utf-8", "replace")

    def set_meta(self, k, v):
        self.db.execute("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", (k, str(v)))

    def read_props(self):
        try:
            p = json.loads(self.get("/props", timeout=15))
        except Exception:
            return
        dgs = p.get("default_generation_settings") or {}
        if dgs.get("n_ctx"):
            self.set_meta("n_ctx", dgs["n_ctx"])
        for k in ("model_path", "build_info", "total_slots"):
            if p.get(k) is not None:
                self.set_meta(k, p[k])
        self.set_meta("endpoint_metrics", bool(p.get("endpoint_metrics")))
        self.db.commit()

    def slot_deltas(self, slots):
        """Mirror of the page's readSlots: first sighting baselines, task change
        means the per-slot counter restarted so the current value is the delta."""
        gen, generating, prefilling, idle = 0.0, 0, 0, 0
        nxt = {}
        for s in slots:
            sid = str(s.get("id"))
            task = s.get("id_task", -1)
            dec = next_tok(s).get("n_decoded") or 0
            prev = self.slot_prev.get(sid)
            if prev is not None:
                gen += max(0.0, dec - prev[1]) if prev[0] == task else dec
            if s.get("is_processing"):
                if dec > 0:
                    generating += 1
                else:
                    prefilling += 1
            else:
                idle += 1
            nxt[sid] = (task, dec)
        self.slot_prev = nxt
        return gen, generating, prefilling, idle

    def poll(self):
        ts = time.time()
        note = None
        try:
            m = parse_prom(self.get("/metrics"))
            if "prompt_tokens_total" not in m:
                raise ValueError("response did not look like llama.cpp metrics")
            self.metrics_ok = True
        except urllib.error.HTTPError as e:
            # 501 means the server was started without --metrics. That is a
            # capability limit, not an outage: /slots still yields decode
            # progress and occupancy, so sample it and leave the counters NULL.
            if e.code not in (400, 501):
                return self.record_down(ts, e)
            m, note = {}, "metrics disabled on this server (HTTP %d) — slots-only mode" % e.code
            self.metrics_ok = False
        except Exception as e:
            return self.record_down(ts, e)

        try:
            slots = json.loads(self.get("/slots"))
            if not isinstance(slots, list):
                slots = []
        except Exception:
            slots = []
        gen, generating, prefilling, idle = self.slot_deltas(slots)

        n_decode = m.get("n_decode_total")
        if self.last_decode is not None and n_decode is not None and n_decode < self.last_decode:
            self.epoch += 1              # counters went backwards: server restarted
            self.slot_prev = {}
        if n_decode is not None:
            self.last_decode = n_decode

        self.db.execute(
            "INSERT OR REPLACE INTO samples(ts,epoch,ok,prompt_tokens,prompt_seconds,"
            "predicted_tokens,predicted_seconds,n_decode,n_tokens_max,busy_per_decode,"
            "requests_processing,requests_deferred,gen_delta,slots_generating,"
            "slots_prefilling,slots_idle) VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (ts, self.epoch, m.get("prompt_tokens_total"), m.get("prompt_seconds_total"),
             m.get("tokens_predicted_total"), m.get("tokens_predicted_seconds_total"),
             n_decode, m.get("n_tokens_max"), m.get("n_busy_slots_per_decode"),
             m.get("requests_processing"), m.get("requests_deferred"),
             gen, generating, prefilling, idle))
        self.db.commit()
        return note

    def record_down(self, ts, err):
        self.db.execute("INSERT OR REPLACE INTO samples(ts,epoch,ok) VALUES(?,?,0)",
                        (ts, self.epoch))
        self.db.commit()
        self.slot_prev = {}              # a gap invalidates the slot baseline
        return "down: %s" % err

    # ── LiteLLM ──────────────────────────────────────────────────────
    #
    # Everything here folds a label set down to one number per deployment.
    # LiteLLM emits each counter once per (api_key, team, user_agent, client_ip,
    # …) combination; the load-balancing question is only ever "which box", so
    # every series carrying a model_id is summed into that model_id and the rest
    # of the labels are dropped. api_base and litellm_model_name are kept as the
    # deployment's identity, last value wins.

    def poll_litellm(self, ts):
        try:
            rows = parse_prom_labeled(self.get_litellm("/metrics/"))
            self.litellm_ok = True
        except Exception as e:
            self.db.execute(
                "INSERT OR REPLACE INTO litellm_samples(ts,epoch,ok) VALUES(?,?,0)",
                (ts, self.litellm_epoch))
            self.db.commit()
            self.litellm_ok = False
            return "litellm down: %s" % e

        proxy = {}
        deps = {}

        def acc(bucket, key, value):
            bucket[key] = bucket.get(key, 0.0) + value

        # Counter families keep the _total suffix in the exposition; histograms
        # expose _sum/_count. Both are mapped to a single column name here so
        # the storage schema does not track LiteLLM's naming.
        PROXY_COUNTERS = {
            "litellm_proxy_total_requests_metric_total": "requests_total",
            "litellm_proxy_failed_requests_metric_total": "requests_failed",
            "litellm_input_tokens_metric_total": "input_tokens",
            "litellm_output_tokens_metric_total": "output_tokens",
            "litellm_total_tokens_metric_total": "total_tokens",
        }
        PROXY_HISTOGRAMS = {
            "litellm_llm_api_latency_metric": "api_latency",
            "litellm_llm_api_time_to_first_token_metric": "ttft",
            "litellm_request_total_latency_metric": "total_latency",
            "litellm_request_queue_time_seconds": "queue",
            "litellm_overhead_latency_metric": "overhead",
        }
        DEP_COUNTERS = {
            "litellm_deployment_total_requests_total": "requests",
            "litellm_deployment_success_responses_total": "success",
            "litellm_deployment_failure_responses_total": "failure",
            "litellm_deployment_cooled_down_total": "cooled_down",
        }

        start_time = None
        for name, labels, value in rows:
            if name == "process_start_time_seconds":
                start_time = value
                continue
            if name == "litellm_in_flight_requests":
                # This scrape is itself an open request on the proxy (verified:
                # two concurrent scrapes read 2), so the observer subtracts
                # itself or an idle proxy never records zero.
                acc(proxy, "in_flight", max(0.0, value - 1.0))
                continue
            col = PROXY_COUNTERS.get(name)
            if col:
                # Only the two request counters carry non-inference traffic;
                # the rest are emitted on real calls only.
                if col in ("requests_total", "requests_failed") and not is_inference(labels):
                    continue
                acc(proxy, col, value)
                continue
            for base, col in PROXY_HISTOGRAMS.items():
                if name == base + "_sum":
                    acc(proxy, col + "_sum", value)
                elif name == base + "_count":
                    acc(proxy, col + "_count", value)

            mid = labels.get("model_id")
            # A routing attempt that never reached a box names no deployment;
            # the proxy-level failure counter already carries it.
            if mid is None or is_placeholder(mid):
                continue
            d = deps.setdefault(mid, {"api_base": None, "model_name": None})
            if not is_placeholder(labels.get("api_base")):
                d["api_base"] = labels["api_base"]
            if not is_placeholder(labels.get("litellm_model_name")):
                d["model_name"] = labels["litellm_model_name"]
            dcol = DEP_COUNTERS.get(name)
            if dcol:
                acc(d, dcol, value)
            elif name == "litellm_deployment_state":
                # A gauge, not a counter: the worst state reported across the
                # deployment's label sets is the one worth recording.
                d["state"] = max(d.get("state", 0.0), value)
            elif name == "litellm_deployment_latency_per_output_token_sum":
                acc(d, "lpot_sum", value)
            elif name == "litellm_deployment_latency_per_output_token_count":
                acc(d, "lpot_count", value)

        # A restarted proxy zeroes every counter. Detect it from the process
        # start time rather than from counters going backwards: the deployment
        # series appear only after a first request, so "backwards" is ambiguous.
        if start_time is not None:
            if self.litellm_start is not None and start_time != self.litellm_start:
                self.litellm_epoch += 1
            self.litellm_start = start_time

        self.db.execute(
            "INSERT OR REPLACE INTO litellm_samples(ts,epoch,ok,requests_total,"
            "requests_failed,in_flight,input_tokens,output_tokens,total_tokens,"
            "api_latency_sum,api_latency_count,ttft_sum,ttft_count,"
            "total_latency_sum,total_latency_count,queue_sum,queue_count,"
            "overhead_sum,overhead_count)"
            " VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (ts, self.litellm_epoch,
             proxy.get("requests_total"), proxy.get("requests_failed"),
             proxy.get("in_flight"), proxy.get("input_tokens"),
             proxy.get("output_tokens"), proxy.get("total_tokens"),
             proxy.get("api_latency_sum"), proxy.get("api_latency_count"),
             proxy.get("ttft_sum"), proxy.get("ttft_count"),
             proxy.get("total_latency_sum"), proxy.get("total_latency_count"),
             proxy.get("queue_sum"), proxy.get("queue_count"),
             proxy.get("overhead_sum"), proxy.get("overhead_count")))
        for mid, d in deps.items():
            self.db.execute(
                "INSERT OR REPLACE INTO litellm_deployments(ts,model_id,epoch,"
                "api_base,model_name,requests,success,failure,cooled_down,state,"
                "lpot_sum,lpot_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (ts, mid, self.litellm_epoch, d.get("api_base"), d.get("model_name"),
                 d.get("requests"), d.get("success"), d.get("failure"),
                 d.get("cooled_down"), d.get("state"), d.get("lpot_sum"),
                 d.get("lpot_count")))
        self.db.commit()
        return None

    def run(self):
        self.read_props()
        last_err = None
        was_metrics = self.metrics_ok
        next_props = time.time() + 600
        while True:
            start = time.time()
            try:
                err = self.poll()
            except Exception as e:                      # never let the loop die
                err = "collector error: %s" % e
            if self.litellm:
                # Same cadence, same loop, separate tables: a LiteLLM outage
                # must not stop llama-server sampling, and the llama-server
                # error is the one worth reporting if both are down.
                try:
                    ll_err = self.poll_litellm(start)
                except Exception as e:
                    ll_err = "litellm collector error: %s" % e
                if ll_err and not err:
                    err = ll_err
            # Capability and model identity are not fixed for the life of the
            # process: the server can be restarted with different flags or a
            # different model under us. Re-read on any change, and periodically.
            if self.metrics_ok != was_metrics or start >= next_props:
                was_metrics = self.metrics_ok
                next_props = start + 600
                self.read_props()
            if err != last_err:
                print(err or "collecting", flush=True)
                last_err = err
            time.sleep(max(0.5, self.interval - (time.time() - start)))


def make_handler(db_path):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _send(self, code, payload):
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            db = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True, timeout=10)
            try:
                if u.path == "/range":
                    r = db.execute(
                        "SELECT MIN(ts),MAX(ts),COUNT(*),SUM(ok),COUNT(prompt_tokens)"
                        " FROM samples").fetchone()
                    meta = dict(db.execute("SELECT k,v FROM meta").fetchall())
                    return self._send(200, {"from": r[0], "to": r[1], "rows": r[2] or 0,
                                            "ok_rows": r[3] or 0,
                                            "metrics": bool(r[4]), "meta": meta})
                if u.path == "/history":
                    now = time.time()
                    t1 = float(q.get("to", [now])[0])
                    t0 = float(q.get("from", [t1 - 3600])[0])
                    pts = max(10, min(4000, int(q.get("points", [600])[0])))
                    width = max(1.0, (t1 - t0) / pts)
                    rows = db.execute(
                        "SELECT MAX(ts), MAX(epoch), MAX(prompt_tokens), MAX(prompt_seconds),"
                        " MAX(predicted_tokens), MAX(predicted_seconds), MAX(n_decode),"
                        " MAX(n_tokens_max), AVG(busy_per_decode), AVG(requests_processing),"
                        " SUM(gen_delta), AVG(slots_generating), AVG(slots_prefilling),"
                        " AVG(slots_idle), COUNT(*), SUM(ok)"
                        " FROM samples WHERE ts>=? AND ts<=?"
                        " GROUP BY CAST((ts-?)/? AS INTEGER) ORDER BY 1",
                        (t0, t1, t0, width)).fetchall()
                    out = [[round(v, 4) if isinstance(v, float) else v for v in r]
                           for r in rows]
                    have = db.execute(
                        "SELECT COUNT(prompt_tokens) FROM samples WHERE ts>=? AND ts<=?",
                        (t0, t1)).fetchone()[0]
                    return self._send(200, {"cols": COLS, "bucket": width,
                                            "from": t0, "to": t1,
                                            "metrics": bool(have), "rows": out})
                if u.path == "/litellm/range":
                    r = db.execute(
                        "SELECT MIN(ts),MAX(ts),COUNT(*),SUM(ok)"
                        " FROM litellm_samples").fetchone()
                    # Last-seen identity per deployment: what the picker labels
                    # its rows with, and the only place api_base is exposed.
                    deps = [
                        {"model_id": m, "api_base": ab, "model_name": mn,
                         "last_ts": lt}
                        for m, ab, mn, lt in db.execute(
                            "SELECT model_id, api_base, model_name, MAX(ts)"
                            " FROM litellm_deployments GROUP BY model_id"
                            " ORDER BY model_id").fetchall()]
                    return self._send(200, {"from": r[0], "to": r[1],
                                            "rows": r[2] or 0,
                                            "ok_rows": r[3] or 0,
                                            "deployments": deps})
                if u.path == "/litellm/history":
                    now = time.time()
                    t1 = float(q.get("to", [now])[0])
                    t0 = float(q.get("from", [t1 - 3600])[0])
                    pts = max(10, min(4000, int(q.get("points", [600])[0])))
                    width = max(1.0, (t1 - t0) / pts)
                    rows = db.execute(
                        "SELECT MAX(ts), MAX(epoch), MAX(requests_total),"
                        " MAX(requests_failed), AVG(in_flight), MAX(input_tokens),"
                        " MAX(output_tokens), MAX(total_tokens),"
                        " MAX(api_latency_sum), MAX(api_latency_count),"
                        " MAX(ttft_sum), MAX(ttft_count), MAX(total_latency_sum),"
                        " MAX(total_latency_count), MAX(queue_sum), MAX(queue_count),"
                        " MAX(overhead_sum), MAX(overhead_count), COUNT(*), SUM(ok)"
                        " FROM litellm_samples WHERE ts>=? AND ts<=?"
                        " GROUP BY CAST((ts-?)/? AS INTEGER) ORDER BY 1",
                        (t0, t1, t0, width)).fetchall()
                    # Counters are monotonic within an epoch, so MAX() per
                    # bucket then differencing gives the interval's volume —
                    # the same reconstruction the llama-server history uses.
                    deps = db.execute(
                        "SELECT MAX(ts), model_id, MAX(epoch), MAX(api_base),"
                        " MAX(model_name), MAX(requests), MAX(success),"
                        " MAX(failure), MAX(cooled_down), MAX(state),"
                        " MAX(lpot_sum), MAX(lpot_count), COUNT(*)"
                        " FROM litellm_deployments WHERE ts>=? AND ts<=?"
                        " GROUP BY CAST((ts-?)/? AS INTEGER), model_id ORDER BY 1",
                        (t0, t1, t0, width)).fetchall()
                    rnd = lambda rs: [[round(v, 4) if isinstance(v, float) else v
                                       for v in r] for r in rs]
                    return self._send(200, {"cols": LL_COLS,
                                            "dep_cols": LL_DEP_COLS,
                                            "bucket": width, "from": t0, "to": t1,
                                            "rows": rnd(rows),
                                            "dep_rows": rnd(deps)})
                return self._send(404, {"error": "not found"})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            finally:
                db.close()
    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.expanduser("~/llamacpp-telemetry/telemetry.db"))
    ap.add_argument("--server", default="http://127.0.0.1:8080")
    ap.add_argument("--interval", type=float, default=5.0)
    ap.add_argument("--timeout", type=float, default=20.0)
    ap.add_argument("--port", type=int, default=8081)
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--litellm", default=os.environ.get("LITELLM_URL", ""),
                    help="LiteLLM proxy base URL, e.g. http://127.0.0.1:8080. "
                         "Omit to collect llama-server only.")
    ap.add_argument("--litellm-key", default="",
                    help="LiteLLM key for /metrics. Prefer the LITELLM_API_KEY "
                         "or LITELLM_MASTER_KEY environment variable: a key "
                         "passed here is visible in ps(1) to every user on the "
                         "host.")
    a = ap.parse_args()

    # LITELLM_MASTER_KEY is the name LiteLLM's own config reads, so the unit can
    # take EnvironmentFile= straight from the proxy's env file rather than
    # duplicating the key into a second one.
    litellm_key = (a.litellm_key or os.environ.get("LITELLM_API_KEY")
                   or os.environ.get("LITELLM_MASTER_KEY", ""))

    os.makedirs(os.path.dirname(a.db), exist_ok=True)
    c = Collector(a.db, a.server, a.interval, a.timeout,
                  litellm=a.litellm or None, litellm_key=litellm_key)

    srv = ThreadingHTTPServer((a.bind, a.port), make_handler(a.db))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print("polling %s every %.1fs -> %s ; api on %s:%d"
          % (a.server, a.interval, a.db, a.bind, a.port), flush=True)
    if a.litellm:
        print("also polling litellm %s%s"
              % (a.litellm, "" if litellm_key else " (no key — /metrics is "
                                                   "likely to answer 401)"),
              flush=True)
    c.run()


if __name__ == "__main__":
    main()
