/**
 * Gig submissions: the records, their limits and their validation. Shared by
 * the Worker, which enforces it, and the form and review page, which use the
 * same types and limits.
 */

import { addDays, type DayKey } from "./time";
import type { Relevance } from "./types";

export const STATUSES = ["pending", "approved", "rejected"] as const;
export type Status = (typeof STATUSES)[number];

/** The venue choice for a room that isn't in the registry yet. */
export const OTHER_VENUE = "other";

/** The action the form's Turnstile widget declares; the Worker checks it. */
export const TURNSTILE_ACTION = "submit-gig";

/** The furthest ahead a gig may be. */
export const MAX_DAYS_AHEAD = 366;

/** Characters allowed in each text field. */
export const MAX_LENGTH = {
  title: 150,
  venue_name: 100,
  venue_town: 60,
  price: 40,
  url: 500,
  submitter_name: 100,
  submitter_email: 200,
  notes: 1000,
  editor_note: 1000,
} as const;

type TextField = keyof typeof MAX_LENGTH;

/** What a gig listing says: everything the reviewer can edit. */
export interface Gig {
  title: string;
  date: DayKey;
  /** "HH:MM", Boston local; null when the time is TBA. */
  start_time: string | null;
  /** "HH:MM"; earlier than the start means after midnight. */
  end_time: string | null;
  /** Venue id, or null for a venue we don't list yet (see venue_name). */
  venue: string | null;
  venue_name: string | null;
  venue_town: string | null;
  price: string | null;
  /** A page confirming the gig. */
  url: string;
}

/** A submission as the form sends it, once validated. */
export interface NewSubmission extends Gig {
  submitter_name: string;
  submitter_email: string;
  notes: string | null;
}

/** A stored submission, as the review page sees it. */
export interface Submission extends NewSubmission {
  id: string;
  created_at: string;
  status: Status;
  relevance: Relevance | null;
  reviewed_at: string | null;
  editor_note: string | null;
}

/** An approved gig as the scraper reads it: publishable fields only. */
export interface ApprovedGig {
  id: string;
  title: string;
  date: DayKey;
  start_time: string | null;
  end_time: string | null;
  venue: string;
  price: string | null;
  url: string;
  relevance: Relevance;
}

/** Field name -> what's wrong with it. */
export type FieldErrors = Record<string, string>;

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; errors: FieldErrors };

export interface ValidationContext {
  /** Boston's date today. */
  today: DayKey;
  /**
   * Venue ids in the published feed. Without them any id passes, so the
   * Worker can check everything else before it reads the feed.
   */
  venues?: ReadonlySet<string>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** No whitespace, and nothing that adds recipients or headers to a mailto: link. */
const EMAIL = /^[^\s@?&%,;<>]+@[^\s@?&%,;<>]+\.[^\s@?&%,;<>]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collapses whitespace and drops control characters; notes keep newlines. */
function normalize(value: string, multiline: boolean): string {
  if (!multiline) return value.replace(/\s+/g, " ").replace(/\p{Cc}/gu, "");
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/(?!\n)\p{Cc}/gu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isCalendarDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toISOString().slice(0, 10) === value;
}

/** Reads fields from untrusted input, collecting the first error for each. */
class Reader {
  readonly errors: FieldErrors = {};
  private readonly input: Record<string, unknown>;

  constructor(input: Record<string, unknown>) {
    this.input = input;
  }

  fail(name: string, message: string): null {
    this.errors[name] ??= message;
    return null;
  }

  /** A string field, trimmed; "" and absent become null. */
  raw(name: string): string | null {
    const value = this.input[name];
    if (value == null) return null;
    if (typeof value !== "string") return this.fail(name, "Must be text.");
    return value.trim() || null;
  }

  text(name: TextField, required = false, multiline = false): string | null {
    const raw = this.raw(name);
    const value = raw && normalize(raw, multiline);
    if (!value) return required ? this.fail(name, "Required.") : null;
    if (value.length > MAX_LENGTH[name]) {
      return this.fail(name, `Keep it under ${MAX_LENGTH[name]} characters.`);
    }
    return value;
  }

  flag(name: string): boolean {
    const value = this.input[name];
    if (value == null || typeof value === "boolean") return value === true;
    this.fail(name, "Must be true or false.");
    return false;
  }

  date(name: string, today: DayKey): DayKey | null {
    const value = this.raw(name);
    if (!value) return this.fail(name, "Required.");
    if (!DATE.test(value) || !isCalendarDate(value)) {
      return this.fail(name, "Use a date like 2026-11-07.");
    }
    if (value < today) return this.fail(name, "That date has passed.");
    if (value > addDays(today, MAX_DAYS_AHEAD)) {
      return this.fail(name, "Must be within the next year.");
    }
    return value;
  }

