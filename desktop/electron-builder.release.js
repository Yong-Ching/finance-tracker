// The release app: what other people install from GitHub Releases (see main.js
// for how it differs from the development app that `npm run install-app` makes).
// Built by `npm run dist`, after scripts/stage-server.js has staged the server.

const base = require("./package.json").build;

module.exports = {
  // Its own id and name, so it never shares a settings or data folder (or a
  // Dock identity) with the development app on the same Mac.
  appId: "io.github.yong-ching.finance-tracker",
  productName: "Finance Tracker",
  // app.getName(), and so the userData folder, comes from the packaged package.json.
  extraMetadata: { productName: "Finance Tracker" },
  files: base.files.filter((f) => f !== "project-path.json"),
  // The server goes in by scripts/after-pack.js: extraResources drops node_modules.
  extraResources: [{ from: "build/release/drizzle", to: "drizzle" }],
  directories: { output: "dist-release" },
  mac: {
    target: "dmg",
    icon: base.mac.icon,
    category: base.mac.category,
    // No Developer ID: signed ad hoc after packing instead (scripts/after-pack.js).
    identity: null,
  },
  dmg: { artifactName: "Finance-Tracker-${version}-${arch}.${ext}" },
  afterPack: "scripts/after-pack.js",
  publish: null,
};
