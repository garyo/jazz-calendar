/**
 * The "Share" button: a popover with a QR code for the address of the view
 * on screen, so someone nearby can scan it to open the same listings.
 */

import { encode } from "uqr";
import { disclosure } from "./disclosure";
import { byId } from "./dom";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Blank modules around the code; the QR spec asks for at least four. */
const QUIET_ZONE = 4;

/** The page's address without its fragment (which only opens dialogs). */
export function shareUrl(
  loc: Pick<Location, "origin" | "pathname" | "search">,
) {
  return `${loc.origin}${loc.pathname}${loc.search}`;
}

/**
 * One path covering every dark module of the code. Medium error correction
 * keeps the code small enough to scan from across a table.
 */
export function qrPath(text: string): { size: number; d: string } {
  const { data, size } = encode(text, { ecc: "M", border: 0 });
  let d = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y][x]) d += `M${x} ${y}h1v1h-1z`;
    }
  }
  return { size, d };
}

/**
 * The code as an SVG. Colors are attributes, not styles, and are fixed
 * (black on white, quiet zone included) so it scans in every theme.
 */
export function qrSvg(text: string): SVGSVGElement {
  const { size, d } = qrPath(text);
  const full = size + 2 * QUIET_ZONE;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `${-QUIET_ZONE} ${-QUIET_ZONE} ${full} ${full}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code for this page’s address");
  svg.setAttribute("shape-rendering", "crispEdges");

  const background = document.createElementNS(SVG_NS, "rect");
  background.setAttribute("x", String(-QUIET_ZONE));
  background.setAttribute("y", String(-QUIET_ZONE));
  background.setAttribute("width", String(full));
  background.setAttribute("height", String(full));
  background.setAttribute("fill", "#fff");

  const modules = document.createElementNS(SVG_NS, "path");
  modules.setAttribute("d", d);
  modules.setAttribute("fill", "#000");

  svg.append(background, modules);
  return svg;
}

/** Wires the Share button; the code is drawn each time the panel opens. */
export function sharePanel(): void {
  const qr = byId("share-qr");
  const address = byId("share-url");

  disclosure(
    byId<HTMLButtonElement>("share-toggle"),
    byId("share-panel"),
    () => {
      const url = shareUrl(location);
      qr.replaceChildren(qrSvg(url));
      address.textContent = url;
    },
  );
}
