"use strict";
const vscode = require("vscode");
const { marked } = require("./media/vendor/marked.min.js");
const core = require("./core/mdmap-core.js");
const arch = require("./core/mdmap-arch.js");
const { Translator, PROVIDERS } = require("./translate/translator.js");

const MD_GLOB = "**/*.{md,markdown}";
const CODE_GLOB = "**/*.{py,ts,tsx,js,jsx,mjs,go,rs,java,kt,cs,rb,php,swift,c,cc,cpp,h,hpp,scala,dart,vue,svelte}";
const decoder = new TextDecoder("utf-8");

let output;
let projects = [];
let activeIndex = 0;
let panel = null;
let panelReady = false;
let pendingReveal = null;
let treeProvider;
let statusItem;
let extContext;
let translator;
let mtJob = null;

function log(msg) { output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`); }

// ---------- 单个工作区文件夹 ----------
class FolderProject {
  constructor(folder) {
    this.folder = folder;
    this.model = new core.Project(marked, folder.name);
    // 源码文件路径，用来归纳系统模块
    this.code = new Set();
    this.disposables = [];
    this.pending = new Map();
    this.timer = null;
    this.scanning = null;
    this.lastChanges = null;
  }

  rel(uri) {
    const base = this.folder.uri.path.replace(/\/$/, "");
    if (uri.path.toLowerCase().startsWith(base.toLowerCase() + "/")) return uri.path.slice(base.length + 1);
    return null;
  }

  uri(rel) { return vscode.Uri.joinPath(this.folder.uri, ...rel.split("/")); }

  async readText(rel) {
    try { return decoder.decode(await vscode.workspace.fs.readFile(this.uri(rel))); }
    catch (e) { return null; }
  }

  editorExcludes() {
    const globs = [];
    const filesExclude = vscode.workspace.getConfiguration("files", this.folder.uri).get("exclude") || {};
    for (const [g, on] of Object.entries(filesExclude)) if (on === true) globs.push(g);
    globs.push(...(vscode.workspace.getConfiguration("mdmap", this.folder.uri).get("exclude") || []));
    return globs;
  }

  async scan() {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const t0 = Date.now();
      this.model.setConfig(await this.readText(".mdmap.json"));
      this.model.setExtraExcludes(this.editorExcludes());
      const plain = this.model.excludeGlobs().filter(g => !/[{}]/.test(g));
      const exclude = plain.length ? new vscode.RelativePattern(this.folder, `{${plain.join(",")}}`) : null;
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(this.folder, MD_GLOB), exclude, 20000);
      if (this.model.transDir) {
        const trans = await vscode.workspace.findFiles(new vscode.RelativePattern(this.folder, this.model.transDir + MD_GLOB), null, 20000);
        const seen = new Set(found.map(u => u.toString()));
        for (const u of trans) if (!seen.has(u.toString())) found.push(u);
      }
      const code = await vscode.workspace.findFiles(new vscode.RelativePattern(this.folder, CODE_GLOB), exclude, 50000);
      this.model.clear();
      this.code.clear();
      for (const u of code) this.addCode(this.rel(u));
      await mapLimit(found, 24, uri => this.load(uri));
      this.rebuild();
      log(`${this.folder.name}：扫描到 ${this.model.docs.size} 篇文档、${this.code.size} 个源码文件，用时 ${Date.now() - t0}ms`);
    })();
    try { await this.scanning; } finally { this.scanning = null; }
  }

  addCode(rel) {
    if (!rel || !arch.CODE_RE.test(rel) || this.model.excluded(rel) || this.code.has(rel)) return false;
    this.code.add(rel);
    return true;
  }

  removeCode(rel) {
    const prefix = rel.replace(/\/$/, "") + "/";
    let n = 0;
    for (const p of [...this.code]) if (p === rel || p.startsWith(prefix)) { this.code.delete(p); n++; }
    return n > 0;
  }

  rebuild() {
    this.model.rebuild();
    const t0 = Date.now();
    try { this.model.setSystem(arch.inferModules(this.model.docs, [...this.code])); }
    catch (e) { this.model.setSystem(null); log("归纳系统模块失败：" + (e.stack || e)); }
    const ms = Date.now() - t0;
    if (ms > 500) log(`${this.folder.name}：归纳系统模块用时 ${ms}ms`);
  }

  async load(uri) {
    const rel = this.rel(uri);
    if (!rel || !this.model.classify(rel)) return null;
    try {
      const [bytes, stat] = await Promise.all([vscode.workspace.fs.readFile(uri), vscode.workspace.fs.stat(uri)]);
      return this.model.upsert(rel, decoder.decode(bytes), { size: stat.size, mtime: stat.mtime });
    } catch (e) {
      return null;
    }
  }

  watch() {
    this.disposeWatchers();
    const md = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, MD_GLOB));
    const cfg = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, ".mdmap.json"));
    // 目录的创建/删除/重命名不会逐个触发其中 md 文件的事件，需要单独监听
    const any = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, "**/*"), false, true, false);
    const enqueue = uri => this.enqueue(uri);
    const rescan = () => this.enqueue(null);
    this.disposables.push(
      md, cfg, any,
      md.onDidCreate(enqueue), md.onDidChange(enqueue), md.onDidDelete(enqueue),
      cfg.onDidCreate(rescan), cfg.onDidChange(rescan), cfg.onDidDelete(rescan),
      any.onDidCreate(uri => { if (!core.MD_RE.test(uri.path)) enqueue(uri); }),
      any.onDidDelete(uri => { if (!core.MD_RE.test(uri.path)) enqueue(uri); }),
    );
  }

  enqueue(uri) {
    this.pending.set(uri ? uri.toString() : "*", uri);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch(e => log("处理文件变化失败：" + (e.stack || e))), 300);
  }

  async flush() {
    const items = [...this.pending.values()];
    this.pending.clear();
    if (items.includes(null)) {
      await this.scan();
      this.publish({ reset: true });
      return;
    }
    const changes = { added: [], changed: [], removed: [], zh: [] };
    let codeChanged = false;
    for (const uri of items) {
      const rel = this.rel(uri);
      if (!rel) continue;
      let stat = null;
      try { stat = await vscode.workspace.fs.stat(uri); } catch (e) { stat = null; }
      if (!stat) {
        const r = this.model.remove(rel);
        changes.removed.push(...r.removed);
        changes.zh.push(...r.zhKeys);
        codeChanged = this.removeCode(rel) || codeChanged;
      } else if (stat.type & vscode.FileType.Directory) {
        const inner = await vscode.workspace.findFiles(new vscode.RelativePattern(uri, MD_GLOB), null, 5000);
        for (const u of inner) collect(changes, await this.load(u), this.rel(u));
        const code = await vscode.workspace.findFiles(new vscode.RelativePattern(uri, CODE_GLOB), null, 20000);
        for (const u of code) codeChanged = this.addCode(this.rel(u)) || codeChanged;
      } else if (core.MD_RE.test(rel)) {
        collect(changes, await this.load(uri), rel);
      } else {
        codeChanged = this.addCode(rel) || codeChanged;
      }
    }
    if (!codeChanged && !changes.added.length && !changes.changed.length && !changes.removed.length && !changes.zh.length) return;
    this.rebuild();
    log(`${this.folder.name}：新增 ${changes.added.length}，修改 ${changes.changed.length}，删除 ${changes.removed.length}，译文变化 ${changes.zh.length}` + (codeChanged ? "，源码文件有增删" : ""));
    this.publish(changes);
  }

  publish(changes) {
    this.lastChanges = changes;
    treeProvider.refresh();
    updateStatus();
    if (projects[activeIndex] === this) postInit(changes);
  }

  disposeWatchers() {
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }

  dispose() {
    clearTimeout(this.timer);
    this.disposeWatchers();
  }
}

function collect(changes, result, rel) {
  if (result === "added") changes.added.push(rel);
  else if (result === "changed") changes.changed.push(rel);
  else if (result && result.zh) changes.zh.push(result.zh);
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

async function initProjects() {
  projects.forEach(p => p.dispose());
  projects = (vscode.workspace.workspaceFolders || []).map(f => new FolderProject(f));
  activeIndex = Math.min(activeIndex, Math.max(0, projects.length - 1));
  treeProvider.refresh();
  for (const p of projects) {
    try { await p.scan(); p.watch(); }
    catch (e) { log(`${p.folder.name}：扫描失败 ${e.stack || e}`); }
  }
  treeProvider.refresh();
  updateStatus();
  postInit({ reset: true });
}

function activeProject() { return projects[activeIndex] || null; }

function findDoc(arg) {
  if (arg instanceof vscode.Uri) {
    for (let i = 0; i < projects.length; i++) {
      const rel = projects[i].rel(arg);
      if (rel && projects[i].model.docs.has(rel)) return { index: i, path: rel };
    }
    return null;
  }
  if (arg && typeof arg.path === "string") return { index: arg.index || 0, path: arg.path };
  return null;
}

// ---------- 网页面板 ----------
function openPanel(reveal) {
  if (reveal) pendingReveal = reveal;
  if (panel) {
    panel.reveal();
    if (panelReady) postInit(null);
    return;
  }
  const p = vscode.window.createWebviewPanel("mdmap.panel", "文档地图", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  setupPanel(p);
}

function setupPanel(p) {
  panel = p;
  panelReady = false;
  const media = vscode.Uri.joinPath(extContext.extensionUri, "media");
  const coreDir = vscode.Uri.joinPath(extContext.extensionUri, "core");
  p.webview.options = {
    enableScripts: true,
    localResourceRoots: [media, coreDir, ...(vscode.workspace.workspaceFolders || []).map(f => f.uri)],
  };
  p.iconPath = vscode.Uri.joinPath(media, "icon.svg");
  p.webview.html = renderHtml(p.webview, media, coreDir);
  p.onDidDispose(() => { if (panel === p) { panel = null; panelReady = false; } });
  p.webview.onDidReceiveMessage(msg => onMessage(msg).catch(e => log("处理面板消息失败：" + (e.stack || e))));
}

function renderHtml(webview, media, coreDir) {
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
  const src = (...parts) => webview.asWebviewUri(vscode.Uri.joinPath(...parts)).toString();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: http: data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${src(media, "app.css")}">
<title>文档地图</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${src(media, "vendor", "marked.min.js")}"></script>
<script nonce="${nonce}" src="${src(media, "vendor", "highlight.min.js")}"></script>
<script nonce="${nonce}" src="${src(coreDir, "mdmap-core.js")}"></script>
<script nonce="${nonce}" src="${src(media, "app.js")}"></script>
</body>
</html>`;
}

