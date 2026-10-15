/**
 * A multi-select: a button that opens a checkbox list, optionally grouped
 * and with a filter box. Native checkboxes keep it keyboard- and
 * screen-reader-friendly; the disclosure handles opening and closing.
 */

import { disclosure } from "./disclosure";
import { h } from "./dom";
import { normalize } from "./listings";

export interface PickerOption {
  value: string;
  label: string;
  /** Options with the same group are listed together under it. */
  group?: string;
}

export interface PickerConfig {
  /** Prefix for element ids, e.g. "venue". */
  id: string;
  /** Visible field label, e.g. "Venues". */
  label: string;
  /** Singular and plural nouns, e.g. ["venue", "venues"]. */
  noun: [string, string];
  /** Show a filter box above the list. */
  filterable?: boolean;
  /** Called after the user changes the selection. */
  onChange(): void;
}

export interface Picker {
  /** The field: label, button and panel. */
  readonly element: HTMLElement;
  setOptions(options: readonly PickerOption[]): void;
  /** Selected values, in option order. */
  selected(): string[];
  setSelected(values: readonly string[]): void;
  labelOf(value: string): string;
  focus(): void;
}

export function createPicker(config: PickerConfig): Picker {
  const { id, label, noun, filterable, onChange } = config;
  const [one, many] = noun;
  let options: readonly PickerOption[] = [];
  let boxes: HTMLInputElement[] = [];

  const summary = h("span", { class: "picker-summary" });
  const toggle = h(
    "button",
    {
      type: "button",
      class: "picker-toggle",
      id: `${id}-toggle`,
      "aria-labelledby": `${id}-label ${id}-toggle`,
    },
    summary,
  );
  const list = h("div", { class: "picker-options", id: `${id}-options` });
  const empty = h(
    "p",
    { class: "picker-empty", hidden: "" },
    `No ${many} match.`,
  );
  const status = h("p", { class: "sr-only", role: "status" });
  const filter =
    filterable &&
    h("input", {
      type: "search",
      class: "picker-filter",
      placeholder: `Filter ${many}`,
      "aria-label": `Filter ${many}`,
      "aria-controls": list.id,
      autocomplete: "off",
      spellcheck: "false",
    });
  const clear = h(
    "button",
    { type: "button", class: "button button-small" },
    "Clear",
  );
  const done = h(
    "button",
    { type: "button", class: "button button-small" },
    "Done",
  );
  const panel = h(
    "div",
    {
      class: "popover picker-panel",
      id: `${id}-panel`,
      role: "group",
      "aria-labelledby": `${id}-label`,
    },
    filter,
    list,
    empty,
    status,
    h("div", { class: "picker-actions" }, clear, done),
  );
  const element = h(
    "div",
    { class: `field picker picker-${id}` },
    h("span", { class: "field-label", id: `${id}-label` }, label),
    h("div", { class: "picker-anchor" }, toggle, panel),
  );
  const popup = disclosure(toggle, panel);

  function selected(): string[] {
    return boxes.filter((box) => box.checked).map((box) => box.value);
  }

  function labelOf(value: string): string {
    return options.find((option) => option.value === value)?.label ?? value;
  }

  function updateSummary(): void {
    const values = selected();
    summary.textContent =
      values.length === 0
        ? `All ${many}`
        : values.length === 1
          ? labelOf(values[0])
          : `${values.length} ${many}`;
    element.classList.toggle("has-selection", values.length > 0);
  }

  function applyFilter(): void {
    if (!filter) return;
    const query = normalize(filter.value.trim());
    let visible = 0;
    for (const box of boxes) {
      const option = box.closest("label");
      if (!option) continue;
      const match = !query || (option.dataset.search ?? "").includes(query);
      option.hidden = !match;
      if (match) visible++;
    }
    for (const group of list.querySelectorAll("fieldset")) {
      group.hidden = !group.querySelector("label:not([hidden])");
    }
    empty.hidden = visible > 0;
    status.textContent = query
      ? `${visible} ${visible === 1 ? one : many} shown`
      : "";
  }

  function renderOption(option: PickerOption): HTMLLabelElement {
    const box = h("input", { type: "checkbox", value: option.value });
    boxes.push(box);
    const row = h(
      "label",
      { class: "picker-option" },
      box,
      h("span", {}, option.label),
    );
    row.dataset.search = normalize(`${option.label} ${option.group ?? ""}`);
    return row;
  }

  function setOptions(next: readonly PickerOption[]): void {
    const keep = new Set(selected());
    options = next;
    boxes = [];
    const groups = new Map<string, PickerOption[]>();
    for (const option of next) {
      const key = option.group ?? "";
      const members = groups.get(key);
      if (members) members.push(option);
      else groups.set(key, [option]);
    }
    list.replaceChildren(
      ...[...groups].map(([group, members]) =>
        group
          ? h(
              "fieldset",
              { class: "picker-group" },
              h("legend", {}, group),
              ...members.map(renderOption),
            )
          : h("div", { class: "picker-group" }, ...members.map(renderOption)),
      ),
    );
    for (const box of boxes) box.checked = keep.has(box.value);
    applyFilter();
    updateSummary();
  }

  function setSelected(values: readonly string[]): void {
    const wanted = new Set(values);
    for (const box of boxes) box.checked = wanted.has(box.value);
    updateSummary();
  }

  // The picker reports its own changes; the surrounding form shouldn't.
  for (const type of ["input", "change"]) {
    panel.addEventListener(type, (event) => {
      event.stopPropagation();
      if (event.target === filter) {
        applyFilter();
      } else if (type === "change") {
        updateSummary();
        onChange();
      }
    });
  }
  clear.addEventListener("click", () => {
    setSelected([]);
    onChange();
  });
  done.addEventListener("click", () => {
    popup.setOpen(false);
    toggle.focus();
  });
  updateSummary();

  return {
    element,
    setOptions,
    selected,
    setSelected,
    labelOf,
    focus: () => toggle.focus(),
  };
}
