/**
 * The owner's review page for submissions and the venues added with them
 * (public/admin.html). The admin
 * token is kept in sessionStorage when allowed, so it lasts until the tab
 * closes; every API call sends it.
 */

import { byId, h, safeUrl } from "./dom";
import {
  type FieldErrors,
  type Hidden,
  OTHER_VENUE,
  repeatsOf,
  STATUSES,
  type Status,
  type Submission,
  scheduleText,
  venueSlug,
} from "./submission";
import { showFieldErrors, showGroup, venueOptions } from "./submit";
import {
  addDays,
  dayKey,
  formatDate,
  formatWallClock,
  TIME_ZONE,
} from "./time";
import type { EventsFile, Venue } from "./types";

const TOKEN_KEY = "admin-token";
const API = "/api/admin/submissions";
const VENUES_API = "/api/admin/venues";
const HIDDEN_API = "/api/admin/hidden";
/** A regular not confirmed for this many days is due a check. */
const RECHECK_DAYS = 90;

const REPEATS: [string, string][] = [
  ["once", "One night"],
  ["weekly", "Every week"],
  ["monthly", "Some weeks of the month"],
];
const DAYS: [string, string][] = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
];
const WEEKS: [string, string][] = [
  ["1", "1st"],
  ["2", "2nd"],
  ["3", "3rd"],
  ["4", "4th"],
  ["5", "5th"],
  ["-1", "Last"],
];
const JAZZ_LEVELS: [string, string][] = [
  ["", "Choose…"],
  ["dedicated", "Dedicated: a jazz room"],
  ["regular", "Regular: books jazz often"],
  ["occasional", "Occasional"],
];
const VENUE_FIELDS = [
  "venue_id",
  "venue_name",
  "venue_address",
  "venue_town",
  "venue_neighborhood",
  "venue_url",
  "venue_jazz_level",
];

const signin = byId<HTMLFormElement>("signin");
const tokenInput = byId<HTMLInputElement>("admin-token");
const signinStatus = byId<HTMLElement>("signin-status");
const review = byId<HTMLElement>("review");
const list = byId<HTMLOListElement>("review-list");
const reviewStatus = byId<HTMLElement>("review-status");

let token = readToken();
/** Every listed venue: the feed's and those added here. */
let venues = new Map<string, Venue>();
/** The venues added here, which this page can change. */
let added: Venue[] = [];
let tab: Status | "venues" | "hidden" = "pending";

function readToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveToken(value: string): void {
  token = value;
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Without storage the token lasts until the page closes.
  }
}

function showSignin(message = ""): void {
  saveToken("");
  review.hidden = true;
  signin.hidden = false;
  signinStatus.textContent = message;
  tokenInput.focus();
}

class Unauthorized extends Error {}

interface ApiResult {
  status: number;
  body: {
    error?: string;
    fields?: FieldErrors;
    submissions?: Submission[];
    submission?: Submission;
    venues?: Venue[];
    hidden?: Hidden[];
  };
}

async function api(path: string, body?: unknown): Promise<ApiResult> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) throw new Unauthorized();
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

const stampFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

function stamp(iso: string): string {
  return stampFormat.format(new Date(iso));
}

function when(s: Submission): string {
  if (s.kind === "regular") return scheduleText(s);
  const day = formatDate(s.date ?? "") ?? s.date;
  if (!s.start_time) return `${day}, time TBA`;
  const end = s.end_time ? `–${formatWallClock(s.end_time)}` : "";
  return `${day}, ${formatWallClock(s.start_time)}${end}`;
}

function where(s: Submission): string {
  const venue = s.venue ? venues.get(s.venue) : undefined;
  if (venue) return `${venue.name}, ${venue.town}`;
  return s.venue ?? `${s.venue_name}, ${s.venue_town} (not listed)`;
}

function link(href: string, text: string): Node {
  const safe = safeUrl(href);
  return safe
    ? h("a", { href: safe, target: "_blank", rel: "noopener noreferrer" }, text)
    : document.createTextNode(text);
}

