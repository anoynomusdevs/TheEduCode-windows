#!/usr/bin/env bash
# ByteHide JavaScript Obfuscator - Cloud API
# Directly calls https://node.shield.bytehide.com/obfuscate
#
# Usage: 
#   obfuscate-bytehide.sh "code here"
#   echo "code" | obfuscate-bytehide.sh

set -euo pipefail

API_URL="https://node.shield.bytehide.com/obfuscate"

# Read code from arg or stdin
if [[ $# -gt 0 ]]; then
    CODE="$1"
else
    CODE=$(cat)
fi

if [[ -z "${CODE// }" ]]; then
    echo "Error: No code provided" >&2
    echo "Usage: $0 \"code here\"" >&2
    exit 1
fi

curl -s -X POST "$API_URL" \
  -H 'accept: */*' \
  -H 'content-type: application/json' \
  -H 'origin: https://bytehide.com' \
  -H 'referer: https://bytehide.com/' \
  -H 'user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' \
  -d "{\"code\":$(jq -Rs . <<<"$CODE")}" \
  | jq -r '.output'