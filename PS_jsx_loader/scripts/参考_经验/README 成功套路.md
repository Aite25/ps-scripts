# 成功套路集 —— PS/AE 自动化（本项目实测可用）

> 本文只写**能用**的做法（配方）。
> **不成功的尝试、报错原文、为什么不行**，见 `参考_多选与选区/README 多选与选区.md`。
>
> 环境：Photoshop 2023 (24.x) / After Effects 2024 (24.6) / Windows / CEP 面板。

---

## 一、ExtendScript 基本纪律

### 1.1 ES3 安全

不能用的语法/API：

```js
const / let / 箭头函数 / class / 模板字符串
JSON.*             （改用 $.global 传对象，或自己拼字符串）
[].forEach / map / filter / some / indexOf
"".trim()
```

**原因**：PS/AE 的 ExtendScript 是 ES3 引擎。

**替代**：

```js
for (var i = 0; i < arr.length; i++) { ... }
function contains(a, v) { for (var i=0;i<a.length;i++) if (a[i]===v) return true; return false; }
function trim(s) { return ("" + s).replace(/^\s+|\s+$/g, ""); }
```

### 1.2 文件编码

- **UTF-8 无 BOM**（本项目所有 `.jsx` 都是这个）
- 换行 **CRLF**（和现有脚本一致）
- 中文注释不会被截断

### 1.3 IIFE 隔离

```js
(function () {
    /* 全部逻辑 */
})();
```

### 1.4 `suspendHistory` 的正确用法

```js
/* ★ 第二个参数是【在全局作用域执行的字符串】，
   所以入口必须先挂到 $.global，IIFE 里的函数它看不到。 */
function main() { ... }

try { $.global.PSJSX_HOOK = main; } catch (e) {}
try {
    app.activeDocument.suspendHistory("操作名", "PSJSX_HOOK()");
} catch (e) {
    /* ★ 不要在这里重跑 main()：这可能是 main 内部抛的异常，重跑会把操作做两遍 */
} finally {
    try { delete $.global.PSJSX_HOOK; } catch (e) { $.global.PSJSX_HOOK = null; }
}
```

**`suspendHistory` 不能嵌套** —— 需要"整体一次撤销"时，把真正的工作放在 `doWork()` 里，
让外层只包一层。

### 1.5 顶层 try/catch 必须有

CEP 的 `runScript` 会**静默吞掉**异常 -> 表现为"点了没反应"。

```js
(function () {
    try {
        /* 业务逻辑 */
    } catch (eAll) {
        /* 写日志 + alert，带行号 */
        alert("出错：" + eAll + "\n行号：" + eAll.line);
    }
})();
```

---

## 二、烘焙（烤像素）的可靠做法

### 2.1 用「选择层空对象合并」，**不要栅格化**

```
① 记下目标层的 blendMode / name / visible / grouped
② 选中目标层
③ doc.artLayers.add() 建空层，empty.move(目标, ElementPlacement.PLACEAFTER)   // 放下面
④ 重新选中目标层（③ 之后选区跑到了空层上）
⑤ executeAction(charIDToTypeID("Mrg2"))                                       // 合并向下
⑥ 还原 blendMode / name / visible；原来是剪贴层就 res.grouped = true
```

**不要还原 `opacity` / `fillOpacity`** —— 合并已经把它们算进像素了，再还原一次等于乘两遍。

**为什么不用 `rasterize()`**：

```js
layer.rasterize(RasterizeType.SHAPELAYER)   // 对"纯色填充层"在这台 PS 上直接失败
layer.rasterize(RasterizeType.FILLCONTENT)  // 兜底会得到"整幅纯色 + 保留矢量蒙版"
```

**教训**：兜底链不要随便往下掉 —— 掉到 `FILLCONTENT` 是"看似成功但结果错"。

**文件夹（LayerSet）没有 `.rasterize()`** —— 组上的矢量蒙版只能统计、不能处理。

### 2.2 判断"是不是矢量蒙版"要小心

形状/填充/文字图层**天生带一条矢量路径**，描述符里 `hasVectorMask` 也是 true，
**但那只是"定义形状的路径"，不是蒙版**。

**只有非形状类层**才可能是"真的矢量蒙版"。

### 2.3 用 id 集合校验合并结果

