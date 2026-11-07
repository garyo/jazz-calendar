/**
 * `bun run dev`: builds dist/, serves it with `wrangler dev` (arguments
 * pass through, e.g. `bun run dev -- --port 8790`), and rebuilds whenever
 * public/ or src/ changes. Each page also loads /dev-reload.js, which
 * reloads it after a rebuild. Wrangler's own --live-reload can't do this:
 * it injects an inline script, which the pages' Content-Security-Policy
 * blocks.
 */

import { watch } from "node:fs";
import { join } from "node:path";
import { build, PAGES } from "./build";

const SITE = join(import.meta.dir, "..");
const DIST = join(SITE, "dist");
const STAMP = "dev-build.txt";

/** Polls the build stamp and reloads the page when a rebuild changes it. */
const RELOADER = `(() => {
  let seen;
  setInterval(async () => {
    try {
      const response = await fetch("/${STAMP}", { cache: "no-store" });
      if (!response.ok) return;
      const stamp = await response.text();
      if (seen && stamp !== seen) location.reload();
      seen = stamp;
    } catch {}
  }, 1000);
})();
`;

async function devBuild(): Promise<void> {
  await build(DIST);
  await Bun.write(join(DIST, "dev-reload.js"), RELOADER);
  for (const page of PAGES) {
    const path = join(DIST, page);
    const html = await Bun.file(path).text();
    await Bun.write(
      path,
      html.replace("</body>", '<script src="/dev-reload.js"></script></body>'),
    );
  }
  await Bun.write(join(DIST, STAMP), String(Date.now()));
}

await devBuild();

const wrangler = Bun.spawn(
  ["bunx", "wrangler", "dev", ...process.argv.slice(2)],
  { cwd: SITE, stdio: ["inherit", "pipe", "inherit"] },
);
process.on("SIGINT", () => wrangler.kill());
process.on("SIGTERM", () => wrangler.kill());

// Pass wrangler's output through, less its log line for every poll.
(async () => {
  const reader = wrangler.stdout
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = (rest + value).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.includes(`/${STAMP}`)) process.stdout.write(`${line}\n`);
    }
  }
  if (rest) process.stdout.write(rest);
})();

// One rebuild at a time; a burst of saves becomes one more rebuild.
let pending: Promise<void> = Promise.resolve();
let timer: Timer | undefined;
function rebuild(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    pending = pending
      .then(devBuild)
      .then(() => console.log("[dev] rebuilt dist/"))
      .catch((error: unknown) => console.error("[dev] build failed:", error));
  }, 100);
}
for (const dir of ["public", "src"]) {
  watch(join(SITE, dir), { recursive: true }, rebuild);
}

process.exit(await wrangler.exited);
