/**
 * Filter state, mirrored in the query string so every view can be shared.
 * Defaults are left out of the URL, so the plain address shows everything.
 */

export const DATE_PRESETS = ["tonight", "weekend", "week", "all"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export interface Filters {
  /** Free-text search over title, artists and venue. */
  query: string;
  /** A venue town, or "" for all towns. */
  town: string;
  /** Include jazz-adjacent listings. */
  adjacent: boolean;
  when: DatePreset;
}

export const DEFAULT_FILTERS: Readonly<Filters> = {
  query: "",
  town: "",
  adjacent: true,
  when: "all",
};

function isDatePreset(value: string | null): value is DatePreset {
  return DATE_PRESETS.some((preset) => preset === value);
}

export function parseFilters(search: string): Filters {
  const params = new URLSearchParams(search);
  const when = params.get("when");
  return {
    query: params.get("q")?.trim() ?? DEFAULT_FILTERS.query,
    town: params.get("town") ?? DEFAULT_FILTERS.town,
    adjacent: params.get("adjacent") !== "0",
    when: isDatePreset(when) ? when : DEFAULT_FILTERS.when,
  };
}

/** "?q=…&town=…", or "" when every filter is at its default. */
export function serializeFilters(filters: Filters): string {
  const params = new URLSearchParams();
  const query = filters.query.trim();
  if (query) params.set("q", query);
  if (filters.town) params.set("town", filters.town);
  if (!filters.adjacent) params.set("adjacent", "0");
  if (filters.when !== DEFAULT_FILTERS.when) params.set("when", filters.when);
  const search = params.toString();
  return search ? `?${search}` : "";
}
