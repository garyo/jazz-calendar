import { describe, expect, test } from "bun:test";
import {
  buildMenu,
  fileSlug,
  renderAddToCalendar,
  wireCalendarMenus,
} from "./calendar-menu";
import { creditsById } from "./credits";
import { sample, useDom } from "./testing";

useDom();

const credits = creditsById(sample.sources);
const [event] = sample.events;
const venue = sample.venues.find((v) => v.id === event.venue);

const menu = () =>
  renderAddToCalendar(event, venue, ` for ${event.title}`, credits, []);

describe("an add-to-calendar menu", () => {
  test("starts with only its summary", () => {
    const details = menu();
    expect(details.querySelector("summary")?.textContent).toBe(
      `Add to calendar for ${event.title}`,
    );
    expect(details.querySelector(".menu")).toBeNull();
  });

  test("gets its items once, when first built", () => {
    const details = menu();
    buildMenu(details);
    buildMenu(details);
    expect(details.querySelectorAll(".menu")).toHaveLength(1);
    const google = details.querySelector<HTMLAnchorElement>("a.menu-item");
    expect(google?.href).toStartWith(
      "https://calendar.google.com/calendar/render?action=TEMPLATE",
    );
    expect(details.querySelector("button.menu-item")?.textContent).toBe(
      "Apple, Outlook (.ics)",
    );
  });

  test("is built by a click on its summary", () => {
    const root = document.createElement("div");
    const details = menu();
    root.append(details);
    document.body.replaceChildren(root);
    wireCalendarMenus(root);
    details.querySelector("summary")?.click();
    expect(details.querySelector(".menu")).not.toBeNull();
  });
});

test("fileSlug", () => {
  expect(fileSlug("Café Jam: Late Set!")).toBe("cafe-jam-late-set");
  expect(fileSlug("¡!")).toBe("event");
});
