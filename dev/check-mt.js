// 离线检查机器翻译：用假的 https / vscode 模块验证签名、分批、错误处理、缓存与过期判断。
// 用法：node dev/check-mt.js
"use strict";
const Module = require("module");
const crypto = require("crypto");
const assert = require("assert");
const { EventEmitter } = require("events");

// ---------- 假 https：按 handler 返回响应，记录请求 ----------
const calls = [];
let handler = null;
const fakeHttps = {
  request(opts, cb) {
    const req = new EventEmitter();
    req.destroy = e => req.emit("error", e);
    req.end = data => {
      const call = { host: opts.hostname, path: opts.path, headers: opts.headers, body: data.toString("utf8") };
      calls.push(call);
      setImmediate(() => {
        const { status, json } = handler(call);
        const res = new EventEmitter();
        res.statusCode = status;
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify(json)));
        res.emit("end");
      });
    };
    return req;
  },
};

// ---------- 假 vscode：内存文件系统 + 配置 ----------
const files = new Map();
const config = { "translate.provider": "deepl" };
const fakeVscode = {
  Uri: { joinPath: (base, ...p) => ({ path: [base.path, ...p].join("/") }) },
  workspace: {
    fs: {
      readFile: async uri => { if (!files.has(uri.path)) throw new Error("ENOENT"); return files.get(uri.path); },
      writeFile: async (uri, data) => { files.set(uri.path, Buffer.from(data)); },
      createDirectory: async () => {},
    },
    getConfiguration: () => ({ get: k => config[k] }),
  },
};

const load = Module._load;
Module._load = function (req, ...rest) {
  if (req === "https") return fakeHttps;
  if (req === "vscode") return fakeVscode;
  return load.call(this, req, ...rest);
};

const { marked } = require("../media/vendor/marked.min.js");
const core = require("../core/mdmap-core.js");
const { PROVIDERS, MtError, translateTexts, batches } = require("../translate/providers.js");
const { Translator } = require("../translate/translator.js");

