#!/usr/bin/env bash
# One open issue per alert title. Usage:
#   scripts/alert.sh open    "<title>" <body-file> [extra-label]
#   scripts/alert.sh recover "<title>" "<message>"
# Uses the workflow's GITHUB_TOKEN through gh (GH_TOKEN env). No other credentials.
set -euo pipefail
action="$1"; title="$2"
find_open() {
  gh issue list --repo "$GITHUB_REPOSITORY" --state open --label alert --limit 100 --json number,title \
    --jq ".[] | select(.title == \"$title\") | .number" | head -n1
}
num="$(find_open || true)"
case "$action" in
  open)
    body_file="$3"; extra="${4:-}"
    labels="alert"; [ -n "$extra" ] && labels="alert,$extra"
    if [ -n "$num" ]; then
      gh issue comment "$num" --repo "$GITHUB_REPOSITORY" --body-file "$body_file"
      echo "Alert still open: #$num (commented)"
    else
      gh issue create --repo "$GITHUB_REPOSITORY" --title "$title" --label "$labels" --body-file "$body_file"
    fi ;;
  recover)
    msg="$3"
    if [ -n "$num" ]; then
      gh issue comment "$num" --repo "$GITHUB_REPOSITORY" --body "✅ Recovered: $msg"
      gh issue close "$num" --repo "$GITHUB_REPOSITORY" --reason completed
      echo "Closed #$num"
    else
      echo "No open alert titled '$title'"
    fi ;;
  *) echo "unknown action $action" >&2; exit 2 ;;
esac
