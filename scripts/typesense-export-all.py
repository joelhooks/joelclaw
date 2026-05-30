#!/usr/bin/env python3
"""Export every Typesense collection for machine migration.

Outputs a restorable bundle:
  schemas/collections.json
  schemas/<collection>.schema.json
  documents/<collection>.jsonl.gz
  synonyms/<collection>.json
  overrides/<collection>.json
  aliases.json
  manifest.json

Requires TYPESENSE_API_KEY in the environment. Never prints the key.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urljoin
from urllib.request import Request, urlopen


DEFAULT_URL = "http://127.0.0.1:8108"


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def request_json(base_url: str, api_key: str, path: str) -> Any:
    url = urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))
    req = Request(url, headers={"X-TYPESENSE-API-KEY": api_key})
    with urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def request_optional_json(base_url: str, api_key: str, path: str, empty_key: str) -> Any:
    try:
        return request_json(base_url, api_key, path)
    except HTTPError as error:
        if error.code == 404:
            return {empty_key: []}
        raise


def dump_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def export_documents(base_url: str, api_key: str, collection: str, out_file: Path) -> dict[str, Any]:
    encoded = quote(collection, safe="")
    url = urljoin(base_url.rstrip("/") + "/", f"collections/{encoded}/documents/export")
    req = Request(url, headers={"X-TYPESENSE-API-KEY": api_key})
    tmp_file = out_file.with_suffix(out_file.suffix + ".tmp")
    out_file.parent.mkdir(parents=True, exist_ok=True)

    line_count = 0
    uncompressed_bytes = 0
    started = time.time()

    try:
        with urlopen(req, timeout=3600) as resp, gzip.open(tmp_file, "wb", compresslevel=6) as gz:
            pending = b""
            for chunk in iter(lambda: resp.read(1024 * 1024), b""):
                if not chunk:
                    break
                uncompressed_bytes += len(chunk)
                line_count += chunk.count(b"\n")
                pending = chunk
                gz.write(chunk)
            if pending and not pending.endswith(b"\n"):
                line_count += 1
    except (HTTPError, URLError) as error:
        if tmp_file.exists():
            tmp_file.unlink()
        raise RuntimeError(f"failed exporting {collection}: {error}") from error

    tmp_file.replace(out_file)
    compressed_bytes = out_file.stat().st_size
    return {
        "file": str(out_file),
        "documentsExported": line_count,
        "uncompressedBytes": uncompressed_bytes,
        "compressedBytes": compressed_bytes,
        "sha256": sha256_file(out_file),
        "durationSeconds": round(time.time() - started, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Export all Typesense collections for migration")
    parser.add_argument("--url", default=os.environ.get("TYPESENSE_URL", DEFAULT_URL))
    parser.add_argument("--out", default="")
    parser.add_argument("--skip-documents", action="store_true", help="Export schemas/aliases/synonyms/overrides only")
    parser.add_argument("--collections", default="", help="Comma-separated allowlist of collections")
    args = parser.parse_args()

    api_key = os.environ.get("TYPESENSE_API_KEY", "").strip()
    if not api_key:
        print("TYPESENSE_API_KEY is required", file=sys.stderr)
        return 2

    out_dir = Path(args.out).expanduser() if args.out else Path.home() / ".local/share/typesense-exports" / utc_stamp()
    out_dir.mkdir(parents=True, exist_ok=True)

    allowlist = {name.strip() for name in args.collections.split(",") if name.strip()}
    started_at = datetime.now(timezone.utc).isoformat()

    health = request_json(args.url, api_key, "/health")
    debug = request_optional_json(args.url, api_key, "/debug", "debug")
    collections = request_json(args.url, api_key, "/collections/")
    if allowlist:
        collections = [collection for collection in collections if collection.get("name") in allowlist]

    aliases = request_optional_json(args.url, api_key, "/aliases", "aliases")

    dump_json(out_dir / "health.json", health)
    dump_json(out_dir / "debug.json", debug)
    dump_json(out_dir / "aliases.json", aliases)
    dump_json(out_dir / "schemas/collections.json", collections)

    manifest: dict[str, Any] = {
        "createdAt": started_at,
        "completedAt": None,
        "sourceUrl": args.url,
        "typesense": {
            "health": health,
            "debug": debug,
        },
        "collectionCount": len(collections),
        "collections": [],
        "aliasesFile": "aliases.json",
        "skippedDocuments": bool(args.skip_documents),
    }

    for collection in sorted(collections, key=lambda value: value.get("name", "")):
        name = collection["name"]
        print(f"exporting {name} ({collection.get('num_documents', 0)} docs)", flush=True)
        encoded = quote(name, safe="")

        schema_file = out_dir / "schemas" / f"{name}.schema.json"
        synonyms_file = out_dir / "synonyms" / f"{name}.json"
        overrides_file = out_dir / "overrides" / f"{name}.json"
        dump_json(schema_file, collection)
        dump_json(synonyms_file, request_optional_json(args.url, api_key, f"/collections/{encoded}/synonyms", "synonyms"))
        dump_json(overrides_file, request_optional_json(args.url, api_key, f"/collections/{encoded}/overrides", "overrides"))

        entry: dict[str, Any] = {
            "name": name,
            "schemaFile": str(schema_file.relative_to(out_dir)),
            "synonymsFile": str(synonyms_file.relative_to(out_dir)),
            "overridesFile": str(overrides_file.relative_to(out_dir)),
            "schemaNumDocuments": collection.get("num_documents"),
            "fields": len(collection.get("fields", [])),
        }

        if not args.skip_documents:
            export_result = export_documents(args.url, api_key, name, out_dir / "documents" / f"{name}.jsonl.gz")
            entry["documents"] = {
                **export_result,
                "file": str(Path(export_result["file"]).relative_to(out_dir)),
            }

        manifest["collections"].append(entry)

    manifest["completedAt"] = datetime.now(timezone.utc).isoformat()
    dump_json(out_dir / "manifest.json", manifest)

    bundle = out_dir.with_suffix(".tar.gz")
    print(f"export complete: {out_dir}", flush=True)
    print(f"manifest: {out_dir / 'manifest.json'}", flush=True)
    print("bundle command:", flush=True)
    print(f"  tar -C {out_dir.parent} -czf {bundle} {out_dir.name}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
