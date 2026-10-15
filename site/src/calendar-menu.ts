/**
 * Each show's "Add to calendar" menu: a Google Calendar link and an .ics
 * download. A menu's items are built when it first opens, so a long list
 * renders only a <details> and its summary per show. One menu is open at a
 * time; Escape, a click outside or picking an item closes it.
 */

import { buildCalendar, googleEventUrl } from "./calendar-export";
import type { Credits } from "./credits";
import { h, srOnly } from "./dom";
import { ASSUMED_DURATION_MS, normalize } from "./listings";
import type { CalendarEvent, SourceCredit, Venue } from "./types";

const MENU = "details.add-to-calendar";

/** Menus not yet opened, each with what builds its items. */
const unbuilt = new WeakMap<HTMLDetailsElement, () => HTMLElement>();

/** Saves text as a file via a temporary object URL. */
function downloadFile(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  h("a", { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** "Lilypad Jam Session" -> "lilypad-jam-session". */
export function fileSlug(text: string): string {
  const slug = normalize(text)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "event";
}

function menuItems(
  event: CalendarEvent,
  venue: Venue | undefined,
  credits: Credits,
  via: readonly SourceCredit[],
): HTMLUListElement {
  const download = h(
    "button",
    { type: "button", class: "menu-item" },
    "Apple, Outlook (.ics)",
  );
  download.addEventListener("click", () => {
    const venues = new Map(venue ? [[venue.id, venue]] : []);
    const ics = buildCalendar([event], venues, {
      name: event.title,
      stamp: new Date(),
      credits,
    });
    downloadFile(`${fileSlug(event.title)}.ics`, ics, "text/calendar");
  });
  return h(
    "ul",
    { class: "popover menu" },
    h(
      "li",
      {},
      h(
        "a",
        {
          class: "menu-item",
          href: googleEventUrl(event, venue, ASSUMED_DURATION_MS, via),
          target: "_blank",
          rel: "noopener",
        },
        "Google Calendar",
      ),
    ),
    h("li", {}, download),
  );
}

/** A show's menu, closed and still empty; `about` names the show for screen readers. */
export function renderAddToCalendar(
  event: CalendarEvent,
  venue: Venue | undefined,
  about: string,
  credits: Credits,
  via: readonly SourceCredit[],
): HTMLDetailsElement {
  const menu = h(
    "details",
    { class: "add-to-calendar" },
    h(
      "summary",
      { class: "add-to-calendar-toggle", title: "Add to calendar" },
      h("span", { class: "icon icon-calendar", "aria-hidden": "true" }),
      h("span", { class: "add-to-calendar-label" }, "Add to calendar"),
      srOnly(about),
    ),
  );
  unbuilt.set(menu, () => menuItems(event, venue, credits, via));
  return menu;
}

/** Adds a menu's items, once. */
export function buildMenu(menu: HTMLDetailsElement): void {
  const build = unbuilt.get(menu);
  if (!build) return;
  unbuilt.delete(menu);
  menu.append(build());
}

/** Wires the menus rendered anywhere inside `root`. */
export function wireCalendarMenus(root: HTMLElement): void {
  const openMenus = () =>
    document.querySelectorAll<HTMLDetailsElement>(`${MENU}[open]`);
  // A click on the summary runs before the menu opens, so its items are
  // there for the first frame.
  root.addEventListener("click", (event) => {
    const target = event.target as Element;
    const summary = target.closest(`${MENU} > summary`);
    if (summary) {
      buildMenu(summary.parentElement as HTMLDetailsElement);
      return;
    }
    const menu = target
      .closest(".menu-item")
      ?.closest<HTMLDetailsElement>(MENU);
    if (menu) menu.open = false;
  });
  root.addEventListener(
    "toggle",
    (event) => {
      const menu = event.target as HTMLDetailsElement;
      if (!menu.matches(MENU) || !menu.open) return;
      buildMenu(menu);
      for (const other of openMenus()) if (other !== menu) other.open = false;
    },
    true,
  );
  document.addEventListener("pointerdown", (event) => {
    for (const menu of openMenus()) {
      if (!menu.contains(event.target as Node)) menu.open = false;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const menu = (event.target as Element).closest?.<HTMLDetailsElement>(
      `${MENU}[open]`,
    );
    if (!menu) return;
    menu.open = false;
    menu.querySelector("summary")?.focus();
  });
}
