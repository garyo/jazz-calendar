import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { useDom } from "./testing";
import {
  DEFAULT_THEME,
  fontsHref,
  THEME_FONTS,
  THEMES,
  themeSwitcher,
} from "./theme";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const html = await read("../public/index.html");
const headers = await read("../public/_headers");
const inline = html.match(/<script>([^<]*)<\/script>/)?.[1] ?? "";

interface Inline {
  theme: string | undefined;
  stored: string | null;
  /** The font stylesheet link it added. */
  fonts: { rel?: string; href?: string; dataset: DOMStringMap };
}

/** Runs the pre-paint script against a fake URL, storage and document. */
function runInline(
  search: string,
  stored: string | null,
  storage: "ok" | "blocked" = "ok",
): Inline {
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
  const added: Inline["fonts"][] = [];
  const document = {
    documentElement: { dataset: {} as DOMStringMap },
    createElement: () => ({ dataset: {} }),
    head: { append: (link: Inline["fonts"]) => added.push(link) },
  };
  new Function("location", "localStorage", "document", inline)(
    { search },
    localStorage,
    document,
  );
  expect(added).toHaveLength(1);
  return {
    theme: document.documentElement.dataset.theme,
    stored: saved,
    fonts: added[0],
  };
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

  test("loads only the theme's fonts, as THEME_FONTS lists them", () => {
    for (const theme of THEMES) {
      const { fonts } = runInline(`?theme=${theme}`, null);
      expect(fonts).toEqual({
        rel: "stylesheet",
        href: fontsHref(theme),
        dataset: { themeFonts: theme },
      });
    }
  });

  test("every theme has a stylesheet and a switcher button", () => {
    for (const theme of THEMES) {
      expect(html).toContain(`href="/theme-${theme}.css"`);
      expect(html).toContain(`data-theme-choice="${theme}"`);
    }
  });

  test("saves a theme from the query string", () => {
    expect(runInline("?when=week&theme=guide", "club")).toMatchObject({
      theme: "guide",
      stored: "guide",
    });
  });

  test("falls back to the saved theme, then the default", () => {
    expect(runInline("?theme=nope", "lateset").theme).toBe("lateset");
    expect(runInline("", "nope").theme).toBe(DEFAULT_THEME);
    expect(runInline("?theme=toString", "constructor").theme).toBe(
      DEFAULT_THEME,
    );
  });

  test("works without storage", () => {
    expect(runInline("?theme=guide", null, "blocked").theme).toBe("guide");
    expect(runInline("", null, "blocked").theme).toBe(DEFAULT_THEME);
  });
});

describe("THEME_FONTS", () => {
  /** The first family of each --font-* in a theme's stylesheet. */
  async function cssFamilies(theme: string): Promise<string[]> {
    const css = await read(`../public/theme-${theme}.css`);
    const names = [...css.matchAll(/--font-\w+:\s*"([^"]+)"/g)].map(
      ([, name]) => name,
    );
    return [...new Set(names)].sort();
  }

  test("names exactly the families each theme's stylesheet uses", async () => {
    for (const theme of THEMES) {
      const families = THEME_FONTS[theme].map((spec) =>
        spec.split(":")[0].replaceAll("+", " "),
      );
      expect(families.sort()).toEqual(await cssFamilies(theme));
    }
  });

  test("asks for no optical-size axis", () => {
    for (const theme of THEMES) expect(fontsHref(theme)).not.toContain("opsz");
  });
});

describe("the switcher", () => {
  useDom();

  test("loads a theme's fonts once, on first choosing it", () => {
    document.documentElement.dataset.theme = DEFAULT_THEME;
    const container = document.createElement("div");
    for (const theme of THEMES) {
      const button = document.createElement("button");
      button.dataset.themeChoice = theme;
      container.append(button);
    }
    let changes = 0;
    themeSwitcher(container, () => changes++);
    const choose = (theme: string) =>
      container
        .querySelector<HTMLButtonElement>(`[data-theme-choice="${theme}"]`)
        ?.click();
    const links = () =>
      [
        ...document.head.querySelectorAll<HTMLLinkElement>(
          "link[data-theme-fonts]",
        ),
      ].map((link) => link.href);

    choose("guide");
    choose("club");
    choose("guide");
    expect(document.documentElement.dataset.theme).toBe("guide");
    expect(links()).toEqual([fontsHref("guide"), fontsHref("club")]);
    expect(changes).toBe(3);
    expect(
      container
        .querySelector('[data-theme-choice="guide"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
