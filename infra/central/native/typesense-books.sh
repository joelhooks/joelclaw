#!/bin/sh
set -eu

CONFIG="${TYPESENSE_BOOKS_CONFIG:-${HOME}/.config/joelclaw/typesense-books.ini}"
BINARY="${TYPESENSE_BOOKS_BINARY:-/opt/homebrew/opt/typesense-server@30.2/bin/typesense-server}"

if [ ! -x "${BINARY}" ]; then
  printf 'Typesense binary is missing: %s\n' "${BINARY}" >&2
  exit 1
fi
if [ ! -r "${CONFIG}" ]; then
  printf 'Typesense books config is missing: %s\n' "${CONFIG}" >&2
  exit 1
fi

exec "${BINARY}" --config="${CONFIG}"
