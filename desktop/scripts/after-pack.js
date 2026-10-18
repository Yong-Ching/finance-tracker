// Runs on the packed release app before it becomes a DMG.
//
// 1. Copies the staged server into Resources/server. electron-builder's
//    extraResources always drops node_modules, which the server cannot run
//    without, so it is copied here instead, links kept as links.
// 2. Signs the app ad hoc. Apple Silicon refuses to run unsigned code at all,
//    and packing invalidates Electron's own signature. This is not a Developer
//    ID, so macOS still asks once before the first launch.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  const staged = path.join(__dirname, "..", "build", "release", "server");
  if (!fs.existsSync(path.join(staged, "server.js"))) throw new Error("server not staged; run `npm run stage`");
  const dest = path.join(appPath, "Contents", "Resources", "server");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(staged, dest, { recursive: true, verbatimSymlinks: true });

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
