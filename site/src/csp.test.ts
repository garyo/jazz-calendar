import { describe, expect, test } from "bun:test";
import { COLLECT_URL, TRACKER_URL } from "./analytics";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

/** Each _headers rule's Content-Security-Policy, by path pattern. */
function policies(headers: string): Map<string, Map<string, string[]>> {
  const result = new Map<string, Map<string, string[]>>();
  let path = "";
  for (const line of headers.split("\n")) {
    if (/^\S/.test(line) && !line.startsWith("#")) path = line.trim();
    const csp = line.match(/^\s+Content-Security-Policy:\s*(.+)$/)?.[1];
    if (!csp) continue;
    const directives = csp.split(";").map((d) => d.trim().split(/\s+/));
    result.set(
      path,
      new Map(directives.map(([name, ...sources]) => [name, sources])),
    );
  }
  return result;
}

/** Every local module `entry` pulls in, as paths relative to src/. */
async function importGraph(entry: string): Promise<Set<string>> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const visit = async (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const imports = transpiler.scanImports(await read(file));
    for (const { path } of imports) {
      if (path.startsWith("./")) await visit(`${path}.ts`);
    }
  };
  await visit(entry);
  return seen;
}

const headers = policies(await read("../public/_headers"));

describe("Content-Security-Policy", () => {
  test("allows the analytics tracker and endpoint by exact URL only", () => {
    const site = headers.get("/*");
    expect(site?.get("script-src")).toContain(TRACKER_URL);
    expect(site?.get("connect-src")).toContain(COLLECT_URL);
    for (const sources of site?.values() ?? []) {
      for (const source of sources) {
        if (source.includes("analytics.")) {
          expect([TRACKER_URL, COLLECT_URL]).toContain(source);
        }
      }
    }
  });

  test("the review page runs only its own scripts and talks only home", () => {
    const admin = headers.get("/admin*");
    expect(admin?.get("script-src")).toEqual(["'self'"]);
    expect(admin?.get("connect-src")).toEqual(["'self'"]);
  });
});

describe("the review page", () => {
  test("never loads analytics", async () => {
    const html = await read("../public/admin.html");
    expect(html).not.toContain("analytics");
    expect([...html.matchAll(/<script[^>]*>/g)].map(([tag]) => tag)).toEqual([
      '<script type="module" src="/admin.js">',
    ]);
    const modules = await importGraph("./admin.ts");
    expect(modules).toContain("./submit.ts");
    expect(modules).not.toContain("./analytics.ts");
  });
});