function post(msg) { if (panel && panelReady) panel.webview.postMessage(msg); }

function postInit(changes) {
  if (!panel || !panelReady) return;
  const p = activeProject();
  post({
    type: "init",
    projects: projects.map((x, i) => ({ index: i, name: x.folder.name })),
    active: activeIndex,
    snapshot: p ? p.model.snapshot() : null,
    scanning: !!(p && p.scanning),
    assetBase: p ? panel.webview.asWebviewUri(p.folder.uri).toString() : "",
    changes,
    lang: extContext.globalState.get("mdmap.lang", "zh"),
    group: groupBy(),
    mt: mtState(),
  });
  if (pendingReveal) {
    post({ type: "reveal", path: pendingReveal.path, view: pendingReveal.view });
    pendingReveal = null;
  }
}

async function onMessage(msg) {
  const p = activeProject();
  switch (msg.type) {
    case "ready":
      panelReady = true;
      postInit({ reset: true });
      break;
    case "open": {
      const payload = p && p.model.docPayload(msg.path);
      post({ type: "doc", path: msg.path, payload });
      break;
    }
    case "search":
      post({ type: "searchResult", q: msg.q, full: msg.full, hits: p ? p.model.search(msg.q, msg.full) : [] });
      break;
    case "source":
      if (p) await vscode.window.showTextDocument(p.uri(msg.path), { viewColumn: vscode.ViewColumn.Beside, preview: true });
      break;
    case "file":
      if (p) {
        const uri = p.uri(msg.path);
        try { await vscode.workspace.fs.stat(uri); await vscode.commands.executeCommand("vscode.open", uri, vscode.ViewColumn.Beside); }
        catch (e) { vscode.window.showWarningMessage(`文件不存在：${msg.path}`); }
      }
      break;
    case "external":
      await vscode.env.openExternal(vscode.Uri.parse(msg.url));
      break;
    case "rescan":
      if (p) { await p.scan(); p.publish({ reset: true }); }
      break;
    case "switch":
      if (projects[msg.index]) { activeIndex = msg.index; postInit({ reset: true }); treeProvider.refresh(); }
      break;
    case "lang":
      await extContext.globalState.update("mdmap.lang", msg.lang);
      break;
    case "group":
      await setGroup(msg.group);
      break;
    case "copy":
      await vscode.env.clipboard.writeText(msg.text);
      break;
    case "translate":
      if (p) await translateOne(p, msg.path);
      break;
    case "translateAll":
      if (p) await translateAll(p);
      break;
    case "configureMt":
      await translator.configure();
      postMt();
      break;
  }
}