```js
var before = layerIdSet();                 // 合并前所有层 id
executeAction(cid("Mrg2"), ...);
var after = layerIdSet();
/* 消失的层数 == 预期（参与合并的层数 - 1） */
```

比"看图层数量"可靠（层数相同但合错了也能发现）。

---

## 三、图层关系与属性

### 3.1 `itemIndex` 越大越靠上

同父级里：`itemIndex` 小的在**下面**，大的在**上面**。

→ **"最下面那层"= `itemIndex` 最小**（本方所有"找基底"的地方都用这个）。

### 3.2 `itemIndex` 只在父级内有意义

**不要在整棵文档树里按 `itemIndex` 查找** —— 不同文件夹会撞号，取回别处的层。

**✔ 正确**：多选时选中的层同属一个父级 →

```js
var par = doc.activeLayer.parent;
for (var i = 0; i < par.layers.length; i++) {
    if (par.layers[i].itemIndex === idx) return par.layers[i];
}
```

### 3.3 `grouped` = 剪贴关系

```js
L.grouped === true     // 剪贴到【下面那层】
L.grouped === false    // 应用层 / 基底
```

**分组**：按 `itemIndex` 降序（上→下）扫，遇到 `grouped === false` 就收一组。

### 3.4 图层对象会失效 —— 用 id 快照

合并/删除图层后，之前收集的图层对象会变成悬空引用
（读 `.name` 得到 `"?"`，调用方法报「命令不可用」）。

**配方**：

```js
/* ① 先转纯数据 */
items[i].id      = L.id;                 // 数字，稳定
items[i].name    = "" + L.name;           // 字符串快照
items[i].grouped = (L.grouped === true);

/* ② 每步按 id 现查 */
function findById(root, id) {
    for (var i = 0; i < root.layers.length; i++) {
        var L = root.layers[i];
        if (L.id === id) return L;
        if (L.typename === "LayerSet") { var R = findById(L, id); if (R) return R; }
    }
    return null;
}
```

### 3.5 读选区

```js
var ref = new ActionReference();
ref.putProperty(stringIDToTypeID("property"), stringIDToTypeID("targetLayers"));
ref.putEnumerated(stringIDToTypeID("document"), stringIDToTypeID("ordinal"), stringIDToTypeID("targetEnum"));
var desc = executeActionGet(ref);
if (!desc.hasKey(stringIDToTypeID("targetLayers"))) return [];

var lst = desc.getList(stringIDToTypeID("targetLayers"));
var count = lst.count;                              // ← 真实选中层数（可用来做自检）
var idx   = lst.getReference(i).getIndex() + 1;     // ← 父级内序号（1 开始）
```

**`getIdentifier()` 在这里返回 -1，不能用。**

---

## 四、合并（`Mrg2`）的三种正确用法

| 场景 | 做法 |
|---|---|
| **人手已选 ≥2 层** | `executeAction(cid("Mrg2"), new ActionDescriptor(), DialogModes.NO)` | 
| **合并一个文件夹（合并组）** | 选中该 `LayerSet` 后同上；或 `layerSet.merge()` |
| **逐层合并向下** | ✗ 不要用 `ArtLayer.merge()`（会吞掉无关层） |

### 4.1 智能对象：关 `app.displayDialogs`

```js
var prev = app.displayDialogs;
app.displayDialogs = DialogModes.NO;      // ★ 不是 executeAction 的第三个参数
try {
    executeAction(cid("Mrg2"), new ActionDescriptor(), DialogModes.NO);
} finally {
    if (prev !== null) app.displayDialogs = prev;
}
```

否则智能对象会弹"栅格化确认框" -> 脚本里无人点 -> `用户取消了操作`。

### 4.2 合并后还原名字与混合模式

```js
var baseName  = base.name;        // 合并【前】取
var baseBlend = base.blendMode;   // 合并【前】取

/* 合并... */

res.name = baseName;
if (baseBlend === BlendMode.PASSTHROUGH) {
    res.blendMode = BlendMode.NORMAL;    // ★ 穿透只能用于图层组，普通层只能是正常
} else {
    res.blendMode = baseBlend;
}
```

---

## 五、AE 端（ae_lib 引擎）要点

### 5.1 定位合成/图层：**纯按名字**

