// Builds the Xtream Pro TV guide from free XMLTV sources and writes the site published on GitHub Pages.
// node scripts/build.mjs        (no dependencies; Node 20+)
//
// 1. downloads every source of sources.json (gzip or plain XMLTV), fixing wrongly labelled time zones
// 2. groups the sources' channels into OUR catalogue by matching key (scripts/key.mjs + catalog/overrides.json)
// 3. when several sources carry a channel, detects a constant time shift between them (same titles, shifted)
//    and keeps the best one (coverage of the next 24 h, descriptions, trust)
// 4. writes site/v1/guide.json.gz (what the apps read), guide.xml.gz (XMLTV for any player), catalog.json, status.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { key, skeleton } from "./key.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "site");
const NOW = Date.now();
const FROM = NOW - 6 * 3600_000;   // the programme on now (and a little before)
const TO = NOW + 48 * 3600_000;    // two days ahead: the apps refresh every 6–12 h
const DESC_MAX = 200;

const { sources } = JSON.parse(fs.readFileSync(path.join(ROOT, "sources.json"), "utf8"));
const overrides = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog", "overrides.json"), "utf8"));
const merge = overrides.merge || {};
const canonical = k => merge[k] || k;

// ───────────── download / parse ─────────────
async function download(url) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "xtream-epg-builder" }, signal: AbortSignal.timeout(180_000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      return buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
    } catch (e) { last = e; await new Promise(res => setTimeout(res, 3000 * (i + 1))); }
  }
  throw last;
}

const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : entities[e] ?? m)
  .trim();
const attr = (s, name) => (s.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1] ?? "";

