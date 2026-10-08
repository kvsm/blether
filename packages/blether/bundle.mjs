// Bundles the blether CLI and the bridge into single files inside the
// plugin, so the npm package needs no dependencies of its own, and the
// plugin carries everything it runs. Run after `pnpm build` (tsc).
import {
  copyFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const bridge = join(here, "..", "bridge", "dist");
const out = join(here, "plugin", "dist");

rmSync(out, { recursive: true, force: true });
const { metafile } = await build({
  entryPoints: {
    cli: join(bridge, "cli-bin.js"),
    bridge: join(bridge, "bin.js"),
  },
  outdir: out,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // Dependencies written as CommonJS (ws, among others) call require().
  // (The entry points' own #! lines stay at the top.)
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  // ws uses these native speed-ups only if they're installed.
  external: ["bufferutil", "utf-8-validate"],
  metafile: true,
  logLevel: "warning",
});

writeNotices(metafile);
// npm ships a LICENSE from the package's own directory.
copyFileSync(join(here, "..", "..", "LICENSE"), join(here, "LICENSE"));
console.log(`Bundled the CLI and bridge into ${out}`);

/** Collects the licence of every third-party package in the bundles. */
function writeNotices(meta) {
  const packages = new Map();
  for (const input of Object.keys(meta.inputs)) {
    const match = /^(.*node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(
      input,
    );
    if (!match) continue;
    // Metafile paths are relative to the working directory.
    const dir = resolve(match[1]);
    if (packages.has(dir)) continue;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const licenceFile = readdirSync(dir).find((f) =>
      /^(licen[cs]e|copying)/i.test(f),
    );
    packages.set(dir, {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? "(see text)",
      text: licenceFile
        ? readFileSync(join(dir, licenceFile), "utf8").trim()
        : "",
    });
  }
  const sections = [...packages.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (p) =>
        `${p.name}@${p.version} (${p.license})\n\n${p.text || "No licence file included in the package."}`,
    );
  writeFileSync(
    join(out, "THIRD-PARTY-NOTICES.txt"),
    `The bundled CLI and bridge include these packages.\n\n${sections.join(`\n\n${"-".repeat(72)}\n\n`)}\n`,
  );
}
