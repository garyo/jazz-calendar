/**
 * View state, mirrored in the query string so every view can be shared.
 * Defaults are left out of the URL, so the plain address shows everything.
 */

import {
  EVERYTHING,
  parseSelection,
  queryString,
  type Selection,
  writeSelection,
} from "./selection";
import type { DayKey } from "./time";

export const DATE_PRESETS = ["tonight", "weekend", "week", "all"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const VIEWS = ["list", "month"] as const;
export type View = (typeof VIEWS)[number];

export interface ViewState extends Selection {
  /** Free-text search over title, artists and venue. */
  query: string;
  /** The list view's date range; ignored while `day` is set. */
  when: DatePreset;
  view: View;
  /** The month view's month, "YYYY-MM", or "" for the current one. */
  month: string;
  /**
   * One day: the list view shows only it, and the month view lists it
   * under the grid. "" for none.
   */
  day: DayKey | "";
}

export const DEFAULT_STATE: Readonly<ViewState> = {
  ...EVERYTHING,
  query: "",
  when: "all",
  view: "list",
  month: "",
  day: "",
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function oneOf<T extends string>(
  options: readonly T[],
  value: string | null,
  fallback: T,
): T {
  return options.find((option) => option === value) ?? fallback;
}

function matching(pattern: RegExp, value: string | null): string {
  return value && pattern.test(value) ? value : "";
}

export function parseState(search: string): ViewState {
  const params = new URLSearchParams(search);
  const view = oneOf(VIEWS, params.get("view"), DEFAULT_STATE.view);
  return {
    ...parseSelection(params),
    query: params.get("q")?.trim() ?? DEFAULT_STATE.query,
    when: oneOf(DATE_PRESETS, params.get("when"), DEFAULT_STATE.when),
    view,
    month: view === "month" ? matching(MONTH, params.get("month")) : "",
    day: matching(DAY, params.get("day")),
  };
}

/** "?q=…&venue=a,b&…", or "" when everything is at its default. */
export function serializeState(state: ViewState): string {
  const params = new URLSearchParams();
  const query = state.query.trim();
  if (query) params.set("q", query);
  writeSelection(params, state);
  if (state.when !== DEFAULT_STATE.when) params.set("when", state.when);
  if (state.view !== DEFAULT_STATE.view) params.set("view", state.view);
  if (state.view === "month" && state.month) params.set("month", state.month);
  if (state.day) params.set("day", state.day);
  const search = queryString(params);
  return search ? `?${search}` : "";
}
