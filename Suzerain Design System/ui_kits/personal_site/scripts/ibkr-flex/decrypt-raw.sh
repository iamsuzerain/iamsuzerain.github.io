#!/usr/bin/env bash
# Decrypt archived Flex statements back to gzipped XML.
#
# The archive is stored encrypted because the repo is public, which makes it
# write-only without this. Anything that reads the archive -- a warehouse
# ingest, a one-off query, a schema check against an old statement -- comes
# through here.
#
#   export IBKR_FLEX_ARCHIVE_KEY='...'
#   export WAREHOUSE_DIR=/path/to/warehouse/flex-raw
#   ./decrypt-raw.sh OUT_DIR [FILE...]
#
# The archive lives in the private iamsuzerain/warehouse repo, not here:
#
#   git clone git@github.com:iamsuzerain/warehouse.git
#
# With no FILE arguments, decrypts everything under WAREHOUSE_DIR. OUT_DIR
# should be outside both repos -- the site repo's .gitignore refuses plaintext
# and so does the warehouse's, but a directory nobody can accidentally publish
# beats a rule that says no.
#
# Read back with: zcat OUT_DIR/flex-<qid>-<date>.xml.gz
set -euo pipefail

if [ -z "${IBKR_FLEX_ARCHIVE_KEY:-}" ]; then
  echo "IBKR_FLEX_ARCHIVE_KEY is not set" >&2
  exit 2
fi
if [ $# -lt 1 ]; then
  sed -n '2,17p' "$0" >&2
  exit 2
fi

out_dir="$1"; shift
mkdir -p "$out_dir"

if [ $# -gt 0 ]; then
  files=("$@")
else
  if [ -z "${WAREHOUSE_DIR:-}" ]; then
    echo "set WAREHOUSE_DIR to the warehouse checkout's flex-raw/ directory," >&2
    echo "or pass specific .enc files as arguments." >&2
    exit 2
  fi
  # Nothing matched is not an error worth a shell trace -- report it plainly.
  shopt -s nullglob
  files=("$WAREHOUSE_DIR"/*.xml.gz.enc)
  shopt -u nullglob
fi

if [ ${#files[@]} -eq 0 ]; then
  echo "no archived statements found (looked in ${WAREHOUSE_DIR:-<args>})" >&2
  exit 1
fi

n=0
for f in "${files[@]}"; do
  base="$(basename "$f" .enc)"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in "$f" -out "$out_dir/$base" -pass env:IBKR_FLEX_ARCHIVE_KEY
  # gzip integrity doubles as a decryption check: a wrong key yields garbage
  # that openssl may or may not reject, but that gzip certainly will.
  gzip -t "$out_dir/$base"
  n=$((n + 1))
  echo "$out_dir/$base"
done
echo "decrypted $n statement(s)" >&2
