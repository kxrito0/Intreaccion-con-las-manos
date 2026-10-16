/**
 * Zero-dependency static file server.
 *
 * Why this exists instead of `python -m http.server`: Python is not installed on
 * the target machine, and the browser needs a *secure context* to hand over the
 * camera. `file://` is not a secure context, but `http://127.0.0.1` and
 * `http://localhost` are. So the project ships its own tiny server.
 *
 * Run with: node server.js
 */

import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, always with a trailing separator. */
const ROOT = fileURLToPath(new URL(".", import.meta.url));

export const DEFAULT_PORT = 4173;
export const DEFAULT_HOST = "127.0.0.1";

export const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  // Must be a JavaScript type, otherwise the browser refuses to evaluate the
  // <script type="module"> entrypoint.
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
});

function respond(response, status, contentType, body) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-cache",
  });
  response.end(body);
}

/**
 * Resolve a request path to a file inside `root`, or null when it escapes.
 *
 * `root` ends with a separator, so the prefix check cannot be fooled by a
 * sibling directory whose name merely starts with the same characters.
 *
 * This check is deliberately lexical and is only the first of two: it rejects
 * obvious traversals before touching the disk. It cannot see reparse points, so
 * `isWithinRoot` below finishes the job on real paths.
 */
function resolveWithin(root, relative) {
  const requested = resolve(root, normalize(relative));
  if (requested !== root && !requested.startsWith(root)) return null;
  return requested;
}

/** Windows paths are case-insensitive; POSIX paths are not. */
const CASE_INSENSITIVE_PATHS = process.platform === "win32";

function foldCase(path) {
  return CASE_INSENSITIVE_PATHS ? path.toLowerCase() : path;
}

/**
 * True when `candidate` is `root` itself or lives inside it.
 *
 * Both arguments must already be real paths, so that this compares what is
 * actually on disk rather than what the request string claimed.
 */
function isWithinRoot(root, candidate) {
  const rootKey = foldCase(root);
  const candidateKey = foldCase(candidate);
  return candidateKey === rootKey || candidateKey.startsWith(rootKey + sep);
}

/** Build the HTTP server. Does not listen. */
export function createStaticServer({ root = ROOT, mimeTypes = MIME_TYPES } = {}) {
  // Real path of the served root, resolved once and reused for the process
  // lifetime of this server.
  let realRootPromise = null;
  const realRoot = () => {
    realRootPromise ??= realpath(root).catch(() => resolve(root));
    return realRootPromise;
  };

  return createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url, `http://${request.headers.host ?? DEFAULT_HOST}`);
      const relative =
        pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");

      const requested = resolveWithin(root, relative);
      if (requested === null) {
        respond(response, 403, "text/plain; charset=utf-8", "403 Forbidden");
        return;
      }

      const info = await stat(requested).catch(() => null);
      const filePath = info?.isDirectory() ? join(requested, "index.html") : requested;

      // A lexical check is not enough on Windows. A junction or symlink placed
      // inside the root passes the prefix check, and then stat()/readFile()
      // happily follow it out of the served tree. Compare real paths instead.
      const [rootRealPath, fileRealPath] = await Promise.all([
        realRoot(),
        realpath(filePath).catch(() => null),
      ]);

      if (fileRealPath === null) {
        respond(response, 404, "text/plain; charset=utf-8", "404 Not Found");
        return;
      }

      if (!isWithinRoot(rootRealPath, fileRealPath)) {
        respond(response, 403, "text/plain; charset=utf-8", "403 Forbidden");
        return;
      }

      const body = await readFile(filePath);
      respond(response, 200, mimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream", body);
    } catch {
      respond(response, 404, "text/plain; charset=utf-8", "404 Not Found");
    }
  });
}

/** Create the server and start listening. */
export function startServer({ port = DEFAULT_PORT, host = DEFAULT_HOST, root = ROOT } = {}) {
  const server = createStaticServer({ root });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`\n  Port ${port} is already in use.`);
      console.error(`  Try another one:  $env:PORT=5000; node server.js\n`);
    } else {
      console.error(`\n  Server error: ${error.message}\n`);
    }
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    console.log("");
    console.log("  Pinch to Size — running");
    console.log("");
    console.log(`  Open  http://${host}:${port}`);
    console.log("");
    console.log("  The camera requires a secure context: localhost counts, file:// does not.");
    console.log("  Press Ctrl+C to stop.");
    console.log("");
  });

  return server;
}

/** True when this file is the entrypoint rather than an import. */
function isEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isEntrypoint()) {
  startServer({ port: Number(process.env.PORT ?? DEFAULT_PORT) });
}
