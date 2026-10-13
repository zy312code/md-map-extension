// 解析、分组、排序与链接分析；不依赖 VS Code API，插件进程与网页面板共用。
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MdmapCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_EXCLUDE = [
    "**/node_modules/**", "**/.git/**", "**/.venv/**", "**/venv/**",
    "**/__pycache__/**", "**/dist/**", "**/.next/**", "**/.cache/**",
  ];
  const PALETTE = ["#2563eb", "#7c3aed", "#ea580c", "#059669", "#0891b2", "#db2777", "#ca8a04", "#4f46e5", "#dc2626", "#0d9488"];
  const MD_RE = /\.(md|markdown)$/i;
  const INDEX_NAMES = ["README.md", "readme.md", "index.md"];
  const DEFAULT_TRANS_DIR = ".mdmap/zh/";
  const MT_MARK_RE = /<!--\s*mdmap-mt:([^>]*?)-->/;

  // ---------- 机器翻译标记：译文开头记录翻译服务与原文指纹，用来判断译文是否过期 ----------
  function contentHash(text) {
    const s = String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
  function formatMtMark(provider, source) { return `<!-- mdmap-mt: provider=${provider} source=${source} -->`; }
  function parseMtMark(text) {
    const m = MT_MARK_RE.exec(String(text).slice(0, 4000));
    if (!m) return null;
    const mark = {};
    for (const kv of m[1].trim().split(/\s+/)) { const i = kv.indexOf("="); if (i > 0) mark[kv.slice(0, i)] = kv.slice(i + 1); }
    return mark.provider && mark.source ? mark : null;
  }

  // ---------- 文本工具 ----------
  function basename(p) { return p.slice(p.lastIndexOf("/") + 1); }
  function unquote(s) { return String(s).trim().replace(/^["']|["']$/g, ""); }
  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  function stripInline(s) {
    return String(s)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[^\w])[*_](\S(?:.*?\S)?)[*_](?=[^\w]|$)/g, "$1$2")
      .replace(/`/g, "")
      .replace(/\\([\\`*_{}\[\]()#+\-.!|])/g, "$1")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .trim();
  }

  function slugify(text) {
    return String(text).trim().toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
  }

  function resolvePath(from, rel) {
    const parts = from ? from.split("/").slice(0, -1) : [];
    for (const seg of rel.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg && seg !== ".") parts.push(seg);
    }
    return parts.join("/");
  }

  function normDir(s) {
    if (!s || typeof s !== "string") return "";
    const d = s.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
    return d ? d + "/" : "";
  }

  // ---------- glob 匹配（VS Code glob 语法的常用子集） ----------
  function globToRegExp(glob) {
    let re = "", depth = 0;
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === "*") {
        if (glob[i + 1] === "*") {
          i++;
          if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
        } else re += "[^/]*";
      } else if (c === "?") re += "[^/]";
      else if (c === "{") { depth++; re += "(?:"; }
      else if (c === "}" && depth) { depth--; re += ")"; }
      else if (c === "," && depth) re += "|";
      else if (c === "[") {
        const j = glob.indexOf("]", i + 1);
        if (j > i) { re += "[" + glob.slice(i + 1, j).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]"; i = j; }
        else re += "\\[";
      } else re += c.replace(/[.+^$()|\\\]]/g, "\\$&");
    }
    return new RegExp("^" + re + "$");
  }

  function normGlob(g) {
    g = String(g).replace(/\\/g, "/").replace(/^\.\//, "");
    return g.endsWith("/") ? g + "**" : g;
  }

  // 同时检查文件本身及其每一级上级目录，兼容只匹配目录名的规则（如 files.exclude 的 "**/.git"）
  function createMatcher(globs) {
    const res = globs.map(globToRegExp);
    return function excluded(path) {
      if (!res.length) return false;
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join("/");
        const candidates = i < parts.length ? [p, p + "/"] : [p];
        if (candidates.some(c => res.some(r => r.test(c)))) return true;
      }
      return false;
    };
  }

  // ---------- 单篇文档解析 ----------
  function splitFront(text) {
    const src = String(text).replace(/^\uFEFF/, "");
    const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (!m) return { front: null, fm: {}, body: src };
    const fm = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (kv) fm[kv[1]] = unquote(kv[2]);
    }
    return { front: m[1], fm, body: src.slice(m[0].length) };
  }

  function analyzeDoc(marked, path, text) {
    const { front, fm, body } = splitFront(text);
    const heads = [], links = [], anchors = new Set();
    let tokens = [];
    try { tokens = marked.lexer(body); } catch (e) { tokens = []; }
    const scanHtml = raw => {
      for (const m of raw.matchAll(/<a\s[^>]*?href\s*=\s*["']([^"']+)["']/gi)) links.push({ href: m[1], text: "" });
      for (const m of raw.matchAll(/\s(?:id|name)\s*=\s*["']([^"']+)["']/gi)) anchors.add(m[1].toLowerCase());
    };
    try {
      marked.walkTokens(tokens, t => {
        if (t.type === "heading") heads.push({ depth: t.depth, text: stripInline(t.text) });
        else if (t.type === "link") links.push({ href: t.href, text: stripInline(t.text || "") });
        else if (t.type === "html") scanHtml(t.raw || "");
      });
    } catch (e) { /* 解析失败时仅保留已收集的结果 */ }

    const seen = {};
    for (const h of heads) {
      let s = slugify(h.text);
      if (seen[s] !== undefined) { seen[s]++; s = s + "-" + seen[s]; } else seen[s] = 0;
      h.slug = s;
      anchors.add(s);
    }

    const h1 = heads.find(h => h.depth === 1);
    const title = fm.title || (h1 && h1.text) || fm.name || basename(path).replace(MD_RE, "");
    const order = fm.order !== undefined && fm.order !== "" && !isNaN(+fm.order) ? +fm.order : null;
    const cjk = (body.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    const latin = (body.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, " ").match(/[A-Za-z0-9][A-Za-z0-9_'’-]*/g) || []).length;

    return {
      path, name: basename(path), title, desc: fm.description || "", order,
      front, fm, body, content: text, heads, links, anchors,
      lines: String(text).split("\n").length, words: cjk + latin,
      size: 0, mtime: 0, out: [], brokenCount: 0,
    };
  }

  // ---------- 链接解析 ----------
  function hasAnchor(doc, anchor) {
    if (!doc) return false;
    const a = anchor.toLowerCase();
    return doc.anchors.has(a) || /^l\d+(-l\d+)?$/.test(a);
  }

  function resolveTarget(from, p, hasDoc) {
    const t = p.startsWith("/") ? resolvePath("", p.slice(1)) : resolvePath(from, p);
    if (hasDoc(t) || MD_RE.test(t)) return t;
    const base = t ? t + "/" : "";
    for (const n of INDEX_NAMES) if (hasDoc(base + n)) return base + n;
    return t;
  }

  function splitHref(href) {
    const at = href.indexOf("#");
    const p = (at >= 0 ? href.slice(0, at) : href).split("?")[0];
    const anchor = at >= 0 ? href.slice(at + 1) : "";
    return { p: safeDecode(p), anchor: safeDecode(anchor) };
  }

  function isExternal(href) { return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href); }

  function resolveLink(from, href, docs) {
    href = String(href || "").trim();
    if (!href) return { kind: "empty", href, ok: null };
    if (isExternal(href)) return { kind: "external", href, ok: null };
    const { p, anchor } = splitHref(href);
    if (!p) {
      const ok = !anchor || hasAnchor(docs.get(from), anchor);
      return { kind: "anchor", href, target: from, anchor, ok, reason: ok ? "" : "本页没有这个锚点" };
    }
    const target = resolveTarget(from, p, x => docs.has(x));
    if (docs.has(target)) {
      const ok = !anchor || hasAnchor(docs.get(target), anchor);
      return { kind: "doc", href, target, anchor, ok, reason: ok ? "" : "目标文档中没有这个锚点" };
    }
    if (MD_RE.test(target)) return { kind: "doc", href, target, anchor, ok: false, reason: "文档不存在或已被忽略" };
    return { kind: "file", href, target, anchor, ok: null };
  }

  function analyzeLinks(docs) {
    const back = new Map(), broken = [];
    for (const d of docs.values()) {
      d.out = [];
      d.brokenCount = 0;
      for (const l of d.links) {
        const r = resolveLink(d.path, l.href, docs);
        r.text = l.text;
        d.out.push(r);
        if (r.kind === "doc" && r.ok && r.target !== d.path) {
          if (!back.has(r.target)) back.set(r.target, new Set());
          back.get(r.target).add(d.path);
        }
        if (r.ok === false) {
          d.brokenCount++;
          broken.push({ from: d.path, href: r.href, text: r.text, target: r.target, reason: r.reason });
        }
      }
    }
    const backSorted = new Map();
    for (const [k, v] of back) backSorted.set(k, [...v].sort());
    return { back: backSorted, broken };
  }

  // ---------- 层级树 ----------
  function sortDocs(a, b) {
    const oa = a.order === null ? Infinity : a.order, ob = b.order === null ? Infinity : b.order;
    if (oa !== ob) return oa - ob;
    const rank = d => /^(readme|skill|index)\.(md|markdown)$/i.test(d.name) ? 0 : 1;
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  }

  function buildTree(docs, config) {
    const modulesCfg = Array.isArray(config.modules) ? config.modules : [];
    const hints = config.dirLabels && typeof config.dirLabels === "object" ? config.dirLabels : {};
    const explicit = new Set(), placed = new Set();
    (function collect(nodes) {
      for (const n of nodes || []) {
        if (!n || typeof n !== "object") continue;
        for (const f of n.files || []) if (docs.has(f)) explicit.add(f);
        collect(n.children);
      }
    })(modulesCfg);

    function dirDesc(dir) {
      if (hints[dir]) return hints[dir];
      for (const n of INDEX_NAMES) { const d = docs.get(dir + n); if (d) return d.title; }
      const skill = docs.get(dir + "SKILL.md");
      return skill ? skill.desc : "";
    }

    function autoTree(prefix) {
      const list = [...docs.values()].filter(d => !explicit.has(d.path) && !placed.has(d.path) && d.path.startsWith(prefix));
      list.forEach(d => placed.add(d.path));
      const top = { docs: [], children: [], dirs: new Map() };
      for (const d of list) {
        const parts = d.path.slice(prefix.length).split("/");
        let cur = top, acc = prefix;
        for (const seg of parts.slice(0, -1)) {
          acc += seg + "/";
          if (!cur.dirs.has(seg)) {
            const node = { label: seg + "/", desc: dirDesc(acc), docs: [], children: [], dirs: new Map() };
            cur.dirs.set(seg, node);
            cur.children.push(node);
          }
          cur = cur.dirs.get(seg);
        }
        cur.docs.push(d);
      }
      (function finish(n) {
        n.docs.sort(sortDocs);
        n.children.sort((a, b) => a.label.localeCompare(b.label));
        n.children.forEach(finish);
        delete n.dirs;
      })(top);
      return top;
    }

    function resolveNode(cfg) {
      const node = { label: cfg.label || "", desc: cfg.desc || "", sub: cfg.sub || "", color: cfg.color || "", docs: [], children: [] };
      for (const f of cfg.files || []) {
        if (docs.has(f) && !placed.has(f)) { node.docs.push(docs.get(f)); placed.add(f); }
      }
      for (const c of cfg.children || []) if (c && typeof c === "object") node.children.push(resolveNode(c));
      if (typeof cfg.auto === "string") {
        const t = autoTree(normDir(cfg.auto) || "");
        node.docs.push(...t.docs);
        node.children.push(...t.children);
      }
      const flat = [];
      for (const c of node.children) {
        if (!c.label) { node.docs.push(...c.docs); flat.push(...c.children); }
        else flat.push(c);
      }
      node.children = flat.filter(c => countDocs(c) > 0);
      return node;
    }

    const modules = modulesCfg.filter(m => m && typeof m === "object").map(resolveNode);

    // 未被配置覆盖的文档：根目录文件归一个模块，其余按第一级目录各成一个模块
    const rest = [...docs.values()].filter(d => !placed.has(d.path));
    const rootFiles = rest.filter(d => !d.path.includes("/")).sort(sortDocs);
    if (rootFiles.length) {
      rootFiles.forEach(d => placed.add(d.path));
      modules.push({ label: "根目录文件", desc: "项目根目录下的文档", sub: "/", color: "", docs: rootFiles, children: [] });
    }
    const tops = [...new Set(rest.filter(d => d.path.includes("/")).map(d => d.path.split("/")[0]))].sort((a, b) => a.localeCompare(b));
    for (const t of tops) {
      const tree = autoTree(t + "/");
      modules.push({ label: t + "/", desc: dirDesc(t + "/"), sub: t + "/", color: "", docs: tree.docs, children: tree.children });
    }

    const result = modules.filter(m => countDocs(m) > 0);
    const crumbs = new Map();
    result.forEach((m, i) => {
      const color = m.color || PALETTE[i % PALETTE.length];
      (function finalize(n, key, trail) {
        n.key = key;
        n.color = color;
        n.count = countDocs(n);
        const t = trail.concat(n.label);
        n.docs = n.docs.map(d => { crumbs.set(d.path, t); return d.path; });
        n.children.forEach(c => finalize(c, key + "/" + c.label, t));
      })(m, m.label, []);
    });
    return { tree: result, crumbs };
  }

  function countDocs(n) { return n.docs.length + n.children.reduce((s, c) => s + countDocs(c), 0); }

  // ---------- 系统模块树：把 mdmap-arch 的归纳结果整理成与目录树相同的节点结构 ----------
  const OTHER = "#other";
  function buildSystemTree(sys, docs) {
    const roleRank = p => { const i = sys.roleOrder.indexOf(sys.roles.get(p)); return i < 0 ? 99 : i; };
    const byRole = (a, b) => roleRank(a) - roleRank(b) || sortDocs(docs.get(a), docs.get(b));
    const moduleOf = p => sys.assign.has(p) ? sys.assign.get(p).key : OTHER;
    const modules = {};
    for (const m of sys.modules.values()) {
      modules[m.key] = { key: m.key, label: m.label, name: m.name, path: m.path, parent: m.parent, children: m.children.slice(), docs: m.docs.slice().sort(byRole), related: [] };
    }
    if (sys.unassigned.length) {
      modules[OTHER] = { key: OTHER, label: "综合文档", name: "", path: "", parent: null, children: [], docs: sys.unassigned.slice().sort(byRole), related: [] };
    }
    const ancestors = k => { const a = []; for (let x = k; x; x = modules[x].parent) a.push(x); return a; };
    const count = k => modules[k].docs.length + modules[k].children.reduce((s, c) => s + count(c), 0);

    // 模块之间的关联：两个模块的文档互相链接的次数（不计上下级模块之间的链接）
    const pairs = new Map();
    for (const d of docs.values()) {
      const a = moduleOf(d.path);
      for (const o of d.out) {
        if (o.kind !== "doc" || !o.ok || !docs.has(o.target)) continue;
        const b = moduleOf(o.target);
        if (a === b || ancestors(a).includes(b) || ancestors(b).includes(a)) continue;
        const k = a < b ? a + "\n" + b : b + "\n" + a;
        pairs.set(k, (pairs.get(k) || 0) + 1);
      }
    }
    for (const [k, n] of pairs) {
      const [a, b] = k.split("\n");
      modules[a].related.push({ key: b, n });
      modules[b].related.push({ key: a, n });
    }
    for (const m of Object.values(modules)) m.related.sort((x, y) => y.n - x.n);

    const roleSummary = k => {
      const c = {};
      for (const p of modules[k].docs) { const r = sys.roles.get(p); c[r] = (c[r] || 0) + 1; }
      return sys.roleOrder.filter(r => c[r]).map(r => `${r} ${c[r]}`).join(" · ");
    };
    const crumbs = new Map(), info = new Map();
    function node(k, color, trail) {
      const m = modules[k];
      const t = trail.concat(m.label);
      m.count = count(k);
      m.docs.forEach(p => {
        crumbs.set(p, t);
        const a = sys.assign.get(p);
        info.set(p, { module: k, role: sys.roles.get(p), reasons: a ? a.reasons : [] });
      });
      const children = m.children.slice().sort((x, y) => count(y) - count(x)).map(c => node(c, color, t));
      m.children = children.map(c => c.mod);
      const sub = m.label !== m.name && m.name ? m.name + (m.path ? " · " + m.path : "") : m.path;
      return { key: "sys:" + k, mod: k, label: m.label, sub, desc: roleSummary(k), color, docs: m.docs, children, count: m.count };
    }
    const tops = Object.values(modules).filter(m => !m.parent && m.key !== OTHER).sort((a, b) => count(b.key) - count(a.key));
    if (modules[OTHER]) tops.push(modules[OTHER]);
    const tree = tops.map((m, i) => node(m.key, m.key === OTHER ? "#6b7280" : PALETTE[i % PALETTE.length], []));
    if (modules[OTHER]) tree[tree.length - 1].sub = "跨模块或没有明确归属的文档";
    return { tree, crumbs, info, modules };
  }

  // ---------- 项目模型：宿主负责 IO，这里只维护索引 ----------
  class Project {
    constructor(marked, name) {
      this.marked = marked;
      this.name = name;
      this.docs = new Map();
      this.zhParts = new Map();
      this.zh = new Map();
      this.zhDirty = new Set();
      this.tree = [];
      this.crumbs = new Map();
      this.back = new Map();
      this.broken = [];
      this.system = null;
      this.setConfig(null);
    }

    // sys 为 mdmap-arch inferModules 的结果，需在 rebuild 之后调用
    setSystem(sys) {
      this.system = sys ? buildSystemTree(sys, this.docs) : null;
    }

    setConfig(text) {
      this.config = {};
      this.configError = null;
      this.hasConfig = text != null;
      if (text != null && text.trim()) {
        try {
          const c = JSON.parse(text);
          if (c && typeof c === "object" && !Array.isArray(c)) this.config = c;
        } catch (e) { this.configError = ".mdmap.json 解析失败：" + e.message; }
      }
      this.transDir = normDir(this.config.translations && this.config.translations.zh) || DEFAULT_TRANS_DIR;
      this.ignoreGlobs = (Array.isArray(this.config.ignore) ? this.config.ignore : []).map(normGlob);
      this.setExtraExcludes(this.extraGlobs || []);
    }

    // 宿主环境提供的额外排除规则（如编辑器的 files.exclude）
    setExtraExcludes(globs) {
      this.extraGlobs = globs.map(normGlob);
      this.excluded = createMatcher(DEFAULT_EXCLUDE.concat(this.ignoreGlobs, this.extraGlobs));
    }

    excludeGlobs() {
      return DEFAULT_EXCLUDE.concat(this.ignoreGlobs, this.extraGlobs);
    }

    classify(rel) {
      if (!MD_RE.test(rel)) return null;
      if (this.transDir && rel.startsWith(this.transDir)) return "zh";
      if (this.excluded(rel)) return null;
      return "doc";
    }

    clear() {
      this.docs.clear();
      this.zhParts.clear();
      this.zh.clear();
      this.zhDirty.clear();
    }

    // 返回 "added" | "changed" | {zh: key} | null
    upsert(rel, text, stat) {
      const kind = this.classify(rel);
      if (kind === "doc") {
        const existed = this.docs.has(rel);
        const d = analyzeDoc(this.marked, rel, text);
        d.size = stat ? stat.size : text.length;
        d.mtime = stat ? stat.mtime : 0;
        d.hash = contentHash(text);
        this.docs.set(rel, d);
        return existed ? "changed" : "added";
      }
      if (kind === "zh") {
        const inner = rel.slice(this.transDir.length);
        const m = inner.match(/^(.*?)(?:\.part(\d+))?\.(?:md|markdown)$/i);
        const key = m[1] + ".md";
        this.zhParts.set(rel, { key, order: m[2] ? +m[2] : -1, text });
        this.zhDirty.add(key);
        return { zh: key };
      }
      return null;
    }

    // 删除单个文件或整个目录下的文档，返回受影响的原文路径
    remove(rel) {
      const removed = [], zhKeys = [];
      const prefix = rel.replace(/\/$/, "") + "/";
      for (const p of [...this.docs.keys()]) {
        if (p === rel || p.startsWith(prefix)) { this.docs.delete(p); removed.push(p); }
      }
      for (const [p, part] of [...this.zhParts]) {
        if (p === rel || p.startsWith(prefix)) { this.zhParts.delete(p); this.zhDirty.add(part.key); zhKeys.push(part.key); }
      }
      return { removed, zhKeys };
    }

    has(rel) { return this.docs.has(rel) || this.zhParts.has(rel); }

    rebuild() {
      for (const key of this.zhDirty) {
        const parts = [...this.zhParts.values()].filter(p => p.key === key);
        if (!parts.length) { this.zh.delete(key); continue; }
        const whole = parts.find(p => p.order === -1);
        const list = whole ? [whole] : parts.sort((a, b) => a.order - b.order);
        const text = list.map(p => (p.text.endsWith("\n") ? p.text : p.text + "\n")).join("");
        const z = analyzeDoc(this.marked, key, text);
        z.mt = parseMtMark(text);
        this.zh.set(key, z);
      }
      this.zhDirty.clear();
      const { tree, crumbs } = buildTree(this.docs, this.config);
      this.tree = tree;
      this.crumbs = crumbs;
      const { back, broken } = analyzeLinks(this.docs);
      this.back = back;
      this.broken = broken;
    }

    // 译文状态：null 表示没有译文；mt 为生成它的翻译服务（人工译文为 null）；stale 表示原文在机器翻译之后被修改过
    zhState(path) {
      const d = this.docs.get(path), z = this.zh.get(path);
      if (!d || !z) return null;
      return { mt: z.mt ? z.mt.provider : null, stale: !!z.mt && z.mt.source !== d.hash };
    }

    snapshot() {
      const docs = {};
      let totalSize = 0, zhCount = 0, zhStale = 0;
      const sys = this.system;
      for (const [p, d] of this.docs) {
        const z = this.zh.get(p), zs = this.zhState(p);
        if (z) zhCount++;
        if (zs && zs.stale) zhStale++;
        totalSize += d.size;
        docs[p] = {
          name: d.name, title: d.title, zhTitle: z ? z.title : null, desc: d.desc,
          zhMt: zs ? zs.mt : null, zhStale: !!(zs && zs.stale),
          size: d.size, mtime: d.mtime, lines: d.lines, words: d.words,
          broken: d.brokenCount, back: (this.back.get(p) || []).length,
          crumbs: this.crumbs.get(p) || [],
          sys: sys && sys.info.has(p) ? Object.assign({ crumbs: sys.crumbs.get(p) }, sys.info.get(p)) : null,
        };
      }
      return {
        name: this.name, tree: this.tree, docs, broken: this.broken,
        sysTree: sys ? sys.tree : null, modules: sys ? sys.modules : null,
        total: this.docs.size, totalSize, zhCount, zhStale,
        hasTranslations: zhCount > 0, hasConfig: this.hasConfig, configError: this.configError,
      };
    }

    docPayload(path) {
      const d = this.docs.get(path);
      if (!d) return null;
      const z = this.zh.get(path), zs = this.zhState(path);
      return {
        path, front: d.front, body: d.body, content: d.content,
        slugs: d.heads.map(h => h.slug), headCount: d.heads.length,
        out: d.out, back: this.back.get(path) || [],
        zh: z ? { front: z.front, body: z.body, content: z.content, title: z.title, headCount: z.heads.length, mt: zs.mt, stale: zs.stale } : null,
      };
    }

    search(q, full) {
      q = String(q || "").trim().toLowerCase();
      if (!q) return [];
      const hits = [];
      for (const [p, d] of this.docs) {
        const z = this.zh.get(p);
        const meta = (p + " " + d.title + " " + (z ? z.title : "")).toLowerCase().includes(q);
        let count = 0, snip = "";
        if (full) {
          for (const text of [d.content, z && z.content]) {
            if (!text) continue;
            const low = text.toLowerCase();
            let i = low.indexOf(q);
            if (i !== -1 && !snip) snip = text.slice(Math.max(0, i - 40), i + q.length + 60).replace(/\s+/g, " ");
            while (i !== -1) { count++; i = low.indexOf(q, i + q.length); }
          }
        }
        if (meta || count) hits.push({ path: p, meta, count, snip });
      }
      hits.sort((a, b) => (b.meta - a.meta) || (b.count - a.count) || a.path.localeCompare(b.path));
      return hits.slice(0, 200);
    }
  }

  return {
    DEFAULT_EXCLUDE, DEFAULT_TRANS_DIR, MD_RE, Project, contentHash, formatMtMark, parseMtMark,
    analyzeDoc, buildTree, buildSystemTree, analyzeLinks, resolveLink, resolveTarget, resolvePath,
    splitHref, isExternal, slugify, stripInline, globToRegExp, createMatcher, normDir,
  };
});
