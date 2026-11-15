import { describe, it, expect } from "bun:test";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

function readRel(p: string) {
  return Bun.file(join(dist, p));
}

describe("build artifact contract", () => {
  it("dist manifest is valid JSON and references existing files", async () => {
    const manifest = await readRel("manifest.json").json() as Record<string, unknown>;
    expect(manifest.manifest_version).toBe(3);
    const paths: string[] = [];
    const bg = (manifest.background as any)?.service_worker;
    if (typeof bg === "string") paths.push(bg);
    const popup = (manifest.action as any)?.default_popup;
    if (typeof popup === "string") paths.push(popup);
    const opts = (manifest.options_ui as any)?.page;
    if (typeof opts === "string") paths.push(opts);
    for (const v of Object.values((manifest.icons as any) ?? {})) if (typeof v === "string") paths.push(v);
    for (const v of Object.values((manifest.action?.default_icon as any) ?? {})) if (typeof v === "string") paths.push(v);
    for (const p of paths) {
      expect(await readRel(p).exists(), `missing manifest asset: ${p}`).toBe(true);
    }
  });

  it("every HTML page references existing local scripts and stylesheets and no .ts sources", async () => {
    const htmlFiles = ["src/popup/popup.html", "src/options/options.html", "src/pages/placeholder.html"];
    for (const rel of htmlFiles) {
      const file = readRel(rel);
      expect(await file.exists(), `missing HTML: ${rel}`).toBe(true);
      const html = await file.text();
      const baseDir = dirname(join(dist, rel));
      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
      for (const ref of refs) {
        if (/^(https?:|\/|data:|#)/.test(ref)) continue;
        const resolved = join(baseDir, ref);
        expect(await Bun.file(resolved).exists(), `missing HTML asset: ${ref} in ${rel}`).toBe(true);
        expect(ref).not.toMatch(/\.ts($|\?)/);
      }
    }
  });

  it("emits the four expected JavaScript entry points", async () => {
    const entries = ["src/background/service-worker.js", "src/popup/popup.js", "src/options/options.js", "src/pages/placeholder.js"];
    for (const e of entries) {
      expect(await readRel(e).exists(), `missing entry: ${e}`).toBe(true);
    }
  });

  it("production bundle contains no TypeScript source references or source maps", async () => {
    const sw = await readRel("src/background/service-worker.js").text();
    expect(sw).not.toMatch(/\.ts(['"])/);
    expect(sw).not.toMatch(/\/\/# sourceMappingURL/);
    expect(await readRel("src/background/service-worker.js.map").exists()).toBe(false);
  });
});
