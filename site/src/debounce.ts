export interface Debounced {
  /** Runs the function `ms` after the last call. */
  (): void;
  /** Drops a pending run. */
  cancel(): void;
}

/** Runs `fn` once calls stop coming for `ms`. */
export function debounce(fn: () => void, ms: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => clearTimeout(timer);
  const debounced = () => {
    cancel();
    timer = setTimeout(fn, ms);
  };
  return Object.assign(debounced, { cancel });
}