function input(
  name: string,
  value: string | null | undefined,
  type = "text",
): HTMLInputElement {
  return h("input", { name, type, value: value ?? "", autocomplete: "off" });
}

function select(
  name: string,
  options: [string, string][],
  value: string,
): HTMLSelectElement {
  const el = h(
    "select",
    { name },
    ...options.map(([v, label]) => h("option", { value: v }, label)),
  );
  el.value = value;
  return el;
}

function field(label: string, control: HTMLElement, wide = false): HTMLElement {
  return h(
    "label",
    { class: wide ? "form-field form-field-wide" : "form-field" },
    h("span", { class: "form-label" }, label),
    control,
  );
}

/** A row of checkboxes, as a field. */
function checkboxes(
  name: string,
  legend: string,
  options: [string, string][],
  chosen: readonly (string | number)[],
): HTMLElement {
  const picked = new Set(chosen.map(String));
  return h(
    "fieldset",
    { class: "form-field form-field-wide form-choices" },
    h("legend", { class: "form-label" }, legend),
    h(
      "div",
      { class: "form-checks" },
      ...options.map(([value, label]) => {
        const box = h("input", { type: "checkbox", name, value });
        box.checked = picked.has(value);
        return h("label", { class: "form-check" }, box, label);
      }),
    ),
  );
}

function venueSelect(s: Submission): HTMLSelectElement {
  const el = h(
    "select",
    { name: "venue" },
    h("option", { value: "" }, "Choose a listed venue…"),
    ...venueOptions(venues.values()),
  );
  if (s.venue && !venues.has(s.venue)) {
    el.append(h("option", { value: s.venue }, s.venue));
  }
  if (!s.venue) {
    el.append(h("option", { value: OTHER_VENUE }, "Add it as a new venue…"));
  }
  el.value = s.venue ?? OTHER_VENUE;
  return el;
}

/** A venue's fields, named as the API takes them. */
function venueFields(v: Partial<Venue>, newId: boolean): HTMLElement[] {
  const id = input("venue_id", v.id);
  id.readOnly = !newId;
  return [
    field("Name", input("venue_name", v.name), true),
    field("Id", id),
    field("Jazz", select("venue_jazz_level", JAZZ_LEVELS, v.jazz_level ?? "")),
    field("Street address", input("venue_address", v.address), true),
    field("Town", input("venue_town", v.town)),
    field("Neighborhood", input("venue_neighborhood", v.neighborhood)),
    field("Website", input("venue_url", v.url, "url"), true),
  ];
}

function relevanceChoice(s: Submission): Node {
  const radio = (value: string, label: string) => {
    const el = h("input", { type: "radio", name: "relevance", value });
    el.checked = s.relevance === value;
    return h("label", { class: "form-check" }, el, label);
  };
  return h(
    "fieldset",
    { class: "review-relevance form-field" },
    h("legend", { class: "form-label" }, "Relevance"),
    radio("jazz", "Jazz"),
    radio("adjacent", "Jazz-adjacent"),
  );
}

/** When an approved regular was last confirmed, flagged once it's due a check. */
function confirmation(s: Submission): Node | null {
  if (s.kind !== "regular" || s.status !== "approved" || !s.checked) {
    return null;
  }
  const due = s.checked <= addDays(dayKey(new Date()), -RECHECK_DAYS);
  const text = `Last confirmed running ${formatDate(s.checked) ?? s.checked}.`;
  return due
    ? h("p", { class: "review-flag" }, `${text} Check it still runs.`)
    : h("p", { class: "form-hint" }, text);
}

function button(label: string, value: string, primary = false): Node {
  const kind = primary ? "button button-primary" : "button";
  return h("button", { type: "submit", class: kind, value }, label);
}

