// 从文档内容归纳系统模块，不依赖 VS Code API。
// 1. 以源码目录结构作为系统骨架：顶层目录是一级模块；几乎所有文档都会提到的目录（通常是项目主包）展开为它的子目录。
// 2. 每篇文档按标题、路径、小节标题、描述、引用的源码路径和正文提及给各模块打分，先按“模块 + 子模块”的总分选一级模块，
//    子模块证据足够强（标题或路径直接命中）时再细分到子模块。每篇文档只归入一个主模块，证据不足或分散的文档不归入具体模块。
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MdmapArch = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CODE_RE = /\.(py|ts|tsx|js|jsx|mjs|go|rs|java|kt|cs|rb|php|swift|c|cc|cpp|h|hpp|scala|dart|vue|svelte)$/i;
  // 不代表系统功能的目录（packages / apps 等 monorepo 包目录单独处理，不在这里跳过）
  const SKIP_SEGMENTS = new Set([
    "test", "tests", "spec", "specs", "__tests__", "testing", "fixtures", "mocks", "mock", "e2e",
    "script", "scripts", "bin", "build", "dist", "out", "target", "vendor", "third_party", "node_modules",
    "doc", "docs", "example", "examples", "sample", "samples", "demo", "asset", "assets", "static", "public",
    "migration", "migrations", "locale", "locales", "i18n", "style", "styles", "css", "icon", "icons", "image", "images",
    "snapshot", "snapshots", "patch", "patches", "coverage", "storybook", ".storybook",
  ]);
  // monorepo 包目录：本身不是功能模块，展开为其中的包名
  const MONOREPO_ROOTS = new Set(["packages", "apps", "libs", "modules", "crates", "services", "packages-js", "packages-py"]);
  // 太泛、不足以代表一个系统模块的名字
  const STOP = new Set([
    "init", "main", "index", "util", "utils", "helper", "helpers", "common", "base", "type", "types", "constant",
    "constants", "const", "misc", "core", "lib", "src", "app", "apps", "internal", "private", "shared", "model", "models",
    "default", "defaults", "conftest", "setup", "version", "error", "errors", "exception", "exceptions", "log",
    "logging", "logger", "compat", "abc", "interface", "interfaces", "impl", "manager", "service", "services",
    "handler", "handlers", "client", "server", "component", "components", "page", "pages", "view", "views",
    "store", "state", "schema", "schemas", "registry", "loader", "runner", "build", "connect", "format", "status",
    "host", "self", "contract", "manifest", "document", "transcript", "platform", "rendering", "runtime", "message",
    "network", "routing", "instance", "terminal", "workbench", "evaluator", "template", "path", "file", "data",
    "event", "result", "request", "response", "option", "setting", "feature", "support", "helper", "wrapper",
    "key", "id", "name", "value", "item", "list", "info", "process",
  ]);
  // 测试夹具、快照、多语言 README 副本等不代表系统功能，不归入模块
  const TEST_DOC_RE = /(^|\/)(tests?|specs?|__tests__|fixtures|mocks?|e2e|snapshots?)\//i;
  const LOCALE_README_RE = /^readme\.[a-z0-9-]+\.md$/i;
  // 常见技术词的中文名，只用于显示
  const GLOSSARY = {
    agent: "智能体", memory: "记忆", skill: "技能", channel: "渠道", provider: "模型提供商", tool: "工具",
    security: "安全", config: "配置", cron: "定时任务", session: "会话", gateway: "网关", webui: "Web 界面",
    tui: "终端界面", cli: "命令行", api: "OpenAI 兼容 API", sdk: "Python SDK", subagent: "子智能体", mcp: "MCP 工具",
    trigger: "触发器", automation: "自动化", audio: "音频", bus: "消息总线", command: "命令", pairing: "配对",
    web: "网页工具", search: "搜索", sandbox: "沙箱", shell: "Shell", filesystem: "文件系统", plugin: "插件",
    "image generation": "图像生成", "llm usage": "用量统计", autocompact: "上下文压缩", heartbeat: "心跳",
    "model preset": "模型预设", "model runtime": "模型运行时", goal: "目标", transcription: "语音转写",
    hook: "钩子", context: "上下文", "remote instance": "远程实例",
  };
  // 代码名与文档常用叫法不一致时的别名
  const ALIASES = { weixin: ["wechat"], wecom: ["wechat work"], msteams: ["microsoft team", "team"], tui: ["terminal ui"] };
  const PATH_RE = /(?:^|[\s`'"(\[])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\/?)/g;

  function singular(w) {
    if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
    if (w.length > 3 && /[^su]s$/.test(w)) return w.slice(0, -1);
    return w;
  }
  function words(s) {
    return (String(s).replace(/([a-z0-9])([A-Z][a-z])/g, "$1 $2").toLowerCase().match(/[a-z][a-z0-9]*/g) || []).map(singular);
  }
  function norm(s) { return " " + words(s).join(" ") + " "; }
  function count(hay, phrase) {
    let n = 0, i = hay.indexOf(phrase);
    while (i !== -1) { n++; i = hay.indexOf(phrase, i + phrase.length - 1); }
    return n;
  }
  function keyOf(name) {
    const w = words(name.replace(/^_+/, ""));
    if (!w.length || w.join("").length < 2 || w.every(x => STOP.has(x))) return null;
    return w.join(" ");
  }

  // ---------- 系统骨架：模块树 ----------
  // 节点：{ key, name, paths:Set, parent, children:Set, depth, file }；同名目录 / 文件合并为一个节点，以最浅的一处为准。
  // file 表示该模块只由单个源码文件构成（如 memory.py）
  function buildSkeleton(codePaths, docCount, mentions) {
    const files = codePaths.filter(p => CODE_RE.test(p)).map(p => p.split("/"))
      .filter(s => !s.slice(0, -1).some(x => x.startsWith(".") || SKIP_SEGMENTS.has(x.toLowerCase())));
    const nodes = new Map();
    const node = (key, name, path, parent, depth, file) => {
      let n = nodes.get(key);
      if (!n) { n = { key, name, paths: new Set(), parent, children: new Set(), depth, file }; nodes.set(key, n); }
      if (depth < n.depth) Object.assign(n, { depth, parent, name, file, paths: new Set() });
      if (depth === n.depth) { n.paths.add(path); n.file = n.file && file; }
      return n;
    };
    // 一级：顶层目录。下列情况展开为子目录 / 文件：
    // - monorepo 包目录（packages / apps / …）
    // - 被大多数文档提到的目录（通常是项目主包，如 nanobot/）
    const tops = [...new Set(files.filter(s => s.length > 1).map(s => s[0]))];
    const roots = [];
    for (const t of tops) {
      const key = keyOf(t);
      const expand = MONOREPO_ROOTS.has(t.toLowerCase()) || (key && mentions(key) / docCount > 0.5);
      if (expand) {
        for (const s of files) if (s[0] === t && s.length > 1 && keyOf(s[1].replace(/\.[^.]+$/, "")) !== key) roots.push({ base: t, seg: s[1].replace(/\.[^.]+$/, ""), file: s.length === 2, rest: s.slice(2) });
      } else {
        for (const s of files) if (s[0] === t) roots.push({ base: "", seg: t, file: false, rest: s.slice(1) });
      }
    }
    for (const r of roots) {
      const key1 = keyOf(r.seg);
      if (!key1) continue;
      const p1 = (r.base ? r.base + "/" : "") + r.seg;
      node(key1, r.seg, p1, null, 1, r.file);
      // 二、三级：优先用目录；单文件只有名字短且有辨识度时才单独成模块（如 memory.py、mcp.py），
      // 避免 monorepo 里大量 session-persistence.ts 这类文件名刷出噪声模块
      let parentKey = key1, path = p1;
      const rest = r.rest.slice();
      for (let i = 0; i < Math.min(2, rest.length); i++) {
        const file = i === rest.length - 1;
        const seg = file ? rest[i].replace(/\.[^.]+$/, "") : rest[i];
        if (SKIP_SEGMENTS.has(seg.toLowerCase())) break;
        const key = keyOf(seg);
        path += "/" + seg;
        if (!key || key === parentKey) break;
        if (file && key.split(" ").length > 1 && !GLOSSARY[key] && !ALIASES[key]) break;
        node(key, seg, path, parentKey, i + 2, file);
        parentKey = key;
      }
    }
    for (const n of nodes.values()) if (n.parent && nodes.has(n.parent)) nodes.get(n.parent).children.add(n.key);
    return nodes;
  }

  // ---------- 文档特征 ----------
  function docFeatures(d, codeSet, codeDirs) {
    const codeRefs = new Set();
    const addRef = p => {
      p = p.replace(/^\.?\//, "").replace(/\/$/, "");
      if (codeSet.has(p) || codeDirs.has(p)) codeRefs.add(p.replace(/\.[^./]+$/, ""));
    };
    for (const o of d.out || []) if (o.kind === "file" && o.target) addRef(o.target);
    for (const m of d.body.matchAll(PATH_RE)) addRef(m[1]);
    const dirs = d.path.split("/").slice(0, -1).filter(s => !s.startsWith("."));
    const stem = d.name.replace(/\.(md|markdown)$/i, "");
    return {
      title: norm(d.title + " " + (d.fm && d.fm.name || "")),
      near: norm((/^(readme|skill|index)$/i.test(stem) ? "" : stem) + " " + (dirs[dirs.length - 1] || "")),
      far: norm(dirs.slice(0, -1).join(" ")),
      desc: norm(d.desc || ""),
      heads: norm(d.heads.map(h => h.text).join(" . ")),
      body: norm(d.body.replace(/```[\s\S]*?```/g, " ")),
      codeRefs,
    };
  }

  function refsUnder(refs, n) {
    let c = 0;
    for (const r of refs) for (const p of n.paths) if (r === p || r.startsWith(p + "/")) { c++; break; }
    return c;
  }

  function explain(ev, word) {
    const w = `「${word}」`, out = [];
    if (ev.title) out.push(`标题提到${w}`);
    if (ev.path) out.push(`文件名或所在目录是${w}`);
    if (ev.dir) out.push(`位于${w}目录下`);
    if (ev.desc) out.push(`描述中提到${w}`);
    if (ev.heads) out.push(`${ev.heads} 个小节标题提到${w}`);
    if (ev.code) out.push(`引用了该模块的 ${ev.code} 个源码文件`);
    if (ev.body) out.push(`正文提到${w} ${ev.body} 次`);
    return out;
  }

  const ROLE_ORDER = ["概览", "说明文档", "使用指南", "参考手册", "技能定义", "提示词与模板"];

  function docRole(d) {
    const p = d.path.toLowerCase(), stem = d.name.replace(/\.(md|markdown)$/i, "").toLowerCase();
    if (stem === "skill") return "技能定义";
    if (/(^|\/)(templates?|prompts?)\//.test(p)) return "提示词与模板";
    if (/(^|\/)guides?\//.test(p)) return "使用指南";
    if (/(reference|configuration|cli|api|sdk|websocket|commands?)/.test(stem)) return "参考手册";
    if (stem === "readme" || stem === "index") return "概览";
    return "说明文档";
  }

  // docs: Map<path, doc>（mdmap-core analyzeDoc 的结果，需含 out）；codePaths: 工作区相对路径数组
  function inferModules(docs, codePaths) {
    const list = [...docs.values()];
    const N = list.length || 1;
    const codeList = codePaths.filter(p => CODE_RE.test(p));
    const codeSet = new Set(codeList);
    const codeDirs = new Set();
    for (const p of codeList) { const s = p.split("/"); for (let i = 1; i < s.length; i++) codeDirs.add(s.slice(0, i).join("/")); }
    const feats = new Map(list.map(d => [d.path, docFeatures(d, codeSet, codeDirs)]));
    const anyMention = (f, key) => { const ph = " " + key + " "; return f.title.includes(ph) || f.near.includes(ph) || f.far.includes(ph) || f.heads.includes(ph) || f.body.includes(ph); };
    const mentionCount = key => { let n = 0; for (const f of feats.values()) if (anyMention(f, key)) n++; return n; };
    const nodes = buildSkeleton(codeList, N, mentionCount);

    const df = new Map();
    for (const n of nodes.values()) {
      let c = 0;
      const keys = [n.key, ...(ALIASES[n.key] || [])];
      for (const f of feats.values()) if (keys.some(k => anyMention(f, k)) || refsUnder(f.codeRefs, n)) c++;
      df.set(n.key, c);
    }

    // 单个节点的得分：strong 为标题 / 路径 / 描述 / 小节标题 / 源码引用等直接证据。
    // 源码引用按占该文档全部引用的比例计权，避免综述类文档被某一处引用拉走；
    // 单文件模块必须在文字上被点名，仅有源码引用不算。direct 表示标题或所在目录点名了该模块
    function nodeScore(f, n) {
      const ev = { title: 0, path: 0, dir: 0, desc: 0, heads: 0, body: 0, code: refsUnder(f.codeRefs, n) };
      for (const k of [n.key, ...(ALIASES[n.key] || [])]) {
        const ph = " " + k + " ";
        ev.title += count(f.title, ph); ev.path += count(f.near, ph); ev.dir += count(f.far, ph);
        ev.desc += count(f.desc, ph); ev.heads += count(f.heads, ph); ev.body += count(f.body, ph);
      }
      const named = ev.title + ev.path + ev.dir + ev.desc + ev.heads;
      const share = f.codeRefs.size ? ev.code / f.codeRefs.size : 0;
      const strong = 8 * Math.min(ev.title, 1) + 5 * Math.min(ev.path, 1) + 3 * Math.min(ev.dir, 1) +
        3 * Math.min(ev.desc, 1) + Math.min(8, 2 * ev.heads) + (n.file && !named ? 0 : Math.min(18, 6 * ev.code) * share);
      if (!strong) return { score: 0, ev, direct: false, named: false };
      const idf = Math.max(1, Math.log((N + 1) / (df.get(n.key) + 1)));
      return { score: idf * (strong + Math.min(6, 2 * Math.log2(1 + ev.body))), ev, direct: ev.title + ev.path + ev.dir > 0, named: named > 0 };
    }

    const tops = [...nodes.values()].filter(n => !n.parent);
    const assign = new Map();
    for (const d of list) {
      if (TEST_DOC_RE.test(d.path) || LOCALE_README_RE.test(d.name)) continue;
      const f = feats.get(d.path);
      const own = new Map();
      for (const n of nodes.values()) own.set(n.key, nodeScore(f, n));
      const memo = new Map();
      // 子树得分 = 自身得分 + 最强子模块的子树得分；direct 表示子树内有模块被标题或路径点名，named 表示在文字中被提到
      const subtree = key => {
        if (memo.has(key)) return memo.get(key);
        let best = 0, direct = own.get(key).direct, named = own.get(key).named;
        for (const c of nodes.get(key).children) {
          const s = subtree(c);
          best = Math.max(best, s.score);
          direct = direct || s.direct;
          named = named || s.named;
        }
        const s = { score: own.get(key).score + best, direct, named };
        memo.set(key, s);
        return s;
      };
      let top = null, topScore = 0, total = 0;
      for (const t of tops) {
        const s = subtree(t.key).score;
        total += s;
        if (s > topScore) { topScore = s; top = t.key; }
      }
      // 证据太弱、只有源码引用而文字中没提到，或没有点名任何模块且证据分散在多个模块（综述类文档），不归入具体模块
      const best = top && subtree(top);
      if (!best || best.score < 5 || !best.named || (!best.direct && best.score < 0.4 * total)) continue;
      // 向下细分：子模块子树被点名且得分占当前总分一半以上时进入子模块
      let key = top;
      for (;;) {
        let next = null, nextScore = 0;
        for (const c of nodes.get(key).children) {
          const s = subtree(c);
          if (s.direct && s.score > nextScore) { next = c; nextScore = s.score; }
        }
        if (!next || nextScore < 0.5 * subtree(key).score) break;
        key = next;
      }
      const chain = [];
      for (let k = key; k; k = nodes.get(k).parent) chain.unshift(k);
      // 理由取子树中自身证据最强的模块，归入上级模块时也能说明是被哪个子模块的证据带进来的
      let why = key;
      (function walk(k) {
        if (own.get(k).score > own.get(why).score) why = k;
        nodes.get(k).children.forEach(walk);
      })(key);
      assign.set(d.path, { key, chain, score: best.score, ev: own.get(why).ev, reasons: explain(own.get(why).ev, why) });
    }

    // 模块树：只保留有文档归入的模块及其上级
    const keep = new Set();
    for (const a of assign.values()) a.chain.forEach(k => keep.add(k));
    const modules = new Map();
    for (const k of keep) {
      const n = nodes.get(k);
      modules.set(k, {
        key: k, name: n.name, label: GLOSSARY[k] || n.name, path: [...n.paths].sort((a, b) => a.length - b.length)[0],
        parent: n.parent && keep.has(n.parent) ? n.parent : null, docs: [], children: [],
      });
    }
    for (const [p, a] of assign) modules.get(a.key).docs.push(p);
    for (const m of modules.values()) if (m.parent) modules.get(m.parent).children.push(m.key);
    const unassigned = list.map(d => d.path).filter(p => !assign.has(p));
    return { modules, assign, unassigned, roles: new Map(list.map(d => [d.path, docRole(d)])), roleOrder: ROLE_ORDER };
  }

  return { inferModules, buildSkeleton, docRole, words, GLOSSARY, CODE_RE, ROLE_ORDER };
});
