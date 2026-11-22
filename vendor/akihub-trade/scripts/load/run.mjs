// AKIHUB Trade load runner. Node only (fetch/undici, no extra packages, nothing to install).
//
//   node scripts/load/run.mjs --profile read  [--base http://localhost:3681] [--vus 100] [--ramp 30] [--duration 60]
//   node scripts/load/run.mjs --profile write [--base http://localhost:3681] [--vus 10]  [--ramp 10] [--duration 60]
//   node scripts/load/run.mjs --profile live  [--base https://akihub-trade.akihub.workers.dev] [--vus 20] [--duration 60]
//
// Profiles:
//   read   - closed-loop virtual users (VUs) hammering the public read paths + two signed-in API reads
//            (seed profile via /dev/login, local servers only). Ramps linearly to --vus, then holds.
//   write  - realistic mixed traffic at low concurrency: "likes" (binder / wishlist adds), chat messages between
//            seed users, a few listings, plus the reads a chatting user makes. Server actions are replayed with
//            their real Next-Action ids, discovered from the production build (.next/static/chunks).
//            Rate-limited responses (Hebrew limit messages) are counted separately: they are the expected behaviour.
//   live   - gentle read-only smoke-load against the deployed worker: 20 VUs, 60s, think time, public pages only,
//            no sign-in, no writes. Stays far inside the Cloudflare free tier.
//
// Output: a table on stdout plus test-results/load/<profile>-<timestamp>.{json,md} with p50/p95/p99 per endpoint,
// error rate, throughput and a per-10s timeline (to see where latency starts climbing during the ramp).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

// ---------- args ----------
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "true" : all[i + 1]] : [])).filter((x) => x.length));
const profile = args.profile ?? "read";
const DEFAULTS = {
  read: { base: "http://localhost:3681", vus: 100, ramp: 30, duration: 60, think: 0 },
  write: { base: "http://localhost:3681", vus: 10, ramp: 10, duration: 60, think: 100 },
  live: { base: "https://akihub-trade.akihub.workers.dev", vus: 20, ramp: 10, duration: 60, think: 300 },
}[profile];
if (!DEFAULTS) {
  console.error(`unknown profile ${profile}`);
  process.exit(2);
}
const base = (args.base ?? DEFAULTS.base).replace(/\/$/, "");
const VUS = Number(args.vus ?? DEFAULTS.vus);
const RAMP_S = Number(args.ramp ?? DEFAULTS.ramp);
const DURATION_S = Number(args.duration ?? DEFAULTS.duration);
const THINK_MS = Number(args.think ?? DEFAULTS.think);
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base);
if (profile === "live" && isLocal) console.warn("live profile against a local base: fine, but the point of 'live' is the deployed worker");
if (profile !== "live" && !isLocal) {
  console.error(`refusing to run the ${profile} profile against a non-local base (${base}); heavy load stays local to protect free tiers`);
  process.exit(2);
}
if (profile === "live" && (VUS > 25 || DURATION_S > 90)) {
  console.error("live profile is capped at 25 VUs / 90s (read-only smoke-load). Run heavy load locally.");
  process.exit(2);
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
const r1 = (n) => Math.round(n * 10) / 10;

async function devLoginCookie(id) {
  const res = await fetch(`${base}/dev/login?as=${id}`, { redirect: "manual" });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error(`dev login as ${id} failed (${res.status}); the write/read profiles need a local seed-mode server`);
  return cookie;
}

/** Finds server-action ids by export name in the production client bundle (the browser does the same at runtime). */
function discoverActionIds(names) {
  const dir = join(process.cwd(), ".next", "static", "chunks");
  const found = {};
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  } catch {
    throw new Error("no .next/static/chunks: run `npm run build` first (the write profile replays this build's server actions)");
  }
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    for (const n of names) {
      if (found[n]) continue;
      const m = src.match(new RegExp(`createServerReference\\)\\("([0-9a-f]{20,})",[^)]{0,200}"${n}"`));
      if (m) found[n] = m[1];
    }
  }
  const missing = names.filter((n) => !found[n]);
  if (missing.length) throw new Error(`could not find server action ids for ${missing.join(", ")} in the build`);
  return found;
}