// ---------- 机器翻译 ----------
function mtState() {
  const id = translator.providerId();
  return { provider: id ? PROVIDERS[id].label : null, job: mtJob && { done: mtJob.done, total: mtJob.total, path: mtJob.path } };
}

function postMt() { post({ type: "mt", mt: mtState() }); }

function mtBusy() {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage("机器翻译会写入译文文件并把文档内容发送给翻译服务，请先信任此工作区。", "管理工作区信任")
      .then(go => go && vscode.commands.executeCommand("workbench.trust.manage"));
    return true;
  }
  if (!mtJob) return false;
  vscode.window.showInformationMessage("已有翻译任务在进行中，请等它完成或取消后再试。");
  return true;
}

async function translateOne(p, rel) {
  if (mtBusy() || !p.model.docs.has(rel)) return;
  const zs = p.model.zhState(rel);
  if (zs && !zs.mt) {
    const ok = await vscode.window.showWarningMessage(`「${rel}」已有人工译文，机器翻译会覆盖它。`, { modal: true }, "覆盖");
    if (ok !== "覆盖") return;
  }
  const ready = await translator.ensureReady();
  if (ready) await runTranslation(p, [rel], ready);
}

async function translateAll(p) {
  if (mtBusy()) return;
  const ready = await translator.ensureReady();
  if (!ready) return;
  const all = [...p.model.docs.keys()];
  const todo = all.filter(rel => { const zs = p.model.zhState(rel); return !zs || zs.stale; });
  const pick = await vscode.window.showQuickPick([
    { id: "todo", label: "翻译还没有译文、或译文已过期的文档", description: `${todo.length} 篇`, detail: "已有的译文（包括人工译文）保持不变" },
    { id: "all", label: "重新翻译全部文档", description: `${all.length} 篇`, detail: "会覆盖已有的译文，包括人工译文" },
  ], { title: "机器翻译全部文档" });
  if (!pick) return;
  const rels = pick.id === "all" ? all : todo;
  if (!rels.length) { vscode.window.showInformationMessage("所有文档都已有最新译文。"); return; }
  const est = await translator.estimate(ready.id, rels.map(rel => p.model.docs.get(rel).content));
  const label = PROVIDERS[ready.id].label;
  const go = await vscode.window.showWarningMessage(
    `将使用${label}翻译 ${rels.length} 篇文档，约 ${est.send.toLocaleString()} 个字符需要发送给翻译服务` +
    (est.cached ? `，另有 ${est.cached.toLocaleString()} 个字符命中缓存，不会重复发送` : "") + "。翻译服务通常按字符计费。",
    { modal: true }, "开始翻译");
  if (go === "开始翻译") await runTranslation(p, rels, ready);
}