function renderCard(s: Submission): HTMLLIElement {
  const tba = h("input", { type: "checkbox", name: "time_tba" });
  tba.checked = s.start_time === null;
  const unlisted = s.venue === null;
  const meta = h(
    "header",
    { class: "review-meta" },
    h(
      "p",
      { class: "review-when" },
      h("strong", {}, when(s)),
      ` · ${where(s)}`,
    ),
    h(
      "p",
      {},
      `Sent ${stamp(s.created_at)} by ${s.submitter_name} `,
      h(
        "a",
        { href: `mailto:${encodeURIComponent(s.submitter_email)}` },
        `<${s.submitter_email}>`,
      ),
    ),
    h("p", {}, "Confirms it: ", link(s.url, s.url)),
    s.notes && h("blockquote", { class: "review-notes" }, s.notes),
    s.reviewed_at &&
      h("p", { class: "form-hint" }, `Reviewed ${stamp(s.reviewed_at)}`),
    confirmation(s),
  );
  const repeats = select("repeats", REPEATS, repeatsOf(s));
  const date = field("Date", input("date", s.date, "date"));
  const days = checkboxes("days", "Days", DAYS, s.days ?? []);
  const weeks = checkboxes("nth", "Which weeks", WEEKS, s.nth ?? []);
  const price = field("Price", input("price", s.price));
  const venue = venueSelect(s);
  const newVenue =
    unlisted &&
    h(
      "fieldset",
      { class: "review-fields review-new-venue form-field-wide" },
      h("legend", { class: "form-label" }, "New venue"),
      ...venueFields(
        {
          id: venueSlug(s.venue_name ?? ""),
          name: s.venue_name ?? "",
          address: s.venue_address,
          town: s.venue_town ?? "",
          url: s.venue_url,
        },
        true,
      ),
    );
  const sync = () => {
    showGroup(date, repeats.value === "once");
    showGroup(price, repeats.value === "once");
    showGroup(days, repeats.value !== "once");
    showGroup(weeks, repeats.value === "monthly");
    if (newVenue) showGroup(newVenue, venue.value === OTHER_VENUE);
  };
  const approved = s.status === "approved";
  const outcome = h("p", { class: "submit-status", role: "status" });
  const form = h(
    "form",
    { id: `review-${s.id}`, novalidate: "" },
    meta,
    h(
      "div",
      { class: "review-fields" },
      field("Title", input("title", s.title), true),
      field("How often", repeats),
      date,
      days,
      weeks,
      field("Starts", input("start_time", s.start_time, "time")),
      field("Ends", input("end_time", s.end_time, "time")),
      h("label", { class: "form-check" }, tba, "Time TBA"),
      field("Venue", venue, true),
      newVenue,
      price,
      relevanceChoice(s),
      field(
        "Editor note (private)",
        h("textarea", { name: "editor_note", rows: "2" }, s.editor_note ?? ""),
        true,
      ),
    ),
    h(
      "div",
      { class: "review-actions" },
      button(approved ? "Save changes" : "Approve", "approve", true),
      approved && s.kind === "regular" && button("Still running", "confirm"),
      s.status !== "rejected" &&
        button(approved ? "Unpublish" : "Reject", "reject"),
      outcome,
    ),
  );
  sync();
  form.addEventListener("change", sync);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const action = (event.submitter as HTMLButtonElement | null)?.value;
    if (action === "approve" || action === "reject" || action === "confirm") {
      void act(form, s, action, outcome);
    }
  });
  return h("li", { class: "review-card" }, form);
}

/** The form's text fields by name; fields hidden (so disabled) are left out. */
function texts(data: FormData, names: string[]): Record<string, string> {
  return Object.fromEntries(
    names
      .filter((name) => data.has(name))
      .map((name) => [name, data.get(name)?.toString() ?? ""]),
  );
}

function edits(form: HTMLFormElement): Record<string, unknown> {
  const data = new FormData(form);
  return {
    ...texts(data, [
      "title",
      "repeats",
      "date",
      "start_time",
      "end_time",
      "venue",
      "price",
      "editor_note",
      ...VENUE_FIELDS,
    ]),
    days: data.getAll("days"),
    nth: data.getAll("nth").map(Number),
    time_tba: data.has("time_tba"),
    relevance: data.get("relevance"),
  };
}

