#!/usr/bin/env node
// Frillion pack builder — queries Wikidata ONCE, politely, and writes static JSON packs the game loads instead of
// hitting Wikidata live. It reads the question templates + quality rules straight out of index.html (single source of truth).
//
//   node build-packs.mjs                      # build/refresh everything that is missing or older than 30 days
//   node build-packs.mjs --max-minutes 300    # stop gracefully after 300 min (progress is saved; next run resumes)
//   node build-packs.mjs --only p:Q937857     # only templates whose id starts with this (testing)
//   node build-packs.mjs --refresh            # ignore age, rebuild everything
// Options: --html index.html  --out packs  --delay 2000 (ms between queries)  --max-age-days 30  --limit N
//          --backoff 5000 (ms, doubles per retry)  --endpoint URL   --qlever (EXPERIMENTAL: use the QLever Wikidata endpoint instead of query.wikidata.org)
// Set WD_CONTACT to a URL or email so Wikimedia can reach you (their user-agent policy).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const args = process.argv.slice(2);
const flag = n => args.includes("--" + n);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const HTML = opt("html", "index.html"), OUT = opt("out", "packs");
const QLEVER = flag("qlever");
const ENDPOINT = opt("endpoint", QLEVER ? "https://qlever.cs.uni-freiburg.de/api/wikidata" : "https://query.wikidata.org/sparql");
const DELAY = +opt("delay", 2000), MAXMIN = +opt("max-minutes", 0), MAXAGE = +opt("max-age-days", 30) * 864e5;
const ONLY = opt("only", ""), LIMIT = +opt("limit", 0), REFRESH = flag("refresh"), BACKOFF = +opt("backoff", 5000);
const UA = `FrillionPackBuilder/1.0 (${process.env.WD_CONTACT || "https://github.com/cogoods7-ctrl/Frillion"}) node/${process.versions.node}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now(), outOfTime = () => MAXMIN > 0 && Date.now() - T0 > MAXMIN * 60000;

// ---- load the game's own definitions (templates, SPARQL builder, cleaning + gate rules) ----
const src = fs.readFileSync(HTML, "utf8");
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error("marker not found in " + HTML + ": " + a); return src.slice(i, j); };
const code = [
  cut("// ===== matching helpers =====", "// ===== DYNAMIC QUESTION ENGINE"),
  cut("// ===== DYNAMIC QUESTION ENGINE", "// ===== network"),
  cut("const poolQuery=", "// R4: verify"),
  cut("function cleanPool", "const cacheGet"),
].join("\n");
const ctx = vm.createContext({ console });
vm.runInContext(code + "\n;globalThis.__x={TPLS,CFG,poolQuery,cleanPool,gate,keyOf}", ctx);
const { TPLS, CFG, poolQuery, cleanPool, gate, keyOf } = ctx.__x;

// ---- polite SPARQL client: one request at a time, backoff on 429/5xx/timeouts, honours Retry-After ----
const toEndpointQuery = q => QLEVER ? q.replace('SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }', '?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel)="en")') : q;
async function sparql(q) {
  for (let a = 0; ; a++) {
    let res;
    try {
      res = await fetch(ENDPOINT + "?format=json&query=" + encodeURIComponent(toEndpointQuery(q)),
        { headers: { "User-Agent": UA, "Accept": "application/sparql-results+json" }, signal: AbortSignal.timeout(80000) });
    } catch (e) { res = { ok: false, status: 0 }; }
    if (res.ok) return (await res.json()).results.bindings;
    const st = res.status;
    if (a >= 4 || !(st === 0 || st === 429 || st >= 500)) throw new Error("HTTP " + st);
    const ra = +(res.headers && res.headers.get && res.headers.get("retry-after") || 0);
    const wait = (ra ? ra * 1000 : BACKOFF * 2 ** a) + Math.random() * 1000;
    console.log(`    … HTTP ${st || "network"}; waiting ${(wait / 1000).toFixed(0)}s (retry ${a + 1}/4)`);
    await sleep(wait);
  }
}

// ---- state (resumable) ----
fs.mkdirSync(path.join(OUT, "pools"), { recursive: true });
const IDX = path.join(OUT, "index.json");
let idx = { v: 1, built: null, seedok: [], pools: {}, bad: {} };
try { const j = JSON.parse(fs.readFileSync(IDX, "utf8")); if (j.v === 1) idx = j; } catch (e) {}
const save = () => { idx.built = new Date().toISOString(); const tmp = IDX + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(idx)); fs.renameSync(tmp, IDX); };
process.on("SIGINT", () => { save(); console.log("\nsaved progress, bye"); process.exit(130); });
const fresh = t => t && Date.now() - t < MAXAGE;

// ---- 1. verify seed entities (guards against wrong Wikidata IDs) ----
const guards = new Map();
TPLS.forEach(t => t.g.forEach(([q, e]) => guards.set(q, e)));
const unchecked = [...guards.keys()].filter(q => !(idx.seedAll || idx.seedok).includes(q));
if (REFRESH || !idx.seedAt || !fresh(idx.seedAt) || !idx.seedok.length || unchecked.length) {
  console.log(`Checking ${guards.size} seed entities…`);
  const ids = [...guards.keys()], lab = {};
  for (let i = 0; i < ids.length; i += 60) {
    const rows = await sparql(`SELECT ?q ?l WHERE { VALUES ?q { ${ids.slice(i, i + 60).map(x => "wd:" + x).join(" ")} } ?q rdfs:label ?l . FILTER(LANG(?l)="en") }`);
    rows.forEach(r => { lab[r.q.value.split("/").pop()] = r.l.value; });
    await sleep(DELAY);
  }
  const ok = [];
  guards.forEach((e, q) => { if (lab[q] && keyOf(lab[q]).includes(keyOf(e))) ok.push(q); else console.log(`  seed rejected: ${q} expected "${e}" got "${lab[q]}"`); });
  if (ok.length < guards.size / 3) throw new Error("Most seed labels did not match — refusing to build wrong packs");
  idx.seedok = ok; idx.seedAll = [...guards.keys()]; idx.seedAt = Date.now(); save();
}
const okSeed = new Set(idx.seedok);

// ---- 2. build pools, most useful templates first ----
const sig = t => t.pat + "|" + (t.limit || CFG.LIMIT) + "|" + (t.minSl || CFG.MIN_SL);
const jit = id => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 14; };
const freshFor = (id, ts) => ts && Date.now() - ts < MAXAGE - 9 * 864e5 + jit(id) * 864e5;
// packs built before signatures existed: these templates' queries were changed, so rebuild them once
const LEGACY_CHANGED = /^(n:|c:fv$|g:|c:Q515|k:Q515@|c:Q8502|k:Q8502@|c:(Q134768|Q10943|Q746549|Q3314483|Q11004|Q40050|Q42527)$|o:Q746549@|o:Q10943@)/;
const sameQuery = (e, t) => e && (e.s ? e.s === sig(t) : !LEGACY_CHANGED.test(t.id));
const statsOf = sls => [sls[0] || 0, sls.filter(x => x >= 40).length, sls.filter(x => x >= 25).length, sls.filter(x => x >= 12).length];
const fileOf = id => id.replace(/[^A-Za-z0-9]+/g, "_") + ".json";
const seen = new Map();
const isNew = t => !(idx.pools[t.id] && sameQuery(idx.pools[t.id], t));
let todo = TPLS.filter(t => !t.variant && t.g.every(([q]) => okSeed.has(q))).sort((a, b) => (isNew(b) - isNew(a)) || (b.pri - a.pri) || a.id.localeCompare(b.id));
todo.forEach(t => { const f = fileOf(t.id); if (seen.has(f)) throw new Error("file name collision: " + t.id + " / " + seen.get(f)); seen.set(f, t.id); });
if (ONLY) todo = todo.filter(t => t.id.startsWith(ONLY));
if (LIMIT) todo = todo.slice(0, LIMIT);
let done = 0, built = 0, skipped = 0, rejected = 0, errors = 0, consecutive = 0;
for (const t of todo) {
  done++;
  const have = idx.pools[t.id], bad = idx.bad[t.id];
  if (!REFRESH && ((have && freshFor(t.id, have.t) && sameQuery(have, t)) || (bad && freshFor(t.id, bad[1]) && sameQuery({ s: bad[2] }, t) && bad[2]))) { skipped++; continue; }
  if (!REFRESH && bad && !bad[2] && freshFor(t.id, bad[1]) && !LEGACY_CHANGED.test(t.id)) { skipped++; continue; }
  if (outOfTime()) { console.log("Time budget reached — stopping; re-run to resume."); break; }
  process.stdout.write(`[${done}/${todo.length}] ${t.q} … `);
  try {
    const limit = t.limit || CFG.LIMIT, rows = await sparql(poolQuery(t.pat, limit, t.minSl));
    const cp = cleanPool(rows, t), why = gate(cp);
    consecutive = 0;
    if (why) { idx.bad[t.id] = [why, Date.now(), sig(t)]; delete idx.pools[t.id]; rejected++; console.log("rejected (" + why + ")"); }
    else {
      const items = cp.items.map(([w, sl, al]) => al && al.length ? [w, sl, al] : [w, sl]);
      fs.writeFileSync(path.join(OUT, "pools", fileOf(t.id)), JSON.stringify({ id: t.id, q: t.q, capped: rows.length >= limit, items }));
      idx.pools[t.id] = { f: fileOf(t.id), n: items.length, c: rows.length >= limit ? 1 : 0, t: Date.now(), s: sig(t), m: statsOf(items.map(x => x[1])) }; delete idx.bad[t.id];
      built++; console.log(`ok (${items.length} answers)`);
    }
  } catch (e) {
    errors++; consecutive++; console.log("error: " + e.message);
    if (consecutive >= 8) { console.log("Too many consecutive errors — endpoint unhealthy; stopping (progress saved)."); save(); process.exit(1); }
  }
  if (done % 10 === 0) save();
  await sleep(DELAY);
}
for (const [id, e] of Object.entries(idx.pools)) if (!e.m) { try { e.m = statsOf(JSON.parse(fs.readFileSync(path.join(OUT, "pools", e.f), "utf8")).items.map(x => x[1])); } catch (err) {} }
const live = new Set(TPLS.map(t => t.id));
for (const id of Object.keys(idx.pools)) if (!live.has(id)) { try { fs.unlinkSync(path.join(OUT, "pools", idx.pools[id].f)); } catch (e) {} delete idx.pools[id]; }
for (const id of Object.keys(idx.bad)) if (!live.has(id)) delete idx.bad[id];
save();
console.log(`\nDone. built ${built}, kept ${skipped}, rejected by rules ${rejected}, errors ${errors}. Packs in index: ${Object.keys(idx.pools).length}.`);
