/**
 * Visual themes, chosen with ?theme= or the footer switcher while the owner
 * compares them. The inline script in index.html applies the saved choice
 * before first paint; this module handles switching afterwards.
 */

export const THEMES = [
  "guide",
  "program",
  "lateset",
  "club",
  "liner",
  "bluenote",
  "evening",
  "broadsheet",
] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "program";
const STORAGE_KEY = "theme";

export function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value);
}

export function currentTheme(): Theme {
  const theme = document.documentElement.dataset.theme;
  return isTheme(theme) ? theme : DEFAULT_THEME;
}

function setTheme(theme: Theme): void {
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