/** "20261008133000 +0100" → epoch ms; a forced offset ("+03:00") replaces the file's own. */
function time(s, forced) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2}):?(\d{2})?/.exec((s || "").trim());
  if (!m) return 0;
  let off = (forced || `${m[7] ?? "+00"}:${m[8] ?? "00"}`).replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${off}`);
  return Number.isFinite(t) ? t : 0;
}

function parse(xml, src) {
  const channels = new Map();
  for (const m of xml.matchAll(/<channel\b([^>]*)>([\s\S]*?)<\/channel>/g)) {
    const id = decode(attr(m[1], "id"));
    const names = [...m[2].matchAll(/<display-name[^>]*>([\s\S]*?)<\/display-name>/g)].map(x => decode(x[1])).filter(Boolean);
    const icon = attr((m[2].match(/<icon\b[^>]*>/) || [""])[0], "src");
    channels.set(id, { id, names, icon, progs: [] });
  }
  for (const m of xml.matchAll(/<programme\b([^>]*)>([\s\S]*?)<\/programme>/g)) {
    const ch = channels.get(decode(attr(m[1], "channel")));
    if (!ch) continue;
    const s = time(attr(m[1], "start"), src.offset), e0 = time(attr(m[1], "stop"), src.offset);
    const e = e0 > s ? e0 : s + 3600_000;
    if (!s || e < FROM || s > TO) continue;
    const title = decode((m[2].match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || "");
    const desc = decode((m[2].match(/<desc[^>]*>([\s\S]*?)<\/desc>/) || [])[1] || "");
    if (title) ch.progs.push({ s, e, t: title, d: desc.length > DESC_MAX ? desc.slice(0, DESC_MAX - 1) + "…" : desc });
  }
  for (const ch of channels.values()) ch.progs.sort((a, b) => a.s - b.s);
  return channels;
}

// ───────────── quality ─────────────
function coverage(progs) {
  // share of the next 24 h covered by programmes (overlaps counted once)
  const a = NOW, b = NOW + 24 * 3600_000;
  let covered = 0, cursor = a;
  for (const p of progs) {
    const s = Math.max(p.s, cursor), e = Math.min(p.e, b);
    if (e > s) { covered += e - s; cursor = e; }
  }
  return covered / (b - a);
}
const normTitle = t => key(t).slice(0, 24);

/** Constant shift (minutes) of `cand` against `ref`: the shift that lines up the most identical titles. */
function detectShift(ref, cand) {
  if (ref.length < 4 || cand.length < 4) return null;
  const refStarts = new Map();
  for (const p of ref) {
    const k = normTitle(p.t);
    if (!k) continue;
    if (!refStarts.has(k)) refStarts.set(k, []);
    refStarts.get(k).push(p.s);
  }
  const hits = shift => cand.reduce((n, p) => {
    const list = refStarts.get(normTitle(p.t));
    return n + (list && list.some(s => Math.abs(s - (p.s - shift * 60_000)) <= 5 * 60_000) ? 1 : 0);
  }, 0);
  let best = 0, bestHits = hits(0);
  const zero = bestHits;
  for (let sh = -240; sh <= 240; sh += 30) {
    if (sh === 0) continue;
    const h = hits(sh);
    if (h > bestHits) { best = sh; bestHits = h; }
  }
  if (best !== 0 && bestHits >= 3 && bestHits >= 2 * Math.max(1, zero)) return { shift: best, hits: bestHits, atZero: zero };
  return null;
}

// ───────────── build ─────────────
const status = { generated: new Date(NOW).toISOString(), window: { from: new Date(FROM).toISOString(), to: new Date(TO).toISOString() }, sources: [], shifts: [], channels: 0, programmes: 0 };
const groups = new Map(); // canonical key → candidates

for (const src of sources) {
  const st = { id: src.id, name: src.name, ok: false, channels: 0, withProgrammes: 0, programmes: 0, offset: src.offset || null };
  status.sources.push(st);
  try {
    const t0 = Date.now();
    const xml = (await download(src.url)).toString("utf8");
    const channels = parse(xml, src);
    st.ok = true; st.channels = channels.size; st.seconds = Math.round((Date.now() - t0) / 100) / 10;
    for (const ch of channels.values()) {
      if (!ch.progs.length) continue;
      st.withProgrammes++; st.programmes += ch.progs.length;
      const keys = new Set([key(ch.id), ...ch.names.map(key)].filter(k => k.length >= 2));
      const main = canonical(key(ch.names[0] || ch.id) || key(ch.id));
      if (!main || (overrides.disabled || []).includes(main)) continue;
      if (!groups.has(main)) groups.set(main, []);
      groups.get(main).push({ src, ch, keys, cov: coverage(ch.progs) });
    }
  } catch (e) {
    st.error = String(e && e.message || e);
    console.error(`source ${src.id} failed: ${st.error}`);
  }
}

const guide = { version: 1, generated: status.generated, channels: {} };
const catalog = { version: 1, generated: status.generated, channels: [] };

for (const [id, cands] of groups) {
  // reference = most trusted, then best coverage; the others are checked for a constant time shift against it
  cands.sort((a, b) => (b.src.trust || 0) - (a.src.trust || 0) || b.cov - a.cov);
  const ref = cands[0];
  for (const c of cands.slice(1)) {
    if (c.src.id === ref.src.id) continue;
    const sh = detectShift(ref.ch.progs, c.ch.progs);
    if (sh) {
      for (const p of c.ch.progs) { p.s -= sh.shift * 60_000; p.e -= sh.shift * 60_000; }
      c.cov = coverage(c.ch.progs);
      status.shifts.push({ channel: id, source: c.src.id, against: ref.src.id, minutes: sh.shift, matches: sh.hits, matchesBefore: sh.atZero });
    }
  }
  const prefer = (overrides.prefer || {})[id];
  const score = c => (prefer && c.src.id === prefer ? 1000 : 0) + c.cov * 100 + (c.ch.progs.some(p => p.d) ? 10 : 0) + (c.src.trust || 0) * 5;
  const best = [...cands].sort((a, b) => score(b) - score(a))[0];
  const keys = new Set([id]);
  for (const c of cands) c.keys.forEach(k => keys.add(k));
  for (const a of (overrides.aliases || {})[id] || []) { const k = key(a); if (k.length >= 2) keys.add(k); }
  const name = best.ch.names[0] || best.ch.id;
  guide.channels[id] = {
    n: name,
    k: [...keys],
    p: best.ch.progs.map(p => p.d ? [Math.round(p.s / 1000), Math.round(p.e / 1000), p.t, p.d] : [Math.round(p.s / 1000), Math.round(p.e / 1000), p.t]),
  };
  catalog.channels.push({ id, name, icon: best.ch.icon || "", keys: [...keys], source: best.src.id, sources: [...new Set(cands.map(c => c.src.id))],
    coverage24h: Math.round(best.cov * 100), programmes: best.ch.progs.length });
  status.programmes += best.ch.progs.length;
}
catalog.channels.sort((a, b) => a.id.localeCompare(b.id));
status.channels = catalog.channels.length;

// keys claimed by two of our channels would make the apps guess: they are dropped (reported)
const owners = new Map();
for (const [id, c] of Object.entries(guide.channels)) for (const k of c.k) owners.set(k, owners.has(k) && owners.get(k) !== id ? null : id);
for (const id of Object.keys(guide.channels)) owners.set(id, id); // a channel's own key is always its own
status.ambiguousKeys = [...owners].filter(([, v]) => v === null).map(([k]) => k);
for (const c of Object.values(guide.channels)) c.k = c.k.filter(k => owners.get(k) !== null);

// ───────────── XMLTV for any player ─────────────
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const xt = t => new Date(t * 1000).toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";
let xmltv = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="xtream-epg">\n';
for (const c of catalog.channels) xmltv += `<channel id="${esc(c.id)}"><display-name>${esc(c.name)}</display-name>${c.icon ? `<icon src="${esc(c.icon)}"/>` : ""}</channel>\n`;
for (const [id, c] of Object.entries(guide.channels))
  for (const [s, e, t, d] of c.p) xmltv += `<programme start="${xt(s)}" stop="${xt(e)}" channel="${esc(id)}"><title>${esc(t)}</title>${d ? `<desc>${esc(d)}</desc>` : ""}</programme>\n`;
xmltv += "</tv>\n";

// ───────────── write the site ─────────────
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "v1"), { recursive: true });
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
fs.writeFileSync(path.join(OUT, "v1", "guide.json.gz"), gzipSync(JSON.stringify(guide), { level: 9 }));
fs.writeFileSync(path.join(OUT, "v1", "guide.xml.gz"), gzipSync(xmltv, { level: 9 }));
fs.writeFileSync(path.join(OUT, "v1", "catalog.json"), JSON.stringify(catalog, null, 1));
fs.writeFileSync(path.join(OUT, "v1", "status.json"), JSON.stringify(status, null, 1));
const size = f => Math.round(fs.statSync(path.join(OUT, "v1", f)).size / 1024);
fs.writeFileSync(path.join(OUT, "index.html"), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Xtream Pro TV guide</title><body style="font-family:system-ui;background:#0b0d12;color:#eceef4;padding:24px;max-width:760px;margin:auto">
<h1>Xtream Pro TV guide</h1><p>Updated ${esc(status.generated)} — ${status.channels} channels, ${status.programmes} programmes.</p>
<ul><li><a style="color:#8b7bff" href="v1/guide.xml.gz">guide.xml.gz</a> (XMLTV, ${size("guide.xml.gz")} KB)</li>
<li><a style="color:#8b7bff" href="v1/guide.json.gz">guide.json.gz</a> (apps, ${size("guide.json.gz")} KB)</li>
<li><a style="color:#8b7bff" href="v1/catalog.json">catalog.json</a> · <a style="color:#8b7bff" href="v1/status.json">status.json</a></li></ul>
<p>Sources: ${status.sources.map(s => `${esc(s.name)} ${s.ok ? "✓" : "✗"}`).join(" · ")}</p></body>`);

console.log(`channels ${status.channels}, programmes ${status.programmes}, guide.json.gz ${size("guide.json.gz")} KB, guide.xml.gz ${size("guide.xml.gz")} KB`);
for (const s of status.sources) console.log(`  ${s.ok ? "ok  " : "FAIL"} ${s.id}: ${s.withProgrammes}/${s.channels} channels, ${s.programmes} programmes${s.seconds ? `, ${s.seconds}s` : ""}${s.error ? " — " + s.error : ""}`);
for (const s of status.shifts) console.log(`  shift: ${s.channel} ${s.source} ${s.minutes > 0 ? "+" : ""}${s.minutes} min against ${s.against} (${s.matches} vs ${s.matchesBefore})`);
if (status.ambiguousKeys.length) console.log(`  ambiguous keys dropped: ${status.ambiguousKeys.length}`);
if (!status.sources.some(s => s.ok)) process.exit(1); // keep the previous site when every source failed
