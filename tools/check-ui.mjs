import fs from "node:fs";

const html = fs.readFileSync("index.html", "utf8");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const htmlClasses = new Set(
  [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/))
);

const cfg = fs.readFileSync("js/config.js", "utf8");
const dom = {};
for (const m of cfg.matchAll(/(\w+):\s*["']([^"']+)["']/g)) {
  if (m[2].startsWith("#") || m[2].startsWith(".")) dom[m[1]] = m[2];
}

const popup = fs.readFileSync("js/popup.js", "utf8");
const used = new Set([...popup.matchAll(/config\.domElements\.(\w+)/g)].map((m) => m[1]));

let bad = 0;
for (const k of used) {
  const sel = dom[k];
  if (!sel) { console.log("NO SELECTOR ", k); bad++; continue; }
  if (sel.startsWith("#") && !htmlIds.has(sel.slice(1))) {
    console.log("MISSING ID  ", k, sel); bad++;
  }
  if (sel.startsWith(".") && !htmlClasses.has(sel.slice(1))) {
    console.log("MISSING CLS ", k, sel); bad++;
  }
}

console.log("---");
console.log("html ids   :", [...htmlIds].sort().join(", "));
console.log("unused cfg :", Object.keys(dom).filter((k) => !used.has(k)).join(", ") || "(none)");
console.log(bad ? `PROBLEMS: ${bad}` : "OK - all dom refs resolve");
