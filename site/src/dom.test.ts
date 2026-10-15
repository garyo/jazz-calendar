import { describe, expect, test } from "bun:test";
import { byId, h, safeUrl, srOnly } from "./dom";
import { useDom } from "./testing";

useDom();

describe("h", () => {
  test("sets attributes and appends children, skipping empty ones", () => {
    const el = h(
      "a",
      { href: "/x", title: null, rel: undefined },
      "one",
      null,
      false,
      undefined,
      h("b", {}, "two"),
    );
    expect(el.outerHTML).toBe('<a href="/x">one<b>two</b></a>');
  });
});

test("srOnly", () => {
  expect(srOnly("hi").outerHTML).toBe('<span class="sr-only">hi</span>');
});

test("byId finds an element or throws", () => {
  document.body.replaceChildren(h("p", { id: "here" }));
  expect(byId("here").tagName).toBe("P");
  expect(() => byId("missing")).toThrow("Missing #missing");
});

describe("safeUrl", () => {
  test("keeps http and https links, normalized", () => {
    expect(safeUrl("https://example.com")).toBe("https://example.com/");
    expect(safeUrl("http://example.com/a?b=1")).toBe(
      "http://example.com/a?b=1",
    );
  });

  test("drops other schemes, junk and nothing", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("mailto:a@example.com")).toBeNull();
    expect(safeUrl("not a url")).toBeNull();
    expect(safeUrl("")).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });
});
