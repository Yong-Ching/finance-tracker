// Records where finance/ lives, so the packaged .app (which is copied to
// ~/Applications, away from this repo) can find the project it runs.
const fs = require("node:fs");
const path = require("node:path");

const projectDir = path.resolve(__dirname, "..", "..", "finance");
if (!fs.existsSync(path.join(projectDir, "package.json"))) {
  console.error(`finance project not found at ${projectDir}`);
  process.exit(1);
}
fs.writeFileSync(
  path.join(__dirname, "..", "project-path.json"),
  JSON.stringify({ projectDir }, null, 2) + "\n",
);
console.log(`project: ${projectDir}`);
