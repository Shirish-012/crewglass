// "Nothing leaves your Mac" (plan §9): every request that isn't a local app file is cancelled, no page may open
// windows, navigate away, or get any browser permission. In development the local dev server is also allowed.

import { app, session } from "electron";

export function lockDown(devServerUrl?: string) {
  const dev = devServerUrl ? new URL(devServerUrl) : null;
  const allowed = (url: string) => {
    if (url.startsWith("file://") || url.startsWith("devtools://") || url.startsWith("data:")) return true;
    if (!dev) return false;
    try {
      const u = new URL(url);
      return (u.protocol === "http:" || u.protocol === "ws:") && u.hostname === dev.hostname && u.port === dev.port;
    } catch { return false; }
  };
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const ok = allowed(details.url);
    if (!ok) console.warn(`[privacy] blocked a request to ${(() => { try { return new URL(details.url).origin; } catch { return "an invalid URL"; } })()}`);
    cb({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on("web-contents-created", (_e, wc) => {
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (e, url) => { if (!url.startsWith(wc.getURL().split("#")[0])) e.preventDefault(); });
    wc.on("will-attach-webview", (e) => e.preventDefault());
  });
}