```js
folder.item(i).name === name
```

**推论**：**多个 PSD 同时导入会串**（同名图层组 → 重名合成）。

**✔ 正确做法**：**导入一个 → 立刻应用 → 再下一个**（串行）。

### 5.2 图层样式：读 `enabled` 判断眼睛

PS 描述符里每个图层样式子项都有 `enabled`（眼睛/勾选）和 `present`（是否在样式列表里）。

→ AE 端遇到 `enabled === false` 的效果要**跳过**（PS 里关了就不该在 AE 里出现）。

### 5.3 AE 设置图层效果的两种手段

- 菜单命令 ID（实测：`Effects.addProperty("ADBE Drop Shadow")` 之类）
- **投影**可以用 `Effects.addProperty("ADBE Drop Shadow")` + `distance = 0` 模拟发光

### 5.4 批量调用的静默模式

引擎加一个 `$.global.AE_HANDOFF_QUIET` 开关：

```js
if (!($.global.AE_HANDOFF_QUIET)) { alert(msg); }        // 结尾汇总
if ($.global.AE_HANDOFF_QUIET) { /* 主报告改放 %TEMP% */ }  // 不往桌面堆报告
```

批量脚本在每次调用前设 `true`，结束后恢复。

---

## 六、窗口位置（多显示器）

### 6.1 不做探测，读手册文件

```
%TEMP%\psjsx_screen_manual.txt
内容：left,top,width,height
例：1920,0,1920,1032      （副屏工作区）
```

**为什么不做探测**：vbs/PowerShell 探测会导致 PS 反复闪烁（每次 `.show()` 都重启探测）。
手工写一次这个文件，所有脚本读它即可。

### 6.2 三层位置，互不遮挡

| 窗口类型 | 位置 |
|---|---|
| 外层运行器（ps 00 / ps 00_single 的进度条） | 屏幕**上 1/3**，横向居中 |
| 批处理里的子步骤进度条 | 屏幕**下 1/3**，横向居中 |
| **独立工具**（不在批量流程里的脚本） | **靠右偏上** |

```js
function PSJSX_placeWindow(w, isRunner, isStandalone) {
    var s = PSJSX_targetScreen();          // 读手册文件
    if (!s) return false;                  // 拿不到就按系统默认

    var ww = 0, hh = 0;
    try { var b = w.bounds; ww = b[2]-b[0]; hh = b[3]-b[1]; } catch (e) {}

    var x = s.l + Math.round((s.w - ww) / 2);
    var y;
    if (isStandalone === true) {
        x = s.l + s.w - ww - 24;                       /* 靠右 */
        y = s.t + 24;
    } else if ($.global.PSJSX_BATCH === true && isRunner !== true) {
        y = s.t + Math.round((s.h - hh) * 2 / 3);      /* 下 1/3 */
    } else {
        y = s.t + Math.round((s.h - hh) / 3);          /* 上 1/3 */
    }
    try { w.location = [x, y]; } catch (e) { return false; }
    return true;
}
```

**注意**：`alert()` / `confirm()` 是**系统对话框，位置改不了**（只能在主屏）。
要定位就得用 `new Window("dialog")` 自绘。

### 6.3 共享文件的加载（跨文件夹）