async function runTranslation(p, rels, { id, cred }) {
  const label = PROVIDERS[id].label;
  mtJob = { done: 0, total: rels.length, path: rels[0] };
  postMt();
  let done = 0, kept = 0, stopError = null;
  const failed = [];
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${label}翻译`, cancellable: true }, async (progress, token) => {
      for (const [i, rel] of rels.entries()) {
        const d = p.model.docs.get(rel);
        if (token.isCancellationRequested) break;
        if (!d) continue;
        Object.assign(mtJob, { done: i, path: rel });
        postMt();
        const head = rels.length > 1 ? `${i + 1}/${rels.length} ` : "";
        progress.report({ message: head + rel, increment: i ? 100 / rels.length : 0 });
        try {
          const r = await translator.translateDoc(id, cred, d.content, token,
            (n, total) => progress.report({ message: `${head}${rel}（${n}/${total} 段）` }));
          const uri = p.uri(p.model.transDir + rel);
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
          await vscode.workspace.fs.writeFile(uri, Buffer.from(r.text, "utf8"));
          p.enqueue(uri);
          done++;
          kept += r.failed;
          log(`机器翻译完成：${rel}（发送 ${r.sent} 字符，${r.failed} 段保留原文）`);
        } catch (e) {
          if (e.kind === "cancel") break;
          if (e.kind === "auth" || e.kind === "fatal") throw e;
          failed.push(rel);
          log(`机器翻译失败：${rel}：${e.stack || e.message}`);
        }
      }
    });
  } catch (e) {
    stopError = e;
  } finally {
    mtJob = null;
    postMt();
  }

  const parts = [];
  if (kept) parts.push(`${kept} 段因格式无法对齐保留了原文`);
  if (failed.length) parts.push(`${failed.length} 篇失败（详见输出面板「MD 文档地图」）`);
  if (stopError) {
    log(`机器翻译中止：${stopError.message}`);
    const msg = `机器翻译中止：${stopError.message}` + (done ? `。已完成 ${done} 篇。` : "");
    if (stopError.kind === "auth") {
      if (await vscode.window.showErrorMessage(msg, "重新配置")) { await translator.configure(); postMt(); }
    } else vscode.window.showErrorMessage(msg);
  } else if (rels.length > 1 || parts.length) {
    vscode.window.showInformationMessage(`已翻译 ${done} 篇文档` + (parts.length ? "，" + parts.join("，") : "") + "。");
  } else if (done) {
    vscode.window.setStatusBarMessage(`$(check) 已翻译 ${rels[0]}`, 4000);
  }
}

// ---------- 侧边栏树 ----------
// "sys" 按系统模块分组，"dir" 按目录分组
function groupBy() { return extContext.globalState.get("mdmap.group", "sys"); }

async function setGroup(group) {
  await extContext.globalState.update("mdmap.group", group);
  vscode.commands.executeCommand("setContext", "mdmap.group", group);
  treeProvider.refresh();
  post({ type: "group", group });
}

function topNodes(p) {
  return groupBy() === "sys" && p.model.system ? p.model.system.tree : p.model.tree;
}

class DocTreeProvider {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  refresh() { this.emitter.fire(); }

  getChildren(el) {
    if (!el) {
      if (projects.length > 1) return projects.map((p, index) => ({ kind: "project", index }));
      return projects[0] ? this.nodeChildren(0, { docs: [], children: topNodes(projects[0]) }) : [];
    }
    if (el.kind === "project") return this.nodeChildren(el.index, { docs: [], children: topNodes(projects[el.index]) });
    if (el.kind === "node") return this.nodeChildren(el.index, el.node);
    return [];
  }

  nodeChildren(index, node) {
    return [
      ...node.children.map(n => ({ kind: "node", index, node: n })),
      ...node.docs.map(path => ({ kind: "doc", index, path })),
    ];
  }

  getTreeItem(el) {
    const S = vscode.TreeItemCollapsibleState;
    if (el.kind === "project") {
      const p = projects[el.index];
      const item = new vscode.TreeItem(p.folder.name, S.Expanded);
      item.description = `${p.model.docs.size} 篇`;
      item.iconPath = new vscode.ThemeIcon("root-folder");
      return item;
    }
    if (el.kind === "node") {
      const item = new vscode.TreeItem(el.node.label, S.Collapsed);
      item.description = String(el.node.count);
      item.tooltip = [el.node.label, el.node.sub, el.node.desc].filter(Boolean).join("\n");
      item.iconPath = new vscode.ThemeIcon(el.node.mod ? "symbol-module" : "folder");
      item.id = `${el.index}:${el.node.key}`;
      return item;
    }
    const p = projects[el.index];
    const d = p.model.docs.get(el.path);
    const item = new vscode.TreeItem(d ? d.name : el.path, S.None);
    item.id = `${el.index}:doc:${el.path}`;
    item.resourceUri = p.uri(el.path);
    item.description = d && d.title !== d.name.replace(core.MD_RE, "") ? d.title : "";
    item.tooltip = `${el.path}${d && d.brokenCount ? `\n失效链接 ${d.brokenCount} 个` : ""}`;
    item.iconPath = new vscode.ThemeIcon(d && d.brokenCount ? "warning" : "markdown");
    item.contextValue = "doc";
    item.command = { command: "mdmap.revealDoc", title: "在文档地图中查看", arguments: [{ index: el.index, path: el.path }] };
    return item;
  }
}

function updateStatus() {
  const docs = projects.reduce((s, p) => s + p.model.docs.size, 0);
  const broken = projects.reduce((s, p) => s + p.model.broken.length, 0);
  if (!docs) { statusItem.hide(); return; }
  statusItem.text = broken ? `$(type-hierarchy) 文档地图 $(warning) ${broken}` : "$(type-hierarchy) 文档地图";
  statusItem.tooltip = `打开 MD 文档地图（${docs} 篇文档，${broken} 个失效链接）`;
  statusItem.show();
}

function activate(context) {
  extContext = context;
  output = vscode.window.createOutputChannel("MD 文档地图");
  translator = new Translator(context, marked, log);
  treeProvider = new DocTreeProvider();
  const treeView = vscode.window.createTreeView("mdmap.tree", { treeDataProvider: treeProvider, showCollapseAll: true });
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "mdmap.open";

  context.subscriptions.push(
    output, treeView, statusItem,
    treeView.onDidChangeVisibility(e => {
      if (e.visible && !panel && vscode.workspace.getConfiguration("mdmap").get("openOnViewShow", true)) openPanel(null);
    }),
    vscode.commands.registerCommand("mdmap.open", () => openPanel(null)),
    vscode.commands.registerCommand("mdmap.showBroken", () => openPanel({ view: "broken" })),
    vscode.commands.registerCommand("mdmap.refresh", async () => {
      await Promise.all(projects.map(p => p.scan()));
      projects.forEach(p => p.publish({ reset: true }));
    }),
    vscode.commands.registerCommand("mdmap.revealDoc", arg => {
      const target = findDoc(arg || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri));
      if (!target) { vscode.window.showInformationMessage("该文件不在文档地图中（可能被排除或不在工作区内）。"); return; }
      activeIndex = target.index;
      openPanel(target);
    }),
    vscode.commands.registerCommand("mdmap.openSource", el => {
      const t = findDoc(el);
      if (t) vscode.window.showTextDocument(projects[t.index].uri(t.path), { preview: true });
    }),
    vscode.commands.registerCommand("mdmap.groupBySystem", () => setGroup("sys")),
    vscode.commands.registerCommand("mdmap.groupByDir", () => setGroup("dir")),
    vscode.commands.registerCommand("mdmap.configureTranslation", async () => { await translator.configure(); postMt(); }),
    vscode.commands.registerCommand("mdmap.translateDoc", arg => {
      const t = findDoc(arg || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri));
      if (!t) { vscode.window.showInformationMessage("该文件不在文档地图中（可能被排除或不在工作区内）。"); return; }
      return translateOne(projects[t.index], t.path);
    }),
    vscode.commands.registerCommand("mdmap.translateAll", () => {
      const p = activeProject();
      return p && translateAll(p);
    }),
    vscode.window.registerWebviewPanelSerializer("mdmap.panel", {
      async deserializeWebviewPanel(p) { setupPanel(p); },
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => initProjects()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("files.exclude") || e.affectsConfiguration("mdmap.exclude")) projects.forEach(p => p.enqueue(null));
      if (e.affectsConfiguration("mdmap.translate.provider")) postMt();
    }),
    { dispose: () => projects.forEach(p => p.dispose()) },
  );

  vscode.commands.executeCommand("setContext", "mdmap.group", groupBy());
  initProjects().catch(e => log("初始化失败：" + (e.stack || e)));
}

function deactivate() {}

module.exports = { activate, deactivate };
