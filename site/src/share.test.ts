import { beforeEach, describe, expect, test } from "bun:test";
import { qrPath, qrSvg, sharePanel, shareUrl } from "./share";
import { loadPage, useDom } from "./testing";

useDom("https://bostonjazzcalendar.com/?venue=abc&when=weekend#submit");

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

beforeEach(() => {
  loadPage();
  sharePanel();
});

describe("shareUrl", () => {
  test("keeps the view's query and drops the fragment", () => {
    expect(shareUrl(location)).toBe(
      "https://bostonjazzcalendar.com/?venue=abc&when=weekend",
    );
  });
});

describe("qrPath", () => {
  test("draws a square code with the three finder patterns", () => {
    const { size, d } = qrPath("https://bostonjazzcalendar.com/");
    // Version 1 is 21 modules a side, and each version adds 4.
    expect((size - 17) % 4).toBe(0);
    // A finder pattern's top-left corner is dark at all three corners.
    for (const [x, y] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ]) {
      expect(d).toContain(`M${x} ${y}h1v1h-1z`);
    }
  });

  test("differs for different addresses", () => {
    expect(qrPath("https://a.example/").d).not.toBe(
      qrPath("https://b.example/").d,
    );
  });
});

describe("qrSvg", () => {
  test("is black on white with a quiet zone, and uses no inline style", () => {
    const svg = qrSvg("https://bostonjazzcalendar.com/");
    const { size } = qrPath("https://bostonjazzcalendar.com/");
    expect(svg.getAttribute("viewBox")).toBe(`-4 -4 ${size + 8} ${size + 8}`);
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.querySelector("rect")?.getAttribute("fill")).toBe("#fff");
    expect(svg.querySelector("path")?.getAttribute("fill")).toBe("#000");
    expect(svg.outerHTML).not.toContain("style=");
  });
});

describe("the share panel", () => {
  test("starts closed and draws nothing", () => {
    expect(el("share-panel").hidden).toBe(true);
    expect(el("share-qr").children.length).toBe(0);
  });

  test("shows a code for the current address when opened", () => {
    el("share-toggle").click();
    expect(el("share-panel").hidden).toBe(false);
    expect(el("share-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(el("share-qr").querySelector("svg")).not.toBeNull();
    expect(el("share-url").textContent).toBe(
      "https://bostonjazzcalendar.com/?venue=abc&when=weekend",
    );
  });

  test("closes on Escape", () => {
    el("share-toggle").click();
    el("share-toggle").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(el("share-panel").hidden).toBe(true);
  });
});
