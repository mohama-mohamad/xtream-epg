# Xtream Pro TV guide

A TV guide (EPG) built every 6 hours from free XMLTV sources and published on GitHub Pages.

- `site/v1/guide.json.gz` — compact guide read by the Xtream Pro apps (channels, matching keys, programmes of the next 48 h)
- `site/v1/guide.xml.gz` — the same guide as XMLTV, usable in any IPTV player
- `site/v1/catalog.json` — our channel catalogue (ids, names, matching keys, chosen source, coverage)
- `site/v1/status.json` — last build report (sources, detected time shifts)

## How it works

1. `sources.json` lists the sources. `offset` forces a time zone when a file labels its times wrongly; `trust` decides between sources.
2. Each source channel gets a matching key (`scripts/key.mjs`, identical to the apps): `|AR.MBC| MBC 1 HD`, `MBC.1.ae` and `MBC 1` all become `mbc1`.
3. Channels with the same key form one channel of our catalogue. When several sources carry it, a constant time shift between them is detected (same titles, shifted) and corrected, then the best source is kept (coverage of the next 24 h, descriptions, trust).
4. `catalog/overrides.json` corrects the automatic catalogue: `merge` (same channel under two keys), `aliases` (Arabic names…), `disabled`, `prefer`.

Run locally: `node scripts/build.mjs` (Node 20+, no dependencies).

The guide data comes from public free sources (EPG Share); nothing private is stored here.
