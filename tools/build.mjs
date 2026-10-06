import { cp, mkdir, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "dist");
const paths = ["src", "styles", "vendor"];
async function files(path) {
  const entries = await readdir(resolve(root, path), { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(`${path}/${entry.name}`)
          : `${path}/${entry.name}`,
      ),
    )
  ).flat();
}
const html = await readFile(resolve(root, "index.html"), "utf8");
const hash = createHash("sha256").update(html);
for (const path of (await Promise.all(paths.map(files))).flat().sort())
  hash
    .update(path + "\0")
    .update(await readFile(resolve(root, path)))
    .update("\0");
const revision = hash.digest("hex").slice(0, 16);
const assets = `assets/${revision}`;
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, assets), { recursive: true });
for (const path of paths)
  await cp(resolve(root, path), resolve(output, assets, path), {
    recursive: true,
  });
await writeFile(
  resolve(output, "index.html"),
  html
    .replace(/\.\/(src|styles|vendor)\//g, `./${assets}/$1/`)
    .replace('data-version="development"', `data-version="${revision}"`),
);
console.log(`Static application built in dist/ (${assets})`);
