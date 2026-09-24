# Self-hosted basemap assets

The dashboard map is Protomaps PMTiles + MapLibre GL, served entirely from this deployment
(task spec: self-hosted tiles, no public tile servers).

| Path | What | Source | License |
|---|---|---|---|
| `../tiles/eastern-nc.pmtiles` | Vector basemap, Greenville ± ~60 miles (bbox `-78.45,34.74,-76.30,36.48`), zoom 0-14 | Protomaps daily build `20260923.pmtiles` (tiles v4.15.2), `pmtiles extract` | Data © OpenStreetMap contributors, ODbL |
| `fonts/Noto Sans {Regular,Medium,Italic}/` | Label glyphs, Latin ranges 0-255, 256-511, 8192-8447 only | github.com/protomaps/basemaps-assets `fonts/` | SIL OFL 1.1 (`fonts/OFL.txt`) |
| `sprites/v4/` | Light and dark icon sprites | github.com/protomaps/basemaps-assets `sprites/v4/` | MIT, derived from tangrams/icons |

MapLibre GL, the PMTiles reader and the Protomaps style (`@protomaps/basemaps`) come from npm
and are copied to `../vendor/` by `scripts/build-dashboard.mjs`.

Refresh the tiles (go-pmtiles CLI, github.com/protomaps/go-pmtiles/releases; pick a build from
https://build-metadata.protomaps.dev/builds.json):

```bash
pmtiles extract https://build.protomaps.com/YYYYMMDD.pmtiles dashboard/public/tiles/eastern-nc.pmtiles --bbox=-78.45,34.74,-76.30,36.48 --maxzoom=14
```

Keep `--maxzoom=14` (about 46 MB; zoom 15 is about 91 MB, over GitHub's 50 MB file warning).
MapLibre overzooms zoom-14 tiles for street-level views.
