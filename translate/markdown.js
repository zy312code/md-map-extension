"use strict";
// 把 Markdown 拆成待翻译的文本片段，并在拿到译文后按原结构重新拼回去。
// 只翻译标题、段落、列表项、表格单元格、引用和 front matter 的 title/description；
// 代码块、HTML 块原样保留，行内代码、链接地址、HTML 标签、网址等替换成 {n} 占位符。

const INLINE_PROTECT = new RegExp([
  "``[^`]+?``|`[^`\\n]+`",
  "!\\[[^\\]]*\\]\\((?:[^()\\s]|\\([^()]*\\))*(?:\\s+\"[^\"]*\")?\\)",
  "\\]\\((?:[^()\\s]|\\([^()]*\\))*(?:\\s+\"[^\"]*\")?\\)",
  "\\]\\[[^\\]]*\\]",
  "\\[\\^[^\\]]+\\]",
  "<https?:[^>\\s]+>",
  "<\\/?[A-Za-z][^<>]*>",
  "(?:https?:\\/\\/|www\\.)[^\\s<>()\\[\\]]+",
  "[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+",
  "&[A-Za-z0-9#]+;",
  "\\{\\d+\\}",
].join("|"), "g");

const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;

function protect(raw) {
  const ph = [], tails = [];
  const text = raw.replace(/\s*\n\s*/g, " ").trim().replace(INLINE_PROTECT, m => {
    if (m.startsWith("](")) { tails.push(ph.length); ph.push(m.slice(1)); return "]{" + (ph.length - 1) + "}"; }
    ph.push(m);
    return "{" + (ph.length - 1) + "}";
  });
  return { raw, text, ph, tails };
}

// 去掉占位符后没有英文单词，或中文已经占多数，就不必翻译
function needsTranslation(text) {
  const s = text.replace(/\{\d+\}/g, " ");
  const latin = (s.match(/[A-Za-z]{2,}/g) || []).length;
  if (!latin) return false;
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length;
  return cjk < latin;
}

// 译文回填：占位符必须一个不少、一个不多，链接地址必须紧跟在 ] 之后，否则返回 null 让调用方保留原文
function restore(seg, translated) {
  let s = String(translated).replace(/\s*\n\s*/g, " ").trim();
  if (seg.tails.length && !/[【】]/.test(seg.text)) s = s.replace(/【/g, "[").replace(/】/g, "]");
  const used = new Array(seg.ph.length).fill(0);
  s = s.replace(/[{｛]\s*(\d+)\s*[}｝]/g, (m, i) => {
    i = +i;
    if (i >= seg.ph.length) return m;
    used[i]++;
    return `\u0000${i}\u0001`;
  });
  if (used.some(n => n !== 1)) return null;
  s = s.replace(/\]\s+(?=\u0000)/g, "]");
  if (seg.tails.some(i => !s.includes(`]\u0000${i}\u0001`))) return null;
  return s.replace(/\u0000(\d+)\u0001/g, (m, i) => seg.ph[+i]);
}

function expandTabs(md) {
  return md.replace(/^( *)(\t+)/gm, (m, lead, tabs) => lead + "    ".repeat(tabs.length));
}

function planDoc(marked, content) {
  const segments = [];
  const segOf = raw => {
    const s = protect(raw);
    if (!s.text || !needsTranslation(s.text)) return raw;
    segments.push(s);
    return { seg: segments.length - 1 };
  };
  const lines = (prefixFirst, prefixRest) => s =>
    s.split("\n").map((l, i) => (i === 0 ? prefixFirst + l : l ? prefixRest + l : l)).join("\n");

  function blocks(md) {
    md = expandTabs(md);
    let tokens;
    try { tokens = marked.lexer(md); } catch (e) { return [md]; }
    if (tokens.map(t => t.raw).join("") !== md) return [md];
    const out = [];
    for (const t of tokens) {
      const trail = /\n*$/.exec(t.raw)[0];
      out.push(block(t, t.raw.slice(0, t.raw.length - trail.length)), trail);
    }
    return out;
  }

  function block(t, core) {
    switch (t.type) {
      case "heading":
        return { items: ["#".repeat(t.depth) + " ", segOf(t.text)] };
      case "paragraph": {
        const alert = ALERT_RE.exec(core);
        if (!alert) return segOf(core);
        const rest = core.slice(alert[0].length);
        return { items: [alert[0], rest ? segOf(rest) : ""] };
      }
      case "blockquote": {
        const inner = core.split("\n").map(l => l.replace(/^ {0,3}> ?/, "")).join("\n");
        return { wrap: s => s.split("\n").map(l => (l ? "> " + l : ">")).join("\n"), items: blocks(inner) };
      }
      case "list": {
        // marked 会去掉最后一项末尾的换行，只要差的是空白就照样处理
        const joined = t.items.map(i => i.raw).join("");
        if (!core.startsWith(joined) || /\S/.test(core.slice(joined.length))) return core;
        return { items: [...t.items.map(listItem), core.slice(joined.length)] };
      }
      case "table": {
        const align = core.split("\n")[1];
        if (!t.header || !align) return core;
        const cell = c => ({ wrap: s => s.replace(/(^|[^\\])\|/g, "$1\\|"), items: [segOf(c.text)] });
        const row = cells => ({ items: ["| ", ...cells.flatMap((c, i) => (i ? [" | ", cell(c)] : [cell(c)])), " |"] });
        const items = [row(t.header), "\n" + align];
        for (const r of t.rows) items.push("\n", row(r));
        return { items };
      }
      default:
        return core;
    }
  }

  function listItem(item) {
    const m = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/.exec(item.raw);
    if (!m) return item.raw;
    let rest = item.raw.slice(m[0].length);
    const trail = /\n*$/.exec(rest)[0];
    rest = rest.slice(0, rest.length - trail.length);
    const task = /^\[[ xX]\][ \t]+/.exec(rest);
    if (task) rest = rest.slice(task[0].length);
    const width = m[0].length;
    const dedent = new RegExp(`^ {0,${width}}`);
    const inner = rest.split("\n").map((l, i) => (i === 0 ? l : l.replace(dedent, ""))).join("\n");
    return { items: [{ wrap: lines(m[0] + (task ? task[0] : ""), " ".repeat(width)), items: blocks(inner) }, trail] };
  }

  const src = String(content).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const items = [];
  let body = src;
  const fm = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (fm) {
    items.push("---\n");
    for (const line of fm[1].split("\n")) {
      const m = /^(title|description):[ \t]*(.*)$/.exec(line);
      const val = m && m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
      if (val && !/^[>|]/.test(val)) items.push(m[1] + ': "', { wrap: s => s.replace(/"/g, "'"), items: [segOf(val)] }, '"\n');
      else items.push(line + "\n");
    }
    items.push("---\n");
    body = src.slice(fm[0].length);
  }
  items.push({ header: true }, ...blocks(body));

  // results[i] 为第 i 个片段的译文（含占位符）；为空或回填失败时保留原文
  function render(results, header) {
    let failed = 0;
    const walk = list => list.map(x => {
      if (typeof x === "string") return x;
      if (x.header) return header ? header + "\n" : "";
      if (x.seg !== undefined) {
        const seg = segments[x.seg];
        const r = results[x.seg] == null ? null : restore(seg, results[x.seg]);
        if (r === null) { failed++; return seg.raw; }
        return r;
      }
      const s = walk(x.items);
      return x.wrap ? x.wrap(s) : s;
    }).join("");
    return { text: walk(items), failed };
  }

  return { segments, render };
}

module.exports = { planDoc, protect, restore, needsTranslation };
