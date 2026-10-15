import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DEFAULT_THEME, THEMES } from "./theme";

const html = await Bun.file(
  new URL("../public/index.html", import.meta.url),
).text();
const headers = await Bun.file(
  new URL("../public/_headers", import.meta.url),
).text();
const inline = html.match(/<script>([^<]*)<\/script>/)?.[1] ?? "";

/** Runs the pre-paint script against a fake URL and storage. */
function runInline(
  search: string,
  stored: string | null,
  storage: "ok" | "blocked" = "ok",
): { theme: string | undefined; stored: string | null } {
  let saved = stored;
  const localStorage = {
    getItem: () => {
      if (storage === "blocked") throw new Error("blocked");
      return saved;
    },
    setItem: (_key: string, value: string) => {
      if (storage === "blocked") throw new Error("blocked");
      saved = value;
    },
  };
  const document = { documentElement: { dataset: {} as DOMStringMap } };
  new Function("location", "localStorage", "document", inline)(
    { search },
    localStorage,
    document,
  );
  return { theme: document.documentElement.dataset.theme, stored: saved };
}

describe("pre-paint theme script", () => {
  test("is allowed by the CSP", () => {
    const hash = createHash("sha256").update(inline).digest("base64");
    expect(inline).not.toBe("");
    expect(headers).toContain(`'sha256-${hash}'`);
  });

  test("knows every theme and the default", () => {
    for (const theme of THEMES) {
      expect(runInline(`?theme=${theme}`, null).theme).toBe(theme);
    }
    expect(runInline("", null).theme).toBe(DEFAULT_THEME);
  });

  test("saves a theme from the query string", () => {
    expect(runInline("?when=week&theme=guide", "club")).toEqual({
      theme: "guide",
      stored: "guide",
    });
  });

  test("falls back to the saved theme, then the default", () => {
    expect(runInline("?theme=nope", "lateset").theme).toBe("lateset");
    expect(runInline("", "nope").theme).toBe(DEFAULT_THEME);
  });

  test("works without storage", () => {
    expect(runInline("?theme=guide", null, "blocked").theme).toBe("guide");
    expect(runInline("", null, "blocked").theme).toBe(DEFAULT_THEME);
  });
});
