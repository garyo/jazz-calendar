import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSETS, build, rewriteRefs } from "./build";

const outdir = await mkdtemp(join(tmpdir(), "site-build-"));
afterAll(() => rm(outdir, { recursive: true, force: true }));
const hashed = await build(outdir);
const read = (path: string) => Bun.file(join(outdir, path)).text();

/** A page's local script and stylesheet references. */
async function refs(page: string): Promise<string[]> {
  const html = await read(page);
  return [...html.matchAll(/\b(?:href|src)="(\/[^"]+\.(?:css|js))"/g)].map(
    ([, ref]) => ref,
  );
}

describe("the build", () => {
  test("gives every script and stylesheet a hashed name", async () => {
    expect([...hashed.keys()]).toContain("/main.js");
    expect([...hashed.keys()]).toContain("/admin.js");
    expect([...hashed.keys()]).toContain("/theme-liner.css");
    for (const target of hashed.values()) {
      expect(target).toMatch(/^\/assets\/[\w-]+-\w{6,}\.(css|js)$/);
      expect(await Bun.file(join(outdir, target)).exists()).toBe(true);
    }
    const root = await readdir(outdir);
    expect(root.filter((file) => /\.(css|js)$/.test(file))).toEqual([]);
  });

  test("points the pages at files that exist", async () => {
    for (const page of ["index.html", "admin.html"]) {
      const found = await refs(page);
      expect(found.length).toBeGreaterThan(0);
      for (const ref of found) {
        expect(ref).toStartWith(`/${ASSETS}/`);
        expect(await Bun.file(join(outdir, ref)).exists()).toBe(true);
      }
    }
  });

  test("keeps the pre-paint script, so its CSP hash still matches", async () => {
    const source = await Bun.file(
      new URL("../public/index.html", import.meta.url),
    ).text();
    const inline = (html: string) => html.match(/<script>[^<]*<\/script>/)?.[0];
    expect(inline(await read("index.html"))).toBe(inline(source));
  });

  test("hashed files get a year's caching, and nothing else does", async () => {
    const headers = await read("_headers");
    const rule = headers.match(/^\/assets\/\*\n((?:[ \t]+.*\n?)+)/m)?.[1];
    expect(rule).toContain(
      "Cache-Control: public, max-age=31536000, immutable",
    );
    expect(headers.match(/^\s+Cache-Control:/gm)).toHaveLength(1);
  });
});

test("rewriteRefs rejects a reference with no built file", () => {
  expect(() => rewriteRefs('<link href="/missing.css">', new Map())).toThrow(
    "No built file for /missing.css",
  );
  expect(
    rewriteRefs(
      '<a href="/">home</a><script src="/a.js"></script>',
      new Map([["/a.js", "/assets/a-1.js"]]),
    ),
  ).toBe('<a href="/">home</a><script src="/assets/a-1.js"></script>');
});
