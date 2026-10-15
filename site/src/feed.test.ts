import { describe, expect, test } from "bun:test";
import { readFeed } from "./feed";
import { sample } from "./testing";

describe("readFeed", () => {
  test("indexes venues, credits and sources", () => {
    const feed = readFeed(sample);
    expect(feed.generatedAt).toBe(sample.generated_at);
    expect(feed.events).toBe(sample.events);
    expect(feed.venues.size).toBe(sample.venues.length);
    expect(feed.credits.size).toBe(sample.sources?.length ?? 0);
    expect(feed.sources.own.length).toBeGreaterThan(0);
  });

  test("lists only venues with a listing or a regular", () => {
    const used = new Set(
      [...sample.events, ...(sample.regulars ?? [])].map((l) => l.venue),
    );
    const feed = readFeed(sample);
    expect(feed.listed.map((v) => v.id).sort()).toEqual(
      sample.venues
        .filter((v) => used.has(v.id))
        .map((v) => v.id)
        .sort(),
    );
  });

  test("an older feed without regulars or sources still reads", () => {
    const { regulars: _r, sources: _s, ...older } = sample;
    const feed = readFeed(older);
    expect(feed.regulars).toEqual([]);
    expect(feed.credits.size).toBe(0);
    expect(feed.sources).toEqual({ own: [], via: [] });
  });
});
