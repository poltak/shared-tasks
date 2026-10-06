/**
 * A part that downloads at its first use, so it is not in the first download.
 * `get` starts the download. `part` is the component when it is there.
 */
export function lazy<Part>(load: () => Promise<{ default: Part }>): { readonly part: Part | null; get(): Promise<boolean> } {
  let part = $state.raw<Part | null>(null);
  let pending: Promise<boolean> | null = null;
  return {
    get part() {
      return part;
    },
    get() {
      pending ??= load().then(
        (module) => {
          part = module.default;
          return true;
        },
        () => {
          // The next call tries again.
          pending = null;
          return false;
        },
      );
      return pending;
    },
  };
}
