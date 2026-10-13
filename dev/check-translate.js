// 离线检查 Markdown 切分与回填：用假译文（英文单词替换成“译”）跑遍目录下所有文档，
// 对比标题数、链接数、代码块是否保持不变，并统计残留英文最多的文档。
// 用法：node dev/check-translate.js <目录> [--show 相对路径]
"use strict";
const fs = require("fs");
const path = require("path");
const { marked } = require("../media/vendor/marked.min.js");
const core = require("../core/mdmap-core.js");
const { planDoc } = require("../translate/markdown.js");

const root = path.resolve(process.argv[2] || ".");
const showIdx = process.argv.indexOf("--show");
const show = showIdx > 0 ? process.argv[showIdx + 1] : null;
const excluded = core.createMatcher(core.DEFAULT_EXCLUDE.concat(["docs-map/**", ".mdmap/**"]));

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (e.isDirectory()) { if (!excluded(rel + "/")) walk(full, out); }
    else if (core.MD_RE.test(e.name) && !excluded(rel)) out.push(rel);
  }
  return out;
}

function shape(text) {
  const d = core.analyzeDoc(marked, "x.md", text);
  const codes = [];
  marked.walkTokens(marked.lexer(d.body), t => { if (t.type === "code") codes.push(t.text); });
  return { heads: d.heads.map(h => h.depth).join(","), links: d.links.map(l => l.href).join("\n"), codes: codes.join("\n\u0000\n") };
}

function residual(text) {
  const body = core.analyzeDoc(marked, "x.md", text).body
    .replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/\]\([^)]*\)/g, "]")
    .replace(/<[^>]+>/g, "").replace(/https?:\/\/\S+/g, "");
  return (body.match(/[A-Za-z]{3,}/g) || []).length;
}

const fake = s => s.replace(/[A-Za-z][A-Za-z'’-]*/g, "译");
let segs = 0, chars = 0, bad = 0;
const rows = [];
const t0 = Date.now();
for (const rel of walk(root, [])) {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  const plan = planDoc(marked, text);
  segs += plan.segments.length;
  chars += plan.segments.reduce((s, x) => s + x.text.length, 0);
  const ident = plan.render(plan.segments.map(s => s.text), "<!-- mark -->").text;
  const faked = plan.render(plan.segments.map(s => fake(s.text)), core.formatMtMark("fake", core.contentHash(text)));
  const a = shape(text), b = shape(ident), c = shape(faked.text);
  const problems = [];
  for (const k of ["heads", "links", "codes"]) {
    if (a[k] !== b[k]) problems.push("原样回填后 " + k + " 不一致");
    if (a[k] !== c[k]) problems.push("假译文后 " + k + " 不一致");
  }
  if (faked.failed) problems.push(`${faked.failed} 段回填失败`);
  if (problems.length) bad++;
  rows.push({ rel, segs: plan.segments.length, left: residual(faked.text), problems });
  if (rel === show) {
    console.log(faked.text);
    process.exit(0);
  }
}
rows.sort((x, y) => y.left - x.left);
console.log(`文档 ${rows.length} 篇，片段 ${segs} 个，待翻译 ${chars} 字符，结构异常 ${bad} 篇，用时 ${Date.now() - t0}ms`);
for (const r of rows.filter(r => r.problems.length)) console.log("  [异常]", r.rel, r.problems.join("；"));
console.log("残留英文单词最多的文档：");
for (const r of rows.slice(0, 8)) console.log(`  ${r.left}\t${r.rel}`);
