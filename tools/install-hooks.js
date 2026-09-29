// Installs a dependency-free pre-commit hook that runs `npm run check`.
// Run once: node tools/install-hooks.js
// Remove:   node tools/install-hooks.js --uninstall
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const hooksDir = path.join(root, ".git", "hooks");
const hook = path.join(hooksDir, "pre-commit");

if (process.argv.includes("--uninstall")) {
  if (fs.existsSync(hook)) {
    fs.unlinkSync(hook);
    console.log("removed " + path.relative(root, hook));
  } else {
    console.log("no pre-commit hook installed");
  }
  process.exit(0);
}

if (!fs.existsSync(path.join(root, ".git"))) {
  console.error("not a git repository");
  process.exit(1);
}
fs.mkdirSync(hooksDir, { recursive: true });

const contents = `#!/bin/sh
# Installed by tools/install-hooks.js
set -e
cd "$(git rev-parse --show-toplevel)"
echo "pre-commit: running npm run check"
npm run check
`;

fs.writeFileSync(hook, contents);
try {
  fs.chmodSync(hook, 0o755);
} catch {
  // chmod is a no-op on Windows; the hook still works under WSL/git-bash.
}

console.log("installed " + path.relative(root, hook));
console.log("remove with: node tools/install-hooks.js --uninstall");
