// "Print list": only the chosen list goes to paper. print.css has the rules and tells which
// marks the layouts set.

import type { ID } from '../../../shared/types.ts';
import './print.css';

const MARK = 'printing';
let cleanUp: (() => void) | null = null;

/** The rule that hides each other list. A list id is free text for CSS, so it is escaped. */
function hideOthersRule(listId: ID): string {
  const value = listId.replace(/["\\]/g, '\\$&');
  return `@media print { html[data-${MARK}] [data-print-list]:not([data-print-list="${value}"]) { display: none !important; } }`;
}

/**
 * Prints the list with this id: the element with `data-print-list="<id>"`. The mark on <html>
 * (`data-printing="<id>"`) is there only while the print dialog is open, so a layout can also
 * use it in its own print rules.
 */
export function printList(listId: ID): void {
  cleanUp?.();
  const root = document.documentElement;
  const style = document.createElement('style');
  style.textContent = hideOthersRule(listId);
  document.head.append(style);
  root.dataset[MARK] = listId;

  const done = (): void => {
    if (cleanUp !== done) return;
    cleanUp = null;
    window.removeEventListener('afterprint', done);
    style.remove();
    delete root.dataset[MARK];
  };
  cleanUp = done;
  // Safari on iOS returns from print() before the dialog closes, so the mark stays until the
  // browser tells that the print is over.
  window.addEventListener('afterprint', done);
  window.print();
}
