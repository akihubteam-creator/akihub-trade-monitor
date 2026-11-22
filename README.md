# akihub-trade-monitor

Free, script-only monitoring for **AKIHUB Trade** (https://akihub-trade.akihub.workers.dev). AKIHUB only.
No AI tokens, no secrets, no money. It never deploys, writes or signs in anywhere; it only reads public pages.

| Workflow | Schedule (UTC) | Israel time (winter / summer) | What |
|---|---|---|---|
| `uptime.yml` | `7,37 * * * *` | every 30 min | curl: `/` 200, `/cards` 200, `/listings` 200, `/auth/login` 302/303, `/dev/login` 404. Re-checks at +5/+10/+15 min; alerts only if all fail (15+ min down). |
| `daily-qa.yml` | `30 4 * * *` | 06:30 / 07:30 | `qa:live` (read-only live checks). One retry after 10 min; alerts if both fail. |
| `weekly-load.yml` | `15 1 * * 1` | Mon 03:15 / 04:15 | `qa:load:live` (20 VUs, 60 s, public pages). One retry after 10 min. Also re-enables the schedules (GitHub disables them after 60 quiet days in public repos). |

GitHub may start scheduled runs late (minutes, sometimes more).

## Alerts

A failing check opens **one** issue titled `ALERT: <what>` (label `alert`). While it stays open, further failures
add comments instead of new issues. When the check passes again the workflow comments `✅ Recovered` and closes it.
GitHub emails the repo owner (akihubteam-creator) about new issues and comments, and about failed scheduled runs.

Test the path: Actions -> any workflow -> Run workflow -> `force_fail` = true. It opens an issue labeled `test`
(`ALERT: TEST ...`) and the run stays green. Close the test issue afterwards.

## Not covered (needs a secret, so left out on purpose)

- That the 03:30 UTC daily maintenance cron and the Sunday catalog sync actually ran: the only records are in
  Cloudflare Worker logs and the server-only `catalog_sync_state` table. Checking them needs a Cloudflare API
  token or the Supabase service key. A free option without secrets would be a small public read-only status
  endpoint in akihub-trade (e.g. last maintenance / last sync time) - a code change for the akihub-trade owner.
