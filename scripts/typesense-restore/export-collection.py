#!/usr/bin/env python3
"""
Export a single Typesense collection to JSONL + schema.json.

Safe to rerun — uses atomic tmp->rename writes. No checkpoint: export is a
single streaming HTTP call, so the re-run path is "delete partial, start again".
For resumable target import, use restore-jsonl.py.

Usage:
  export-collection.py \
    --url http://127.0.0.1:18108 \
    --api-key recoverykey \
    --collection docs \
    --out-dir ~/.cache/typesense-transfer
"""

from __future__ import annotations
import argparse
import json
import sys
import urllib.request
import urllib.error
from pathlib import Path


def http_get(url: str, api_key: str, stream: bool = False, timeout: int = 600):
    req = urllib.request.Request(url)
    req.add_header("X-TYPESENSE-API-KEY", api_key)
    return urllib.request.urlopen(req, timeout=timeout)


def export(url: str, api_key: str, collection: str, out_dir: Path) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    schema_path = out_dir / f"{collection}.schema.json"
    jsonl_path = out_dir / f"{collection}.old.jsonl"

    print(f"[schema] {collection} -> {schema_path}")
    with http_get(f"{url}/collections/{collection}", api_key) as resp:
        body = resp.read()
    schema_path.write_bytes(body)

    coll = json.loads(body)
    expected = coll.get("num_documents", "?")
    print(f"[export] {collection} num_documents={expected}")

    tmp = jsonl_path.with_suffix(".jsonl.tmp")
    print(f"[export] streaming to {tmp}")
    with http_get(
        f"{url}/collections/{collection}/documents/export", api_key
    ) as resp, tmp.open("wb") as f:
        bytes_written = 0
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            bytes_written += len(chunk)
    tmp.replace(jsonl_path)
    lines = 0
    with jsonl_path.open("rb") as f:
        for _ in f:
            lines += 1
    print(f"[done]   {collection}: {bytes_written} bytes, {lines} lines -> {jsonl_path}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--url", required=True)
    p.add_argument("--api-key", required=True)
    p.add_argument("--collection", required=True)
    p.add_argument("--out-dir", type=Path, required=True)
    args = p.parse_args()
    return export(args.url.rstrip("/"), args.api_key, args.collection, args.out_dir)


if __name__ == "__main__":
    sys.exit(main())
