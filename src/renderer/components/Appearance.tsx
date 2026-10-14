// Appearance: follow macOS (System), or force Light / Dark. The choice is remembered on this Mac
// (the prototype uses browser storage; the Electron app keeps it in its own settings file).

import { create } from "zustand";
import { Icon } from "./ui";
import { LEGACY } from "@shared/legacy";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "crewglass.appearance";

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY) ?? localStorage.getItem(`${LEGACY.storagePrefix}appearance`); // saved under the old name
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice) {
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
}

export const useAppearance = create<{ choice: ThemeChoice; set: (c: ThemeChoice) => void }>((set) => ({
  choice: read(),
  set: (choice) => {
    applyTheme(choice);
    try { localStorage.setItem(KEY, choice); } catch { /* private window: still works for this session */ }
    set({ choice });
  },
}));

const OPTIONS: { v: ThemeChoice; icon: string; label: string }[] = [
  { v: "system", icon: "monitor", label: "System — follow macOS" },
  { v: "light", icon: "sun", label: "Light" },
  { v: "dark", icon: "moon", label: "Dark" },
];

export function AppearanceToggle() {
  const { choice, set } = useAppearance();
  return (
    <div className="seg appearance" role="radiogroup" aria-label="Appearance">
      {OPTIONS.map((o) => (
        <button key={o.v} className={choice === o.v ? "on" : ""} role="radio" aria-checked={choice === o.v} aria-label={o.label} title={`Appearance: ${o.label}`}
          onClick={() => set(o.v)}>
          <Icon name={o.icon} size={14} />
        </button>
      ))}
    </div>
  );
}