/** Builds the multipart body a form-driven server action receives (prevState {} + FormData). */
function actionBody(fields) {
  const boundary = `----akihubqa${Math.random().toString(36).slice(2)}`;
  const parts = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="_1_${k}"\r\n\r\n${v}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="0"\r\n\r\n[{},"$K1"]\r\n`);
  return { body: parts.join("") + `--${boundary}--\r\n`, contentType: `multipart/form-data; boundary=${boundary}` };
}

// ---------- scenarios ----------
/** Each scenario: { name, weight, run(vu) -> { status, ok, kind } }. kind: "ok" | "rate_limited" | "error". */
async function get(vu, path, { cookie, expect = [200] } = {}) {
  const t0 = performance.now();
  let status = 0;
  let bytes = 0;
  let err = null;
  let hdr = {};
  try {
    const res = await fetch(base + path, { headers: cookie ? { cookie } : {}, redirect: "follow" });
    status = res.status;
    hdr = res.headers;
    const buf = await res.arrayBuffer();
    bytes = buf.byteLength;
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  const ms = performance.now() - t0;
  return { ms, status, bytes, ok: !err && expect.includes(status), kind: !err && expect.includes(status) ? "ok" : "error", err, hdr };
}

async function action(vu, path, actionId, fields, cookie) {
  const { body, contentType } = actionBody(fields);
  const t0 = performance.now();
  let status = 0;
  let text = "";
  let err = null;
  let redirectHeader = null;
  try {
    const res = await fetch(base + path, { method: "POST", headers: { cookie, "next-action": actionId, "content-type": contentType, accept: "text/x-component", origin: base }, body, redirect: "manual" });
    status = res.status;
    // A server action that calls redirect() answers 200 with the target in x-action-redirect (no body to parse).
    redirectHeader = res.headers.get("x-action-redirect") ?? res.headers.get("location");
    text = await res.text();
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  const ms = performance.now() - t0;
  const redirected = !!redirectHeader || status === 303 || status === 302 || /x-action-redirect|"redirect"/i.test(text);
  const okState = /"ok":true/.test(text);
  const errMsg = text.match(/"error":"((?:[^"\\]|\\.)*)"/)?.[1] ?? "";
  const limited = /מהר מדי|ביממה|בשעה האחרונה|חשבון חדש/.test(decodeURIComponent(JSON.parse(`"${errMsg}"`)));
  let kind = "error";
  if (!err && status < 400 && (okState || redirected)) kind = "ok";
  else if (!err && status < 400 && limited) kind = "rate_limited";
  return { ms, status, bytes: text.length, ok: kind !== "error", kind, err: err ?? (kind === "error" ? (errMsg || `status ${status}`).slice(0, 120) : null) };
}

const SEED_CARDS = ["pokemon:base1-4", "pokemon:base1-58", "pokemon:sv03-125", "pokemon:sv03-223", "pokemon:sv04pt5-54", "pokemon:swsh45-SV107", "onepiece:OP01-001", "onepiece:OP01-120", "onepiece:OP05-119", "onepiece:OP02-120"];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function buildScenarios() {
  const publicReads = [
    { name: "GET /", weight: 20, run: (vu) => get(vu, "/") },
    { name: "GET /cards", weight: 12, run: (vu) => get(vu, "/cards") },
    { name: "GET /cards?q=charizard", weight: 8, run: (vu) => get(vu, "/cards?q=charizard") },
    { name: "GET /cards?game=onepiece", weight: 5, run: (vu) => get(vu, "/cards?game=onepiece") },
    { name: "GET /cards/[id]", weight: 8, run: (vu) => get(vu, `/cards/${encodeURIComponent(pick(SEED_CARDS))}`) },
    { name: "GET /listings", weight: 15, run: (vu) => get(vu, "/listings") },
    { name: "GET /listings?filters", weight: 5, run: (vu) => get(vu, `/listings?game=pokemon&region=${encodeURIComponent("מרכז")}&max=5000`) },
    { name: "GET /listings/[id]", weight: 12, run: (vu) => get(vu, `/listings/${pick(["l_1", "l_2", "l_3", "l_4", "l_5", "l_6"])}`) },
    { name: "GET /u/[nickname]", weight: 6, run: (vu) => get(vu, `/u/${pick(["alon_graded", "yoav_collects", "noa_op"])}`) },
    { name: "GET /terms", weight: 2, run: (vu) => get(vu, "/terms") },
    // 401 when signed out; 404 is accepted on the live worker while it still runs a build from before this route existed.
    { name: "GET /api/realtime/token (signed out -> 401)", weight: 2, run: (vu) => get(vu, "/api/realtime/token", { expect: profile === "live" ? [401, 404] : [401] }) },
  ];
  if (profile === "live") return publicReads;

  const yoav = await devLoginCookie("p_yoav");
  if (profile === "read") {
    return publicReads.concat([
      { name: "GET /api/notifications/unread (yoav)", weight: 3, run: (vu) => get(vu, "/api/notifications/unread", { cookie: yoav }) },
      { name: "GET /api/chat/t_1/messages (yoav)", weight: 2, run: (vu) => get(vu, "/api/chat/t_1/messages?after=", { cookie: yoav }) },
      { name: "GET /offers (yoav)", weight: 2, run: (vu) => get(vu, "/offers", { cookie: yoav }) },
    ]);
  }

  // write profile
  const ids = discoverActionIds(["sendMessageAction", "addToCollectionAction", "addToWishlistAction", "createListingAction"]);
  const alon = await devLoginCookie("p_alon");
  const noa = await devLoginCookie("p_noa");
  const chatters = [
    { cookie: yoav, thread: "t_1" },
    { cookie: alon, thread: "t_1" },
  ];
  const likers = [yoav, alon, noa];
  const chatPath = (t) => `/chat/${t}`;
  return [
    { name: "POST like: addToCollectionAction", weight: 35, run: (vu) => { const c = pick(SEED_CARDS); return action(vu, `/cards/${encodeURIComponent(c)}`, ids.addToCollectionAction, { cardId: c, condition: pick(["NM", "LP", "MP"]), visibility: pick(["trade", "sale", "private"]) }, pick(likers)); } },
    { name: "POST want: addToWishlistAction", weight: 15, run: (vu) => { const c = pick(SEED_CARDS); return action(vu, `/cards/${encodeURIComponent(c)}`, ids.addToWishlistAction, { cardId: c, minCondition: "LP", maxPriceIls: String(50 + Math.floor(Math.random() * 500)) }, pick(likers)); } },
    { name: "POST chat: sendMessageAction", weight: 20, run: (vu) => { const u = pick(chatters); return action(vu, chatPath(u.thread), ids.sendMessageAction, { threadId: u.thread, body: `qa_load ${vu} ${Date.now().toString(36)} בדיקת עומס` }, u.cookie); } },
    { name: "POST listing: createListingAction", weight: 3, run: (vu) => action(vu, "/listings/new", ids.createListingAction, { cardId: pick(SEED_CARDS), title: `qa_load listing ${vu} ${Date.now().toString(36)}`, priceIls: String(10 + Math.floor(Math.random() * 900)), openToOffers: "on", delivery: "meetup", region: "מרכז", condition: "NM", language: "en" }, pick(likers)) },
    { name: "GET /chat/t_1 (page, as a chatter)", weight: 8, run: (vu) => get(vu, chatPath("t_1"), { cookie: pick(chatters).cookie }) },
    { name: "GET /api/chat/t_1/messages (poll)", weight: 10, run: (vu) => get(vu, "/api/chat/t_1/messages?after=" + encodeURIComponent(new Date(Date.now() - 5000).toISOString()), { cookie: pick(chatters).cookie }) },
    { name: "GET /api/notifications/unread (poll)", weight: 6, run: (vu) => get(vu, "/api/notifications/unread", { cookie: pick(likers) }) },
    { name: "GET /u/[nickname] (binder grows)", weight: 3, run: (vu) => get(vu, `/u/${pick(["alon_graded", "yoav_collects", "noa_op"])}`) },
  ];
}

// ---------- engine ----------
const scenarios = await buildScenarios();
const totalWeight = scenarios.reduce((s, x) => s + x.weight, 0);
const pickScenario = () => {
  let r = Math.random() * totalWeight;
  for (const s of scenarios) if ((r -= s.weight) < 0) return s;
  return scenarios[scenarios.length - 1];
};

const samples = []; // { t, name, ms, status, kind, bytes, err }
const start = performance.now();
const endAt = start + (RAMP_S + DURATION_S) * 1000;
let active = 0;
let maxActive = 0;

async function vu(i) {
  await sleep((i / VUS) * RAMP_S * 1000); // linear ramp
  active++;
  maxActive = Math.max(maxActive, active);
  while (performance.now() < endAt) {
    const s = pickScenario();
    const r = await s.run(i);
    samples.push({ t: performance.now() - start, name: s.name, ms: r.ms, status: r.status, kind: r.kind, bytes: r.bytes, err: r.err ?? null, hdr: r.hdr });
    if (THINK_MS) await sleep(THINK_MS * (0.5 + Math.random()));
  }
  active--;
}

console.log(`\nAKIHUB load: profile=${profile} base=${base} vus=${VUS} ramp=${RAMP_S}s hold=${DURATION_S}s think=${THINK_MS}ms scenarios=${scenarios.length}`);
const ticker = setInterval(() => {
  const now = performance.now() - start;
  const recent = samples.filter((s) => s.t > now - 5000);
  const lat = recent.map((s) => s.ms).sort((a, b) => a - b);
  const errs = recent.filter((s) => s.kind === "error").length;
  process.stdout.write(`  t=${String(Math.round(now / 1000)).padStart(4)}s active=${String(active).padStart(3)} rps=${String(r1(recent.length / 5)).padStart(6)} p50=${String(Math.round(pct(lat, 50))).padStart(5)}ms p95=${String(Math.round(pct(lat, 95))).padStart(5)}ms err=${errs}\n`);
}, 5000);
await Promise.all(Array.from({ length: VUS }, (_, i) => vu(i)));
clearInterval(ticker);
const wall = (performance.now() - start) / 1000;

// ---------- report ----------
function summarize(list) {
  const lat = list.map((s) => s.ms).sort((a, b) => a - b);
  const errors = list.filter((s) => s.kind === "error");
  const limited = list.filter((s) => s.kind === "rate_limited");
  const statuses = {};
  for (const s of list) statuses[s.status || "net"] = (statuses[s.status || "net"] ?? 0) + 1;
  return {
    requests: list.length,
    ok: list.length - errors.length - limited.length,
    rateLimited: limited.length,
    errors: errors.length,
    errorRate: list.length ? r1((errors.length / list.length) * 100) : 0,
    p50: Math.round(pct(lat, 50)),
    p95: Math.round(pct(lat, 95)),
    p99: Math.round(pct(lat, 99)),
    max: Math.round(lat.at(-1) ?? 0),
    mean: Math.round(lat.reduce((a, b) => a + b, 0) / (lat.length || 1)),
    bytes: list.reduce((a, b) => a + (b.bytes || 0), 0),
    statuses,
    sampleErrors: [...new Set(errors.map((e) => `${e.status || "net"} ${e.err ?? ""}`.trim()))].slice(0, 5),
  };
}
const overall = summarize(samples);
const holdOnly = summarize(samples.filter((s) => s.t >= RAMP_S * 1000));
const perEndpoint = Object.fromEntries(scenarios.map((s) => [s.name, summarize(samples.filter((x) => x.name === s.name))]));
const timeline = [];
for (let t = 0; t < (RAMP_S + DURATION_S) * 1000; t += 10_000) {
  const slice = samples.filter((s) => s.t >= t && s.t < t + 10_000);
  const sum = summarize(slice);
  timeline.push({ fromS: t / 1000, toS: t / 1000 + 10, rps: r1(slice.length / 10), p50: sum.p50, p95: sum.p95, p99: sum.p99, errors: sum.errors, vus: Math.min(VUS, Math.ceil(((t + 10_000) / 1000 / RAMP_S) * VUS)) });
}
const edge = profile === "live" ? { cfRay: samples.some((s) => s.hdr?.get?.("cf-ray")), cacheStatuses: [...new Set(samples.map((s) => s.hdr?.get?.("cf-cache-status")).filter(Boolean))] } : undefined;
const result = { profile, base, vus: VUS, maxActive, rampS: RAMP_S, holdS: DURATION_S, thinkMs: THINK_MS, wallS: r1(wall), throughputRps: r1(samples.length / wall), holdThroughputRps: r1(holdOnly.requests / DURATION_S), overall, hold: holdOnly, perEndpoint, timeline, edge, startedAt: new Date().toISOString() };

const outDir = join(process.cwd(), "test-results", "load");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const jsonPath = join(outDir, `${profile}-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify({ ...result, samples: undefined }, null, 2));

