import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function createStaticServer({ root = repoRoot, basePath = "/" } = {}) {
  root = resolve(root);
  return createServer(async (request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405);
        response.end();
        return;
      }
      const pathname = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname,
      );
      if (!pathname.startsWith(basePath)) throw new Error("Not found");
      const path = pathname.slice(basePath.length) || "index.html";
      if (
        !(path === "index.html" || /^(src|styles|vendor|assets)\//.test(path))
      )
        throw new Error("Not found");
      const file = resolve(root, path);
      if (relative(root, file).startsWith("..") || !(await stat(file)).isFile())
        throw new Error("Not found");
      const bytes = await readFile(file);
      response.writeHead(200, {
        "Content-Type": types[extname(file)] || "application/octet-stream",
        "Content-Length": bytes.length,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) =>
    process.argv
      .find((value) => value.startsWith(`--${name}=`))
      ?.split("=")
      .slice(1)
      .join("=") || fallback;
  const port = Number(arg("port", "8080"));
  const host = arg("host", "127.0.0.1");
  const server = createStaticServer({
    root: resolve(repoRoot, arg("dir", ".")),
  });
  server.listen(port, host, () =>
    console.log(`DPG Video Viewer: http://${host}:${port}`),
  );
}
