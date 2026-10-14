// Commands shared by keyboard shortcuts (prototype) and the app's menus (real app).
import { actions } from "./store";

/** ⌘F: the Library's search box (it filters agents, models, servers and checks). */
export function focusSearch() {
  const el = document.getElementById("library-search") as HTMLInputElement | null;
  el?.focus();
  el?.select();
}

/** Undo / redo from the app's Edit menu: text while you're typing in a field, otherwise the canvas edit. */
export function editCommand(which: "undo" | "redo") {
  const typing = (document.activeElement as HTMLElement | null)?.closest?.("input, textarea, select");
  if (typing) document.execCommand(which);
  else if (which === "undo") actions.undo();
  else actions.redo();
}
