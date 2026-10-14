import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App";
import { actions, useDeck } from "./state/store";

// Deep links, e.g. #main&scenario=approval&inbox — used to review screens and take screenshots.
// Fake-data links (main, chat, scenario, preset) only work in the prototype, never in the real app.
function applyHash(real: boolean) {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!real) {
    if (params.has("main")) actions.skipOnboarding();
    if (params.has("chat")) actions.scenario("this-chat");
    for (const s of (params.get("scenario") ?? "").split(",").filter(Boolean)) actions.scenario(s);
    if (params.has("preset")) actions.applyPreset(params.get("preset")!);
  }
  if (params.has("select")) {
    const [type, ...rest] = params.get("select")!.split(":");
    actions.select({ type: type as "agent" | "mcp" | "link", id: rest.join(":") });
  }
  if (params.has("bottom")) useDeck.setState({ bottomOpen: true, bottomTab: params.get("bottom") as "usage" });
  if (params.has("inbox")) useDeck.setState({ inboxOpen: true });
  if (params.has("review")) useDeck.setState({ reviewOpen: true });
  if (params.has("legend")) useDeck.setState({ legendOpen: true });
  if (params.has("format")) useDeck.setState({ formatOpen: true });
  if (params.has("proto")) useDeck.setState({ protoOpen: true });
  if (params.has("menu")) useDeck.setState({ menu: { x: 700, y: 330, key: params.get("menu")! } });
}

async function start() {
  // Inside the Electron app the preload bridge provides window.crewglass; in a plain browser it's the prototype.
  const real = !!window.crewglass;
  if (real) await (await import("./real/connect")).connectReal();
  applyHash(real);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
void start();
