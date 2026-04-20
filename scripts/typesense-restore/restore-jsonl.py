#!/usr/bin/env python3
"""
Resumable chunked JSONL importer for Typesense.

Safe to rerun. Streams a JSONL file in bounded batches, POSTing to
/collections/{name}/documents/import?action=emplace (idempotent by id).
Persists a checkpoint per (collection, source) so reruns resume from the last
successfully acknowledged batch line number.

Usage:
  restore-jsonl.py \
    --url http://127.0.0.1:8108 \
    --api-key <key> \
    --collection docs_chunks_v2 \
    --source ~/.cache/typesense-transfer/docs_chunks_v2.old.jsonl \
    [--schema-source-url http://127.0.0.1:18108 --schema-source-key recoverykey] \
    [--schema-file path/to/collection.schema.json] \
    [--batch-size 500] \
    [--action emplace|upsert|create] \
    [--checkpoint-dir ~/.cache/typesense-transfer/checkpoints]

Behavior:
  1. Ensures target collection exists. If not, fetches schema from schema-source-url
     or reads schema-file, strips non-create fields, creates collection.
  2. Reads source JSONL line-by-line, batches N lines, POSTs to import endpoint.
  3. After each batch, checks response for per-line errors. On partial error,
     fails loudly with the first error. On success, advances checkpoint.
  4. On rerun, skips lines <= last_committed_line in checkpoint.
"""

from __future__ import annotations
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


SCHEMA_STRIP_FIELDS = {
    "created_at",
    "num_documents",
    "num_memory_shards",
    "memory_used_bytes",
}


def http_request(
    method: str,
    url: str,
    api_key: str,
    body: bytes | None = None,
    content_type: str = "application/json",
    timeout: int = 300,
) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("X-TYPESENSE-API-KEY", api_key)
    if body is not None:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def get_collection(url: str, api_key: str, name: str) -> dict | None:
    code, body = http_request("GET", f"{url}/collections/{name}", api_key)
    if code == 200:
        return json.loads(body)
    if code == 404:
        return None
    raise RuntimeError(f"get_collection({name}) -> {code}: {body!r}")


def fetch_schema_from_source(
    source_url: str, source_key: str, name: str, strip_auto_embed: bool = True
) -> dict:
    coll = get_collection(source_url, source_key, name)
    if coll is None:
        raise RuntimeError(f"schema source has no collection {name!r}")
    return strip_for_create(coll, strip_auto_embed=strip_auto_embed)


def strip_for_create(coll: dict, strip_auto_embed: bool = True) -> dict:
    out = {k: v for k, v in coll.items() if k not in SCHEMA_STRIP_FIELDS}
    if "fields" in out:
        cleaned_fields = []
        for f in out["fields"]:
            field = {k: v for k, v in f.items() if k not in SCHEMA_STRIP_FIELDS}
            if strip_auto_embed and "embed" in field:
                del field["embed"]
            cleaned_fields.append(field)
        out["fields"] = cleaned_fields
    return out


def ensure_collection(
    target_url: str,
    target_key: str,
    name: str,
    schema_file: str | None,
    schema_source_url: str | None,
    schema_source_key: str | None,
    strip_auto_embed: bool = True,
) -> None:
    existing = get_collection(target_url, target_key, name)
    if existing is not None:
        print(
            f"[ensure] live collection {name!r} present (docs={existing.get('num_documents', '?')})"
        )
        return
    if schema_file:
        schema = strip_for_create(
            json.loads(Path(schema_file).read_text()),
            strip_auto_embed=strip_auto_embed,
        )
    elif schema_source_url and schema_source_key:
        schema = fetch_schema_from_source(
            schema_source_url, schema_source_key, name, strip_auto_embed=strip_auto_embed
        )
    else:
        raise RuntimeError(
            f"collection {name!r} missing and no schema source provided"
        )
    code, body = http_request(
        "POST",
        f"{target_url}/collections",
        target_key,
        body=json.dumps(schema).encode("utf-8"),
    )
    if code not in (200, 201):
        raise RuntimeError(
            f"create_collection({name}) -> {code}: {body!r}"
        )
    print(f"[ensure] created live collection {name!r}")