脚本在 `处理所有图层\`，共享文件在 `批量流程\`：

```js
function placeWindowOnHostScreen(w, isStandalone) {
    if (typeof $.global.PSJSX_placeWindow !== "function") {
        var here = File("" + $.fileName);
        if (!here.exists) here = File(decodeURI("" + $.fileName));   // 中文路径要解码
        var p = here.parent.parent.fsName + "/批量流程/_共享 窗口位置.jsx";
        var f = File(p);
        if (f.exists) { try { $.evalFile(f); } catch (e) {} }
    }
    if (typeof $.global.PSJSX_placeWindow === "function") {
        return $.global.PSJSX_placeWindow(w, false, isStandalone === true);
    }
    return false;
}
```

---

## 七、进度条（ScriptUI palette）

### 7.1 不写 `preferredSize`

```js
var w = new Window("palette", "标题");
w.orientation = "column";
var bar = w.add("progressbar", undefined, 0, 100);
bar.preferredSize.width = 400;      // ★ 只给宽度，别给高度/整体尺寸
var txt = w.add("statictext", undefined, "准备中…");
w.show();
```

### 7.2 批处理模式下把进度条藏起来

子步骤在批处理里跑时，自己**不要弹进度条**（外层已经有一个了），
改用 `$.global.PSJSX_BATCH` 判断：

```js
function batchOn() { try { return ($.global.PSJSX_BATCH === true); } catch (e) { return false; } }
```

---

## 八、步骤成败的显式上报

`$.evalFile` 只在**抛异常**时报错，但步骤脚本通常自己 `try/catch` 掉了异常
→ 外层无法判断成败。

**配方**：启动成功先写 `OK`，出错再覆盖成 `FAIL|原因`：

```js
var f = File(Folder.temp.fsName + "/psjsx_step_result.txt");
f.encoding = "UTF-8";
if (f.open("w")) { try { f.write("OK"); } finally { try { f.close(); } catch (c) {} } }
```

---

## 九、CEP 面板（`index.html`）

### 9.1 面板重载：**不要用 `location` 导航**

```js
/* ✗ 白屏元凶：给 file:// 拼 query，CEP 打不开页面 -> 空白，连按钮都没了 */
location.href = base + "?r=" + Date.now();
```

**✔ 就地重建**（安全）：

```js
function reloadPanelForReal() {
    hideIndicator();
    resetAllPreviewState();     // 把"预览状态缓存"也清掉，否则重画时会被守卫挡住
    loadButtons();              // 内部会清容器、清残留、必要时重装监听
}
```

**真要加载改过的 `index.html`** → 点面板上的 **♻ 热重载**（见 9.2）；
它失效时才需要关掉面板再打开（窗口 > 扩展功能）。

### 9.2 热重载（从磁盘重读 HTML 的样式和脚本，不导航不白屏）

```js
var raw = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

/* 抠 <style> 和 内联 <script>（跳过带 src 的） */
var reStyle  = /<style[^>]*>([\s\S]*?)<\/style>/gi;
var reScript = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

