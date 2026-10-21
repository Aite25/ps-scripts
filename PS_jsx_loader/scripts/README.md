# PS_jsx_loader —— 项目说明（给 AI Agent 读）

> **这是给 Agent 的上手文档。** 用户不写脚本，只提需求；
> 所有代码由 Agent 维护。请**先读本文，再动机器**。

---

## 0. 一句话

一个 **Photoshop CEP 扩展面板**（HTML 列表式启动器）+ 一整套 **PS/AE 自动化 JSX**，
用来把设计稿（PSD/PSB）流水线处理成 After Effects 可用的工程。

---

## 1. 环境（本机实测）

| 项 | 值 |
|---|---|
| 扩展根目录 | `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\PS_jsx_loader\` |
| Photoshop | **2023（24.x）** |
| After Effects | **2024（24.6）** |
| 显示器 | 主屏 `0,0,1920×1032`；副屏 `1920,0,1920×1032` |
| PS 常用在副屏，AE 在主屏 | |
| 屏幕手册文件 | `%TEMP%\psjsx_screen_manual.txt` = `1920,0,1920,1032` |

⚠ **不要往桌面写任何文件**（用户明确要求）。临时产物放 `%TEMP%`。

---

## 2. 目录结构

```
PS_jsx_loader\
├── index.html                 面板（单文件：HTML + CSS + JS，~1800 行）
├── CSXS\manifest.xml          CEP 清单
├── host\main.jsx              PS 端引导
├── js\csinterface.js          Adobe 官方库
└── scripts\                   ★ 所有 JSX
    ├── README.md              ← 本文
    ├── 批量流程\              流水线本身
    │   ├── ps 00 批处理_整个文件夹.jsx      批量跑一个文件夹
    │   ├── ps 00_single 处理当前文件.jsx    对当前文档跑一遍
    │   ├── ps 01~ps 07                     各步骤
    │   ├── ae 08 应用AE指令JSON.jsx         AE 端入口
    │   ├── ae 09 批量导入PS并应用指令.jsx   AE 端：串行导入 + 应用
    │   ├── ae_lib 引擎_应用AE指令.jsx       引擎（被 ae 08/09 evalFile）
    │   ├── _共享 窗口位置.jsx               窗口定位（被各脚本 evalFile）
    │   └── 运行批处理.bat / 停止运行.bat
    ├── 处理所有图层\          独立工具（作用于整个文档）
    ├── 处理选中图层\          独立工具（作用于当前选区）
    ├── 诊断\                 一次性排查脚本（可随时删）
    ├── 参考_经验\README 成功套路.md          ★ 只讲「能用」的配方
    └── 参考_多选与选区\README 多选与选区.md  ★ 失败案例 + 报错原文
```

---

## 3. 动手前必读（**省你几个小时**）

### 3.1 两个参考文档

| 文档 | 什么时候读 |
|---|---|
| `参考_经验/README 成功套路.md` | **每次改代码前**。里面所有写法都是实机验证过的 |
| `参考_多选与选区/README 多选与选区.md` | 想用 ActionManager 选区/合并之前，**必读**（5 种写法全失败的记录） |

### 3.2 绝对不能做的事

| ✗ 不要 | 为什么 |
|---|---|
| 用 `rasterize()` 烘焙 | 会变成"整幅纯色 + 保留蒙版"，毁图 |
| 用 `layer.merge()` 做逐层合并 | 会吞掉无关图层，且不保留下层 id |
| 让脚本**创建**多层选区 | 当前环境 5 种写法全失败，只能由人手多选 |
| 用 `location.href = ...?r=xxx` 重载面板 | `file://` 打不开页面 → 面板白屏且按钮消失 |
| 在整棵文档树里按 `itemIndex` 查图层 | 不同文件夹会撞号，取回别处的层 |
| 跨文件夹移动面板里的脚本 | 面板只改显示顺序，不挪磁盘文件，下次重绘就归位 |
| 往桌面写文件 | 用户要求 |
| ES6 语法 / `JSON.*` / `.forEach` 等 | ExtendScript 是 ES3 |
| 依赖 `getIdentifier()` 取图层 id | 对 `targetLayers` 返回 `-1` |

### 3.3 必须遵守的写法

```js
/* ① IIFE 隔离 */
(function () { ... })();

/* ② suspendHistory 的入口必须挂 $.global（字符串在全局执行，看不到 IIFE 内函数） */
try { $.global.PSJSX_HOOK = main; } catch (e) {}
try { doc.suspendHistory("名字", "PSJSX_HOOK()"); }
catch (e) { /* 不要重跑 main（会把操作做两遍） */ }
finally { try { delete $.global.PSJSX_HOOK; } catch (e) {} }

/* ③ 顶层 try/catch：CEP 的 runScript 会静默吞异常，表现为"点了没反应" */
try { 业务 } catch (eAll) { alert("出错：" + eAll + "\n行号：" + eAll.line); }

/* ④ 图层对象会失效：先做纯数据快照，每步按 id 现查 */
items[i].id = L.id; items[i].name = "" + L.name;
var fresh = findById(doc, items[i].id);

/* ⑤ 智能对象合并：关 app.displayDialogs（不是 executeAction 的第三个参数） */
var prev = app.displayDialogs; app.displayDialogs = DialogModes.NO;
try { ...合并... } finally { if (prev !== null) app.displayDialogs = prev; }

/* ⑥ 文件编码：UTF-8 无 BOM，换行 CRLF */
```

