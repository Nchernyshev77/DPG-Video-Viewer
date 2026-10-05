import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(resolve(path, entry.name))
          : resolve(path, entry.name),
      ),
    )
  ).flat();
}
for (const path of ["src", "tools", "tests"]) {
  for (const file of (await files(resolve(root, path))).filter(
    (file) => /\.(js|mjs)$/.test(file) && !file.includes("/.fixtures/"),
  )) {
    const check = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
    });
    if (check.status) throw new Error(check.stderr);
    const text = await readFile(file, "utf8");
    // Browser evaluate callbacks resolve dynamic imports against the served page.
    const imports =
      path === "tests"
        ? /from\s+["']([^"']+)["']/g
        : /(?:from\s+|import\(\s*)["']([^"']+)["']/g;
    for (const [, imported] of text.matchAll(imports)) {
      if (imported.startsWith("."))
        await readFile(new URL(imported, pathToFileURL(file)));
    }
  }
}
console.log("Syntax and local imports verified");