/**
 * Sends one card's change. On success reloads the tab, saying what was done;
 * otherwise shows what went wrong on the card.
 */
async function send(
  form: HTMLFormElement,
  outcome: HTMLElement,
  path: string,
  body: unknown,
  done: (result: ApiResult) => string,
): Promise<void> {
  outcome.textContent = "Saving…";
  outcome.dataset.kind = "info";
  try {
    const result = await api(path, body);
    showFieldErrors(form, result.body.fields ?? {});
    if (result.status === 200 || result.status === 201) {
      await load(done(result));
      return;
    }
    outcome.textContent = result.body.error ?? `Error ${result.status}`;
    outcome.dataset.kind = "error";
  } catch (error) {
    if (error instanceof Unauthorized) return showSignin("Sign in again.");
    outcome.textContent = "Couldn’t reach the site.";
    outcome.dataset.kind = "error";
  }
}

const DONE = {
  approve: "Approved",
  reject: "Rejected",
  confirm: "Confirmed",
} as const;

function act(
  form: HTMLFormElement,
  s: Submission,
  action: keyof typeof DONE,
  outcome: HTMLElement,
): Promise<void> {
  const changes = edits(form);
  const body =
    action === "approve"
      ? { action, edits: changes }
      : action === "reject"
        ? { action, edits: { editor_note: changes.editor_note } }
        : { action };
  return send(form, outcome, `${API}/${s.id}`, body, (result) => {
    return `${DONE[action]} “${result.body.submission?.title ?? s.title}”.`;
  });
}

/** A card for a venue added here, or for adding one when `v` is null. */
function renderVenue(v: Venue | null): HTMLLIElement {
  const outcome = h("p", { class: "submit-status", role: "status" });
  const form = h(
    "form",
    { novalidate: "" },
    v
      ? h(
          "p",
          { class: "review-when" },
          h("strong", {}, v.name),
          ` · ${v.town}`,
        )
      : h("p", { class: "review-when" }, h("strong", {}, "Add a venue")),
    h("div", { class: "review-fields" }, ...venueFields(v ?? {}, v === null)),
    h(
      "div",
      { class: "review-actions" },
      ...(v
        ? [button("Save", "save", true), button("Delete", "delete")]
        : [button("Add", "add", true)]),
      outcome,
    ),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const action = (event.submitter as HTMLButtonElement | null)?.value;
    const fields = texts(new FormData(form), VENUE_FIELDS);
    const name = fields.venue_name || v?.name;
    if (!v) {
      void send(form, outcome, VENUES_API, fields, () => `Added ${name}.`);
    } else if (action === "save" || action === "delete") {
      const path = `${VENUES_API}/${encodeURIComponent(v.id)}`;
      const done = action === "save" ? "Saved" : "Deleted";
      void send(form, outcome, path, { action, ...fields }, () => {
        return `${done} ${name}.`;
      });
    }
  });
  return h("li", { class: "review-card" }, form);
}

