# MD 文档地图

VS Code / Cursor 扩展：扫描工作区里的 Markdown，自动归纳出**系统模块架构**，并支持阅读、搜索、反向链接、失效链接检查与机器翻译。

适合文档较多、模块边界藏在源码目录里的项目：打开即可看到「有哪些模块、每个模块有哪些文档」，点进去再读细节。

## 功能

- **系统模块视图（默认）**  
  结合源码目录结构与文档内容（标题、路径、小节、描述、源码引用、正文提及）自动归纳模块树。每篇文档只归入一个主模块，并给出归类依据。证据不足或跨模块的文档进入「综合文档」。
- **目录视图**  
  可随时切换为按文件夹分组；也可用工作区根目录的 `.mdmap.json` 自定义目录分组。
- **阅读与导航**  
  在面板内渲染 Markdown；面包屑展示所属模块链；右侧有本页目录、所属模块、文档信息（反向链接、出链、失效链接）。
- **搜索**  
  按文件名 / 标题搜索，可选同时搜正文。
- **失效链接**  
  检查指向项目内文档与锚点的链接是否有效。
- **中文 / 原文切换**  
  译文不改动原文件；默认写入 `.mdmap/zh/`（可在配置里改路径）。
- **机器翻译**  
  支持 DeepL、百度翻译、有道智云。密钥保存在编辑器凭据存储中；原文变更后会标记译文已过期。
- **自动刷新**  
  监听工作区内 Markdown（及源码增删）变化，重新扫描并更新地图。

## 要求

- VS Code ≥ 1.80，或兼容的 Cursor
- 无需 Node.js 运行时（扩展本身为纯 JS）

## 安装

### 从 VSIX 安装

```bash
code --install-extension md-map-0.3.1.vsix
# 或 Cursor：
cursor --install-extension md-map-0.3.1.vsix
```

也可在编辑器中：扩展视图 → `⋯` →「从 VSIX 安装…」。

安装或更新后请执行一次 **Developer: Reload Window**。

### 本地打包

在 Windows PowerShell 中（不依赖 `vsce` / Node）：

```powershell
cd md-map-extension
powershell -ExecutionPolicy Bypass -File scripts/pack.ps1
```

会生成 `md-map-<version>.vsix`。

## 使用

1. 打开包含 Markdown 的项目文件夹。
2. 点击活动栏 **MD 文档地图**，或命令面板运行 **MD 文档地图: 打开文档地图**。
3. 默认进入 **系统模块** 视图：
   - 结构图上点模块旁的 **详情** → 模块页（子模块、文档按类型分组、归类依据、相关模块）
   - 点文档 → 阅读页；右侧 **所属模块** 可看归属与同模块文档
4. 顶栏可切换 **系统模块 / 目录**、**中文 / 原文**，并查看失效链接、触发机器翻译。

侧边栏树与结构图使用同一套分组；标题栏图标可在「按系统模块」与「按目录」之间切换。

## 可选配置：`.mdmap.json`

放在工作区根目录。不写也能用（系统模块完全自动）。常见字段：

```json
{
  "translations": { "zh": ".mdmap/zh" },
  "ignore": ["**/vendor/**"],
  "dirLabels": {
    "docs/guides/": "使用指南"
  },
  "modules": [
    {
      "label": "用户文档",
      "sub": "docs/",
      "color": "#ea580c",
      "children": [{ "auto": "docs/" }]
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `translations.zh` | 中文译文目录（相对仓库根）。未配置时为 `.mdmap/zh/` |
| `ignore` | 额外排除的 glob |
| `dirLabels` | 目录视图里某些路径的显示名 |
| `modules` | 自定义**目录视图**分组（`files` / `children` / `auto`）。不影响系统模块归纳 |

编辑器设置：

| 设置 | 说明 |
| --- | --- |
| `mdmap.openOnViewShow` | 点活动栏图标时是否自动打开面板（默认 `true`） |
| `mdmap.exclude` | 额外排除 glob，与 `files.exclude`、`.mdmap.json` 的 `ignore` 合并 |
| `mdmap.translate.provider` | 机器翻译服务；密钥请用命令 **配置机器翻译** 写入凭据存储 |

## 机器翻译说明

- 命令：**配置机器翻译** → 选择 DeepL / 百度 / 有道并填写密钥（可先试译一句）。
- 译文写入译文目录，**不修改原文**。
- 机器译文会带标记；原文之后若被修改，面板会提示译文已过期，可一键更新。
- 未信任的工作区：可浏览地图与阅读；写入译文与调用翻译 API 需先信任工作区。

## 系统模块如何归纳（简要）

1. 以源码目录为骨架：顶层目录（或 monorepo 的 `packages` / `apps` 等包名）作为一级模块，并向下展开子目录。
2. 对每篇文档按标题、路径、描述、小节标题、引用的源码路径、正文提及打分，选得分最高的模块；子模块需有标题或路径上的直接证据才会下钻。
3. 测试夹具、快照、多语言 `README.xx.md` 等不参与模块归类。

效果因项目而异：源码边界清晰、文档会点名模块时效果最好；文档很少或命名脱节时，多数会落在「综合文档」。

## 开发

```
md-map-extension/
  extension.js          # 扩展宿主：扫描、监听、面板、翻译任务
  core/
    mdmap-core.js       # 解析、链接、目录树、项目模型（宿主与 webview 共用）
    mdmap-arch.js       # 系统模块归纳
  media/                # webview UI
  translate/            # 分段与各翻译服务适配
  scripts/pack.ps1      # 打 vsix
  dev/                  # 浏览器调试与离线检查脚本
```

浏览器调试（可选）：

```powershell
powershell -ExecutionPolicy Bypass -File dev/serve.ps1
# 打开 http://localhost:8765/md-map-extension/dev/harness.html
```

离线检查模块归纳：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "<Cursor 或 Electron 可执行文件>" dev/check-arch.js <项目根目录> [--why]
```

## 许可

MIT

## 反馈

Issue 与 PR 欢迎。若某类项目归类偏差较大，请附上仓库结构说明或样例路径，便于改进归纳启发式。
