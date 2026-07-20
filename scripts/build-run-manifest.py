#!/usr/bin/env python3
"""Build a byte-proven compaction manifest from immutable Run JSONL files.

The source tree is opened read-only. The only writes are the requested manifest
and its temporary file in the output directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

Verdict = Literal[
    "exact_duplicate",
    "strict_prefix",
    "unique_tail",
    "divergent_sibling",
]

GENERATOR_PATH = "scripts/build-run-manifest.py"
GENERATOR_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


@dataclass
class RunEntry:
    run_id: str
    metadata_path: Path
    jsonl_path: Path
    jsonl_bytes: int
    metadata: dict[str, Any]
    source_identity: str
    prefix_group_identity: str
    jsonl_sha256: str = ""
    verdict: Verdict | None = None
    covering_run_id: str | None = None
    covering_jsonl_bytes: int | None = None
    covering_jsonl_sha256: str | None = None


@dataclass
class RetainedBody:
    entry: RunEntry
    body: bytes


@dataclass
class Summary:
    source_root: str
    manifest_path: str
    started_at: str
    generator_sha256: str = GENERATOR_SHA256
    run_count: int = 0
    metadata_count: int = 0
    jsonl_count: int = 0
    jsonl_bytes: int = 0
    unique_conversations: int = 0
    unique_source_identities: int = 0
    missing_conversation_id_runs: int = 0
    prefix_group_count: int = 0
    multi_run_prefix_groups: int = 0
    verdict_counts: Counter[str] = field(default_factory=Counter)
    verdict_bytes: Counter[str] = field(default_factory=Counter)
    keep_runs: int = 0
    keep_bytes: int = 0
    skip_runs: int = 0
    skip_bytes: int = 0
    redundant_bytes_pct: float = 0.0
    elapsed_seconds: float = 0.0
    top_redundant_groups: list[dict[str, Any]] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "source_root": self.source_root,
            "manifest_path": self.manifest_path,
            "started_at": self.started_at,
            "generator": {"path": GENERATOR_PATH, "sha256": self.generator_sha256},
            "run_count": self.run_count,
            "metadata_count": self.metadata_count,
            "jsonl_count": self.jsonl_count,
            "jsonl_bytes": self.jsonl_bytes,
            "unique_conversations": self.unique_conversations,
            "unique_source_identities": self.unique_source_identities,
            "missing_conversation_id_runs": self.missing_conversation_id_runs,
            "prefix_group_count": self.prefix_group_count,
            "multi_run_prefix_groups": self.multi_run_prefix_groups,
            "verdict_counts": dict(sorted(self.verdict_counts.items())),
            "verdict_bytes": dict(sorted(self.verdict_bytes.items())),
            "keep_runs": self.keep_runs,
            "keep_bytes": self.keep_bytes,
            "skip_runs": self.skip_runs,
            "skip_bytes": self.skip_bytes,
            "redundant_bytes_pct": self.redundant_bytes_pct,
            "elapsed_seconds": self.elapsed_seconds,
            "top_redundant_groups": self.top_redundant_groups,
        }


def canonical_identity(parts: list[Any]) -> str:
    canonical = json.dumps(parts, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def source_identity(metadata: dict[str, Any], run_id: str) -> str:
    conversation_id = metadata.get("conversation_id")
    if conversation_id is None:
        return canonical_identity(["run-conversation-v1", "legacy-missing", run_id])
    return canonical_identity(["run-conversation-v1", conversation_id])


def source_identity_basis(metadata: dict[str, Any], run_id: str) -> dict[str, Any]:
    conversation_id = metadata.get("conversation_id")
    if conversation_id is None:
        return {"conversation_id": None, "fallback": "run_id", "fallback_value": run_id}
    return {"conversation_id": conversation_id}


def prefix_group_identity(metadata: dict[str, Any], run_id: str) -> str:
    return canonical_identity(
        [
            "run-prefix-group-v1",
            metadata.get("agent_runtime"),
            source_identity(metadata, run_id),
            metadata.get("parent_run_id"),
        ]
    )


def is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def discover_entries(root: Path) -> tuple[list[RunEntry], int, int]:
    entries: list[RunEntry] = []
    metadata_count = 0
    jsonl_count = 0
    seen_run_ids: set[str] = set()

    for metadata_path in sorted(root.rglob("*.metadata.json")):
        metadata_count += 1
        with metadata_path.open("r", encoding="utf-8") as handle:
            metadata = json.load(handle)
        fallback_run_id = metadata_path.name.removesuffix(".metadata.json")
        run_id = metadata.get("run_id") or fallback_run_id
        if not isinstance(run_id, str) or not run_id:
            raise ValueError(f"invalid run_id in {metadata_path}")
        if run_id in seen_run_ids:
            raise ValueError(f"duplicate run_id: {run_id}")
        seen_run_ids.add(run_id)

        jsonl_path = metadata_path.with_name(f"{fallback_run_id}.jsonl")
        if not jsonl_path.is_file():
            raise FileNotFoundError(f"missing JSONL pair for {metadata_path}")
        jsonl_count += 1
        size = jsonl_path.stat().st_size
        entries.append(
            RunEntry(
                run_id=run_id,
                metadata_path=metadata_path,
                jsonl_path=jsonl_path,
                jsonl_bytes=size,
                metadata=metadata,
                source_identity=source_identity(metadata, run_id),
                prefix_group_identity=prefix_group_identity(metadata, run_id),
            )
        )

    unpaired_jsonl = [
        path
        for path in root.rglob("*.jsonl")
        if not path.with_name(f"{path.name.removesuffix('.jsonl')}.metadata.json").is_file()
    ]
    if unpaired_jsonl:
        raise ValueError(f"found {len(unpaired_jsonl)} unpaired JSONL files; first: {unpaired_jsonl[0]}")

    return entries, metadata_count, jsonl_count


def read_stable_body(entry: RunEntry) -> bytes:
    before = entry.jsonl_path.stat()
    with entry.jsonl_path.open("rb") as handle:
        body = handle.read()
    after = entry.jsonl_path.stat()
    if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        raise RuntimeError(f"source changed while reading: {entry.jsonl_path}")
    if len(body) != entry.jsonl_bytes:
        raise RuntimeError(f"source size changed after discovery: {entry.jsonl_path}")
    entry.jsonl_sha256 = hashlib.sha256(body).hexdigest()
    return body


def classify_group(entries: list[RunEntry]) -> dict[str, Any]:
    retained: list[RetainedBody] = []
    ordered = sorted(entries, key=lambda item: (-item.jsonl_bytes, item.run_id))

    for entry in ordered:
        body = read_stable_body(entry)
        covering: list[RetainedBody] = [candidate for candidate in retained if candidate.body.startswith(body)]
        if covering:
            chosen = min(covering, key=lambda candidate: (candidate.entry.jsonl_bytes, candidate.entry.run_id))
            entry.covering_run_id = chosen.entry.run_id
            entry.covering_jsonl_bytes = chosen.entry.jsonl_bytes
            entry.covering_jsonl_sha256 = chosen.entry.jsonl_sha256
            if len(body) == len(chosen.body) and entry.jsonl_sha256 == chosen.entry.jsonl_sha256:
                entry.verdict = "exact_duplicate"
            else:
                entry.verdict = "strict_prefix"
            continue
        retained.append(RetainedBody(entry=entry, body=body))

    retained_verdict: Verdict = "unique_tail" if len(retained) == 1 else "divergent_sibling"
    for candidate in retained:
        candidate.entry.verdict = retained_verdict

    redundant_runs = [
        entry for entry in entries if entry.verdict in ("exact_duplicate", "strict_prefix")
    ]
    first = entries[0]
    return {
        "prefix_group_identity": first.prefix_group_identity,
        "agent_runtime": first.metadata.get("agent_runtime"),
        "conversation_id": first.metadata.get("conversation_id"),
        "parent_run_id": first.metadata.get("parent_run_id"),
        "runs": len(entries),
        "retained_runs": len(retained),
        "redundant_runs": len(redundant_runs),
        "redundant_bytes": sum(entry.jsonl_bytes for entry in redundant_runs),
    }


def manifest_record(entry: RunEntry, source_root: Path) -> dict[str, Any]:
    if entry.verdict is None or not entry.jsonl_sha256:
        raise RuntimeError(f"unclassified Run: {entry.run_id}")
    metadata = entry.metadata
    keep = entry.verdict in ("unique_tail", "divergent_sibling")
    record: dict[str, Any] = {
        "schema_version": 1,
        "generator": {"path": GENERATOR_PATH, "sha256": GENERATOR_SHA256},
        "run_id": entry.run_id,
        "user_id": metadata.get("user_id"),
        "machine_id": metadata.get("machine_id"),
        "agent_runtime": metadata.get("agent_runtime"),
        "conversation_id": metadata.get("conversation_id"),
        "parent_run_id": metadata.get("parent_run_id"),
        "source_identity": entry.source_identity,
        "source_identity_basis": source_identity_basis(metadata, entry.run_id),
        "prefix_group_identity": entry.prefix_group_identity,
        "prefix_group_basis": {
            "agent_runtime": metadata.get("agent_runtime"),
            "conversation_id": metadata.get("conversation_id"),
            "parent_run_id": metadata.get("parent_run_id"),
        },
        "byte_range": {
            "from_offset": 0,
            "to_offset": entry.jsonl_bytes,
            "length": entry.jsonl_bytes,
            "basis": "stored_jsonl_body",
        },
        "jsonl_bytes": entry.jsonl_bytes,
        "jsonl_sha256": entry.jsonl_sha256,
        "verdict": entry.verdict,
        "keep": keep,
        "started_at": metadata.get("started_at"),
        "captured_at": metadata.get("captured_at"),
        "jsonl_path": str(entry.jsonl_path.relative_to(source_root)),
        "metadata_path": str(entry.metadata_path.relative_to(source_root)),
    }
    if entry.covering_run_id is not None:
        record["covering_run_id"] = entry.covering_run_id
        record["coverage_proof"] = {
            "method": "byte_equality" if entry.verdict == "exact_duplicate" else "byte_prefix",
            "covering_jsonl_bytes": entry.covering_jsonl_bytes,
            "covering_jsonl_sha256": entry.covering_jsonl_sha256,
        }
    return record


def write_manifest(entries: list[RunEntry], source_root: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        dir=output.parent, prefix=f".{output.name}.", suffix=".tmp"
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for entry in sorted(entries, key=lambda item: item.run_id):
                handle.write(json.dumps(manifest_record(entry, source_root), separators=(",", ":")))
                handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def run(source_root: Path, output: Path, progress_every: int) -> Summary:
    started = time.time()
    if not source_root.is_dir():
        raise FileNotFoundError(f"source root not found: {source_root}")
    if is_relative_to(output, source_root):
        raise ValueError("manifest output must not be inside the immutable source root")

    entries, metadata_count, jsonl_count = discover_entries(source_root)
    groups: dict[str, list[RunEntry]] = defaultdict(list)
    conversations: set[Any] = set()
    source_identities: set[str] = set()
    missing_conversation = 0
    for entry in entries:
        groups[entry.prefix_group_identity].append(entry)
        conversation_id = entry.metadata.get("conversation_id")
        if conversation_id is None:
            missing_conversation += 1
        else:
            conversations.add(conversation_id)
        source_identities.add(entry.source_identity)

    group_summaries: list[dict[str, Any]] = []
    classified = 0
    for group_entries in groups.values():
        group_summaries.append(classify_group(group_entries))
        classified += len(group_entries)
        if progress_every > 0 and classified % progress_every < len(group_entries):
            print(
                json.dumps(
                    {
                        "progress_runs": classified,
                        "total_runs": len(entries),
                        "elapsed_seconds": round(time.time() - started, 1),
                    },
                    separators=(",", ":"),
                ),
                file=sys.stderr,
            )

    write_manifest(entries, source_root, output)

    verdict_counts: Counter[str] = Counter(entry.verdict for entry in entries if entry.verdict)
    verdict_bytes: Counter[str] = Counter()
    for entry in entries:
        if entry.verdict:
            verdict_bytes[entry.verdict] += entry.jsonl_bytes
    keep_entries = [entry for entry in entries if entry.verdict in ("unique_tail", "divergent_sibling")]
    skip_entries = [entry for entry in entries if entry.verdict in ("exact_duplicate", "strict_prefix")]
    total_bytes = sum(entry.jsonl_bytes for entry in entries)
    skip_bytes = sum(entry.jsonl_bytes for entry in skip_entries)
    top_groups = sorted(
        (group for group in group_summaries if group["redundant_runs"] > 0),
        key=lambda group: (-group["redundant_bytes"], group["prefix_group_identity"]),
    )[:15]

    return Summary(
        source_root=str(source_root),
        manifest_path=str(output),
        started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
        run_count=len(entries),
        metadata_count=metadata_count,
        jsonl_count=jsonl_count,
        jsonl_bytes=total_bytes,
        unique_conversations=len(conversations),
        unique_source_identities=len(source_identities),
        missing_conversation_id_runs=missing_conversation,
        prefix_group_count=len(groups),
        multi_run_prefix_groups=sum(1 for entries_in_group in groups.values() if len(entries_in_group) > 1),
        verdict_counts=verdict_counts,
        verdict_bytes=verdict_bytes,
        keep_runs=len(keep_entries),
        keep_bytes=sum(entry.jsonl_bytes for entry in keep_entries),
        skip_runs=len(skip_entries),
        skip_bytes=skip_bytes,
        redundant_bytes_pct=round((skip_bytes / total_bytes * 100) if total_bytes else 0.0, 6),
        elapsed_seconds=round(time.time() - started, 3),
        top_redundant_groups=top_groups,
    )


def self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="run-manifest-test-") as directory:
        root = Path(directory) / "runs"
        output = Path(directory) / "analysis" / "manifest.jsonl"
        month = root / "joel" / "2026-07"
        month.mkdir(parents=True)
        fixtures = {
            "a": b"abc",
            "b": b"abcdef",
            "c": b"abcdef",
            "d": b"xyz",
        }
        for run_id, body in fixtures.items():
            (month / f"{run_id}.jsonl").write_bytes(body)
            metadata = {
                "run_id": run_id,
                "user_id": "joel",
                "machine_id": "test",
                "agent_runtime": "pi",
                "conversation_id": "conversation",
                "parent_run_id": None,
                "started_at": 1,
                "captured_at": 2,
            }
            (month / f"{run_id}.metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
        summary = run(root, output, 0)
        records = {
            record["run_id"]: record
            for record in (json.loads(line) for line in output.read_text().splitlines())
        }
        assert records["a"]["verdict"] == "strict_prefix"
        assert records["a"]["covering_run_id"] == "b"
        assert records["b"]["verdict"] == "divergent_sibling"
        assert records["c"]["verdict"] == "exact_duplicate"
        assert records["d"]["verdict"] == "divergent_sibling"
        assert records["a"]["coverage_proof"]["method"] == "byte_prefix"
        assert records["c"]["coverage_proof"]["method"] == "byte_equality"
        assert records["a"]["generator"]["sha256"] == GENERATOR_SHA256
        assert source_identity({"conversation_id": None}, "legacy-a") != source_identity(
            {"conversation_id": None}, "legacy-b"
        )
        assert summary.keep_runs == 2
        assert summary.skip_runs == 2
    print(json.dumps({"ok": True, "self_test": "passed"}))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=Path.home() / ".joelclaw" / "runs-dev",
        help="immutable Run store root",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path.home() / ".joelclaw" / "analysis" / "run-manifest-2026-07-19.jsonl",
        help="manifest JSONL path outside the Run store",
    )
    parser.add_argument("--summary-json", type=Path, help="optional machine-readable summary path")
    parser.add_argument("--progress-every", type=int, default=10_000)
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.self_test:
        self_test()
        return
    summary = run(args.source.expanduser(), args.output.expanduser(), args.progress_every)
    summary_json = summary.to_json()
    if args.summary_json:
        summary_path = args.summary_json.expanduser()
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(json.dumps(summary_json, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary_json, indent=2))


if __name__ == "__main__":
    main()
