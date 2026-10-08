// Sets Blether's version everywhere it's recorded, so the npm package, the
// relay image, the plugin and the workspace packages always release together:
//
//   pnpm set-version 0.2.0
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("Usage: pnpm set-version <major.minor.patch>");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packages = join(root, "packages");

// Replaces only the top-level "version" line, keeping each file's formatting.
const setJsonVersion = (file) => {
  const text = readFileSync(file, "utf8");
  const updated = text.replace(/^( {2}"version": )"[^"]*"/m, `$1"${version}"`);
  if (JSON.parse(updated).version !== version) {
    throw new Error(`Couldn't find the top-level version in ${file}`);
  }
  writeFileSync(file, updated);
};

for (const name of readdirSync(packages)) {
  setJsonVersion(join(packages, name, "package.json"));
}
setJsonVersion(
  join(packages, "blether", "plugin", ".claude-plugin", "plugin.json"),
);

const constant = join(packages, "protocol", "src", "version.ts");
writeFileSync(
  constant,
  readFileSync(constant, "utf8").replace(
    /BLETHER_VERSION = "[^"]*"/,
    `BLETHER_VERSION = "${version}"`,
  ),
);

console.log(
  `Blether is now version ${version}. Merging to main publishes the npm package and the relay image.`,
);
