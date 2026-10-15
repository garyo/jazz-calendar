/**
 * The filter controls: search, the venue and town pickers with their
 * chips, the date presets, the jazz-adjacent toggle and the view radios.
 * They report a new view state on every change; typing in the search box
 * waits for a pause, but Enter or clearing it applies at once.
 */

import { debounce } from "./debounce";
import { byId, h } from "./dom";
import { createPicker, type PickerOption } from "./picker";
import type { Venue } from "./types";
import {
  DATE_PRESETS,
  type DatePreset,
  DEFAULT_STATE,
  type ViewState,
} from "./url-state";

/** How long search waits after the last keystroke. */
export const SEARCH_DELAY_MS = 150;

export interface ControlsConfig {
  /** The view state the controls start from and edit. */
  state(): ViewState;
  /** Called with the controls' new state after the user changes one. */
  onChange(next: ViewState): void;
}

export interface Controls {
  /** The current state with the controls' values. */
  read(): ViewState;
  /** Sets the controls from a state. */
  write(state: ViewState): void;
  /** Offers these venues and their towns, plus any already selected. */
  setVenues(listed: readonly Venue[], venues: ReadonlyMap<string, Venue>): void;
  /** Shows the selected venues and towns as removable chips. */
  renderChips(): void;
  /** Clears search, selection and dates, keeping the view and month. */
  reset(): void;
}

/** The value of the checked radio named `name`, if it's one of `options`. */
export function checkedValue<T extends string>(
  name: string,
  options: readonly T[],
  fallback: T,
): T {
  const input = document.querySelector<HTMLInputElement>(
    `input[name="${name}"]:checked`,
  );
  return options.find((option) => option === input?.value) ?? fallback;
}

function setChecked(name: string, value: string): void {
  for (const radio of document.querySelectorAll<HTMLInputElement>(
    `input[name="${name}"]`,
  )) {
    radio.checked = radio.value === value;
  }
}

const without = (values: string[], value: string) =>
  values.filter((v) => v !== value);

export function filterControls({ state, onChange }: ControlsConfig): Controls {
  const form = byId<HTMLFormElement>("filters");
  const query = byId<HTMLInputElement>("q");
  const adjacent = byId<HTMLInputElement>("adjacent");
  const selection = byId("selection");
  const chips = byId<HTMLUListElement>("selection-chips");
  // Until the feed loads the pickers have no options to hold a selection.
  let hasOptions = false;

  const changed = () => onChange(read());
  const venuePicker = createPicker({
    id: "venue",
    label: "Venues",
    noun: ["venue", "venues"],
    filterable: true,
    onChange: changed,
  });
  const townPicker = createPicker({
    id: "town",
    label: "Towns",
    noun: ["town", "towns"],
    onChange: changed,
  });
  byId("q-field").after(venuePicker.element, townPicker.element);

  function read(): ViewState {
    const current = state();
    return {
      ...current,
      query: query.value,
      venues: hasOptions ? venuePicker.selected() : current.venues,
      towns: hasOptions ? townPicker.selected() : current.towns,
      adjacent: adjacent.checked,
      when: checkedValue<DatePreset>("when", DATE_PRESETS, "all"),
    };
  }

  function write(values: ViewState): void {
    query.value = values.query;
    venuePicker.setSelected(values.venues);
    townPicker.setSelected(values.towns);
    adjacent.checked = values.adjacent;
    // A single day replaces the presets, so none of them is checked.
    setChecked("when", values.day ? "" : values.when);
    setChecked("view", values.view);
  }

  function setVenues(
    listed: readonly Venue[],
    venues: ReadonlyMap<string, Venue>,
  ): void {
    const { venues: chosen, towns: chosenTowns } = state();
    const venueOptions: PickerOption[] = listed.map((venue) => ({
      value: venue.id,
      label: venue.name,
      group: venue.town,
    }));
    for (const id of chosen) {
      if (venueOptions.some((option) => option.value === id)) continue;
      const venue = venues.get(id);
      venueOptions.push({
        value: id,
        label: venue?.name ?? id,
        group: venue?.town ?? "Other",
      });
    }
    const towns = new Set([
      ...listed.map((venue) => venue.town),
      ...chosenTowns,
    ]);
    venuePicker.setOptions(venueOptions);
    townPicker.setOptions(
      [...towns]
        .sort((a, b) => a.localeCompare(b))
        .map((town) => ({ value: town, label: town })),
    );
    hasOptions = true;
  }

  function chip(label: string, kind: string, remove: () => void) {
    const button = h(
      "button",
      {
        type: "button",
        class: "selection-chip",
        "aria-label": `Remove ${label}`,
      },
      h("span", { class: "selection-chip-kind" }, kind),
      label,
      h("span", { class: "selection-chip-x", "aria-hidden": "true" }, "×"),
    );
    button.addEventListener("click", () => {
      const index = [...chips.querySelectorAll("button")].indexOf(button);
      remove();
      changed();
      const rest = chips.querySelectorAll("button");
      (rest[Math.min(index, rest.length - 1)] ?? query).focus();
    });
    return h("li", {}, button);
  }

  function renderChips(): void {
    const items = [
      ...venuePicker
        .selected()
        .map((id) =>
          chip(venuePicker.labelOf(id), "Venue", () =>
            venuePicker.setSelected(without(venuePicker.selected(), id)),
          ),
        ),
      ...townPicker
        .selected()
        .map((town) =>
          chip(town, "Town", () =>
            townPicker.setSelected(without(townPicker.selected(), town)),
          ),
        ),
    ];
    chips.replaceChildren(...items);
    selection.hidden = items.length === 0;
  }

  function reset(): void {
    const { view, month } = state();
    const next = { ...DEFAULT_STATE, view, month };
    write(next);
    onChange(next);
  }

  const searchLater = debounce(changed, SEARCH_DELAY_MS);
  // Browsers fire both events for most controls; onChange sees repeats.
  for (const type of ["input", "change"]) {
    form.addEventListener(type, (event) => {
      if (type === "input" && event.target === query && query.value) {
        searchLater();
        return;
      }
      searchLater.cancel();
      const next = read();
      if ((event.target as HTMLInputElement).name === "when") next.day = "";
      onChange(next);
    });
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    searchLater.cancel();
    changed();
  });
  byId("clear-selection").addEventListener("click", () => {
    venuePicker.setSelected([]);
    townPicker.setSelected([]);
    changed();
    venuePicker.focus();
  });

  return { read, write, setVenues, renderChips, reset };
}
