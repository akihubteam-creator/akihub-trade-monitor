// Read-only checks against the deployed worker. Nothing is signed in, nothing is written, no secrets are needed.
//   node scripts/qa/live-check.mjs [https://akihub-trade.akihub.workers.dev]
// Verifies: public pages answer with the right markers, security headers, the Shopify login entry point
// redirects to Shopify (or, while the worker still runs a stub-mode build, is reported as such), the dev login
// hands out no session, private APIs are 401, unknown routes are a Hebrew 404, and that the edge is Cloudflare.
// Exit code 1 on any FAIL. Findings are printed and saved to test-results/qa/live-check.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const base = (process.argv[2] ?? process.env.LIVE_BASE_URL ?? "https://akihub-trade.akihub.workers.dev").replace(/\/$/, "");
if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(base)) {
  console.error("live-check is for the deployed worker; local builds are covered by the Playwright suite");
  process.exit(2);
}

const results = [];
function record(name, ok, detail = "", level = "fail") {
  results.push({ name, ok, detail, level: ok ? "ok" : level });
  console.log(`${ok ? "OK  " : level === "warn" ? "WARN" : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}

async function get(path, opts = {}) {
  const t0 = performance.now();
  const res = await fetch(base + path, { redirect: "manual", headers: { "user-agent": "akihub-qa-live-check" }, ...opts });
  const text = await res.text();
  return { res, text, ms: Math.round(performance.now() - t0) };
}

// 1. Public pages: status + content markers (Hebrew RTL document, key headings, seed-or-live content).
const pages = [
  ["/", 200, ['dir="rtl"', "AKIHUB"]],
  ["/cards", 200, ["קטלוג"]],
  ["/listings", 200, ["מודעות"]],
  ["/login", 200, ["כניסה"]],
  ["/terms", 200, ["AKIHUB אינה צד"]],
  ["/privacy", 200, ["פרטיות"]],
  ["/accessibility", 200, ["5568"]],
  ["/does-not-exist", 404, ["404"]],
];
const timings = [];
for (const [path, status, markers] of pages) {
  const { res, text, ms } = await get(path);
  timings.push({ path, ms, status: res.status });
  const missing = markers.filter((m) => !text.includes(m));
  record(`GET ${path} -> ${status}`, res.status === status && missing.length === 0, `${res.status}, ${ms}ms${missing.length ? `, missing ${missing.join("/")}` : ""}`);
}

// 2. Auth-gated pages redirect to /login; private APIs are 401 JSON with no-store.
for (const path of ["/listings/new", "/offers", "/chat", "/notifications", "/settings", "/admin"]) {
  const { res } = await get(path);
  const loc = res.headers.get("location") ?? "";
  record(`signed out ${path} redirects to /login`, [302, 303, 307, 308].includes(res.status) && /\/login/.test(loc), `${res.status} ${loc}`);
}
for (const path of ["/api/realtime/token", "/api/notifications/unread", "/api/chat/t_1/messages?after="]) {
  const { res, text } = await get(path);
  const ok = res.status === 401 && /no-store/.test(res.headers.get("cache-control") ?? "") && /unauthorized/.test(text);
  // An older build without these routes answers 404, which is also "not reachable".
  record(`signed out ${path} is 401 no-store`, ok || res.status === 404, `${res.status}`, "warn");
}

// 3. Dev login must hand out no session on the public host (seed-mode builds included).
{
  const { res } = await get("/dev/login?as=p_yoav");
  const cookie = res.headers.get("set-cookie") ?? "";
  record("/dev/login hands out no session", res.status === 404 && !/akihub_trade_session/.test(cookie), `${res.status}${cookie ? ", set-cookie present" : ""}`);
}

// 4. Shopify login entry point: must leave for the store's authorize endpoint (AUTH_PROVIDER=shopify).
{
  const { res } = await get("/auth/login");
  const loc = res.headers.get("location") ?? "";
  const toShopify = res.status === 302 && /shopify|akihub\.co\.il|account/.test(loc) && /\/authorize|oauth/.test(loc);
  const stubFallback = res.status === 303 && /\/login$/.test(loc);
  record("/auth/login redirects to the Shopify authorize URL", toShopify, stubFallback ? "stub-mode build is live (303 -> /login)" : `${res.status} ${loc.slice(0, 80) || "(no location)"}`, stubFallback || res.status === 404 ? "warn" : "fail");
  const cb = await get("/auth/callback?code=x&state=y");
  record("/auth/callback with a bogus state never creates a session", ![200].includes(cb.res.status) && !/akihub_trade_session=[^;]{10,}/.test(cb.res.headers.get("set-cookie") ?? ""), `${cb.res.status}`);
}

// 5. Response headers on the home page.
{
  const { res } = await get("/");
  const h = (k) => res.headers.get(k) ?? "";
  record("edge: served by Cloudflare (cf-ray)", !!h("cf-ray"), h("cf-ray").slice(0, 8));
  record("no x-powered-by", !h("x-powered-by"));
  record("x-content-type-options: nosniff", h("x-content-type-options") === "nosniff", h("x-content-type-options") || "missing", "warn");
  record("x-frame-options: DENY", h("x-frame-options") === "DENY", h("x-frame-options") || "missing", "warn");
  record("referrer-policy set", !!h("referrer-policy"), h("referrer-policy") || "missing", "warn");
  record("strict-transport-security set", /max-age=\d+/.test(h("strict-transport-security")), h("strict-transport-security") || "missing", "warn");
  record("content-type is html; charset utf-8", /text\/html/.test(h("content-type")) && /utf-8/i.test(h("content-type")), h("content-type"));
}

// 6. Stub-mode notice must not be visible on the live login page once Shopify login is on.
{
  const { text } = await get("/login");
  record("login page shows no stub-mode notice", !text.includes("מצב פיתוח"), text.includes("מצב פיתוח") ? "stub-mode build is live" : "", "warn");
  const home = await get("/");
  record("home serves the v4 logo", home.text.includes("/brand/v4/"), home.text.includes("/brand/v4/") ? "" : "old build is live", "warn");
}

const fails = results.filter((r) => !r.ok && r.level === "fail").length;
const warns = results.filter((r) => !r.ok && r.level === "warn").length;
const outDir = join(process.cwd(), "test-results", "qa");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "live-check.json"), JSON.stringify({ base, at: new Date().toISOString(), fails, warns, results, timings }, null, 2));
console.log(`\n${results.length - fails - warns} ok, ${warns} warnings, ${fails} failures (${base})`);
process.exit(fails ? 1 : 0);
