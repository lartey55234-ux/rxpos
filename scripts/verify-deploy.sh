#!/usr/bin/env bash
# Check a running rxpos instance from the outside. Usage: scripts/verify-deploy.sh <url>
set -euo pipefail

BASE="${1:?usage: verify-deploy.sh <url>}"
BASE="${BASE%/}"
EMAIL="verify$(date +%s)@example.com"
pass() { printf '  ok  %s\n' "$1"; }

echo "checking $BASE"

curl -fsS --max-time 15 "$BASE/healthz" | grep -q '"status":"ok"'
pass "health check"

curl -fsS --max-time 15 -o /dev/null -D /tmp/rxpos-headers "$BASE/"
grep -qi "content-security-policy" /tmp/rxpos-headers
grep -qi "x-content-type-options" /tmp/rxpos-headers
pass "counter page served with its security headers"

TOKEN=$(curl -fsS --max-time 15 -X POST "$BASE/api/signup" \
  -H 'content-type: application/json' \
  -d "{\"pharmacyName\":\"Verify Pharmacy\",\"ownerName\":\"Verify Owner\",\"email\":\"$EMAIL\",\"password\":\"verifypassword\"}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))')
[ -n "$TOKEN" ]
pass "a pharmacy can register"

CODE=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' -X POST "$BASE/api/signup" \
  -H 'content-type: application/json' \
  -d "{\"pharmacyName\":\"Verify Pharmacy\",\"ownerName\":\"Verify Owner\",\"email\":\"$EMAIL\",\"password\":\"verifypassword\"}")
[ "$CODE" = "409" ]
pass "a duplicate registration is refused with 409"

curl -fsS --max-time 15 "$BASE/api/session" -H "authorization: Bearer $TOKEN" | grep -q "Verify Pharmacy"
pass "the new session works"

echo "all checks passed"
