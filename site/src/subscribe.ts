/**
 * The "Subscribe to this view" panel: a feed of the view's venues, towns and
 * jazz-adjacent choice (search and dates aren't part of a feed), as webcal
 * and Google Calendar links and an address to copy.
 */

import { disclosure } from "./disclosure";
import { byId } from "./dom";
import { feedQuery, selectionLabel } from "./selection";
import type { Venue } from "./types";
import type { ViewState } from "./url-state";

const GOOGLE_SUBSCRIBE = "https://calendar.google.com/calendar/render?cid=";

export interface SubscribePanel {
  /** Points the panel at a view; venue names show once the feed has loaded. */
  update(state: ViewState, venues?: ReadonlyMap<string, Venue>): void;
}

export function subscribePanel(): SubscribePanel {
  const scope = byId("subscribe-scope");
  const note = byId("subscribe-note");
  const webcal = byId<HTMLAnchorElement>("subscribe-webcal");
  const google = byId<HTMLAnchorElement>("subscribe-google");
  const copy = byId<HTMLButtonElement>("subscribe-copy");
  const url = byId<HTMLInputElement>("subscribe-url");
  const status = byId("subscribe-status");
  const everything = byId("subscribe-everything");
  const everythingLink = byId<HTMLAnchorElement>("subscribe-everything-link");

  disclosure(
    byId<HTMLButtonElement>("subscribe-toggle"),
    byId("subscribe-panel"),
  );
  url.addEventListener("focus", () => url.select());
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url.value);
      status.textContent = "Link copied.";
    } catch {
      url.focus();
      status.textContent = "Press Ctrl+C (⌘C on a Mac) to copy.";
    }
  });

  return {
    update(state, venues) {
      const query = feedQuery(state);
      const path = query ? `/calendar.ics?${query}` : "/calendar.ics";
      const feed = `webcal://${location.host}${path}`;
      const label = venues ? selectionLabel(state, venues) : "";
      const what = label ? `Listings at ${label}` : "Every listing";
      scope.textContent = state.adjacent ? `${what}.` : `${what}, jazz only.`;
      note.hidden = !state.query && state.when === "all" && !state.day;
      webcal.href = feed;
      google.href = `${GOOGLE_SUBSCRIBE}${encodeURIComponent(feed)}`;
      url.value = `${location.origin}${path}`;
      everything.hidden = !query;
      everythingLink.href = `webcal://${location.host}/calendar.ics`;
      status.textContent = "";
    },
  };
}
