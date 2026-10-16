/**
 * Tests for the static server (spec AC10, and the filesystem access guard).
 *
 * The guard is a security boundary: it decides which files on disk the server is
 * willing to hand out. These tests pin it with raw HTTP requests, bypassing
 * `fetch`, because `fetch` would normalise `..` segments away before the server
 * ever sees them — which is exactly the input the guard exists to handle.
 *
 * Run with: node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { createStaticServer } from "./server.js";

async function withServer(run) {
  const server = createStaticServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await run(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Send a request with the exact path bytes, no client-side normalisation. */
function rawRequest(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode, contentType: res.headers["content-type"], body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("serves index.html at the root", async () => {
  await withServer(async (port) => {
    const response = await rawRequest(port, "/");
    assert.equal(response.status, 200);
    assert.match(response.contentType, /text\/html/);
    assert.match(response.body, /Pinch to Size/);
  });
});

test("serves .js as a JavaScript content type so ES modules evaluate", async () => {
  await withServer(async (port) => {
    const response = await rawRequest(port, "/pinch.js");
    assert.equal(response.status, 200);
    assert.match(response.contentType, /javascript/);
    assert.match(response.body, /export function pinchRatio/);
  });
});

test("serves nested files", async () => {
  await withServer(async (port) => {
    const response = await rawRequest(port, "/specs/hand-pinch-ball.md");
    assert.equal(response.status, 200);
  });
});

test("returns 404 for a missing file instead of crashing", async () => {
  await withServer(async (port) => {
    const response = await rawRequest(port, "/does-not-exist.js");
    assert.equal(response.status, 404);
  });
});

test("blocks an encoded traversal that escapes the served root", async () => {
  await withServer(async (port) => {
    // %2f and %5c are not decoded by the URL parser, so each of these arrives as
    // a single path segment and only the server-side guard can stop it.
    for (const path of [
      "/..%2f..%2fsecret.txt",
      "/..%2f..%2f..%2fWindows%2fwin.ini",
      "/%2e%2e%2f%2e%2e%2fpackage.json",
      "/..%5c..%5cWindows%5cwin.ini",
    ]) {
      const response = await rawRequest(port, path);
      assert.equal(response.status, 403, `${path} should be forbidden, got ${response.status}`);
      assert.equal(response.body, "403 Forbidden", `${path} leaked a file body`);
    }
  });
});

test("a literal .. is collapsed by the URL parser and never escapes the root", async () => {
  await withServer(async (port) => {
    // The URL parser normalises /../../etc/passwd down to /etc/passwd, which
    // resolves to <root>/etc/passwd: inside the root, absent, so 404. The point
    // is that it can never resolve outside the served directory.
    const response = await rawRequest(port, "/../../../../../etc/passwd");
    assert.equal(response.status, 404);
  });
});

test("still serves a path that uses .. but stays inside the root", async () => {
  await withServer(async (port) => {
    const response = await rawRequest(port, "/specs/../README.md");
    assert.equal(response.status, 200);
    assert.match(response.body, /Pinch to Size/);
  });
});

test("does not list a directory that has no index.html", async () => {
  await withServer(async (port) => {
    const response = await rawRequest(port, "/specs");
    assert.equal(response.status, 404);
  });
});
