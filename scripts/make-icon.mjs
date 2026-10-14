// scripts/make-icon.mjs — draws Crewglass's app icon (a fanned deck of agent cards, like the in-app mark) with
// Electron itself, then turns it into build/icon.icns with macOS's own sips + iconutil. Everything stays local.
//
// Run:  npm run icon

import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = `<!doctype html><html><head><style>
  html,body{margin:0;width:1024px;height:1024px;background:transparent;overflow:hidden}
  .bg{position:absolute;left:100px;top:100px;width:824px;height:824px;border-radius:185px;
      background:linear-gradient(160deg,#1d2533 0%,#0e1219 100%);box-shadow:inset 0 2px 0 rgba(255,255,255,.08)}
  .card{position:absolute;width:330px;height:430px;border-radius:44px;left:347px;top:300px;transform-origin:50% 120%;
        box-shadow:0 18px 40px rgba(0,0,0,.45)}
  .c1{background:linear-gradient(160deg,#eda100,#eb6834);transform:rotate(-20deg)}
  .c2{background:linear-gradient(160deg,#1baf7a,#138a60);transform:rotate(0deg)}
  .c3{background:linear-gradient(160deg,#3f93f0,#2a78d6);transform:rotate(20deg)}
  .line{position:absolute;left:60px;height:26px;border-radius:13px;background:rgba(255,255,255,.85)}
  .dot{position:absolute;right:56px;top:52px;width:44px;height:44px;border-radius:50%;background:#fff;box-shadow:0 0 0 12px rgba(255,255,255,.25)}
</style></head><body><div class="bg"></div>
  <div class="card c1"></div><div class="card c2"></div>
  <div class="card c3"><div class="dot"></div><div class="line" style="top:70px;width:120px"></div>
    <div class="line" style="top:150px;width:210px;opacity:.7"></div><div class="line" style="top:210px;width:170px;opacity:.7"></div></div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 400));
  const png = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024 }).toPNG();
  const work = join(tmpdir(), `crewglass-icon-${process.pid}`);
  const set = join(work, "icon.iconset");
  mkdirSync(set, { recursive: true });
  const master = join(work, "icon-1024.png");
  writeFileSync(master, png);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale;
      execFileSync("/usr/bin/sips", ["-z", String(px), String(px), master, "--out", join(set, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)], { stdio: "ignore" });
    }
  }
  mkdirSync(join(root, "build"), { recursive: true });
  execFileSync("/usr/bin/iconutil", ["-c", "icns", set, "-o", join(root, "build", "icon.icns")]);
  writeFileSync(join(root, "build", "icon.png"), png);
  rmSync(work, { recursive: true, force: true });
  console.log("build/icon.icns written");
  app.exit(0);
});