/* 1) 先克隆替换工具栏按钮，摘掉旧监听（否则重跑脚本会重复绑定） */
/* 2) 删掉所有 <style>，把新的插进 <head> */
/* 3) 清空列表容器 */
/* 4) 注入新的内联 <script> —— 它最后一行是 loadButtons()，列表会自己重建 */
var sc = document.createElement("script");
sc.textContent = jsCode;
document.body.appendChild(sc);
```

**面板没有 CSP** -> 注入 `<script>` 可用，不需要 `eval`。

### 9.3 滚动条永远预留位置

展开文件夹时内容变高 -> 滚动条才出现 -> 挤掉 10px -> 行宽在"展开那一刻"变化。

```css
html {
    overflow-x: hidden;
    overflow-y: scroll;          /* ★ 不管内容多高，滚动条位置一直占着 */
    scrollbar-gutter: stable;    /* 新引擎等价写法，双保险 */
}
```

### 9.4 脚本执行中提示

```js
btn.addEventListener("click", function () {
    if (row.classList.contains("running")) return;      // 防重复点击
    row.classList.add("running");
    cs.evalScript('runScript("' + fullPath + '")', function (res) {
        /* ★ evalScript 的回调在 PS 侧跑完时才触发（脚本弹模态窗则等窗关掉） */
        if (("" + res) === "EvalScript error.") { /* 闪红 */ }
        row.classList.remove("running");
    });
});
```

CSS 用动画做脉冲：

```css
@keyframes psjsxRunningPulse {
    0%   { background: #1f4e8a; }
    50%  { background: #3a86dc; }
    100% { background: #1f4e8a; }
}
.btn-row.running .ps-btn { animation: psjsxRunningPulse 1.1s ease-in-out infinite; }
```

### 9.5 拖拽落点预览：三个必守规则

**① 蓝框要插进锚点自己的父节点**

```js
/* ✗ 错：脚本行不是 #btn-container 的直接子节点（在 .folder-sec > .sec-body 里） */
container.insertBefore(indicator, row);      // 抛 NotFoundError，被 try/catch 吞掉 -> 完全没有预览

/* ✔ 对 */
anchorEl.parentNode.insertBefore(indicator, anchorEl);
```

**② 只在"预览状态变化时"才写 DOM**

`dragover` 频率极高（鼠标一动一次）。每次都删除/重插一个**普通流里的 22px 元素**
-> 整列上下跳 -> 配合强制重排 -> **肉眼可见的闪烁**。

```js
function setPreview(anchorEl, before, mode, folder) {
    var same = (pv.anchor === anchorEl && pv.before === !!before &&
                pv.mode === mode && pv.folder === (folder || ""));
    if (same && indicator.parentNode) return;      // ★ 状态没变：零 DOM 操作
    /* ... 真的移动蓝框 / 高亮 ... */
}
```

**③ 判定不能依赖"会被自己推动的布局"**

蓝框插入会推走内容 26px -> "光标下面到底是哪一行/哪个文件夹"每帧都在变
-> 目标在相邻两块之间反复横跳 -> 疯狂闪烁。

**✔ 配方：拖拽开始时冻结几何，判定只用"光标位置 + 冻结坐标"**

```js
REORDER.freezeGeo = function () {
    var st = scrollTopNow();                       // 用内容坐标，滚动也不失效
    list = 每个 .folder-sec 的 { el, top: r.top+st, bottom: r.bottom+st, mid: ... };
};
REORDER.folderAtY = function (clientY) {
    var y = clientY + scrollTopNow();
    for (...) if (y >= f.top && y < f.bottom) return f;
};
```

**④ 判定要放在容器级，并覆盖"没有 handler 的地方"**

文件夹标题行和第一条脚本之间的**空隙**没有任何 handler ->
光标在那儿预览不更新 -> 边界来回压就闪。

✔ 统一在**容器级** `dragover` 里用冻结几何判定（标题行 / 空隙 / 脚本行同一套规则）。

**⑤ 判定和落点必须用同一套数据**

预览用冻结几何、drop 却用实时 `getBoundingClientRect()` -> "蓝框在上面、松手落下面"。

### 9.6 拖拽排序：跨文件夹要拒绝

面板只改**显示顺序**（`localStorage`），**不会挪磁盘文件** ->
"把文件夹里的脚本拖到别的文件夹"下一次重绘就会归位（看起来像没反应）。

**✔ 配方**：同文件夹内按行上下半区重排；跨文件夹直接不给预览、松手不动。

### 9.7 命令行的落点：`REORDER` 状态缓存要复位

清掉预览时，把 `setPreview` 的"上一次状态"也复位，否则重建后第一次预览会被守卫挡住：

```js
if (indicator.parentNode) indicator.parentNode.removeChild(indicator);
pv.anchor = null; pv.mode = ""; pv.folder = "";
```

---

## 十、调试方法论

1. **启动探针**：脚本一进来就往 `%TEMP%\xxx_probe.txt` 写一行
   - 没有文件 -> 脚本没跑起来（面板/路径问题）
   - 有 START 没后续 -> 在探针之后立即出错
   - 有 START + 业务步骤 -> 正常
2. **顶层 try/catch + 行号**：CEP 会吞异常，必须自己 `alert` 出来
3. **日志写全**：输入（选区内容）、中间状态（每组成员）、每步结果、异常行号
4. **先验证假设，再实现**
   - 本项目的最大教训：我一直"以为"`slct` 选上了 2 层，
     实测（加了 `targetLayers.count` 自检）才发现一直是 1 层，
     后面所有失败都源于这个没验证的假设
5. **看不到的现象就用"读回"验证**
   - 选区是否真的多选 -> 读 `targetLayers.count`
   - 合并是否真的发生 -> 比对合并前后的图层 id 集合
   - 设置是否生效 -> 设完立刻读回

---

## 十一、文件与目录约定

```
scripts\
├── 批量流程\            流水线（ps 00 / ps 00_single / ps 01~07 / ae 08 / ae 09 / 引擎 / 共享 / .bat）
├── 处理所有图层\         独立工具（作用于全文档）
├── 处理选中图层\         独立工具（作用于选区）
├── 诊断\               一次性排查脚本（可随时删）
└── 参考_多选与选区\      结论文档 + 可执行测试
```

**`listScripts` 的规则**：目录被当作文件夹分组，`.jsx` 直接被列出；
脚本在哪个目录，面板就显示在哪个分组里。