  time(name: string, required: boolean): string | null {
    const value = this.raw(name);
    if (!value) {
      return required
        ? this.fail(name, "Add a start time, or check “Time TBA”.")
        : null;
    }
    // Some browsers send seconds.
    const hhmm = value.replace(/^(\d\d:\d\d):00$/, "$1");
    return TIME.test(hhmm) ? hhmm : this.fail(name, "Use a time like 20:00.");
  }

  url(name: TextField): string | null {
    const value = this.text(name, true);
    if (!value) return null;
    try {
      const url = new URL(value);
      const web = url.protocol === "https:" || url.protocol === "http:";
      if (web && !url.username && !url.password && url.hostname.includes(".")) {
        return url.href;
      }
    } catch {
      // Falls through to the error below.
    }
    return this.fail(name, "Use a web address starting with https://.");
  }

  email(name: TextField): string | null {
    const value = this.text(name, true);
    if (!value) return null;
    return EMAIL.test(value) ? value : this.fail(name, "Check the address.");
  }
}

function readGig(fields: Reader, ctx: ValidationContext): Gig {
  const title = fields.text("title", true);
  const date = fields.date("date", ctx.today);
  const tba = fields.flag("time_tba");
  const start_time = tba ? null : fields.time("start_time", true);
  const end_time = tba ? null : fields.time("end_time", false);
  const venue = fields.raw("venue");
  const other = venue === OTHER_VENUE;
  if (!venue) fields.fail("venue", "Choose a venue.");
  else if (!other && ctx.venues && !ctx.venues.has(venue)) {
    fields.fail("venue", "Choose a venue from the list.");
  }
  return {
    title: title ?? "",
    date: date ?? "",
    start_time,
    end_time,
    venue: other ? null : venue,
    venue_name: other ? fields.text("venue_name", true) : null,
    venue_town: other ? fields.text("venue_town", true) : null,
    price: fields.text("price"),
    url: fields.url("url") ?? "",
  };
}

function result<T>(fields: Reader, value: T): Validated<T> {
  return Object.keys(fields.errors).length > 0
    ? { ok: false, errors: fields.errors }
    : { ok: true, value };
}

/** Validates a submission from the public form. */
export function validateSubmission(
  input: unknown,
  ctx: ValidationContext,
): Validated<NewSubmission> {
  if (!isRecord(input)) return { ok: false, errors: { form: "Bad request." } };
  const fields = new Reader(input);
  return result(fields, {
    ...readGig(fields, ctx),
    submitter_name: fields.text("submitter_name", true) ?? "",
    submitter_email: fields.email("submitter_email") ?? "",
    notes: fields.text("notes", false, true),
  });
}

export interface Review {
  gig: Gig;
  relevance: Relevance;
  editor_note: string | null;
}

/** The form fields that describe a stored gig, for re-validating it. */
function gigInput(gig: Gig): Record<string, unknown> {
  return {
    ...gig,
    venue: gig.venue ?? OTHER_VENUE,
    time_tba: gig.start_time === null,
  };
}

/**
 * Validates an approval: the stored gig with the reviewer's edits applied.
 * A published gig needs a listed venue and a relevance.
 */
export function validateApproval(
  current: Submission,
  edits: unknown,
  ctx: Required<ValidationContext>,
): Validated<Review> {
  if (edits != null && !isRecord(edits)) {
    return { ok: false, errors: { form: "Bad edits." } };
  }
  const input = {
    ...gigInput(current),
    relevance: current.relevance,
    ...edits,
  };
  const fields = new Reader(input);
  const gig = readGig(fields, ctx);
  if (gig.venue === null) {
    fields.fail(
      "venue",
      "Choose a listed venue. Add new ones to data/venues.yaml first.",
    );
  }
  const relevance = fields.raw("relevance");
  if (relevance !== "jazz" && relevance !== "adjacent") {
    fields.fail("relevance", "Choose jazz or jazz-adjacent.");
  }
  return result(fields, {
    gig,
    relevance: relevance === "adjacent" ? "adjacent" : "jazz",
    editor_note: fields.text("editor_note", false, true),
  });
}

/** Validates the editor's note on a rejection; nothing else changes. */
export function validateRejection(edits: unknown): Validated<string | null> {
  if (edits != null && !isRecord(edits)) {
    return { ok: false, errors: { form: "Bad edits." } };
  }
  const fields = new Reader(edits ?? {});
  return result(fields, fields.text("editor_note", false, true));
}
