"use strict";
// 机器翻译服务适配：每个服务把一批文本翻译成简体中文，返回等长数组。
// 分批、限速、重试统一在 translateTexts 中处理。
const https = require("https");
const crypto = require("crypto");

class MtError extends Error {
  // kind: auth（凭据问题，需要重新配置）| fatal（额度用尽等，继续也没用）| retry（可重试）| cancel | 其他
  constructor(message, kind) {
    super(message);
    this.kind = kind || "error";
  }
}

function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(body, "utf8");
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "POST", timeout: 30000,
      headers: { ...headers, "Content-Length": data.length },
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", e => reject(new MtError("网络错误：" + e.message, "retry")));
    });
    req.on("timeout", () => req.destroy(new MtError("请求超时", "retry")));
    req.on("error", e => reject(e instanceof MtError ? e : new MtError("网络错误：" + e.message, "retry")));
    req.end(data);
  });
}

function form(params) {
  return Object.entries(params).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
}
function parseJson(r, name) {
  try { return JSON.parse(r.text); }
  catch (e) { throw new MtError(`${name} 返回了无法解析的内容（HTTP ${r.status}）`, r.status >= 500 ? "retry" : "error"); }
}
const hash = (algo, s) => crypto.createHash(algo).update(s, "utf8").digest("hex");

const BAIDU_ERRORS = {
  52001: ["请求超时", "retry"], 52002: ["系统错误", "retry"], 52003: ["APP ID 无效或未开通服务", "auth"],
  54001: ["签名错误，请检查密钥", "auth"], 54003: ["访问频率受限", "retry"], 54004: ["账户余额不足", "fatal"],
  54005: ["长文本请求过于频繁", "retry"], 58000: ["客户端 IP 不在白名单中", "auth"], 58002: ["服务已关闭", "fatal"],
  90107: ["认证未通过或未生效", "auth"],
};
const YOUDAO_ERRORS = {
  108: ["应用 ID 无效", "auth"], 110: ["应用未绑定文本翻译服务", "auth"], 111: ["开发者账号无效", "auth"],
  202: ["签名检验失败，请检查应用密钥", "auth"], 206: ["时间戳无效，请检查系统时间", "error"],
  401: ["账户已欠费", "fatal"], 411: ["访问频率受限", "retry"], 412: ["长请求过于频繁", "retry"], 103: ["翻译文本过长", "error"],
};