/** A card for a hidden listing, or for hiding one when `entry` is null. */
function renderHidden(entry: Hidden | null): HTMLLIElement {
  const outcome = h("p", { class: "submit-status", role: "status" });
  if (entry) {
    const venue = entry.venue
      ? (venues.get(entry.venue)?.name ?? entry.venue)
      : "any venue";
    const night = entry.night
      ? (formatDate(entry.night) ?? entry.night)
      : "any night";
    const form = h(
      "form",
      { novalidate: "" },
      h(
        "p",
        { class: "review-when" },
        h("strong", {}, entry.title ? `“${entry.title}”` : "Every listing"),
        ` · ${venue} · ${night}`,
      ),
      h(
        "p",
        { class: "form-hint" },
        `Hidden since ${formatDate(entry.requested) ?? entry.requested}.`,
      ),
      entry.note && h("blockquote", { class: "review-notes" }, entry.note),
      h(
        "div",
        { class: "review-actions" },
        button("Show again", "delete"),
        outcome,
      ),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const path = `${HIDDEN_API}/${entry.id}`;
      void send(
        form,
        outcome,
        path,
        { action: "delete" },
        () => "Shown again.",
      );
    });
    return h("li", { class: "review-card" }, form);
  }
  const venue = h(
    "select",
    { name: "venue" },
    h("option", { value: "" }, "Any venue"),
    ...venueOptions(venues.values()),
  );
  const form = h(
    "form",
    { novalidate: "" },
    h("p", { class: "review-when" }, h("strong", {}, "Hide listings")),
    h(
      "p",
      { class: "form-hint" },
      "Every field given must match. Title words match whole words, ignoring case: “Pat Example” alone hides every listing with that name, at any venue, and their weekly series. Hidden listings leave the site within about 10 minutes.",
    ),
    h(
      "div",
      { class: "review-fields" },
      field("Words in the title", input("title", null), true),
      field("Venue", venue),
      field("Night", input("night", null, "date")),
      field(
        "Private note: who asked, and how",
        h("textarea", { name: "note", rows: "2" }),
        true,
      ),
    ),
    h(
      "div",
      { class: "review-actions" },
      button("Hide", "hide", true),
      outcome,
    ),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const fields = texts(new FormData(form), [
      "title",
      "venue",
      "night",
      "note",
    ]);
    void send(form, outcome, HIDDEN_API, fields, () => "Hidden.");
  });
  return h("li", { class: "review-card" }, form);
}

/** The feed's venues and those added here. */
async function loadVenues(): Promise<void> {
  const [feed, mine] = await Promise.all([
    fetch("/data/events.json").then(
      (response) => response.json() as Promise<EventsFile>,
      () => null,
    ),
    api(VENUES_API),
  ]);
  added = mine.body.venues ?? [];
  venues = new Map(
    [...(feed?.venues ?? []), ...added].map((venue) => [venue.id, venue]),
  );
  if (!feed) reviewStatus.textContent = "Couldn’t load the venue list.";
}

/** The current tab's cards, and how many things it lists. */
async function tabCards(): Promise<[HTMLLIElement[], string]> {
  if (tab === "venues") {
    const cards = [renderVenue(null), ...added.map(renderVenue)];
    return [cards, `${added.length} added here`];
  }
  if (tab === "hidden") {
    const hidden = (await api(HIDDEN_API)).body.hidden ?? [];
    return [
      [renderHidden(null), ...hidden.map(renderHidden)],
      `${hidden.length} hidden`,
    ];
  }
  const submissions =
    (await api(`${API}?status=${tab}`)).body.submissions ?? [];
  return [submissions.map(renderCard), `${submissions.length} ${tab}`];
}

async function load(message = ""): Promise<void> {
  reviewStatus.textContent = "Loading…";
  try {
    await loadVenues();
    const [cards, count] = await tabCards();
    list.replaceChildren(...cards);
    reviewStatus.textContent = message ? `${message} ${count}.` : `${count}.`;
  } catch (error) {
    if (error instanceof Unauthorized) {
      return showSignin("That token didn’t work.");
    }
    reviewStatus.textContent = "Couldn’t load submissions.";
  }
}

function start(): Promise<void> {
  signin.hidden = true;
  review.hidden = false;
  return load();
}

signin.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = tokenInput.value.trim();
  if (!value) return;
  saveToken(value);
  tokenInput.value = "";
  void start();
});

byId("status-tabs").addEventListener("change", (event) => {
  const value = (event.target as HTMLInputElement).value;
  tab =
    value === "venues" || value === "hidden"
      ? value
      : (STATUSES.find((known) => known === value) ?? "pending");
  void load();
});
byId("refresh").addEventListener("click", () => void load());
byId("signout").addEventListener("click", () => showSignin());

if (token) void start();
else showSignin();
