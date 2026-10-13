// 用 Node 直接对一个目录跑核心逻辑，打印统计信息。
// 用法：ELECTRON_RUN_AS_NODE=1 Cursor.exe dev/check-core.js <项目目录>
const fs = require("fs");
const path = require("path");
const { marked } = require("../media/vendor/marked.min.js");
const core = require("../core/mdmap-core.js");

const root = path.resolve(process.argv[2] || ".");
const project = new core.Project(marked, path.basename(root));
const cfg = path.join(root, ".mdmap.json");
project.setConfig(fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : null);
const excluded = core.createMatcher(core.DEFAULT_EXCLUDE.concat(project.ignoreGlobs));

(function walk(dir, rel) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + "/" + ent.name : ent.name;
    if (ent.isDirectory()) {
      if (!excluded(r + "/x")) walk(path.join(dir, ent.name), r);
    } else if (core.MD_RE.test(ent.name)) {
      const full = path.join(dir, ent.name);
      const st = fs.statSync(full);
      project.upsert(r, fs.readFileSync(full, "utf8"), { size: st.size, mtime: st.mtimeMs });
    }
  }
})(root, "");

const t0 = Date.now();
project.rebuild();
const snap = project.snapshot();
console.log(`重建耗时 ${Date.now() - t0}ms，文档 ${snap.total} 篇，译文 ${snap.zhCount} 篇，失效链接 ${snap.broken.length} 个`);
if (snap.configError) console.log("配置错误：", snap.configError);
(function print(nodes, indent) {
  for (const n of nodes) {
    console.log(`${indent}${n.label} (${n.count})`);
    if (indent.length < 4) print(n.children, indent + "  ");
  }
})(snap.tree, "");
console.log("\n失效链接示例：");
for (const b of snap.broken.slice(0, 15)) console.log(`  ${b.from} -> ${b.href}  [${b.reason}]`);
const top = Object.entries(snap.docs).sort((a, b) => b[1].back - a[1].back).slice(0, 5);
console.log("\n被引用最多：", top.map(([p, d]) => `${p}(${d.back})`).join(", "));
