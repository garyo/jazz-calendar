/**
 * Day headings stick just below whichever bar the theme pins (the filters
 * or the day strip), so the stylesheet needs that bar's height in
 * --sticky-top. It's kept current as the bars resize and the layout changes;
 * the returned function updates it on demand, as after a theme switch.
 */
export function trackStickyTop(
  bars: readonly (HTMLElement | null)[],
  layout: MediaQueryList,
): () => void {
  const present = bars.filter((bar) => bar !== null);
  const update = () => {
    const pinned = present.find(
      (bar) => getComputedStyle(bar).position === "sticky",
    );
    document.documentElement.style.setProperty(
      "--sticky-top",
      `${pinned?.offsetHeight ?? 0}px`,
    );
  };
  const observer = new ResizeObserver(update);
  for (const bar of present) observer.observe(bar);
  layout.addEventListener("change", update);
  return update;
}
