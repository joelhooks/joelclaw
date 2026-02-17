#!/usr/bin/env python3
"""Embed text via all-mpnet-base-v2 (768-dim). Reads JSON lines from stdin, writes JSON array to stdout.

Input (one JSON per line):  {"id": "...", "text": "..."}
Output (JSON array):        [{"id": "...", "vector": [0.1, ...]}]

Or single text via --text flag:
  embed.py --text "some text"
  Output: [0.1, 0.2, ...]
"""
import sys
import json
import argparse

from sentence_transformers import SentenceTransformer

# Suppress the "loading from different task" note
import logging
logging.getLogger("sentence_transformers").setLevel(logging.ERROR)

model = SentenceTransformer("all-mpnet-base-v2")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", type=str, help="Single text to embed")
    args = parser.parse_args()

    if args.text:
        vec = model.encode(args.text).tolist()
        json.dump(vec, sys.stdout)
        sys.stdout.write("\n")
        return

    # Batch mode: JSON lines from stdin
    items = []
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        items.append(json.loads(line))

    if not items:
        json.dump([], sys.stdout)
        sys.stdout.write("\n")
        return

    texts = [item["text"] for item in items]
    vectors = model.encode(texts).tolist()

    results = []
    for item, vec in zip(items, vectors):
        results.append({"id": item["id"], "vector": vec})

    json.dump(results, sys.stdout)
    sys.stdout.write("\n")

if __name__ == "__main__":
    main()
