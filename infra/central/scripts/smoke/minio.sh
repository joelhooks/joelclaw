#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_smoke_command curl
require_smoke_command python3
require_secret_env MINIO_ROOT_USER
require_secret_env MINIO_ROOT_PASSWORD

endpoint="http://${CENTRAL_BIND_ADDR}:9000"
bucket="$(smoke_id | tr '[:upper:]' '[:lower:]' | tr '_' '-')-minio"
object="smoke.txt"
body="minio-ok-${RANDOM}"
export MINIO_SMOKE_ENDPOINT="$endpoint"
export MINIO_SMOKE_BUCKET="$bucket"
export MINIO_SMOKE_OBJECT="$object"
export MINIO_SMOKE_BODY="$body"

smoke_log "checking MinIO readiness"
http_ok "${endpoint}/minio/health/ready"

smoke_log "creating temp bucket/object through S3 API"
python3 - <<'PY'
import datetime
import hashlib
import hmac
import os
import sys
import urllib.error
import urllib.request

access_key = os.environ["MINIO_ROOT_USER"]
secret_key = os.environ["MINIO_ROOT_PASSWORD"]
endpoint = os.environ["MINIO_SMOKE_ENDPOINT"].rstrip("/")
bucket = os.environ["MINIO_SMOKE_BUCKET"]
obj = os.environ["MINIO_SMOKE_OBJECT"]
body = os.environ["MINIO_SMOKE_BODY"].encode()
region = "us-east-1"
service = "s3"


def sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def signing_key(date_stamp: str) -> bytes:
    k_date = sign(("AWS4" + secret_key).encode(), date_stamp)
    k_region = sign(k_date, region)
    k_service = sign(k_region, service)
    return sign(k_service, "aws4_request")


def request(method: str, path: str, payload: bytes = b"", expected=(200, 204)) -> bytes:
    now = datetime.datetime.utcnow()
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(payload).hexdigest()
    host = endpoint.split("://", 1)[1]
    canonical_headers = f"host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical_request = "\n".join([
        method,
        path,
        "",
        canonical_headers,
        signed_headers,
        payload_hash,
    ])
    credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256",
        amz_date,
        credential_scope,
        hashlib.sha256(canonical_request.encode()).hexdigest(),
    ])
    signature = hmac.new(signing_key(date_stamp), string_to_sign.encode(), hashlib.sha256).hexdigest()
    auth = (
        "AWS4-HMAC-SHA256 "
        f"Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, "
        f"Signature={signature}"
    )
    req = urllib.request.Request(
        endpoint + path,
        data=payload if method in {"PUT", "POST"} else None,
        method=method,
        headers={
            "Authorization": auth,
            "x-amz-date": amz_date,
            "x-amz-content-sha256": payload_hash,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            if response.status not in expected:
                raise RuntimeError(f"unexpected status {response.status} for {method} {path}")
            return response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"S3 {method} {path} failed: {error.code} {detail}") from error

try:
    request("PUT", f"/{bucket}", expected=(200,))
    request("PUT", f"/{bucket}/{obj}", payload=body, expected=(200,))
    fetched = request("GET", f"/{bucket}/{obj}", expected=(200,))
    if fetched != body:
        raise RuntimeError("fetched object body did not match")
finally:
    try:
        request("DELETE", f"/{bucket}/{obj}", expected=(204,))
    except Exception:
        pass
    try:
        request("DELETE", f"/{bucket}", expected=(204,))
    except Exception:
        pass
PY

smoke_log "ok minio temp bucket/object write/read/delete"
