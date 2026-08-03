#!/usr/bin/env python3
"""Long-run telemetry collector for llama-server.

Polls /metrics and /slots on a fixed interval, writes one row per poll into
SQLite, and serves a read-only JSON history API for the telemetry page.

The /metrics counters are monotonic, so history is reconstructed by differencing
any two rows. Per-slot n_decoded is not monotonic (it resets per request), so the
per-interval decoded delta is resolved here, while the previous slot state is
still in hand, and stored alongside each row.

stdlib only, no dependencies.
"""

import argparse
import json
import os
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
"""

COLS = ["ts", "epoch", "prompt_tokens", "prompt_seconds", "predicted_tokens",
        "predicted_seconds", "n_decode", "n_tokens_max", "busy_per_decode",
        "requests_processing", "gen_delta", "slots_generating",
        "slots_prefilling", "slots_idle", "n", "n_ok"]


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


def next_tok(slot):
    """next_token is a one-element list on some builds, a bare object on others."""
    nt = slot.get("next_token")
    if isinstance(nt, list):
        nt = nt[0] if nt else None
    return nt if isinstance(nt, dict) else {}


class Collector:
    def __init__(self, db_path, base, interval, timeout):
        self.base = base.rstrip("/")
        self.interval = interval
        self.timeout = timeout
        self.db = sqlite3.connect(db_path, timeout=30)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(SCHEMA)
        self.db.commit()
        self.slot_prev = {}
        self.metrics_ok = True
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
    a = ap.parse_args()

    os.makedirs(os.path.dirname(a.db), exist_ok=True)
    c = Collector(a.db, a.server, a.interval, a.timeout)

    srv = ThreadingHTTPServer((a.bind, a.port), make_handler(a.db))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print("polling %s every %.1fs -> %s ; api on %s:%d"
          % (a.server, a.interval, a.db, a.bind, a.port), flush=True)
    c.run()


if __name__ == "__main__":
    main()