---

## 4. 常见任务怎么做

### 4.1 加一个流水线步骤

1. 在 `批量流程\` 新建 `ps 08 xxx.jsx`
2. 头部约定：`#target photoshop` + 大段注释说明用途/坑
3. 用 `$.global.PSJSX_BATCH === true` 判断是否在批处理里（是则不弹自己的进度条）
4. 开始成功先写 `<TEMP>\psjsx_step_result.txt` 为 `OK`，出错覆盖为 `FAIL|原因`
5. **加到 `ps 00` 和 `ps 00_single` 的 `batchScripts` 数组末尾**
6. 用 `_共享 窗口位置.jsx` 的 `PSJSX_placeWindow(w, isRunner)` 定位弹窗

### 4.2 加一个独立工具

1. 放 `处理所有图层\`（作用于全文档）或 `处理选中图层\`（作用于选区）
2. 独立工具用 **`isStandalone = true`** 定位（靠右偏上，不遮批量进度条）
3. 跨目录加载共享文件：`here.parent.parent.fsName + "/批量流程/_共享 窗口位置.jsx"`

### 4.3 改面板（`index.html`）

1. **改之前先 `Copy-Item` 备份到 `%TEMP%`**（`Program Files` 下不建新文件，桌面又不许放）
2. 改完必须：`node --check` 校验内联 `<script>` 块（提取出来存成 `.js` 再 check）
   + 检查 `<style>` 块花括号配对
3. 面板里点 **♻ 热重载** 即可生效（不需要关面板）
   - 只有**新增 HTML 元素**时才必须重开面板（热重载只同步 style + script）
4. 面板是**单文件**，无构建步骤；无 CSP，可注入 `<script>`

### 4.4 改 AE 引擎

1. 引擎 `ae_lib 引擎_应用AE指令.jsx` 是纯 ES3，**可以被 `node --check` 校验**
   （复制成 `.js` 再 check，因为它不是 `.jsx` 扩展名）
2. 引擎**纯按名字**定位合成/图层 → **多个 PSD 同时导入会串**
   → 批量必须**串行**（导入一个就应用一个）
3. 引擎报告：默认写桌面（`ae08报告_*.txt`）+ JSON 旁边（`*_ae08报告.txt`）
   - 静默模式下（`$.global.AE_HANDOFF_QUIET`）主报告改放 `%TEMP%`

---

## 5. 验证与调试

### 5.1 改完 JSX 的验证流程

```powershell
# 语法（复制成 .js，因为 node --check 不认 .jsx）
Copy-Item "xxx.jsx" "$env:TEMP\chk.js"
node --check "$env:TEMP\chk.js"      # 记得先剥掉 #target 等指令行
```

### 5.2 实机跑不通时

1. 脚本里加**启动探针**（一进来就写 `%TEMP%\xxx_probe.txt`）
2. 顶层 `try/catch` 把错误和**行号**写进日志并弹窗
3. 把**关键状态**写日志：选区内容、每步结果
4. **不要靠猜**：看不到的现象用"读回"验证
   - 选了几层 → 读 `targetLayers.count`
   - 合并了几层 → 比对合并前后 id 集合
   - 设置生效没 → 设完立刻读回

### 5.3 面板不可见时

面板的 `console.log` 看不到 → 一切诊断都要**写文件**或**弹窗**。

---

## 6. 交付与同步

- **跨电脑同步靠 GitHub**：`https://github.com/Aite25/ps-scripts`（目录 `PS_jsx_loader/`）
- 推送方式：克隆到 `%TEMP%` → 整份覆盖 `PS_jsx_loader/` → commit → push
  （**不要**在 `scripts\` 里直接 push，那是本地仓库，结构不同）
- `scripts\` 本身也是个**本地 git 仓库**，可以先本地 commit
- 提交信息写清"改了什么、为什么"，用户会从 GitHub 看历史

---

## 7. 用户偏好（重要）

| 偏好 | 说明 |
|---|---|
| **不写脚本** | 只提需求，Agent 负责实现 |
| **要能验证** | 改完要给出"怎么测、看什么" |
| **不要桌面文件** | 备份/临时文件放 `%TEMP%` |
| **成功时不弹窗** | 只在失败时提示（用户嫌打断） |
| **别重复成功提示** | 合并/整理类工具成功时静默，结果看画面 |
| **说清楚限制** | 做不到的（如 `alert` 定位）要直说，不要假装能 |
| **文档给 Agent 看** | 写"配方"和"禁忌"，不要写面向人的教程腔 |
