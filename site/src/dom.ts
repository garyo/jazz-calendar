/** Small DOM helpers shared by the page, the submit dialog and the review page. */

export type Child = Node | string | null | undefined | false;

/** An element with attributes (null and undefined are left out) and children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | null | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value != null) el.setAttribute(name, value);
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

/** The element with this id; a missing one is a bug in the page. */
export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

/** Each reusable element's markup as built, before any later change to it. */
const built = new WeakMap<Element, string>();

/**
 * `next`, or `current` in its place when `next` was built the same as
 * `current` was. Compares markup as built, so state added since (an open
 * menu and its items) doesn't count as a change.
 */
export function reuse<T extends Element>(
  current: Element | undefined,
  next: T,
): T {
  const html = next.outerHTML;
  if (current && built.get(current) === html) return current as T;
  built.set(next, html);
  return next;
}

/**
 * Makes `nodes` the children of `parent`, moving as few as it can: a child
 * already in place stays put, keeping its layout and the browser's scroll
 * anchoring.
 */
export function placeChildren(parent: Node, nodes: readonly Node[]): void {
  const keep = new Set(nodes);
  for (const child of [...parent.childNodes]) {
    if (!keep.has(child)) child.remove();
  }
  let cursor = parent.firstChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(node, cursor);
  }
}

/** Text for screen readers only. */
export function srOnly(text: string): HTMLSpanElement {
  return h("span", { class: "sr-only" }, text);
}

/** Only http(s) links from scraped data become hrefs. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol, href } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? href : null;
  } catch {
    return null;
  }
}
