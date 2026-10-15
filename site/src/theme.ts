/**
 * Visual themes, chosen with ?theme= or the footer switcher while the owner
 * compares them. The inline script in index.html applies the saved choice
 * and loads its fonts before first paint; this module handles switching
 * afterwards.
 */

/**
 * Each theme's Google Fonts families, with only the axes, weights and
 * styles its stylesheet uses. A single weight gets a small static file; a
 * range gets one variable file. The inline script in index.html carries a
 * copy of this table (theme.test.ts checks they match).
 */
export const THEME_FONTS = {
  guide: ["Source+Serif+4:wght@500..650"],
  program: ["IBM+Plex+Mono:wght@400;500", "IBM+Plex+Sans:wght@400;500;600"],
  lateset: ["Archivo:wdth,wght@62..100,400..800"],
  club: ["Fraunces:ital,wght@0,400..600;1,400"],
  liner: [
    "IBM+Plex+Mono:wght@400;500",
    "IBM+Plex+Sans:wght@400;500;600",
    "Source+Serif+4:ital,wght@0,600;1,400",
  ],
  hardbop: ["Archivo:wght@400..800"],
  evening: [
    "IBM+Plex+Mono:wght@400;500",
    "IBM+Plex+Sans:wght@400;500;600",
    "Jost:wght@500..600",
  ],
  broadsheet: [
    "Libre+Caslon+Text:ital,wght@0,700;1,400",
    "Libre+Franklin:wght@400..700",
  ],
} as const satisfies Record<string, readonly string[]>;

export type Theme = keyof typeof THEME_FONTS;
export const THEMES = Object.keys(THEME_FONTS) as Theme[];
export const DEFAULT_THEME: Theme = "liner";
const STORAGE_KEY = "theme";

function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value);
}

function currentTheme(): Theme {
  const theme = document.documentElement.dataset.theme;
  return isTheme(theme) ? theme : DEFAULT_THEME;
}

/** The Google Fonts stylesheet for a theme's families. */
export function fontsHref(theme: Theme): string {
  const families = THEME_FONTS[theme].join("&family=");
  return `https://fonts.googleapis.com/css2?family=${families}&display=swap`;
}

/** Adds a theme's font stylesheet, unless the page already has it. */
function loadFonts(theme: Theme): void {
  const loaded = document.head.querySelectorAll<HTMLLinkElement>(
    "link[data-theme-fonts]",
  );
  if ([...loaded].some((link) => link.dataset.themeFonts === theme)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = fontsHref(theme);
  link.dataset.themeFonts = theme;
  document.head.append(link);
}

function setTheme(theme: Theme): void {
  loadFonts(theme);
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage can be blocked; the theme still applies to this page.
  }
}

/** Wires the switcher's buttons (each with data-theme-choice). */
export function themeSwitcher(
  container: HTMLElement,
  onChange: () => void,
): void {
  const buttons = [
    ...container.querySelectorAll<HTMLButtonElement>("[data-theme-choice]"),
  ];
  const sync = () => {
    const active = currentTheme();
    for (const button of buttons) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.themeChoice === active),
      );
    }
  };
  container.addEventListener("click", (event) => {
    const choice = (event.target as Element).closest<HTMLButtonElement>(
      "[data-theme-choice]",
    )?.dataset.themeChoice;
    if (!isTheme(choice) || choice === currentTheme()) return;
    setTheme(choice);
    sync();
    onChange();
  });
  sync();
}
