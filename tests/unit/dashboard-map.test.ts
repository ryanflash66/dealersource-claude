import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers.js";

// Task spec: the dashboard basemap is Protomaps PMTiles + MapLibre, self-hosted; public tile
// servers are never used. Everything the map loads must come from the deployment itself.
describe("dashboard map is self-hosted", () => {
  const app = readFileSync(join(ROOT, "dashboard", "src", "app.ts"), "utf8");
  const pub = join(ROOT, "dashboard", "public");

  it("loads no map code, glyphs, sprites or tiles from another host", () => {
    for (const host of ["unpkg.com", "jsdelivr", "protomaps.github.io", "tile.openstreetmap.org", "api.maptiles", "mapbox.com"]) {
      expect(app).not.toContain(host);
    }
    expect(app).toContain('new URL("./vendor/", location.href)');
    expect(app).toContain('new URL("./map/", location.href)');
  });

  it("ships the Eastern NC archive, glyphs and sprites the style asks for", () => {
    const tiles = join(pub, "tiles", "eastern-nc.pmtiles");
    expect(existsSync(tiles)).toBe(true);
    const size = statSync(tiles).size;
    expect(size).toBeGreaterThan(1_000_000);
    expect(size).toBeLessThan(50 * 1024 * 1024); // GitHub warns on files over 50 MB
    expect(readFileSync(tiles).subarray(0, 7).toString("latin1")).toBe("PMTiles");
    for (const font of ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"]) {
      expect(existsSync(join(pub, "map", "fonts", font, "0-255.pbf"))).toBe(true);
    }
    for (const f of ["light.json", "light.png", "light@2x.json", "light@2x.png", "dark.json", "dark.png"]) {
      expect(existsSync(join(pub, "map", "sprites", "v4", f))).toBe(true);
    }
  });

  it("the build copies the map libraries and defaults PMTILES_URL to the bundled archive", () => {
    const build = readFileSync(join(ROOT, "scripts", "build-dashboard.mjs"), "utf8");
    for (const f of ["maplibre-gl.mjs", "maplibre-gl-shared.mjs", "maplibre-gl-worker.mjs", "maplibre-gl.css", "pmtiles.js", "basemaps.js"]) {
      expect(build).toContain(f);
    }
    expect(build).toContain('"./tiles/eastern-nc.pmtiles"');
  });
});