def checkpoint_path(ckpt_dir: Path, collection: str, source: Path) -> Path:
    src_id = source.resolve().as_posix().replace("/", "_").lstrip("_")
    return ckpt_dir / f"{collection}__{src_id}.json"


def read_checkpoint(path: Path) -> dict:
    if not path.exists():
        return {"last_committed_line": 0, "batches": 0, "docs": 0}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {"last_committed_line": 0, "batches": 0, "docs": 0}


def write_checkpoint(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(path)


def post_batch(
    url: str, api_key: str, collection: str, action: str, batch: list[str]
) -> list[dict]:
    body = ("\n".join(batch)).encode("utf-8")
    endpoint = f"{url}/collections/{collection}/documents/import?action={action}&batch_size={len(batch)}"
    # Retry transient 503/502/504 with exponential backoff — Typesense returns
    # 503 "Not Ready or Lagging" while raft catches up queued writes after a
    # pod restart; 503 is NOT an import error, it's a server-not-ready signal.
    max_attempts = 12
    delay = 2.0
    for attempt in range(1, max_attempts + 1):
        code, resp = http_request(
            "POST",
            endpoint,
            api_key,
            body=body,
            content_type="text/plain",
            timeout=600,
        )
        if code == 200:
            break
        if code in (502, 503, 504) and attempt < max_attempts:
            sleep_for = min(delay * attempt, 30.0)
            print(
                f"[retry] batch -> {code}: {resp[:120]!r} sleeping {sleep_for:.1f}s (attempt {attempt}/{max_attempts})"
            )
            time.sleep(sleep_for)
            continue
        raise RuntimeError(f"import batch -> {code}: {resp!r}")
    results = []
    for line in resp.decode("utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            results.append(json.loads(line))
        except json.JSONDecodeError as e:
            raise RuntimeError(f"unparseable import response line: {line!r}") from e
    return results


def run(
    url: str,
    api_key: str,
    collection: str,
    source: Path,
    batch_size: int,
    action: str,
    ckpt_dir: Path,
    schema_file: str | None,
    schema_source_url: str | None,
    schema_source_key: str | None,
    fail_fast: bool,
    strip_auto_embed: bool,
) -> int:
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    ckpt_file = checkpoint_path(ckpt_dir, collection, source)
    state = read_checkpoint(ckpt_file)
    resume_from = state.get("last_committed_line", 0)
    print(
        f"[start] collection={collection} source={source} batch_size={batch_size} action={action}"
    )
    print(f"[ckpt]  {ckpt_file} resume_from_line={resume_from}")

    ensure_collection(
        url,
        api_key,
        collection,
        schema_file,
        schema_source_url,
        schema_source_key,
        strip_auto_embed=strip_auto_embed,
    )

    start_ts = time.time()
    processed_docs = state.get("docs", 0)
    batches = state.get("batches", 0)

    with source.open("r", encoding="utf-8") as f:
        line_no = 0
        batch: list[str] = []
        batch_start_line = resume_from
        total_errors = 0
        for line in f:
            line_no += 1
            if line_no <= resume_from:
                continue
            line = line.rstrip("\n")
            if not line:
                continue
            batch.append(line)
            if len(batch) < batch_size:
                continue
            batch_start_line = line_no - len(batch) + 1
            results = post_batch(url, api_key, collection, action, batch)
            errors_in_batch = [r for r in results if not r.get("success", False)]
            if errors_in_batch:
                total_errors += len(errors_in_batch)
                first = errors_in_batch[0]
                msg = first.get("error", first)
                sample = first.get("document", "")
                if isinstance(sample, str) and len(sample) > 200:
                    sample = sample[:200] + "..."
                print(
                    f"[ERR]   batch@lines {batch_start_line}-{line_no} errors={len(errors_in_batch)}/{len(batch)} first={msg} doc_sample={sample}"
                )
                if fail_fast:
                    return 2
            processed_docs += len(batch) - len(errors_in_batch)
            batches += 1
            state = {
                "last_committed_line": line_no,
                "batches": batches,
                "docs": processed_docs,
                "errors_total": state.get("errors_total", 0) + len(errors_in_batch),
                "source": str(source),
                "collection": collection,
                "updated_at": time.time(),
            }
            write_checkpoint(ckpt_file, state)
            elapsed = max(time.time() - start_ts, 1e-3)
            rate = (processed_docs - state.get("docs", 0) + processed_docs) / elapsed
            print(
                f"[ok]    batch#{batches} lines {batch_start_line}-{line_no} docs+={len(batch)} total={processed_docs} elapsed={elapsed:.1f}s"
            )
            batch = []
        if batch:
            batch_start_line = line_no - len(batch) + 1
            results = post_batch(url, api_key, collection, action, batch)
            errors_in_batch = [r for r in results if not r.get("success", False)]
            if errors_in_batch:
                total_errors += len(errors_in_batch)
                first = errors_in_batch[0]
                msg = first.get("error", first)
                print(
                    f"[ERR]   final batch@lines {batch_start_line}-{line_no} errors={len(errors_in_batch)}/{len(batch)} first={msg}"
                )
                if fail_fast:
                    return 2
            processed_docs += len(batch) - len(errors_in_batch)
            batches += 1
            state = {
                "last_committed_line": line_no,
                "batches": batches,
                "docs": processed_docs,
                "errors_total": state.get("errors_total", 0) + len(errors_in_batch),
                "source": str(source),
                "collection": collection,
                "updated_at": time.time(),
            }
            write_checkpoint(ckpt_file, state)
            print(
                f"[ok]    final batch lines {batch_start_line}-{line_no} docs+={len(batch)} total={processed_docs}"
            )

    elapsed = time.time() - start_ts
    print(
        f"[done]  collection={collection} docs_processed={processed_docs} batches={batches} errors={total_errors} elapsed={elapsed:.1f}s"
    )
    return 0 if total_errors == 0 else 1


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--url", required=True)
    p.add_argument("--api-key", required=True)
    p.add_argument("--collection", required=True)
    p.add_argument("--source", required=True, type=Path)
    p.add_argument("--batch-size", type=int, default=500)
    p.add_argument(
        "--action", default="emplace", choices=["emplace", "upsert", "create", "update"]
    )
    p.add_argument(
        "--checkpoint-dir",
        type=Path,
        default=Path.home() / ".cache" / "typesense-transfer" / "checkpoints",
    )
    p.add_argument("--schema-file")
    p.add_argument("--schema-source-url")
    p.add_argument("--schema-source-key")
    p.add_argument(
        "--fail-fast",
        action="store_true",
        help="stop on first batch with errors",
    )
    p.add_argument(
        "--keep-auto-embed",
        action="store_true",
        help="preserve embed.from stanza in schema (default: strip so Typesense never regenerates vectors)",
    )
    args = p.parse_args()

    if not args.source.exists():
        print(f"[fatal] source not found: {args.source}", file=sys.stderr)
        return 2

    return run(
        url=args.url.rstrip("/"),
        api_key=args.api_key,
        collection=args.collection,
        source=args.source,
        batch_size=args.batch_size,
        action=args.action,
        ckpt_dir=args.checkpoint_dir,
        schema_file=args.schema_file,
        schema_source_url=args.schema_source_url,
        schema_source_key=args.schema_source_key,
        fail_fast=args.fail_fast,
        strip_auto_embed=not args.keep_auto_embed,
    )


if __name__ == "__main__":
    sys.exit(main())
