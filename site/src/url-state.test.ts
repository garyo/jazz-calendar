import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FILTERS,
  type Filters,
  parseFilters,
  serializeFilters,
} from "./url-state";

describe("URL state", () => {
  test("defaults produce a bare URL and parse back", () => {
    expect(serializeFilters(DEFAULT_FILTERS)).toBe("");
    expect(parseFilters("")).toEqual(DEFAULT_FILTERS);
  });

  test("round-trips every non-default filter", () => {
    const filters: Filters = {
      query: "Miles & Coltrane",
      town: "Jamaica Plain",
      adjacent: false,
      when: "weekend",
    };
    const search = serializeFilters(filters);
    expect(search).toBe(
      "?q=Miles+%26+Coltrane&town=Jamaica+Plain&adjacent=0&when=weekend",
    );
    expect(parseFilters(search)).toEqual(filters);
  });

  test("ignores unknown or malformed values", () => {
    expect(parseFilters("?when=someday&adjacent=yes&q=%20%20")).toEqual(
      DEFAULT_FILTERS,
    );
  });

  test("trims the query", () => {
    expect(serializeFilters({ ...DEFAULT_FILTERS, query: "  jam " })).toBe(
      "?q=jam",
    );
  });
});
