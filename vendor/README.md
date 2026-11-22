`vendor/akihub-trade/` holds unmodified copies of two dependency-free scripts from the private repo
akihubteam-creator/akihub-trade at commit 6ee0b66 (the commit deployed on 22.11.2026, Worker 9f376889):

- `scripts/qa/live-check.mjs` = `npm run qa:live`
- `scripts/load/run.mjs` = `npm run qa:load:live` (run with `--profile live`)

They are copied so this repo needs no token to read the private repo. Refresh them when akihub-trade changes them:
`git -C <akihub-trade> archive -o v.tar origin/main scripts/qa/live-check.mjs scripts/load/run.mjs` and extract here.
