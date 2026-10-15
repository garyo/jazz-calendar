/**
 * Builds dist/ for the Worker's asset layer: copies public/, bundles
 * src/main.ts and src/admin.ts, and moves every script and stylesheet to
 * a content-hashed name under /assets/, which public/_headers lets
 * browsers cache for a year. The pages keep their names and are rewritten
 * to load the hashed files. Run with `bun run build`.
 */

import { cp, readdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";

const SITE = join(import.meta.dir, "..");
const ENTRIES = ["src/main.ts", "src/admin.ts"];
const PAGES = ["index.html", "admin.html"];
export const ASSETS = "assets";

/** "styles.css" with its content's hash: "styles-1a2b3c4d5e.css". */
function hashedName(file: string, content: ArrayBuffer): string {
  const hash = new Bun.CryptoHasher("sha256")
    .update(content)
    .digest("hex")
    .slice(0, 10);
  return file.replace(/(\.\w+)$/, `-${hash}$1`);
}

/**
 * Points a page's local script and stylesheet references ("/styles.css")
 * at their hashed copies; a reference with no built file is an error.
 */
export function rewriteRefs(
  html: string,
  hashed: ReadonlyMap<string, string>,
): string {
  return html.replace(
    /\b(href|src)="(\/[^"/]+\.(?:css|js))"/g,
    (_match, attr: string, ref: string) => {
      const target = hashed.get(ref);
      if (!target) throw new Error(`No built file for ${ref}`);
      return `${attr}="${target}"`;
    },
  );
}

/** Builds the site into `outdir`; returns each original path's hashed one. */
export async function build(
  outdir = join(SITE, "dist"),
): Promise<Map<string, string>> {
  const assets = join(outdir, ASSETS);
  await rm(outdir, { recursive: true, force: true });
  await cp(join(SITE, "public"), outdir, { recursive: true });

  const bundle = await Bun.build({
    entrypoints: ENTRIES.map((entry) => join(SITE, entry)),
    outdir: assets,
    naming: "[name]-[hash].[ext]",
    target: "browser",
    minify: true,
    sourcemap: "linked",
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Bundle failed");

  const hashed = new Map<string, string>();
  for (const output of bundle.outputs) {
    if (output.kind !== "entry-point") continue;
    const name = basename(output.path);
    hashed.set(`/${name.replace(/-\w+\.js$/, ".js")}`, `/${ASSETS}/${name}`);
  }
  for (const file of await readdir(outdir)) {
    if (!file.endsWith(".css")) continue;
    const content = await Bun.file(join(outdir, file)).arrayBuffer();
    const name = hashedName(file, content);
    await rename(join(outdir, file), join(assets, name));
    hashed.set(`/${file}`, `/${ASSETS}/${name}`);
  }
  for (const page of PAGES) {
    const path = join(outdir, page);
    await Bun.write(path, rewriteRefs(await Bun.file(path).text(), hashed));
  }
  return hashed;
}

if (import.meta.main) {
  const hashed = await build();
  for (const [from, to] of hashed) console.log(`${from} -> ${to}`);
}
