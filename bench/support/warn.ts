let quiet = false;

export function setQuiet(value: boolean): void {
  quiet = value;
}

export function resetQuiet(): void {
  quiet = false;
}

export function warn(...args: unknown[]): void {
  if (!quiet) console.warn(...args);
}
