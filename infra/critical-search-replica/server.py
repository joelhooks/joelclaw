#!/usr/bin/env python3
"""Read-only HTTP shim for a replicated critical.db."""

from __future__ import annotations

import hmac
import json
import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

DB_PATH = Path(os.environ.get("CRITICAL_DB_PATH", "/data/critical.db"))
REPLICA_NAME = os.environ.get("REPLICA_NAME", "unknown-replica")
SYNC_STATE_PATH = Path(os.environ.get("SYNC_STATE_PATH", "/data/sync-state.json"))
SCHEMA_VERSION = "2"
SOURCE_STALE_AFTER_SECONDS = 7 * 24 * 60 * 60
MAX_BODY_BYTES = 64 * 1024
AUTH_TOKEN = os.environ.get("CRITICAL_SEARCH_TOKEN", "")
COLLECTIONS = {"observations", "memory_observations", "brain_pages", "system_knowledge", "vault_notes"}

if len(AUTH_TOKEN) < 32:
    raise RuntimeError("CRITICAL_SEARCH_TOKEN must contain at least 32 characters")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def iso_now() -> str:
    return utc_now().isoformat().replace("+00:00", "Z")


def open_db() -> sqlite3.Connection:
    if not DB_PATH.is_file():
        raise RuntimeError(f"critical.db not found at {DB_PATH}")
    connection = sqlite3.connect(f"file:{DB_PATH}?mode=ro&immutable=1", uri=True, timeout=1.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    return connection


def metadata(connection: sqlite3.Connection) -> dict[str, str]:
    values = {row["key"]: row["value"] for row in connection.execute("SELECT key, value FROM metadata")}
    if values.get("schema_version") != SCHEMA_VERSION:
        raise RuntimeError(f"critical.db schema mismatch: {values.get('schema_version', 'missing')}")
    return values


def read_sync_state() -> dict[str, Any]:
    try:
        state = json.loads(SYNC_STATE_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError) as error:
        raise RuntimeError(f"sync state unavailable: {error}") from error
    if not state.get("checkedAt") or not state.get("sha256"):
        raise RuntimeError("sync state is missing checkedAt or sha256")
    return state


def age_seconds(value: str | None, now: datetime) -> int | None:
    parsed = parse_iso(value)
    if parsed is None:
        return None
    return max(0, int((now - parsed).total_seconds()))


def freshness(connection: sqlite3.Connection, values: dict[str, str], now: datetime) -> dict[str, Any]:
    built_at = values.get("built_at", "1970-01-01T00:00:00Z")
    newest = connection.execute("SELECT max(source_updated_at) AS value FROM documents").fetchone()["value"]
    raw_sources = json.loads(values.get("sources_json", "{}"))
    sources: dict[str, Any] = {}
    for key, source in raw_sources.items():
        water_age = age_seconds(source.get("highWaterAt"), now)
        source_status = source.get("status", "unavailable")
        source_freshness = source_status if source_status != "ok" else (
            "stale" if water_age is not None and water_age > SOURCE_STALE_AFTER_SECONDS else "fresh"
        )
        sources[key] = {**source, "ageSeconds": water_age, "freshness": source_freshness}
    required = [sources.get(key) for key in (
        "files:observations", "files:brain", "files:vault", "files:knowledge", "archive:memory_observations",
    )]
    status = "degraded" if values.get("degraded_override") == "true" or any(
        not source or source.get("status") != "ok" for source in required
    ) else "stale" if any(source.get("freshness") == "stale" for source in required if source) else "ok"
    now_epoch = int(now.timestamp())
    return {
        "builtAt": built_at,
        "ageSeconds": age_seconds(built_at, now) or 0,
        "newestSourceAt": datetime.fromtimestamp(newest, timezone.utc).isoformat().replace("+00:00", "Z") if newest else None,
        "sourceAgeSeconds": max(0, now_epoch - int(newest)) if newest else None,
        "documentCount": int(values.get("document_count", "0")),
        "status": status,
        "sources": sources,
        "coverageGaps": json.loads(values.get("coverage_gaps_json", "[]")),
    }


def fts_query(value: str) -> str:
    terms = re.findall(r"[\w./:-]+", value, flags=re.UNICODE)[:16]
    return " OR ".join(f'"{term.replace(chr(34), chr(34) * 2)}"' for term in terms)


def health_payload() -> dict[str, Any]:
    started = time.perf_counter()
    now = utc_now()
    sync_state = read_sync_state()
    with open_db() as connection:
        values = metadata(connection)
        connection.execute("SELECT count(*) FROM documents_fts").fetchone()
        fresh = freshness(connection, values, now)
    copied = parse_iso(sync_state.get("copiedAt"))
    source = parse_iso(sync_state.get("sourceMtime"))
    lag = max(0, int((copied - source).total_seconds())) if copied and source else None
    return {
        "ok": True,
        "replica": REPLICA_NAME,
        "checkedAt": iso_now(),
        "syncCheckedAt": sync_state.get("checkedAt"),
        "syncCheckAgeSeconds": age_seconds(sync_state.get("checkedAt"), now),
        "replicaLagSeconds": lag,
        "sha256": sync_state.get("sha256"),
        "freshness": fresh,
        "durationMs": round((time.perf_counter() - started) * 1000, 2),
    }


def search_payload(request: dict[str, Any]) -> dict[str, Any]:
    started = time.perf_counter()
    now = utc_now()
    query = fts_query(str(request.get("query", "")))
    limit = max(1, min(int(request.get("limit") or 10), 100))
    collections = [item for item in (request.get("collections") or []) if item in COLLECTIONS]
    requested_type = str(request.get("type") or "").strip()

    with open_db() as connection:
        values = metadata(connection)
        fresh = freshness(connection, values, now)
        if not query:
            rows: list[sqlite3.Row] = []
            found = 0
        else:
            clauses = ["documents_fts MATCH ?"]
            parameters: list[Any] = [query]
            if collections:
                clauses.append(f"d.collection IN ({','.join('?' for _ in collections)})")
                parameters.extend(collections)
            if requested_type:
                clauses.append("d.type = ?")
                parameters.append(requested_type)
            where = " AND ".join(clauses)
            rows = connection.execute(f"""
                SELECT d.document_id, d.collection, d.type, d.title, d.content, d.source,
                  d.source_key, d.path, d.run_id, d.session_id, d.privacy, d.created_at,
                  d.source_updated_at, d.payload_json,
                  bm25(documents_fts, 6.0, 2.0, 1.0, 1.0) AS rank,
                  snippet(documents_fts, 1, '<mark>', '</mark>', ' … ', 32) AS snippet
                FROM documents_fts JOIN documents d ON d.rowid = documents_fts.rowid
                WHERE {where}
                ORDER BY rank ASC, COALESCE(d.source_updated_at, d.created_at, 0) DESC LIMIT ?
            """, [*parameters, limit]).fetchall()
            found = connection.execute(
                f"SELECT count(*) AS count FROM documents_fts JOIN documents d ON d.rowid = documents_fts.rowid WHERE {where}",
                parameters,
            ).fetchone()["count"]

    hits = []
    now_epoch = int(now.timestamp())
    for row in rows:
        source_key = row["source_key"]
        source_freshness = fresh["sources"].get(source_key, {})
        document_timestamp = row["source_updated_at"] or row["created_at"]
        rank = float(row["rank"] or 0)
        hits.append({
            "id": row["document_id"], "collection": row["collection"], "type": row["type"],
            "title": row["title"], "content": row["content"], "source": row["source"],
            "sourceKey": source_key, "path": row["path"], "runId": row["run_id"],
            "sessionId": row["session_id"], "privacy": row["privacy"], "createdAt": row["created_at"],
            "sourceUpdatedAt": row["source_updated_at"], "payload": json.loads(row["payload_json"] or "{}"),
            "rank": rank, "score": max(0, -rank), "snippet": (row["snippet"] or row["content"])[:1500],
            "sourceFreshness": {
                "sourceKey": source_key, "highWaterAt": source_freshness.get("highWaterAt"),
                "ageSeconds": source_freshness.get("ageSeconds"),
                "status": source_freshness.get("freshness", source_freshness.get("status", "unknown")),
                "documentAgeSeconds": max(0, now_epoch - int(document_timestamp)) if document_timestamp else None,
            },
        })

    return {
        "dbPath": str(DB_PATH), "hits": hits, "found": int(found), "freshness": fresh,
        "durationMs": round((time.perf_counter() - started) * 1000, 2),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "critical-search-replica/1"
    # Real HTTP/1.1 keep-alive (Content-Length is always sent), so pooled
    # clients stop dying on reused sockets. Takes effect at next image build.
    protocol_version = "HTTP/1.1"

    def authenticated(self) -> bool:
        provided = self.headers.get("authorization", "")
        return hmac.compare_digest(provided, f"Bearer {AUTH_TOKEN}")

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} {format % args}", flush=True)

    def json_response(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if not self.authenticated():
            self.json_response(401, {"ok": False, "error": "unauthorized"})
            return
        if self.path != "/health":
            self.json_response(404, {"ok": False, "error": "not found"})
            return
        try:
            self.json_response(200, health_payload())
        except Exception as error:
            self.json_response(503, {"ok": False, "replica": REPLICA_NAME, "error": str(error)[:500]})

    def do_POST(self) -> None:
        if not self.authenticated():
            self.json_response(401, {"ok": False, "error": "unauthorized"})
            return
        if self.path != "/search":
            self.json_response(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > MAX_BODY_BYTES:
                self.json_response(413, {"ok": False, "error": "invalid request size"})
                return
            request = json.loads(self.rfile.read(length))
            self.json_response(200, search_payload(request))
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            self.json_response(400, {"ok": False, "error": str(error)[:500]})
        except Exception as error:
            self.json_response(503, {"ok": False, "replica": REPLICA_NAME, "error": str(error)[:500]})


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "7411"))
    print(f"critical-search replica={REPLICA_NAME} listening={host}:{port} db={DB_PATH}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