const PROVIDERS = {
  deepl: {
    label: "DeepL",
    detail: "在 DeepL 账户页的「API Keys」中创建密钥；免费版密钥以 :fx 结尾",
    fields: [{ key: "key", prompt: "DeepL API 密钥（Authentication Key）", password: true }],
    gap: 0, maxItems: 50, maxChars: 30000,
    async call(texts, cred) {
      const key = cred.key.trim();
      const host = key.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
      const r = await httpPost(`https://${host}/v2/translate`,
        JSON.stringify({ text: texts, target_lang: "ZH-HANS", preserve_formatting: true, split_sentences: "nonewlines" }),
        { "Content-Type": "application/json", Authorization: "DeepL-Auth-Key " + key });
      if (r.status === 403) throw new MtError("DeepL 密钥无效", "auth");
      if (r.status === 456) throw new MtError("DeepL 额度已用完", "fatal");
      if (r.status === 429 || r.status >= 500) throw new MtError(`DeepL 暂时不可用（HTTP ${r.status}）`, "retry");
      if (r.status !== 200) throw new MtError(`DeepL 请求失败（HTTP ${r.status}）：${r.text.slice(0, 200)}`);
      return parseJson(r, "DeepL").translations.map(t => t.text);
    },
  },
  baidu: {
    label: "百度翻译",
    detail: "百度翻译开放平台 → 管理控制台 → 开发者信息中的 APP ID 与密钥",
    fields: [{ key: "appid", prompt: "百度翻译 APP ID" }, { key: "secret", prompt: "百度翻译密钥", password: true }],
    gap: 1100, maxItems: 200, maxBytes: 5000, joined: true,
    async call(texts, cred) {
      const q = texts.join("\n");
      const salt = String(Date.now());
      const sign = hash("md5", cred.appid + q + salt + cred.secret);
      const r = await httpPost("https://fanyi-api.baidu.com/api/trans/vip/translate",
        form({ q, from: "auto", to: "zh", appid: cred.appid, salt, sign }),
        { "Content-Type": "application/x-www-form-urlencoded" });
      const j = parseJson(r, "百度翻译");
      if (j.error_code && String(j.error_code) !== "52000") {
        const [msg, kind] = BAIDU_ERRORS[j.error_code] || [j.error_msg || "未知错误", "error"];
        throw new MtError(`百度翻译：${msg}（${j.error_code}）`, kind);
      }
      return (j.trans_result || []).map(x => x.dst);
    },
  },
  youdao: {
    label: "有道智云",
    detail: "有道智云 AI 开放平台 → 应用总览中的应用 ID 与应用密钥（应用需绑定文本翻译服务）",
    fields: [{ key: "appKey", prompt: "有道智云应用 ID" }, { key: "secret", prompt: "有道智云应用密钥", password: true }],
    gap: 300, maxItems: 200, maxChars: 4000, joined: true,
    async call(texts, cred) {
      const q = texts.join("\n");
      const chars = Array.from(q);
      const input = chars.length <= 20 ? q : chars.slice(0, 10).join("") + chars.length + chars.slice(-10).join("");
      const salt = crypto.randomUUID();
      const curtime = String(Math.floor(Date.now() / 1000));
      const sign = hash("sha256", cred.appKey + input + salt + curtime + cred.secret);
      const r = await httpPost("https://openapi.youdao.com/api",
        form({ q, from: "auto", to: "zh-CHS", appKey: cred.appKey, salt, sign, signType: "v3", curtime }),
        { "Content-Type": "application/x-www-form-urlencoded" });
      const j = parseJson(r, "有道智云");
      if (String(j.errorCode) !== "0") {
        const [msg, kind] = YOUDAO_ERRORS[j.errorCode] || ["未知错误", "error"];
        throw new MtError(`有道智云：${msg}（${j.errorCode}）`, kind);
      }
      return (j.translation || []).join("\n").split("\n");
    },
  },
};

const lastCall = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callOnce(id, texts, cred, token) {
  const p = PROVIDERS[id];
  for (let attempt = 0; ; attempt++) {
    if (token && token.isCancellationRequested) throw new MtError("已取消", "cancel");
    const wait = (lastCall[id] || 0) + p.gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall[id] = Date.now();
    try {
      return await p.call(texts, cred);
    } catch (e) {
      if (!(e instanceof MtError) || e.kind !== "retry" || attempt >= 3) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

function batches(p, texts) {
  const out = [];
  let cur = [], size = 0;
  const measure = s => (p.maxBytes ? Buffer.byteLength(s, "utf8") : s.length) + 1;
  const limit = p.maxBytes || p.maxChars;
  for (let i = 0; i < texts.length; i++) {
    const n = measure(texts[i]);
    if (cur.length && (cur.length >= p.maxItems || size + n > limit)) { out.push(cur); cur = []; size = 0; }
    cur.push(i);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// 返回与 texts 等长的译文数组；onProgress(已完成条数)
async function translateTexts(id, cred, texts, { token, onProgress } = {}) {
  const p = PROVIDERS[id];
  if (!p) throw new MtError("未知的翻译服务：" + id, "auth");
  const out = new Array(texts.length);
  let done = 0;
  for (const idx of batches(p, texts)) {
    const group = idx.map(i => texts[i]);
    let res = await callOnce(id, group, cred, token);
    // 按换行拼接提交的服务偶尔会合并或拆分行，对不上时逐条重翻
    if (res.length !== group.length) {
      res = [];
      for (const t of group) res.push((await callOnce(id, [t], cred, token)).join(" "));
    }
    idx.forEach((i, k) => { out[i] = res[k]; });
    done += idx.length;
    if (onProgress) onProgress(done);
  }
  return out;
}

module.exports = { PROVIDERS, MtError, translateTexts, batches };
