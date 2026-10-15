/**
 * The "Submit a gig" dialog: opened by any link to #submit, checked with the
 * same validation the Worker applies, then sent to POST /api/submissions
 * with a Cloudflare Turnstile token. Turnstile loads on first open, so
 * visitors who never submit don't fetch it.
 */

import { h } from "./render";
import {
  type FieldErrors,
  MAX_DAYS_AHEAD,
  MAX_LENGTH,
  OTHER_VENUE,
  TURNSTILE_ACTION,
  validateSubmission,
} from "./submission";
import { addDays, dayKey } from "./time";
import type { Venue } from "./types";

/**
 * The Turnstile widget's site key (Cloudflare dashboard → Turnstile), whose
 * hostnames must include every host the site is served from. Until it's
 * set, the deployed form says submissions aren't open yet.
 */
const SITE_KEY: string | null = "0x4AAAAAAFXrwlgP4FrzULhU";
/** Cloudflare's always-passing test key, for wrangler dev. */
const TEST_SITE_KEY = "1x00000000000000000000AA";
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const HASH = "#submit";

interface Turnstile {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action?: string;
      theme?: "auto" | "light" | "dark";
      size?: "normal" | "flexible" | "compact";
      "error-callback"?: () => void;
    },
  ): string;
  getResponse(widgetId: string): string | undefined;
  reset(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

/** Venues grouped by town, for a <select>. */
export function venueOptions(venues: Iterable<Venue>): HTMLOptGroupElement[] {
  const towns = new Map<string, Venue[]>();
  for (const venue of venues) {
    towns.set(venue.town, [...(towns.get(venue.town) ?? []), venue]);
  }
  return [...towns.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((town) =>
      h(
        "optgroup",
        { label: town },
        ...(towns.get(town) ?? [])
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((venue) => h("option", { value: venue.id }, venue.name)),
      ),
    );
}

/** Shows each field's error under it, or clears them all. */
export function showFieldErrors(
  form: HTMLFormElement,
  errors: FieldErrors,
): HTMLElement | null {
  for (const old of form.querySelectorAll(".field-error")) old.remove();
  for (const field of form.querySelectorAll("[aria-invalid]")) {
    field.removeAttribute("aria-invalid");
  }
  let first: HTMLElement | null = null;
  for (const [name, message] of Object.entries(errors)) {
    const named = form.elements.namedItem(name);
    // A radio group's error goes on its first radio, under the group.
    const field = named instanceof RadioNodeList ? named[0] : named;
    if (!(field instanceof HTMLElement)) continue;
    const id = `${form.id}-${name}-error`;
    field.setAttribute("aria-invalid", "true");
    field.setAttribute("aria-errormessage", id);
    const wrapper = field.closest(".form-field") ?? field.parentElement;
    wrapper?.append(h("p", { class: "field-error", id }, message));
    first ??= field;
  }
  return first;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

export interface SubmitDialog {
  setVenues(venues: Venue[]): void;
}

export function submitDialog(): SubmitDialog {
  const dialog = byId<HTMLDialogElement>("submit-dialog");
  const form = byId<HTMLFormElement>("submit-form");
  const title = byId<HTMLInputElement>("submit-title");
  const venue = byId<HTMLSelectElement>("submit-venue");
  const otherVenue = byId<HTMLElement>("submit-other-venue");
  const tba = byId<HTMLInputElement>("submit-tba");
  const date = byId<HTMLInputElement>("submit-date");
  const times = [
    byId<HTMLInputElement>("submit-start"),
    byId<HTMLInputElement>("submit-end"),
  ];
  const status = byId<HTMLElement>("submit-status");
  const send = byId<HTMLButtonElement>("submit-send");
  const widgetSlot = byId<HTMLElement>("submit-turnstile");
  const done = byId<HTMLElement>("submit-done");
  const doneTitle = byId<HTMLElement>("submit-done-title");
  const [placeholder] = venue.options;
  const other = byId<HTMLOptionElement>("submit-venue-other");
  let venues = new Set<string>();
  let widget: string | null = null;
  let sending = false;

  for (const [name, max] of Object.entries(MAX_LENGTH)) {
    const field = form.elements.namedItem(name);
    if (field instanceof HTMLInputElement) field.maxLength = max;
    if (field instanceof HTMLTextAreaElement) field.maxLength = max;
  }

  function say(message: string, kind: "error" | "info" = "error"): void {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function syncFields(): void {
    const isOther = venue.value === OTHER_VENUE;
    otherVenue.hidden = !isOther;
    for (const input of otherVenue.querySelectorAll("input")) {
      input.required = isOther;
    }
    for (const input of times) input.disabled = tba.checked;
    times[0].required = !tba.checked;
  }

  function startTurnstile(): void {
    if (widget !== null || widgetSlot.dataset.state) return;
    const sitekey = LOCAL_HOSTS.includes(location.hostname)
      ? TEST_SITE_KEY
      : SITE_KEY;
    const unavailable = (message: string) => {
      widgetSlot.dataset.state = "failed";
      widgetSlot.replaceChildren(h("p", { class: "form-hint" }, message));
    };
    if (!sitekey) {
      send.disabled = true;
      unavailable(
        "The form opens soon. Until then, email the details to listings@bostonjazzcalendar.com.",
      );
      return;
    }
    widgetSlot.dataset.state = "loading";
    const render = () => {
      if (!window.turnstile) return;
      widgetSlot.dataset.state = "ready";
      widget = window.turnstile.render(widgetSlot, {
        sitekey,
        action: TURNSTILE_ACTION,
        theme: "auto",
        size: "flexible",
        "error-callback": () =>
          say("The spam check had trouble. Reload the page and try again."),
      });
    };
    if (window.turnstile) {
      render();
      return;
    }
    const script = h("script", { src: TURNSTILE_SCRIPT, async: "" });
    script.addEventListener("load", render);
    script.addEventListener("error", () =>
      unavailable(
        "The spam check couldn’t load (a blocker?). You can email the details to listings@bostonjazzcalendar.com instead.",
      ),
    );
    document.head.append(script);
  }

  function open(): void {
    if (dialog.open) return;
    const today = dayKey(new Date());
    date.min = today;
    date.max = addDays(today, MAX_DAYS_AHEAD);
    syncFields();
    dialog.showModal();
    (form.hidden ? doneTitle : title).focus();
    startTurnstile();
  }

  function values(): Record<string, unknown> {
    const data = new FormData(form);
    const result: Record<string, unknown> = {};
    for (const [name, value] of data) {
      if (typeof value === "string") result[name] = value;
    }
    result.time_tba = tba.checked;
    delete result["cf-turnstile-response"];
    return result;
  }

  function showErrors(errors: FieldErrors): void {
    const first = showFieldErrors(form, errors);
    const count = Object.keys(errors).length;
    say(
      errors.form ??
        `Please check ${count === 1 ? "the field" : `${count} fields`} marked below.`,
    );
    first?.focus();
  }

  async function submit(): Promise<void> {
    const input = values();
    const checked = validateSubmission(input, {
      today: dayKey(new Date()),
      // Before the listings load, any venue id is fine; the server checks.
      venues: venues.size > 0 ? venues : undefined,
    });
    if (!checked.ok) return showErrors(checked.errors);
    showFieldErrors(form, {});
    const token = widget !== null && window.turnstile?.getResponse(widget);
    if (!token) {
      say("One moment: the spam check is still running.", "info");
      return;
    }
    sending = true;
    send.disabled = true;
    say("Sending…", "info");
    try {
      const response = await fetch("/api/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, turnstile: token }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        fields?: FieldErrors;
      };
      if (response.status === 201) return finish();
      if (body.fields) showErrors(body.fields);
      else say(body.error ?? "Something went wrong. Please try again.");
    } catch {
      say("Couldn’t reach the site. Check your connection and try again.");
    } finally {
      sending = false;
      send.disabled = false;
      // A token works once, so every attempt gets a fresh one.
      if (widget !== null) window.turnstile?.reset(widget);
    }
  }

  function finish(): void {
    form.reset();
    syncFields();
    say("", "info");
    form.hidden = true;
    done.hidden = false;
    doneTitle.focus();
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!sending) void submit();
  });
  form.addEventListener("change", syncFields);
  byId("submit-another").addEventListener("click", () => {
    done.hidden = true;
    form.hidden = false;
    title.focus();
  });
  dialog.addEventListener("click", (event) => {
    if ((event.target as Element).closest("[data-submit-close]")) {
      dialog.close();
    }
  });
  dialog.addEventListener("close", () => {
    if (location.hash === HASH) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  });
  document.addEventListener("click", (event) => {
    const link = (event.target as Element).closest?.(`a[href="${HASH}"]`);
    if (!link) return;
    event.preventDefault();
    open();
  });
  window.addEventListener("hashchange", () => {
    if (location.hash === HASH) open();
  });
  if (location.hash === HASH) open();

  return {
    setVenues(list) {
      venues = new Set(list.map((v) => v.id));
      const chosen = venue.value;
      venue.replaceChildren(placeholder, ...venueOptions(list), other);
      venue.value = chosen;
    },
  };
}
