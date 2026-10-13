"use strict";
// 文档级机器翻译：切分片段 → 查缓存 → 调用翻译服务 → 回填并加上机器翻译标记。
// 密钥保存在 VS Code SecretStorage，片段缓存保存在扩展的 globalStorage 中，原文只改了几段时只会重翻改动的部分。
const vscode = require("vscode");
const crypto = require("crypto");
const core = require("../core/mdmap-core.js");
const { planDoc } = require("./markdown.js");
const { PROVIDERS, MtError, translateTexts } = require("./providers.js");

const SECRET_PREFIX = "mdmap.mt.";
const decoder = new TextDecoder("utf-8");

class Translator {
  constructor(context, marked, log) {
    this.context = context;
    this.marked = marked;
    this.log = log;
    this.cacheUri = vscode.Uri.joinPath(context.globalStorageUri, "mt-cache.json");
    this.cache = null;
    this.cacheDirty = false;
  }

  providerId() {
    const id = vscode.workspace.getConfiguration("mdmap").get("translate.provider");
    return PROVIDERS[id] ? id : null;
  }

  async credentials(id) {
    const raw = await this.context.secrets.get(SECRET_PREFIX + id);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  // 选择翻译服务并录入密钥，录入后用一句话试翻验证；成功返回 { id, cred }
  async configure() {
    const current = this.providerId();
    const pick = await vscode.window.showQuickPick(Object.entries(PROVIDERS).map(([id, p]) => ({
      id, label: p.label, description: id === current ? "当前使用" : "", detail: p.detail,
    })), { title: "配置机器翻译（1/2）：选择翻译服务", placeHolder: "译文统一翻译为简体中文" });
    if (!pick) return null;
    const p = PROVIDERS[pick.id];
    const old = (await this.credentials(pick.id)) || {};
    const cred = {};
    for (const [i, f] of p.fields.entries()) {
      const value = await vscode.window.showInputBox({
        title: `配置机器翻译（2/2）：${p.label} · ${i + 1}/${p.fields.length}`,
        prompt: f.prompt + (old[f.key] ? "（留空则沿用已保存的值）" : ""),
        password: !!f.password, ignoreFocusOut: true,
      });
      if (value === undefined) return null;
      cred[f.key] = value.trim() || old[f.key] || "";
      if (!cred[f.key]) { vscode.window.showWarningMessage(`${f.prompt}不能为空。`); return null; }
    }
    try {
      const [sample] = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `正在验证 ${p.label} 的密钥…` },
        () => translateTexts(pick.id, cred, ["Hello, world!"]));
      await this.context.secrets.store(SECRET_PREFIX + pick.id, JSON.stringify(cred));
      await vscode.workspace.getConfiguration("mdmap").update("translate.provider", pick.id, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`${p.label} 配置成功（试翻：Hello, world! → ${sample}）`);
      return { id: pick.id, cred };
    } catch (e) {
      vscode.window.showErrorMessage(`${p.label} 验证失败：${e.message}`);
      return null;
    }
  }

  async ensureReady() {
    const id = this.providerId();
    const cred = id && await this.credentials(id);
    if (id && cred) return { id, cred };
    const go = await vscode.window.showInformationMessage("使用机器翻译前，需要先选择翻译服务并填写 API 密钥。", "去配置");
    return go ? this.configure() : null;
  }

  async loadCache() {
    if (this.cache) return this.cache;
    try { this.cache = JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(this.cacheUri))).entries || {}; }
    catch (e) { this.cache = {}; }
    return this.cache;
  }

  async saveCache() {
    if (!this.cacheDirty) return;
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    await vscode.workspace.fs.writeFile(this.cacheUri, Buffer.from(JSON.stringify({ version: 1, entries: this.cache }), "utf8"));
    this.cacheDirty = false;
  }

  key(id, text) { return crypto.createHash("sha1").update(id + "\u0000" + text, "utf8").digest("hex"); }

  // 估算需要发送给翻译服务的字符数（扣除缓存命中和同文重复）
  async estimate(id, contents) {
    const cache = await this.loadCache();
    const seen = new Set();
    let send = 0, cached = 0;
    for (const content of contents) {
      for (const s of planDoc(this.marked, content).segments) {
        const k = this.key(id, s.text);
        if (seen.has(k)) continue;
        seen.add(k);
        if (cache[k] !== undefined) cached += s.text.length; else send += s.text.length;
      }
    }
    return { send, cached };
  }

  // 返回 { text, sent, failed }；text 为带机器翻译标记的完整译文
  async translateDoc(id, cred, content, token, onProgress) {
    const cache = await this.loadCache();
    const plan = planDoc(this.marked, content);
    const keys = plan.segments.map(s => this.key(id, s.text));
    const missing = [...new Set(keys.filter(k => cache[k] === undefined))];
    const textOf = new Map(keys.map((k, i) => [k, plan.segments[i].text]));
    let sent = 0;
    if (missing.length) {
      const texts = missing.map(k => textOf.get(k));
      const out = await translateTexts(id, cred, texts, {
        token, onProgress: n => onProgress && onProgress(n, missing.length),
      });
      missing.forEach((k, i) => { if (typeof out[i] === "string") cache[k] = out[i]; });
      sent = texts.reduce((s, t) => s + t.length, 0);
      this.cacheDirty = true;
      await this.saveCache();
    }
    const { text, failed } = plan.render(keys.map(k => cache[k]), core.formatMtMark(id, core.contentHash(content)));
    const before = core.analyzeDoc(this.marked, "a.md", content).heads.length;
    const after = core.analyzeDoc(this.marked, "a.md", text).heads.length;
    if (before !== after) this.log(`警告：译文标题数量（${after}）与原文（${before}）不一致`);
    return { text, sent, failed };
  }
}

module.exports = { Translator, MtError, PROVIDERS };
