#!/usr/bin/env bash
# Smoke check: every URL must answer with one of its expected status codes (no redirects followed).
# Prints a markdown table; exit 1 if any check fails. Curl only, no secrets.
set -uo pipefail
BASE="${BASE_URL:-https://akihub-trade.akihub.workers.dev}"
# path|expected codes (comma separated). /auth/login must leave for Shopify (302); a redirect to
# /login?error=... (303) means the Shopify login is broken and counts as a failure.
CHECKS=(
  "/|200"
  "/cards|200"
  "/listings|200"
  "/auth/login|302"
  "/dev/login|404"
)
[ "${FORCE_FAIL:-false}" = "true" ] && CHECKS+=("/__monitor_forced_test__|200")
fail=0
echo "| path | got | expected | ms | redirect |"
echo "|---|---|---|---|---|"
for c in "${CHECKS[@]}"; do
  path="${c%%|*}"; want="${c#*|}"
  out="$(curl -s -o /dev/null -A akihub-trade-monitor --max-time 20 -w '%{http_code} %{time_total} %{redirect_url}' "$BASE$path" || echo "000 0 ")"
  code="$(echo "$out" | cut -d' ' -f1)"; t="$(echo "$out" | cut -d' ' -f2)"; loc="$(echo "$out" | cut -d' ' -f3- | cut -c1-60)"
  ms="$(awk -v t="$t" 'BEGIN{printf "%d", t*1000}')"
  ok="❌"
  if [[ ",$want," == *",$code,"* ]] && [[ "$loc" != *"error="* ]]; then ok="✅"; else fail=1; fi
  echo "| $ok \`$path\` | $code | $want | $ms | ${loc:--} |"
done
exit $fail
