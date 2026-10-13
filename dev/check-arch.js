// 在目录上运行系统模块归纳，打印模块树、每篇文档的归属与理由。
// 用法：node dev/check-arch.js <目录> [--why]
"use strict";
const fs = require("fs");
const path = require("path");
const { marked } = require("../media/vendor/marked.min.js");
const core = require("../core/mdmap-core.js");
const arch = require("../core/mdmap-arch.js");

const root = path.resolve(process.argv[2] || ".");
const why = process.argv.includes("--why");
const project = new core.Project(marked, path.basename(root));
const cfg = path.join(root, ".mdmap.json");
project.setConfig(fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : null);
const excluded = core.createMatcher(core.DEFAULT_EXCLUDE.concat(project.ignoreGlobs, ["md-map-extension/**", "docs-map/**"]));

const code = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (e.isDirectory()) { if (!excluded(rel + "/") || (project.transDir && rel + "/" === project.transDir)) walk(full); continue; }
    if (arch.CODE_RE.test(e.name) && !excluded(rel)) code.push(rel);
    else if (project.classify(rel)) project.upsert(rel, fs.readFileSync(full, "utf8"), null);
  }
})(root);
project.rebuild();

const t0 = Date.now();
const r = arch.inferModules(project.docs, code);
console.log(`文档 ${project.docs.size} 篇，源码 ${code.length} 个，模块 ${r.modules.size} 个，未归类 ${r.unassigned.length} 篇，用时 ${Date.now() - t0}ms\n`);
const fmt = a => Object.entries(a.ev).filter(([, v]) => v).map(([k, v]) => `${k}${v}`).join(" ");
function print(key, depth) {
  const m = r.modules.get(key);
  console.log(`${"  ".repeat(depth)}■ ${m.label}${m.label !== m.name ? `（${m.name}）` : ""}  [${m.path}]  ${m.docs.length} 篇`);
  for (const p of m.docs) {
    const a = r.assign.get(p);
    console.log(`${"  ".repeat(depth + 1)}- ${p}  〈${r.roles.get(p)}〉` + (why ? `  ${a.score.toFixed(1)} ${fmt(a)}` : ""));
  }
  for (const c of m.children.sort()) print(c, depth + 1);
}
for (const m of [...r.modules.values()].filter(m => !m.parent).sort((a, b) => b.docs.length - a.docs.length)) print(m.key, 0);
console.log("\n■ 未归类");
for (const p of r.unassigned) console.log("  - " + p);