const row = (name, s) => `| ${name} | ${s.requests} | ${s.p50} | ${s.p95} | ${s.p99} | ${s.max} | ${s.errors} (${s.errorRate}%) | ${s.rateLimited} |`;
const md = [
  `# Load test: ${profile}`,
  ``,
  `- Base: ${base}`,
  `- VUs: ${VUS} (peak active ${maxActive}), ramp ${RAMP_S}s, hold ${DURATION_S}s, think ${THINK_MS}ms, wall ${r1(wall)}s`,
  `- Requests: ${overall.requests} (${result.throughputRps} req/s overall, ${result.holdThroughputRps} req/s during the hold)`,
  `- Errors: ${overall.errors} (${overall.errorRate}%), rate-limited (expected): ${overall.rateLimited}`,
  `- Latency overall: p50 ${overall.p50}ms, p95 ${overall.p95}ms, p99 ${overall.p99}ms, max ${overall.max}ms`,
  `- Latency during the hold (${VUS} VUs): p50 ${holdOnly.p50}ms, p95 ${holdOnly.p95}ms, p99 ${holdOnly.p99}ms`,
  `- Status codes: ${JSON.stringify(overall.statuses)}`,
  edge ? `- Edge: cf-ray ${edge.cfRay ? "present" : "absent"}, cf-cache-status ${edge.cacheStatuses.join("/") || "none"}` : "",
  overall.sampleErrors.length ? `- Error samples: ${overall.sampleErrors.join(" | ")}` : "",
  ``,
  `| endpoint | req | p50 | p95 | p99 | max | errors | rate-limited |`,
  `|---|---|---|---|---|---|---|---|`,
  ...Object.entries(perEndpoint).map(([n, s]) => row(n, s)),
  ``,
  `| window | VUs | req/s | p50 | p95 | p99 | errors |`,
  `|---|---|---|---|---|---|---|`,
  ...timeline.map((t) => `| ${t.fromS}-${t.toS}s | ${t.vus} | ${t.rps} | ${t.p50} | ${t.p95} | ${t.p99} | ${t.errors} |`),
  ``,
].filter((l) => l !== undefined).join("\n");
const mdPath = join(outDir, `${profile}-${stamp}.md`);
writeFileSync(mdPath, md);

console.log(`\n${md}`);
console.log(`saved: ${jsonPath}\n       ${mdPath}`);
// Exit code: 1 when the error rate is above 1% (rate-limited responses are not errors).
process.exit(overall.errorRate > 1 ? 1 : 0);
