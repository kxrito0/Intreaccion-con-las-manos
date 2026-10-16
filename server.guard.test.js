/**
 * Boundary tests for the filesystem access guard in server.js.
 *
 * These probes were produced by an independent verification pass that defeated
 * the original purely-lexical guard with a directory junction. They are kept as
 * regression tests so the same escape cannot come back.
 *
 * Run with: node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStaticServer } from "./server.js";

function rawRequest(port, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServedRoot(root, run) {
  const server = createStaticServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * Remove a scratch directory.
 *
 * Windows keeps handles on a freshly written file for a moment (indexer,
 * antivirus, the just-closed server), so a plain `rm` intermittently fails with
 * EBUSY and turns a passing test red. The retry options exist for exactly this.
 * Cleanup failure must never be reported as a test failure.
 */
async function removeScratch(base) {
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
}

/** A scratch directory holding `root/` plus a `secret.txt` outside it. */
async function makeScratch() {
  const base = await mkdtemp(join(tmpdir(), "guard-"));
  const root = `${join(base, "root")}\\`;
  await mkdir(root);
  await writeFile(join(base, "secret.txt"), "TOP SECRET OUTSIDE ROOT");
  return { base, root };
}

test("blocks request-controlled traversal and never leaks file contents", async () => {
  const { base, root } = await makeScratch();

  try {
    await withServedRoot(root, async (port) => {
      const attacks = [
        "/..%2fsecret.txt",
        "/..%5csecret.txt",
        "/..%2f..%2f..%2fsecret.txt",
        "/%2e%2e%2fsecret.txt",
        "/%2E%2E%5Csecret.txt",
        "/%5csecret.txt",
        "/C:%5cWindows%5cwin.ini",
        "/%5c%5cserver%5cshare%5cfile.txt",
      ];

      for (const path of attacks) {
        const response = await rawRequest(port, path);
        assert.equal(response.status, 403, `${path} returned ${response.status}`);
        assert.ok(!response.body.includes("SECRET"), `${path} leaked the secret`);
      }
    });
  } finally {
    await removeScratch(base);
  }
});

test("a double-encoded traversal decodes once and cannot escape the root", async () => {
  const { base, root } = await makeScratch();

  try {
    await withServedRoot(root, async (port) => {
      // Decoded once this is the literal filename "..%2fsecret.txt", which is a
      // normal name inside the root, not a traversal. It does not exist, so 404.
      const response = await rawRequest(port, "/..%252fsecret.txt");
      assert.equal(response.status, 404);
      assert.ok(!response.body.includes("SECRET"), "double decode escaped the root");
    });
  } finally {
    await removeScratch(base);
  }
});

test("a sibling directory sharing the root's name prefix is not served", async () => {
  const { base, root } = await makeScratch();

  try {
    await mkdir(join(base, "rootX"));
    await writeFile(join(base, "rootX", "leak.txt"), "SIBLING PREFIX LEAK");
    await withServedRoot(root, async (port) => {
      const response = await rawRequest(port, "/..%2frootX%2fleak.txt");
      assert.equal(response.status, 403);
      assert.ok(!response.body.includes("SIBLING PREFIX LEAK"));
    });
  } finally {
    await removeScratch(base);
  }
});

test("malformed and hostile targets return 404 without killing the server", async () => {
  const { base } = await makeScratch();

  try {
    await writeFile(join(base, "ok.txt"), "ok");
    await withServedRoot(`${base}\\`, async (port) => {
      for (const path of ["/%ff", "/%c0%af", "/%zz", "/a%00b.txt", `/${"a".repeat(5000)}`]) {
        const response = await rawRequest(port, path);
        assert.equal(response.status, 404, `${path} returned ${response.status}`);
      }

      // The process must still be healthy afterwards.
      assert.equal((await rawRequest(port, "/ok.txt")).status, 200);
    });
  } finally {
    await removeScratch(base);
  }
});

test("a symlink or junction inside the root cannot expose files outside it", async (t) => {
  const { base, root } = await makeScratch();

  try {
    // A file named index.html outside the root, so the directory-substitution
    // path (`<dir>` -> `<dir>/index.html`) is exercised as well.
    await writeFile(join(base, "index.html"), "TOP SECRET OUTSIDE ROOT");

    try {
      await symlink(base, join(root, "link"), "junction");
    } catch {
      t.skip("symlink/junction not permitted on this host");
      return;
    }

    await withServedRoot(root, async (port) => {
      for (const path of ["/link/secret.txt", "/link", "/link/index.html"]) {
        const response = await rawRequest(port, path);
        assert.equal(response.status, 403, `${path} returned ${response.status}`);
        assert.ok(!response.body.includes("SECRET"), `${path} leaked the secret`);
      }
    });
  } finally {
    // Unlink the reparse point explicitly before a recursive removal, so
    // nothing ever has to walk into it.
    await rm(join(root, "link"), { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    await removeScratch(base);
  }
});

test("importing server.js does not start a listener", async () => {
  const { spawn } = await import("node:child_process");
  const serverUrl = new URL("./server.js", import.meta.url).href;
  const code = `import ${JSON.stringify(serverUrl)}; console.log("imported");`;

  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const exited = await Promise.race([
    new Promise((resolve) => child.on("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);

  if (!exited) child.kill();
  assert.equal(exited, true, "import kept the process alive — it started listening");
});
