import { describe, expect, test } from "bun:test";
import { byId, h, placeChildren, reuse, safeUrl, srOnly } from "./dom";
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

test("reuse keeps an element built the same, despite later changes", () => {
  const menu = reuse(undefined, h("details", {}, h("summary", {}, "Add")));
  menu.setAttribute("open", "");
  menu.append(h("ul"));
  expect(reuse(menu, h("details", {}, h("summary", {}, "Add")))).toBe(menu);
  const changed = h("details", {}, h("summary", {}, "Add to calendar"));
  expect(reuse(menu, changed)).toBe(changed);
});

test("placeChildren leaves children in place and moves only the rest", () => {
  const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => h("p", { id }));
  const parent = h("div", {}, a, b, c);
  const moved: Node[] = [];
  parent.insertBefore = <T extends Node>(node: T, child: Node | null): T => {
    moved.push(node);
    return Node.prototype.insertBefore.call(parent, node, child) as T;
  };
  placeChildren(parent, [a, d, c]);
  expect(parent.firstChild).toBe(a);
  expect(a.nextSibling).toBe(d);
  expect(d.nextSibling).toBe(c);
  expect(c.nextSibling).toBeNull();
  expect(moved.length).toBe(1);
  expect(moved[0]).toBe(d);
});
