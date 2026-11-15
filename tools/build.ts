import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const dev = process.argv.includes("--dev");

const entries = [
  ["src/background/service-worker.ts", "src/background/service-worker.js"],
  ["src/popup/popup.ts", "src/popup/popup.js"],
  ["src/options/options.ts", "src/options/options.js"],
  ["src/pages/placeholder.ts", "src/pages/placeholder.js"],
] as const;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const [entry, output] of entries) {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    outdir: dist,
    target: "browser",
    format: "esm",
    naming: { entry: output },
    minify: !dev,
    sourcemap: dev ? "linked" : "none",
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Failed to build ${entry}`);
  }
}

await Promise.all([
  cp(join(root, "manifest.json"), join(dist, "manifest.json")),
  cp(join(root, "icons"), join(dist, "icons"), { recursive: true }),
  cp(join(root, "src/styles"), join(dist, "src/styles"), { recursive: true }),
  cp(join(root, "src/popup/popup.html"), join(dist, "src/popup/popup.html")),
  cp(join(root, "src/popup/popup.css"), join(dist, "src/popup/popup.css")),
  cp(join(root, "src/options/options.html"), join(dist, "src/options/options.html")),
  cp(join(root, "src/options/options.css"), join(dist, "src/options/options.css")),
  cp(join(root, "src/pages/placeholder.html"), join(dist, "src/pages/placeholder.html")),
  cp(join(root, "src/pages/placeholder.css"), join(dist, "src/pages/placeholder.css")),
]);

const manifest = await Bun.file(join(dist, "manifest.json")).json();
const referencedPaths = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...Object.values(manifest.icons ?? {}),
].filter((path): path is string => typeof path === "string");

for (const path of referencedPaths) {
  if (!(await Bun.file(join(dist, path)).exists())) {
    throw new Error(`Built manifest references a missing file: ${path}`);
  }
}

console.log(`${dev ? "Development" : "Production"} build written to ${dist}`);
