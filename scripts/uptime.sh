#!/usr/bin/env bash
# Smoke check: every URL must answer with one of its expected status codes (no redirects followed).
# Prints a markdown table; exit 1 if any check fails. Curl only, no secrets.
set -uo pipefail
BASE="${BASE_URL:-https://akihub-trade.akihub.workers.dev}"
# path|expected codes (comma separated). /auth/login is 303 while the stub login build is live, 302 once Shopify login is on.
CHECKS=(
  "/|200"
  "/cards|200"
  "/listings|200"
  "/auth/login|302,303"
  "/dev/login|404"
)
[ "${FORCE_FAIL:-false}" = "true" ] && CHECKS+=("/__monitor_forced_test__|200")
fail=0
echo "| path | got | expected | ms |"
echo "|---|---|---|---|"
for c in "${CHECKS[@]}"; do
  path="${c%%|*}"; want="${c#*|}"
  out="$(curl -s -o /dev/null -A akihub-trade-monitor --max-time 20 -w '%{http_code} %{time_total}' "$BASE$path" || echo "000 0")"
  code="${out%% *}"; ms="$(awk -v t="${out#* }" 'BEGIN{printf "%d", t*1000}')"
  ok="❌"; [[ ",$want," == *",$code,"* ]] && ok="✅" || fail=1
  echo "| $ok \`$path\` | $code | $want | $ms |"
done
exit $fail
