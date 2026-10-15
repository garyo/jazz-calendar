/**
 * A button that shows and hides a popover panel (the WAI-ARIA disclosure
 * pattern). Escape closes it and returns focus to the button; so do a click
 * or a Tab outside it.
 */

export interface Disclosure {
  readonly isOpen: boolean;
  setOpen(open: boolean): void;
}

export function disclosure(
  toggle: HTMLButtonElement,
  panel: HTMLElement,
  onOpen?: () => void,
): Disclosure {
  const root = toggle.parentElement ?? toggle;
  let isOpen = false;

  function setOpen(open: boolean): void {
    if (open === isOpen) return;
    isOpen = open;
    toggle.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
    root.classList.toggle("is-open", open);
    if (open) onOpen?.();
  }

  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", panel.id);
  panel.hidden = true;
  toggle.addEventListener("click", () => setOpen(!isOpen));
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isOpen) return;
    event.preventDefault();
    setOpen(false);
    toggle.focus();
  });
  // Clicks don't focus buttons and checkboxes in Safari, so pointer
  // dismissal can't rely on focus; focusout only handles keyboard moves.
  document.addEventListener("pointerdown", (event) => {
    if (isOpen && !root.contains(event.target as Node)) setOpen(false);
  });
  root.addEventListener("focusout", (event) => {
    const next = event.relatedTarget as Node | null;
    if (next && !root.contains(next)) setOpen(false);
  });

  return {
    get isOpen() {
      return isOpen;
    },
    setOpen,
  };
}