const zhOf = s => s.replace(/[A-Za-z][A-Za-z'’-]*/g, "译");
const form = body => Object.fromEntries(new URLSearchParams(body));
const md5 = s => crypto.createHash("md5").update(s, "utf8").digest("hex");
const sha256 = s => crypto.createHash("sha256").update(s, "utf8").digest("hex");

async function run(name, fn) {
  calls.length = 0;
  try { await fn(); console.log("通过  " + name); }
  catch (e) { console.log("失败  " + name + "\n      " + (e.stack || e).split("\n").slice(0, 3).join("\n      ")); process.exitCode = 1; }
}

(async () => {
  for (const p of Object.values(PROVIDERS)) p.gap = 0;

  await run("百度签名与官方示例一致", async () => {
    assert.strictEqual(md5("2015063000000001" + "apple" + "1435660288" + "12345678"), "f89f9594663708c1605f3d736d01d2d4");
  });

  await run("百度：按行拼接提交、签名正确、结果逐行对应", async () => {
    handler = c => {
      const f = form(c.body);
      assert.strictEqual(f.sign, md5(f.appid + f.q + f.salt + "sec"));
      assert.strictEqual(f.to, "zh");
      return { status: 200, json: { trans_result: f.q.split("\n").map(s => ({ src: s, dst: zhOf(s) })) } };
    };
    const out = await translateTexts("baidu", { appid: "id1", secret: "sec" }, ["Hello {0} world", "Second line"]);
    assert.deepStrictEqual(out, ["译 {0} 译", "译 译"]);
    assert.strictEqual(calls.length, 1);
  });

  await run("百度：访问频率受限会重试，凭据错误归为 auth", async () => {
    let n = 0;
    handler = c => (++n === 1 ? { status: 200, json: { error_code: "54003", error_msg: "Invalid Access Limit" } }
      : { status: 200, json: { trans_result: [{ dst: "好" }] } });
    assert.deepStrictEqual(await translateTexts("baidu", { appid: "a", secret: "b" }, ["ok"]), ["好"]);
    assert.strictEqual(n, 2);
    handler = () => ({ status: 200, json: { error_code: "52003", error_msg: "UNAUTHORIZED USER" } });
    await assert.rejects(translateTexts("baidu", { appid: "a", secret: "b" }, ["ok"]), e => e instanceof MtError && e.kind === "auth");
  });

  await run("百度：返回行数对不上时逐条重翻", async () => {
    handler = c => {
      const q = form(c.body).q;
      return { status: 200, json: { trans_result: [{ dst: zhOf(q.replace(/\n/g, " ")) }] } };
    };
    const out = await translateTexts("baidu", { appid: "a", secret: "b" }, ["One", "Two", "Three"]);
    assert.deepStrictEqual(out, ["译", "译", "译"]);
    assert.strictEqual(calls.length, 4);
  });

  await run("有道：v3 签名（长文本截取规则）与结果拆行", async () => {
    handler = c => {
      const f = form(c.body);
      const chars = Array.from(f.q);
      const input = chars.length <= 20 ? f.q : chars.slice(0, 10).join("") + chars.length + chars.slice(-10).join("");
      assert.strictEqual(f.sign, sha256(f.appKey + input + f.salt + f.curtime + "sec"));
      assert.strictEqual(f.signType, "v3");
      return { status: 200, json: { errorCode: "0", translation: [zhOf(f.q)] } };
    };
    const out = await translateTexts("youdao", { appKey: "k", secret: "sec" }, ["A long sentence for signing 🐈", "Next"]);
    assert.deepStrictEqual(out, ["译 译 译 译 译 🐈", "译"]);
  });

  await run("DeepL：免费版密钥走 api-free，额度用完归为 fatal", async () => {
    handler = c => {
      assert.strictEqual(c.host, "api-free.deepl.com");
      assert.strictEqual(c.headers.Authorization, "DeepL-Auth-Key abc:fx");
      const j = JSON.parse(c.body);
      assert.strictEqual(j.target_lang, "ZH-HANS");
      return { status: 200, json: { translations: j.text.map(t => ({ text: zhOf(t) })) } };
    };
    assert.deepStrictEqual(await translateTexts("deepl", { key: "abc:fx" }, ["Hi there"]), ["译 译"]);
    handler = () => ({ status: 456, json: {} });
    await assert.rejects(translateTexts("deepl", { key: "abc" }, ["x"]), e => e.kind === "fatal");
  });

  await run("分批：遵守条数与字节上限", async () => {
    const texts = Array.from({ length: 120 }, (_, i) => "word ".repeat(i % 7 + 1));
    for (const b of batches(PROVIDERS.deepl, texts)) assert.ok(b.length <= 50);
    const big = Array.from({ length: 30 }, () => "中".repeat(400));
    for (const b of batches(PROVIDERS.baidu, big)) assert.ok(b.reduce((s, i) => s + Buffer.byteLength(big[i]) + 1, 0) <= 5000);
  });

  await run("取消：请求前检查取消标记", async () => {
    handler = () => ({ status: 200, json: { translations: [] } });
    await assert.rejects(translateTexts("deepl", { key: "k" }, ["x"], { token: { isCancellationRequested: true } }), e => e.kind === "cancel");
  });

  await run("文档翻译：结构保持、缓存命中、过期判断", async () => {
    handler = c => ({ status: 200, json: { translations: JSON.parse(c.body).text.map(t => ({ text: zhOf(t) })) } });
    const context = { globalStorageUri: { path: "/g" }, secrets: { get: async () => JSON.stringify({ key: "k" }) } };
    const tr = new Translator(context, marked, () => {});
    const src = [
      "---", "name: demo", "description: A short demo skill", "---", "",
      "# Getting Started", "", "Install with `pip install x` and read [the guide](guide.md#setup).", "",
      "- First item", "- Second item with **bold**", "", "| Key | Meaning |", "| --- | --- |", "| `a` | The first key |", "",
      "> [!NOTE]", "> Keep your keys private.", "", "```bash", "echo hello", "```", "",
    ].join("\n");
    const r1 = await tr.translateDoc("deepl", { key: "k" }, src);
    assert.strictEqual(r1.failed, 0);
    assert.ok(r1.sent > 0);
    assert.ok(r1.text.includes('description: "译 译 译 译"'));
    assert.ok(r1.text.includes("`pip install x`") && r1.text.includes("](guide.md#setup)"));
    assert.ok(r1.text.includes("echo hello") && r1.text.includes("> [!NOTE]") && r1.text.includes("| `a` | 译 译 译 |"));
    const sent1 = calls.length;
    const r2 = await tr.translateDoc("deepl", { key: "k" }, src);
    assert.strictEqual(r2.sent, 0);
    assert.strictEqual(calls.length, sent1, "第二次应全部命中缓存");

    const p = new core.Project(marked, "demo");
    p.upsert("docs/a.md", src, null);
    p.upsert(core.DEFAULT_TRANS_DIR + "docs/a.md", r1.text, null);
    p.rebuild();
    assert.deepStrictEqual(p.zhState("docs/a.md"), { mt: "deepl", stale: false });
    assert.strictEqual(p.docPayload("docs/a.md").zh.headCount, p.docPayload("docs/a.md").headCount);
    p.upsert("docs/a.md", src + "\nOne more paragraph.\n", null);
    p.rebuild();
    assert.deepStrictEqual(p.zhState("docs/a.md"), { mt: "deepl", stale: true });
    assert.strictEqual(p.snapshot().zhStale, 1);
    const est = await tr.estimate("deepl", [src + "\nOne more paragraph.\n"]);
    assert.strictEqual(est.send, "One more paragraph.".length);
  });

  await run("占位符被翻译服务弄丢时保留原文", async () => {
    handler = c => ({ status: 200, json: { translations: JSON.parse(c.body).text.map(t => ({ text: zhOf(t).replace(/\{\d+\}/g, "") })) } });
    const tr = new Translator({ globalStorageUri: { path: "/g2" } }, marked, () => {});
    const r = await tr.translateDoc("deepl", { key: "k" }, "Run `make` now.\n\nPlain words here.\n");
    assert.strictEqual(r.failed, 1);
    assert.ok(r.text.includes("Run `make` now.") && r.text.includes("译 译 译"));
  });
})();
