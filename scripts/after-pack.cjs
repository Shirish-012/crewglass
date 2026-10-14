// electron-builder afterPack hook (runs before signing): drop Electron's demo app, which Crewglass never loads.
const { existsSync, rmSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources", "default_app.asar");
  if (existsSync(app)) rmSync(app);
};
