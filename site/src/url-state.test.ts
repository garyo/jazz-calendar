import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STATE,
  parseState,
  serializeState,
  type ViewState,
} from "./url-state";

describe("URL state", () => {
  test("defaults produce a bare URL and parse back", () => {
    expect(serializeState(DEFAULT_STATE)).toBe("");
    expect(parseState("")).toEqual(DEFAULT_STATE);
  });

  test("round-trips every non-default filter, keeping list commas literal", () => {
    const state: ViewState = {
      query: "Miles & Coltrane",
      venues: ["lilypad", "wallys"],
      towns: ["Cambridge", "Jamaica Plain"],
      adjacent: false,
      when: "weekend",
      view: "list",
      month: "",
      day: "",
    };
    const search = serializeState(state);
    expect(search).toBe(
      "?q=Miles+%26+Coltrane&venue=lilypad,wallys&town=Cambridge,Jamaica+Plain&adjacent=0&when=weekend",
    );
    expect(parseState(search)).toEqual(state);
  });

  test("an old single town= link still parses", () => {
    expect(parseState("?town=Jamaica+Plain").towns).toEqual(["Jamaica Plain"]);
  });

  test("lists are trimmed, deduplicated and sorted; repeats are merged", () => {
    const state = parseState("?venue=wallys,+lilypad,,wallys&venue=scullers");
    expect(state.venues).toEqual(["lilypad", "scullers", "wallys"]);
    expect(serializeState(state)).toBe("?venue=lilypad,scullers,wallys");
  });

  test("month view with its month, and a single day", () => {
    const state = parseState("?view=month&month=2026-11&day=2026-11-12");
    expect(state).toMatchObject({
      view: "month",
      month: "2026-11",
      day: "2026-11-12",
    });
    expect(serializeState(state)).toBe(
      "?view=month&month=2026-11&day=2026-11-12",
    );
  });

  test("a month only counts in month view", () => {
    expect(parseState("?month=2026-11").month).toBe("");
    expect(serializeState({ ...DEFAULT_STATE, month: "2026-11" })).toBe("");
  });

  test("ignores unknown or malformed values", () => {
    expect(
      parseState(
        "?when=someday&adjacent=yes&q=%20%20&view=year&month=2026-13&day=2026-1-5&venue=",
      ),
    ).toEqual(DEFAULT_STATE);
    expect(parseState("?view=month&month=26-11").month).toBe("");
  });

  test("trims the query", () => {
    expect(serializeState({ ...DEFAULT_STATE, query: "  jam " })).toBe(
      "?q=jam",
    );
  });
});
