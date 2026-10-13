(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const Core = window.MdmapCore;

  const saved = vscode.getState() || {};
  const st = {
    view: saved.view || "map",
    current: saved.current || null,
    module: saved.module || null,
    level: saved.level || 2,
    collapsed: saved.collapsed || {},
    sideOpen: saved.sideOpen || {},
    panelTab: saved.panelTab || "toc",
    zoom: saved.zoom || 1,
    full: !!saved.full,
    sideHidden: !!saved.sideHidden,
    raw: false,
  };
  function save() {
    const { raw, ...rest } = st;
    vscode.setState(rest);
  }

  let snap = null, projects = [], active = 0, assetBase = "", lang = "zh", scanning = true, group = "sys";
  let payload = null, pendingAnchor = null, keepScroll = null, lastQuery = "";
  let mt = { provider: null, job: null };
  const MT_LABELS = { deepl: "DeepL", baidu: "百度翻译", youdao: "有道智云" };
  const recent = new Map();
  const history = [];

  // ---------- 骨架 ----------
  document.getElementById("app").innerHTML = `
<header class="top">
  <select id="projSel" hidden></select>
  <h1 id="projName"></h1>
  <span class="stats" id="stats"></span>
  <span class="spacer"></span>
  <div class="seg" id="langSeg" hidden><button data-lang="zh">中文</button><button data-lang="orig">原文</button></div>
  <button id="btnSide" title="显示 / 隐藏侧边栏">☰</button>
  <button id="btnMap">结构图</button>
  <button id="btnBroken" title="查看全部失效链接">失效链接 <b id="brokenN">0</b></button>
  <button id="btnMtAll">翻译全部</button>
  <button id="btnRescan" title="重新扫描整个工作区">⟳ 重新扫描</button>
</header>
<div class="body">
  <aside id="aside">
    <div class="search">
      <input type="text" id="q" placeholder="搜索文件名 / 标题 …" autocomplete="off">
      <label><input type="checkbox" id="qFull"> 同时搜索正文内容</label>
    </div>
    <div class="side-tree" id="side"></div>
  </aside>
  <main>
    <section class="view" id="mapView">
      <div class="map-toolbar">
        <div class="seg" id="groupSeg"><button data-group="sys" title="按文档内容归纳的系统模块组织文档">系统模块</button><button data-group="dir" title="按文档所在目录组织文档">目录</button></div>
        <span class="lbl">展开层级：</span>
        <button data-level="1">一级</button>
        <button data-level="2">二级</button>
        <button data-level="99">全部文档</button>
        <button id="zoomOut" title="缩小">－</button>
        <span id="zoomLbl" class="lbl">100%</span>
        <button id="zoomIn" title="放大">＋</button>
        <div class="legend" id="legend"></div>
        <span class="hint" id="mapHint"></span>
      </div>
      <div class="map-scroll" id="mapScroll"><div class="mm" id="mm"></div></div>
    </section>
    <section class="view" id="docView">
      <div class="doc-head">
        <div class="crumbs" id="crumbs"></div>
        <div class="doc-title-row">
          <h2 id="docTitle"></h2>
          <button id="btnBack">← 返回</button>
          <button id="btnTranslate">机器翻译</button>
          <button id="btnRaw">查看源码</button>
          <button id="btnSource">在编辑器中打开</button>
          <button id="btnCopy">复制路径</button>
        </div>
        <div class="doc-meta" id="docMeta"></div>
        <div class="notice" id="docNotice" hidden></div>
      </div>
      <div class="doc-body">
        <div class="doc-scroll" id="docScroll"><div id="docContent"></div></div>
        <div class="doc-side">
          <div class="tabs"><button data-tab="toc">本页目录</button><button data-tab="module">所属模块</button><button data-tab="info">文档信息</button></div>
          <div class="side-body" id="sideBody"></div>
        </div>
      </div>
    </section>
    <section class="view" id="moduleView"><div class="mod-scroll" id="modContent"></div></section>
    <section class="view" id="brokenView"><div class="broken-scroll" id="brokenList"></div></section>
    <section class="view" id="emptyView"><div class="empty-card" id="emptyMsg"></div></section>
  </main>
</div>
<div id="toast"></div>`;

  const $ = id => document.getElementById(id);
  const mm = $("mm"), side = $("side"), docScroll = $("docScroll"), docContent = $("docContent"), sideBody = $("sideBody");

  // ---------- 工具 ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtSize(n) { return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
  function fmtTime(ms) {
    if (!ms) return "-";
    const d = new Date(ms), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function meta(path) { return snap && snap.docs[path]; }
  function title(path) {
    const m = meta(path);
    if (!m) return path;
    return lang === "zh" && m.zhTitle ? m.zhTitle : m.title;
  }
  function subtitle(path) {
    const m = meta(path), t = title(path);
    return t && t !== m.name.replace(Core.MD_RE, "") ? t : m.desc;
  }
  function sysMode() { return group === "sys" && !!(snap && snap.sysTree); }
  function curTree() { return sysMode() ? snap.sysTree : snap.tree; }
  function mod(key) { return snap && snap.modules && snap.modules[key]; }
  function modChain(key) {
    const chain = [];
    for (let k = key; k && mod(k); k = mod(k).parent) chain.unshift(k);
    return chain;
  }
  function modLink(key, extra) {
    const m = mod(key);
    return m ? `<a data-mod="${esc(key)}" title="查看模块详情">${esc(m.label)}${extra || ""}</a>` : "";
  }
  function isFresh(path) {
    const t = recent.get(path);
    return t && Date.now() - t < 20000;
  }
  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ---------- 视图切换 ----------
  function showView(name) {
    if (!snap || !snap.total) name = "empty";
    for (const v of ["map", "doc", "module", "broken", "empty"]) $(v + "View").classList.toggle("show", v === name);
    $("btnMap").classList.toggle("on", name === "map");
    $("btnBroken").classList.toggle("on", name === "broken");
    if (name !== "empty") { st.view = name; save(); }
  }

  function renderHeader() {
    const sel = $("projSel");
    sel.hidden = projects.length < 2;
    $("projName").hidden = projects.length >= 2;
    if (projects.length >= 2) {
      sel.innerHTML = projects.map(p => `<option value="${p.index}"${p.index === active ? " selected" : ""}>${esc(p.name)}</option>`).join("");
    }
    $("projName").textContent = snap ? snap.name : "文档地图";
    const modCount = sysMode() ? Object.keys(snap.modules).filter(k => k !== "#other").length : 0;
    $("stats").textContent = snap
      ? (sysMode() ? `${modCount} 个系统模块` : `${snap.tree.length} 个目录分组`) + ` · ${snap.total} 篇文档 · ${fmtSize(snap.totalSize)}` +
        (snap.hasTranslations ? ` · 译文 ${snap.zhCount} 篇` + (snap.zhStale ? `（${snap.zhStale} 篇已过期）` : "") : "")
      : "";
    const all = $("btnMtAll");
    all.textContent = mt.job ? `翻译中 ${mt.job.done + 1}/${mt.job.total}` : "翻译全部";
    all.disabled = !!mt.job;
    all.title = mt.provider ? `使用${mt.provider}机器翻译还没有译文或译文已过期的文档` : "配置机器翻译服务后，可一键翻译全部文档";
    $("langSeg").hidden = !(snap && snap.hasTranslations);
    document.querySelectorAll("#langSeg button").forEach(b => b.classList.toggle("on", b.dataset.lang === lang));
    $("brokenN").textContent = snap ? snap.broken.length : 0;
    $("aside").hidden = st.sideHidden;
  }

  function renderEmpty() {
    let html;
    if (scanning && !snap) html = "<h2>正在扫描…</h2>";
    else if (!projects.length) html = "<h2>没有打开的文件夹</h2><p>请先在 VS Code 中打开一个项目文件夹。</p>";
    else html = "<h2>没有找到 Markdown 文档</h2><p>当前工作区中没有 .md 文件，或者它们都被排除规则过滤掉了。</p>";
    if (snap && snap.configError) html += `<p style="color:var(--error)">${esc(snap.configError)}</p>`;
    $("emptyMsg").innerHTML = html;
  }

  // ---------- 结构图 ----------
  function collapsedOf(map, key, depth, threshold) {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : depth >= threshold;
  }

  function renderMap() {
    mm.innerHTML = "";
    document.querySelectorAll("#groupSeg button").forEach(b => b.classList.toggle("on", b.dataset.group === (sysMode() ? "sys" : "dir")));
    $("groupSeg").hidden = !(snap && snap.sysTree);
    $("mapHint").textContent = sysMode() ? "模块由文档内容与源码结构自动归纳；点击「详情」查看模块，点击文档阅读" : "点击分组可折叠，点击文档查看详情";
    if (!snap || !snap.total) return;
    const tree = curTree();
    const top = el("ul", "top");
    const rootLi = el("li");
    rootLi.appendChild(el("div", "n root", `${esc(snap.name)}<span class="badge">${snap.total}</span>`));
    const ul = el("ul");
    tree.forEach(m => ul.appendChild(mmNode(m, "mod", 1)));
    rootLi.appendChild(ul);
    top.appendChild(rootLi);
    mm.appendChild(top);
    mm.style.zoom = st.zoom;
    $("zoomLbl").textContent = Math.round(st.zoom * 100) + "%";
    document.querySelectorAll(".map-toolbar button[data-level]").forEach(b => {
      b.classList.toggle("on", !Object.keys(st.collapsed).length && +b.dataset.level === st.level);
    });

    const legend = $("legend");
    legend.innerHTML = "";
    tree.forEach((m, i) => {
      const s = el("span", "", `<i style="background:${m.color}"></i>${esc(m.label)}`);
      s.title = "定位到该模块";
      s.onclick = () => {
        const li = ul.children[i];
        li.classList.remove("collapsed");
        st.collapsed[m.key] = false;
        save();
        li.firstChild.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      };
      legend.appendChild(s);
    });
  }

  function mmNode(n, kind, depth) {
    const li = el("li");
    li.style.setProperty("--c", n.color);
    li.classList.toggle("collapsed", collapsedOf(st.collapsed, n.key, depth, st.level));
    const brokenCount = countBroken(n);
    const badge = `<span class="badge">${n.count}</span>` + (brokenCount ? `<span class="badge warn" title="失效链接">⚠ ${brokenCount}</span>` : "") +
      (n.mod ? `<span class="badge more" data-open="${esc(n.mod)}" title="查看模块详情">详情</span>` : "");
    const note = [n.sub, n.desc].filter(Boolean).join(" · ");
    const box = el("div", "n " + kind, `${esc(n.label)}${badge}` + (note ? `<small title="${esc(note)}">${esc(note)}</small>` : ""));
    box.title = n.mod ? `${n.label}${n.sub ? "\n" + n.sub : ""}\n点击折叠 / 展开` : "点击折叠 / 展开";
    box.onclick = e => {
      if (e.target.dataset.open) { openModule(e.target.dataset.open); return; }
      li.classList.toggle("collapsed");
      st.collapsed[n.key] = li.classList.contains("collapsed");
      save();
      document.querySelectorAll(".map-toolbar button[data-level]").forEach(b => b.classList.remove("on"));
    };
    li.appendChild(box);
    const ul = el("ul");
    if (n.mod && n.children.length && n.docs.length) {
      // 有子模块时，先列子模块，本模块自己的文档收进一个可折叠节点，展开层级时只显示架构
      n.children.forEach(c => ul.appendChild(mmNode(c, "grp", depth + 1)));
      ul.appendChild(mmNode(docsNode(n), "grp", depth + 1));
    } else {
      n.docs.forEach(p => ul.appendChild(mmDoc(p, n.color)));
      n.children.forEach(c => ul.appendChild(mmNode(c, "grp", depth + 1)));
    }
    li.appendChild(ul);
    return li;
  }

  function docsNode(n) {
    return { key: n.key + "#docs", label: "本模块文档", desc: "", sub: "", color: n.color, docs: n.docs, children: [], count: n.docs.length };
  }

  function countBroken(n) {
    return n.docs.reduce((s, p) => s + ((meta(p) || {}).broken || 0), 0) + n.children.reduce((s, c) => s + countBroken(c), 0);
  }

  function mmDoc(path, color) {
    const m = meta(path);
    const li = el("li");
    li.style.setProperty("--c", color);
    const sub = subtitle(path);
    const role = sysMode() && m.sys ? `<span class="badge role">${esc(m.sys.role)}</span>` : "";
    const box = el("div", "n doc" + (isFresh(path) ? " fresh" : "") + (path === st.current ? " active" : ""),
      `<span class="fn">${esc(m.name)}</span>${role}` + (m.broken ? `<span class="badge warn">⚠ ${m.broken}</span>` : "") + (sub ? `<small>${esc(sub)}</small>` : ""));
    box.title = `${path}  (${fmtSize(m.size)})` + (sysMode() && m.sys && m.sys.reasons.length ? "\n归类依据：" + m.sys.reasons.join("；") : "");
    box.onclick = () => openDoc(path);
    li.appendChild(box);
    return li;
  }

  function setLevel(level) {
    st.level = level;
    st.collapsed = {};
    save();
    renderMap();
  }

  // ---------- 侧边栏 ----------
  function renderSide() {
    if (lastQuery) return;
    side.innerHTML = "";
    if (!snap) return;
    curTree().forEach(m => side.appendChild(sideNode(m, 0)));
    markActive();
  }

  function sideNode(n, depth) {
    const wrap = el("div", "st-node");
    wrap.classList.toggle("collapsed", collapsedOf(st.sideOpen, n.key, depth, sysMode() ? 1 : 2));
    const row = el("div", "st-row",
      `<span class="st-caret">▼</span><span class="st-dot" style="background:${n.color}"></span>` +
      `<span class="st-label" title="${esc([n.sub, n.desc].filter(Boolean).join("\n"))}">${esc(n.label)}</span>` +
      (n.mod ? `<span class="st-more" data-open="${esc(n.mod)}" title="查看模块详情">详情</span>` : "") +
      `<span class="st-count">${n.count}</span>`);
    row.onclick = e => {
      if (e.target.dataset.open) { openModule(e.target.dataset.open); return; }
      wrap.classList.toggle("collapsed");
      st.sideOpen[n.key] = wrap.classList.contains("collapsed");
      save();
    };
    const kids = el("div", "st-children");
    if (n.mod) {
      n.children.forEach(c => kids.appendChild(sideNode(c, depth + 1)));
      n.docs.forEach(p => kids.appendChild(sideDoc(p)));
    } else {
      n.docs.forEach(p => kids.appendChild(sideDoc(p)));
      n.children.forEach(c => kids.appendChild(sideNode(c, depth + 1)));
    }
    wrap.append(row, kids);
    return wrap;
  }

  function sideDoc(path) {
    const m = meta(path);
    const d = el("div", "st-doc",
      `<span class="fn">${esc(m.name)}${m.broken ? `<span class="warn-badge">⚠ ${m.broken}</span>` : ""}</span><span class="tt">${esc(title(path))}</span>`);
    d.dataset.path = path;
    d.title = path;
    d.onclick = () => openDoc(path);
    return d;
  }

  function markActive() {
    side.querySelectorAll(".st-doc.active").forEach(e => e.classList.remove("active"));
    if (!st.current) return;
    const target = [...side.querySelectorAll(".st-doc")].find(e => e.dataset.path === st.current);
    if (!target) return;
    target.classList.add("active");
    for (let p = target.parentElement; p && p !== side; p = p.parentElement) p.classList.remove("collapsed");
    target.scrollIntoView({ block: "nearest" });
  }

  let searchTimer;
  function runSearch() {
    const q = $("q").value.trim();
    lastQuery = q;
    clearTimeout(searchTimer);
    if (!q) { renderSide(); return; }
    searchTimer = setTimeout(() => vscode.postMessage({ type: "search", q, full: $("qFull").checked }), 150);
  }

  function renderSearch(q, hits) {
    if (q !== lastQuery) return;
    const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const hl = s => esc(s).replace(re, x => `<mark>${x}</mark>`);
    side.innerHTML = hits.length ? "" : '<div class="empty">没有匹配的文档</div>';
    for (const h of hits) {
      if (!meta(h.path)) continue;
      const r = el("div", "result",
        `<div class="p">${hl(h.path)}</div><div class="t">${hl(title(h.path))}${h.count ? ` · 正文命中 ${h.count} 处` : ""}</div>` +
        (h.snip ? `<div class="snip">…${hl(h.snip)}…</div>` : ""));
      r.onclick = () => openDoc(h.path);
      side.appendChild(r);
    }
  }

  // ---------- 文档阅读 ----------
  // 记录当前页面，供「返回」使用
  function pushHistory() {
    if (st.view === "doc" && st.current) history.push({ doc: st.current });
    else if (st.view === "module" && st.module) history.push({ mod: st.module });
  }

  function openModule(key, fromHistory) {
    if (!mod(key)) return;
    if (!fromHistory && !(st.view === "module" && st.module === key)) pushHistory();
    st.module = key;
    renderModule();
    showView("module");
    $("modContent").scrollTop = 0;
  }

  function renderModule() {
    const box = $("modContent");
    const m = mod(st.module);
    if (!m) { box.innerHTML = ""; return; }
    const node = findNode(snap.sysTree, "sys:" + st.module);
    const crumbs = [`<a data-home>${esc(snap.name)}</a>`].concat(modChain(st.module).map(k => k === st.module ? `<span>${esc(mod(k).label)}</span>` : modLink(k)));
    let html = `<div class="crumbs">${crumbs.join(" <span>›</span> ")}</div>
      <div class="doc-title-row"><h2>${esc(m.label)}${m.name && m.name !== m.label ? `<small>${esc(m.name)}</small>` : ""}</h2><button data-back>← 返回</button></div>
      <div class="doc-meta">` +
      (m.path ? `<span>对应源码：<code>${esc(m.path)}</code></span>` : "") +
      `<span>文档 ${m.count} 篇${m.children.length ? `（本模块 ${m.docs.length} 篇，子模块 ${m.count - m.docs.length} 篇）` : ""}</span>` +
      (node && node.desc ? `<span>${esc(node.desc)}</span>` : "") + `</div>`;
    if (st.module === "#other") html += `<p class="muted">这些文档没有明确指向某一个系统模块：通常是项目总览、配置参考、开发与发布流程等跨模块内容，或者内容太少无法判断。</p>`;

    if (m.children.length) {
      html += `<h3>子模块（${m.children.length}）</h3><div class="mod-cards">`;
      for (const k of m.children) {
        const c = mod(k), cn = findNode(snap.sysTree, "sys:" + k);
        const sample = c.docs.slice(0, 3).map(p => `<li>${esc(title(p))}</li>`).join("");
        html += `<div class="mod-card" data-mod="${esc(k)}" style="--c:${cn ? cn.color : "var(--line)"}">
          <div class="h">${esc(c.label)}<span class="badge">${c.count}</span></div>
          ${c.path ? `<div class="p">${esc(c.path)}</div>` : ""}
          ${cn && cn.desc ? `<div class="r">${esc(cn.desc)}</div>` : ""}
          ${sample ? `<ul>${sample}</ul>` : ""}</div>`;
      }
      html += `</div>`;
    }

    if (m.docs.length) {
      html += `<h3>本模块文档（${m.docs.length}）</h3>`;
      const groups = new Map();
      for (const p of m.docs) {
        const r = (meta(p).sys || {}).role || "文档";
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(p);
      }
      for (const [r, list] of groups) {
        html += `<h4>${esc(r)}（${list.length}）</h4>`;
        for (const p of list) {
          const d = meta(p), why = d.sys && d.sys.reasons.length ? d.sys.reasons.join("；") : "";
          html += `<div class="mod-doc" data-doc="${esc(p)}">
            <div class="t">${esc(title(p))}${d.broken ? `<span class="warn-badge">⚠ ${d.broken}</span>` : ""}</div>
            <div class="p">${esc(p)}${d.desc ? " · " + esc(d.desc) : ""}</div>
            ${why ? `<div class="why">归类依据：${esc(why)}</div>` : ""}</div>`;
        }
      }
    }

    html += `<h3>相关模块</h3>`;
    html += m.related.length
      ? `<div class="mod-rel">` + m.related.map(r => modLink(r.key, `<span class="muted"> · 文档互相链接 ${r.n} 次</span>`)).join("") + `</div>`
      : `<p class="muted">这个模块的文档与其他模块之间没有链接。</p>`;
    box.innerHTML = html;
  }

  function findNode(nodes, key) {
    for (const n of nodes || []) {
      if (n.key === key) return n;
      const f = findNode(n.children, key);
      if (f) return f;
    }
    return null;
  }

  function goBack() {
    const prev = history.pop();
    if (prev && prev.doc && meta(prev.doc)) openDoc(prev.doc, null, true);
    else if (prev && prev.mod && mod(prev.mod)) openModule(prev.mod, true);
    else showView("map");
  }

  function openDoc(path, anchor, fromHistory) {
    if (!meta(path)) return;
    if (!fromHistory && !(st.view === "doc" && st.current === path)) pushHistory();
    const same = st.current === path && st.view === "doc" && payload && payload.path === path;
    st.current = path;
    showView("doc");
    markActive();
    if (same) {
      if (anchor) scrollToAnchor(anchor);
      return;
    }
    pendingAnchor = anchor || null;
    keepScroll = null;
    payload = null;
    renderDocHead();
    docContent.innerHTML = '<div class="loading">加载中…</div>';
    sideBody.innerHTML = "";
    vscode.postMessage({ type: "open", path });
  }

  function renderDocHead() {
    const m = meta(st.current);
    if (!m) return;
    const crumbs = $("crumbs");
    crumbs.innerHTML = "";
    const home = el("a", "", esc(snap.name));
    home.onclick = () => showView("map");
    crumbs.appendChild(home);
    if (sysMode() && m.sys) modChain(m.sys.module).forEach(k => crumbs.insertAdjacentHTML("beforeend", ` <span>›</span> ${modLink(k)}`));
    else m.crumbs.forEach(c => crumbs.insertAdjacentHTML("beforeend", ` <span>›</span> <span>${esc(c)}</span>`));
    crumbs.insertAdjacentHTML("beforeend", ` <span>›</span> <span>${esc(m.name)}</span>`);
    $("docTitle").textContent = title(st.current);
    $("docMeta").innerHTML =
      `<span>路径：<code>${esc(st.current)}</code></span><span>大小：${fmtSize(m.size)}</span>` +
      `<span>行数：${m.lines}</span><span>字数：${m.words}</span><span>修改时间：${fmtTime(m.mtime)}</span>`;
    $("btnRaw").textContent = st.raw ? "查看渲染" : "查看源码";
    $("btnRaw").classList.toggle("on", st.raw);
    $("btnBack").disabled = false;
    const tr = $("btnTranslate");
    const busy = mt.job && mt.job.path === st.current;
    tr.textContent = busy ? "翻译中…" : m.zhStale ? "更新译文" : m.zhMt ? "重新翻译" : "机器翻译";
    tr.disabled = !!mt.job;
    tr.title = mt.provider ? `使用${mt.provider}翻译这篇文档` : "配置机器翻译服务后翻译这篇文档";
    const notice = $("docNotice");
    let msg = "";
    if (lang === "zh" && m.zhStale) msg = `原文在机器翻译之后有修改，译文可能已过期。<a data-act="translate">更新译文</a>`;
    else if (lang === "zh" && snap.hasTranslations && !m.zhTitle) msg = `这篇文档暂无译文，显示原文。<a data-act="translate">机器翻译</a>`;
    notice.hidden = !msg || !!mt.job;
    notice.innerHTML = msg;
  }

  function translateCurrent() {
    if (!st.current || mt.job) return;
    vscode.postMessage({ type: "translate", path: st.current });
  }

  function renderDoc() {
    if (!payload || !meta(st.current)) return;
    renderDocHead();
    const useZh = lang === "zh" && payload.zh;
    const src = useZh ? payload.zh : payload;
    const scroll = keepScroll;
    keepScroll = null;
    if (st.raw) {
      docContent.innerHTML = "";
      const pre = el("pre", "raw");
      pre.textContent = src.content;
      docContent.appendChild(pre);
    } else {
      let html = "";
      if (src.front) html += `<div class="frontmatter"><div class="lbl">Front Matter</div><pre>${esc(src.front)}</pre></div>`;
      let body;
      try { body = marked.parse(src.body, { gfm: true }); }
      catch (e) { body = `<pre class="raw">${esc(src.body)}</pre>`; }
      docContent.innerHTML = html + `<article class="markdown-body">${body}</article>`;
      enhance(docContent.querySelector(".markdown-body"));
    }
    renderPanel();
    if (pendingAnchor) { scrollToAnchor(pendingAnchor); pendingAnchor = null; }
    else docScroll.scrollTop = scroll || 0;
  }

  const ALERTS = { NOTE: ["说明", "#2563eb"], TIP: ["提示", "#059669"], IMPORTANT: ["重要", "#7c3aed"], WARNING: ["警告", "#d97706"], CAUTION: ["注意", "#dc2626"] };

  function assetUrl(path) {
    return assetBase + "/" + path.split("/").map(encodeURIComponent).join("/");
  }

  function enhance(art) {
    const from = st.current;
    // 译文与原文标题数量一致时沿用原文锚点，保证 #install 这类链接在中文模式下也能跳转
    const hs = [...art.querySelectorAll("h1,h2,h3,h4,h5,h6")];
    if (hs.length === payload.slugs.length) hs.forEach((h, i) => { h.id = payload.slugs[i]; });
    else {
      const seen = {};
      hs.forEach(h => {
        let s = Core.slugify(h.textContent);
        if (seen[s] !== undefined) { seen[s]++; s += "-" + seen[s]; } else seen[s] = 0;
        h.id = s;
      });
    }

    art.querySelectorAll("a[href]").forEach(a => {
      const href = a.getAttribute("href");
      if (Core.isExternal(href)) { a.dataset.ext = href; a.title = href; return; }
      const { p, anchor } = Core.splitHref(href);
      if (!p) { a.dataset.anchor = anchor; return; }
      const target = Core.resolveTarget(from, p, x => !!meta(x));
      if (meta(target)) {
        a.dataset.doc = target;
        if (anchor) a.dataset.anchor = anchor;
        a.classList.add("internal");
        a.title = "在文档地图中打开：" + target;
      } else {
        a.dataset.file = target;
        a.title = "在编辑器中打开：" + target;
      }
    });

    art.querySelectorAll("img[src]").forEach(img => {
      const src = img.getAttribute("src");
      if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) return;
      const { p } = Core.splitHref(src);
      img.src = assetUrl(p.startsWith("/") ? Core.resolvePath("", p.slice(1)) : Core.resolvePath(from, p));
    });

    art.querySelectorAll("blockquote").forEach(bq => {
      const p = bq.firstElementChild;
      const m = p && p.tagName === "P" && p.innerHTML.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(<br>)?/i);
      if (!m) return;
      const [label, color] = ALERTS[m[1].toUpperCase()];
      p.innerHTML = p.innerHTML.slice(m[0].length);
      bq.classList.add("alert");
      bq.style.setProperty("--ac", color);
      bq.insertAdjacentHTML("afterbegin", `<div class="alert-title">${label}</div>`);
    });

    if (window.hljs) art.querySelectorAll("pre code").forEach(c => {
      if (c.textContent.length < 30000) { try { hljs.highlightElement(c); } catch (e) { /* 忽略不支持的语言 */ } }
    });
  }

  function scrollToAnchor(id) {
    const a = String(id).toLowerCase();
    const target = [...docContent.querySelectorAll("[id],[name]")].find(e => (e.id || e.getAttribute("name") || "").toLowerCase() === a);
    if (!target) { toast("本页没有找到锚点：#" + id); return; }
    target.scrollIntoView({ block: "start" });
    target.classList.remove("flash");
    void target.offsetWidth;
    target.classList.add("flash");
  }

  function onLinkClick(e) {
    const a = e.target.closest("a");
    if (!a) return;
    if (a.dataset.doc) { e.preventDefault(); openDoc(a.dataset.doc, a.dataset.anchor); }
    else if (a.dataset.anchor !== undefined && !a.dataset.file) { e.preventDefault(); scrollToAnchor(a.dataset.anchor); }
    else if (a.dataset.file) { e.preventDefault(); vscode.postMessage({ type: "file", path: a.dataset.file }); }
    else if (a.dataset.ext) { e.preventDefault(); vscode.postMessage({ type: "external", url: a.dataset.ext }); }
    else if (a.dataset.toc) { e.preventDefault(); scrollToAnchor(a.dataset.toc); }
    else if (a.dataset.mod) { e.preventDefault(); openModule(a.dataset.mod); }
  }

  // ---------- 右侧面板 ----------
  function renderPanel() {
    document.querySelectorAll(".doc-side .tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === st.panelTab));
    if (!payload) { sideBody.innerHTML = ""; return; }
    if (st.panelTab === "toc") renderToc();
    else if (st.panelTab === "module") renderModuleTab();
    else renderInfo();
  }

  function renderModuleTab() {
    const s = meta(st.current).sys;
    if (!s || !mod(s.module)) { sideBody.innerHTML = '<div class="muted">暂无系统模块信息。</div>'; return; }
    const m = mod(s.module);
    let html = `<h4>所属模块</h4><div class="chain">${modChain(s.module).map(k => modLink(k)).join('<span class="muted">›</span>')}</div>
      <dl><dt>文档类型</dt><dd>${esc(s.role)}</dd>${m.path ? `<dt>对应源码</dt><dd>${esc(m.path)}</dd>` : ""}</dl>`;
    html += `<h4>归类依据</h4>` + (s.reasons.length
      ? `<ul class="why">${s.reasons.map(r => `<li>${esc(r)}</li>`).join("")}</ul>`
      : '<div class="muted">没有明确指向某个系统模块的内容，归入综合文档。</div>');
    const siblings = m.docs.filter(p => p !== st.current);
    html += `<h4>同模块文档（${siblings.length}）</h4>` + (siblings.length ? siblings.map(p => docLink(p)).join("") : '<div class="muted">无</div>');
    if (m.children.length) html += `<h4>子模块（${m.children.length}）</h4>` + m.children.map(k => modLink(k, `<span class="muted"> · ${mod(k).count} 篇</span>`)).join("");
    if (m.related.length) html += `<h4>相关模块</h4>` + m.related.map(r => modLink(r.key, `<span class="muted"> · 链接 ${r.n} 次</span>`)).join("");
    sideBody.innerHTML = html;
  }

  function renderToc() {
    const hs = [...docContent.querySelectorAll(".markdown-body h2, .markdown-body h3")];
    if (!hs.length) { sideBody.innerHTML = `<div class="muted">${st.raw ? "源码模式下不显示目录。" : "这篇文档没有二、三级标题。"}</div>`; return; }
    sideBody.innerHTML = hs.map(h =>
      `<a data-toc="${esc(h.id)}" class="${h.tagName === "H3" ? "l3" : ""}" title="${esc(h.textContent)}">${esc(h.textContent)}</a>`).join("");
  }

  function docLink(path, extraCls) {
    const m = meta(path);
    return `<a data-doc="${esc(path)}" class="${extraCls || ""}" title="${esc(path)}">${esc(m ? title(path) : path)}<span class="muted"> · ${esc(m ? m.name : "")}</span></a>`;
  }

  function renderInfo() {
    const m = meta(st.current);
    const out = payload.out || [];
    const docs = [], seen = new Set(), broken = [], external = [], files = [];
    for (const o of out) {
      if (o.ok === false) broken.push(o);
      else if (o.kind === "doc" && !seen.has(o.target) && o.target !== st.current) { seen.add(o.target); docs.push(o); }
      else if (o.kind === "external" && !external.includes(o.href)) external.push(o.href);
      else if (o.kind === "file" && !files.includes(o.target)) files.push(o.target);
    }
    let html = `<h4>基本信息</h4><dl>
      <dt>路径</dt><dd>${esc(st.current)}</dd>
      <dt>目录分组</dt><dd>${esc(m.crumbs.join(" › "))}</dd>
      ${m.sys ? `<dt>系统模块</dt><dd>${esc(m.sys.crumbs.join(" › "))}</dd>` : ""}
      <dt>大小</dt><dd>${fmtSize(m.size)}</dd>
      <dt>行数</dt><dd>${m.lines}</dd>
      <dt>字数</dt><dd>${m.words}</dd>
      <dt>标题数</dt><dd>${payload.headCount}</dd>
      <dt>修改时间</dt><dd>${fmtTime(m.mtime)}</dd>
      <dt>译文</dt><dd>${zhInfo(payload.zh, payload.headCount)}</dd>
    </dl>`;
    if (payload.front) html += `<h4>Front Matter</h4><pre>${esc(payload.front)}</pre>`;
    html += `<h4>被引用（${payload.back.length}）</h4>` + (payload.back.length ? payload.back.map(p => docLink(p)).join("") : '<div class="muted">没有其他文档链接到这里。</div>');
    html += `<h4>链接到的文档（${docs.length}）</h4>` + (docs.length ? docs.map(o => docLink(o.target)).join("") : '<div class="muted">无</div>');
    if (broken.length) {
      html += `<h4 class="bad">失效链接（${broken.length}）</h4>` + broken.map(o =>
        `<a class="bad" title="${esc(o.href)}" ${o.target ? `data-file="${esc(o.target)}"` : ""}>${esc(o.text || o.href)}</a><span class="reason">${esc(o.href)} · ${esc(o.reason)}</span>`).join("");
    }
    if (files.length) html += `<h4>其他文件（${files.length}）</h4>` + files.map(f => `<a data-file="${esc(f)}" title="在编辑器中打开">${esc(f)}</a>`).join("");
    if (external.length) html += `<h4>外部链接（${external.length}）</h4>` + external.map(u => `<a data-ext="${esc(u)}" title="${esc(u)}">${esc(u)}</a>`).join("");
    sideBody.innerHTML = html;
  }

  function zhInfo(zh, headCount) {
    if (!zh) return "暂无";
    let s = zh.mt ? `机器翻译（${esc(MT_LABELS[zh.mt] || zh.mt)}）` : "人工译文";
    if (zh.stale) s += `<span class="bad">，原文已修改，译文已过期</span>`;
    if (zh.headCount !== headCount) s += "，标题数量与原文不一致";
    return s;
  }

  // ---------- 失效链接页 ----------
  function renderBroken() {
    const list = $("brokenList");
    if (!snap) { list.innerHTML = ""; return; }
    if (!snap.broken.length) { list.innerHTML = '<div class="empty-card"><h2>没有失效链接</h2><p>所有指向项目内文档和锚点的链接都有效。</p></div>'; return; }
    const groups = new Map();
    for (const b of snap.broken) {
      if (!groups.has(b.from)) groups.set(b.from, []);
      groups.get(b.from).push(b);
    }
    list.innerHTML = `<p class="muted" style="color:var(--muted)">共 ${snap.broken.length} 个失效链接，分布在 ${groups.size} 篇文档中。</p>`;
    for (const [from, items] of groups) {
      const g = el("div", "broken-group");
      const h = el("h3", "", `${esc(title(from))}<small>${esc(from)}</small>`);
      h.onclick = () => openDoc(from);
      g.appendChild(h);
      for (const b of items) {
        g.appendChild(el("div", "broken-row", `<span>${esc(b.text || "(无文字)")}</span><code>${esc(b.href)}</code><span class="reason">${esc(b.reason)}</span>`));
      }
      list.appendChild(g);
    }
  }

  // ---------- 渲染入口 ----------
  function renderAll() {
    renderHeader();
    if (!snap || !snap.total) { renderEmpty(); showView("empty"); side.innerHTML = ""; mm.innerHTML = ""; return; }
    renderMap();
    if (lastQuery) runSearch(); else renderSide();
    renderBroken();
  }

  function onInit(m) {
    const prevName = snap && snap.name;
    projects = m.projects || [];
    active = m.active || 0;
    assetBase = m.assetBase || "";
    lang = m.lang || lang;
    group = m.group || group;
    mt = m.mt || mt;
    scanning = !!m.scanning;
    snap = m.snapshot;
    const ch = m.changes;
    if (ch && !ch.reset) {
      const now = Date.now();
      [...ch.added, ...ch.changed].forEach(p => recent.set(p, now));
      const parts = [];
      if (ch.added.length) parts.push(`新增 ${ch.added.length}`);
      if (ch.changed.length) parts.push(`修改 ${ch.changed.length}`);
      if (ch.removed.length) parts.push(`删除 ${ch.removed.length}`);
      if (ch.zh.length) parts.push(`译文更新 ${ch.zh.length}`);
      if (parts.length) toast("文档已更新：" + parts.join(" · "));
    }
    if (prevName && snap && prevName !== snap.name) { st.current = null; payload = null; history.length = 0; }
    renderAll();
    if (!snap || !snap.total) return;

    if (st.current && !meta(st.current)) {
      if (st.view === "doc") toast("当前文档已被删除或排除");
      st.current = null;
      payload = null;
      showView("map");
      return;
    }
    if (st.view === "doc" && st.current) {
      showView("doc");
      keepScroll = payload ? docScroll.scrollTop : null;
      renderDocHead();
      vscode.postMessage({ type: "open", path: st.current });
    } else if (st.view === "module") {
      if (mod(st.module)) { const top = $("modContent").scrollTop; renderModule(); showView("module"); $("modContent").scrollTop = top; }
      else showView("map");
    } else {
      showView(st.view === "broken" ? "broken" : "map");
    }
  }

  window.addEventListener("message", e => {
    const m = e.data;
    switch (m.type) {
      case "init": onInit(m); break;
      case "doc":
        if (m.path !== st.current) return;
        if (!m.payload) { toast("文档已不存在"); showView("map"); return; }
        payload = m.payload;
        renderDoc();
        break;
      case "searchResult": renderSearch(m.q, m.hits); break;
      case "mt":
        mt = m.mt;
        renderHeader();
        if (st.view === "doc" && meta(st.current)) renderDocHead();
        break;
      case "group":
        if (group !== m.group) { group = m.group; rerender(); }
        break;
      case "reveal":
        if (m.view === "broken") showView("broken");
        else if (m.path) openDoc(m.path);
        break;
    }
  });

  // ---------- 事件绑定 ----------
  $("projSel").onchange = e => vscode.postMessage({ type: "switch", index: +e.target.value });
  // 切换语言或分组方式后重绘当前页面
  function rerender() {
    renderHeader();
    renderMap();
    if (lastQuery) runSearch(); else renderSide();
    renderBroken();
    if (st.view === "doc" && payload) { keepScroll = docScroll.scrollTop; renderDoc(); }
    if (st.view === "module") renderModule();
  }
  document.querySelectorAll("#langSeg button").forEach(b => b.onclick = () => {
    lang = b.dataset.lang;
    vscode.postMessage({ type: "lang", lang });
    rerender();
  });
  document.querySelectorAll("#groupSeg button").forEach(b => b.onclick = () => {
    if (group === b.dataset.group) return;
    group = b.dataset.group;
    vscode.postMessage({ type: "group", group });
    rerender();
  });
  $("modContent").addEventListener("click", e => {
    const t = e.target.closest("[data-mod],[data-doc],[data-home],[data-back]");
    if (!t) return;
    if (t.dataset.mod) openModule(t.dataset.mod);
    else if (t.dataset.doc) openDoc(t.dataset.doc);
    else if (t.dataset.back !== undefined) goBack();
    else showView("map");
  });
  $("crumbs").addEventListener("click", onLinkClick);
  $("btnSide").onclick = () => { st.sideHidden = !st.sideHidden; save(); renderHeader(); };
  $("btnMap").onclick = () => showView("map");
  $("btnBroken").onclick = () => { renderBroken(); showView("broken"); };
  $("btnRescan").onclick = () => { vscode.postMessage({ type: "rescan" }); toast("正在重新扫描…"); };
  $("btnMtAll").onclick = () => { if (!mt.job) vscode.postMessage({ type: "translateAll" }); };
  $("btnTranslate").onclick = translateCurrent;
  $("docNotice").onclick = e => { if (e.target.closest("a[data-act=translate]")) translateCurrent(); };
  $("q").addEventListener("input", runSearch);
  $("qFull").addEventListener("change", runSearch);
  document.querySelectorAll(".map-toolbar button[data-level]").forEach(b => b.onclick = () => setLevel(+b.dataset.level));
  $("zoomIn").onclick = () => { st.zoom = Math.min(1.6, +(st.zoom + 0.1).toFixed(2)); save(); renderMap(); };
  $("zoomOut").onclick = () => { st.zoom = Math.max(0.4, +(st.zoom - 0.1).toFixed(2)); save(); renderMap(); };
  $("btnBack").onclick = goBack;
  $("btnRaw").onclick = () => { st.raw = !st.raw; keepScroll = 0; renderDoc(); };
  $("btnSource").onclick = () => vscode.postMessage({ type: "source", path: st.current });
  $("btnCopy").onclick = () => { vscode.postMessage({ type: "copy", text: st.current }); toast("已复制路径：" + st.current); };
  document.querySelectorAll(".doc-side .tabs button").forEach(b => b.onclick = () => { st.panelTab = b.dataset.tab; save(); renderPanel(); });
  docContent.addEventListener("click", onLinkClick);
  sideBody.addEventListener("click", onLinkClick);

  renderAll();
  vscode.postMessage({ type: "ready" });
})();
