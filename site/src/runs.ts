/**
 * Scraper runs asked for on the review page: the `runs` table
 * (../migrations), shared by the Worker and the page.
 */

import { type FieldErrors, isRecord, type Validated } from "./submission";

export const RUN_KINDS = ["full", "source", "rebuild"] as const;
/**
 * full: scrape every source and publish; source: scrape one; rebuild: no
 * scraping, just rebuild the feed from what was last scraped, with the latest
 * code, and publish it.
 */
export type RunKind = (typeof RUN_KINDS)[number];
export type RunStatus = "queued" | "running" | "done" | "failed";

export interface Run {
  id: number;
  kind: RunKind;
  source: string | null;
  status: RunStatus;
  requested: string;
  started: string | null;
  finished: string | null;
  error: string | null;
}

export type RunRequest = Pick<Run, "kind" | "source">;

/** A source id as data/sources.yaml gives it: "mad-monkfish". */
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateRun(input: unknown): Validated<RunRequest> {
  if (!isRecord(input)) return { ok: false, errors: { form: "Bad request." } };
  const errors: FieldErrors = {};
  const kind = RUN_KINDS.find((k) => k === input.kind);
  if (!kind) errors.kind = `Choose ${RUN_KINDS.join(", ")}.`;
  const source = kind === "source" ? input.source : null;
  if (
    kind === "source" &&
    !(typeof source === "string" && SOURCE_ID.test(source))
  ) {
    errors.source = "Choose a source.";
  }
  if (!kind || Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { kind, source: source as string | null } };
}
