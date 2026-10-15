/** Test helpers: a happy-dom document holding the real page's markup. */

import { afterAll, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { EventsFile } from "./types";

const html = await Bun.file(
  new URL("../public/index.html", import.meta.url),
).text();

export const sample: EventsFile = await Bun.file(
  new URL("../../schema/sample-events.json", import.meta.url),
).json();

/** Registers happy-dom globals for the tests in this file. */
export function useDom(url = "https://bostonjazzcalendar.com/"): void {
  beforeAll(() =>
    GlobalRegistrator.register({
      url,
      settings: {
        disableCSSFileLoading: true,
        handleDisabledFileLoadingAsSuccess: true,
      },
    }),
  );
  afterAll(() => GlobalRegistrator.unregister());
}

/** Replaces the document's body with index.html's. */
export function loadPage(): void {
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "";
  document.body.innerHTML = body;
}
