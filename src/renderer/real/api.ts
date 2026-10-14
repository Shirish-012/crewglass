// Small helpers for calls that differ between the real app and the prototype.
import { toast, useDeck } from "../state/store";

export const deckApi = () => window.crewglass ?? null;
export const isReal = () => useDeck.getState().mode === "real";

/** Open a file or folder in VS Code: a path relative to the watched folder, or an absolute path inside it / the source repo. */
export function openInVSCode(path: string) {
  const s = useDeck.getState();
  const abs = path.startsWith("/") ? path : path.startsWith("~/") ? path : `${s.folder}/${path}`;
  const api = deckApi();
  if (api) void api.openInVSCode(abs);
  else toast("Open in VS Code", `Would run: open -a "Visual Studio Code" "${abs}"`);
}

/** Folder picker → watch that folder (real app); in the prototype just a message. */
export async function pickFolder(path?: string): Promise<boolean> {
  const api = deckApi();
  if (!api) { toast("Folder switched (prototype)", path ? `Would now watch only ${path}.` : "The real app opens the macOS folder picker here."); return false; }
  const chosen = path ?? (await api.chooseFolder());
  if (!chosen) return false;
  const ok = await api.setFolder(chosen);
  if (ok) useDeck.setState({ folder: chosen, selection: null, onboarded: true });
  return ok;
}
