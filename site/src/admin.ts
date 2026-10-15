/**
 * The owner's review page for gig submissions (public/admin.html). The admin
 * token is kept in sessionStorage when allowed, so it lasts until the tab
 * closes; every API call sends it.
 */

import { byId, h, safeUrl } from "./dom";
import {
  type FieldErrors,
  STATUSES,
  type Status,
  type Submission,
} from "./submission";
import { showFieldErrors, venueOptions } from "./submit";
import { formatDate, formatWallClock, TIME_ZONE } from "./time";
import type { EventsFile, Venue } from "./types";

const TOKEN_KEY = "admin-token";
const API = "/api/admin/submissions";

const signin = byId<HTMLFormElement>("signin");
const tokenInput = byId<HTMLInputElement>("admin-token");
const signinStatus = byId<HTMLElement>("signin-status");
const review = byId<HTMLElement>("review");
const list = byId<HTMLOListElement>("review-list");
const reviewStatus = byId<HTMLElement>("review-status");

let token = readToken();
let venues = new Map<string, Venue>();
let status: Status = "pending";

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
  const day = formatDate(s.date) ?? s.date;
  if (!s.start_time) return `${day}, time TBA`;
  const end = s.end_time ? `–${formatWallClock(s.end_time)}` : "";
  return `${day}, ${formatWallClock(s.start_time)}${end}`;
}

function where(s: Submission): string {
  const venue = s.venue ? venues.get(s.venue) : undefined;
  if (venue) return `${venue.name}, ${venue.town}`;
  return s.venue ?? `${s.venue_name}, ${s.venue_town} (not listed)`;
}

function input(
  name: string,
  value: string | null,
  type = "text",
): HTMLInputElement {
  return h("input", { name, type, value: value ?? "", autocomplete: "off" });
}

function field(label: string, control: HTMLElement, wide = false): Node {
  return h(
    "label",
    { class: wide ? "form-field form-field-wide" : "form-field" },
    h("span", { class: "form-label" }, label),
    control,
  );
}

function venueSelect(s: Submission): HTMLSelectElement {
  const select = h(
    "select",
    { name: "venue" },
    h("option", { value: "" }, "Choose a listed venue…"),
    ...venueOptions(venues.values()),
  );
  if (s.venue && !venues.has(s.venue)) {
    select.append(h("option", { value: s.venue }, s.venue));
  }
  select.value = s.venue ?? "";
  return select;
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

function renderCard(s: Submission): HTMLLIElement {
  const tba = h("input", { type: "checkbox", name: "time_tba" });
  tba.checked = s.start_time === null;
  const href = safeUrl(s.url);
  const confirmation = href
    ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, s.url)
    : s.url;
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
    h("p", {}, "Confirms it: ", confirmation),
    s.venue_name &&
      h(
        "p",
        { class: "review-flag" },
        `Venue as submitted: ${s.venue_name}, ${s.venue_town}. If it isn't listed, add it to data/venues.yaml and publish, then choose it below.`,
      ),
    s.notes && h("blockquote", { class: "review-notes" }, s.notes),
    s.reviewed_at &&
      h("p", { class: "form-hint" }, `Reviewed ${stamp(s.reviewed_at)}`),
  );
  const outcome = h("p", { class: "submit-status", role: "status" });
  const approve = h(
    "button",
    { type: "submit", class: "button button-primary", value: "approve" },
    s.status === "approved" ? "Save changes" : "Approve",
  );
  const reject = h(
    "button",
    { type: "submit", class: "button", value: "reject" },
    s.status === "approved" ? "Unpublish" : "Reject",
  );
  const form = h(
    "form",
    { id: `review-${s.id}`, novalidate: "" },
    meta,
    h(
      "div",
      { class: "review-fields" },
      field("Title", input("title", s.title), true),
      field("Date", input("date", s.date, "date")),
      field("Starts", input("start_time", s.start_time, "time")),
      field("Ends", input("end_time", s.end_time, "time")),
      h("label", { class: "form-check" }, tba, "Time TBA"),
      field("Venue", venueSelect(s), true),
      field("Price", input("price", s.price)),
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
      ...(s.status === "rejected" ? [approve] : [approve, reject]),
      outcome,
    ),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const action = (event.submitter as HTMLButtonElement | null)?.value;
    if (action === "approve" || action === "reject") {
      void act(form, s, action, outcome);
    }
  });
  return h("li", { class: "review-card" }, form);
}

function edits(form: HTMLFormElement): Record<string, unknown> {
  const data = new FormData(form);
  const value = (name: string) => data.get(name)?.toString() ?? "";
  return {
    title: value("title"),
    date: value("date"),
    start_time: value("start_time"),
    end_time: value("end_time"),
    time_tba: data.has("time_tba"),
    venue: value("venue"),
    price: value("price"),
    relevance: data.get("relevance"),
    editor_note: value("editor_note"),
  };
}

async function act(
  form: HTMLFormElement,
  s: Submission,
  action: "approve" | "reject",
  outcome: HTMLElement,
): Promise<void> {
  const changes = edits(form);
  const body =
    action === "approve"
      ? { action, edits: changes }
      : { action, edits: { editor_note: changes.editor_note } };
  outcome.textContent = "Saving…";
  outcome.dataset.kind = "info";
  try {
    const result = await api(`${API}/${s.id}`, body);
    showFieldErrors(form, result.body.fields ?? {});
    if (result.status === 200) {
      const done = action === "approve" ? "Approved" : "Rejected";
      await load(`${done} “${result.body.submission?.title ?? s.title}”.`);
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

async function load(message = ""): Promise<void> {
  reviewStatus.textContent = "Loading…";
  try {
    const result = await api(`${API}?status=${status}`);
    const submissions = result.body.submissions ?? [];
    list.replaceChildren(...submissions.map(renderCard));
    const count = `${submissions.length} ${status}`;
    reviewStatus.textContent = message ? `${message} ${count}.` : `${count}.`;
  } catch (error) {
    if (error instanceof Unauthorized) {
      return showSignin("That token didn’t work.");
    }
    reviewStatus.textContent = "Couldn’t load submissions.";
  }
}

async function loadVenues(): Promise<void> {
  try {
    const response = await fetch("/data/events.json");
    const feed: EventsFile = await response.json();
    venues = new Map(feed.venues.map((venue) => [venue.id, venue]));
  } catch {
    reviewStatus.textContent = "Couldn’t load the venue list.";
  }
}

async function start(): Promise<void> {
  signin.hidden = true;
  review.hidden = false;
  await loadVenues();
  await load();
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
  status = STATUSES.find((known) => known === value) ?? "pending";
  void load();
});
byId("refresh").addEventListener("click", () => void load());
byId("signout").addEventListener("click", () => showSignin());

if (token) void start();
else showSignin();
