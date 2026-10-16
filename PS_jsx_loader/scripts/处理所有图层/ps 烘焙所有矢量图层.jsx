#target photoshop
/* ==========================================================================
 * ps 烘焙所有矢量图层
 * --------------------------------------------------------------------------
 * 【独立工具，不属于批量流程】
 *
 * 把文档里所有"矢量"内容烤成像素，方便交给 After Effects 或后续流程：
 *   ① 形状 / 填充图层（纯色 · 渐变 · 图案）
 *   ② 文字图层（默认【关】：不可逆，之后改不了字）
 *   ③ 普通图层上的【真矢量蒙版】（非形状类层才有"真矢量蒙版"）
 *   ④ 文件夹自己的矢量蒙版 —— 空对象合并【不支持组】，只统计不处理
 *
 * ★★ 烘焙方式：用「选择层空对象合并」的办法（★ 不用栅格化 ★）★★
 *   在图层下面新建一个空层 → 合并向下（Mrg2）→ 还原混合模式 / 名字 / 可见性。
 *   填充、矢量蒙版、图层样式、智能滤镜、文字全部烤成像素，而且【外观不变】。
 *
 *   ★ 为什么弃用栅格化（实测踩过的坑）★
 *     这台 PS 上 rasterize(RasterizeType.SHAPELAYER) 对"纯色填充层"全部失败，
 *     于是走到兜底 rasterize(FILLCONTENT)（填充内容）—— 而"填充内容"只把填充变成
 *     像素、【矢量蒙版原封不动留着】 -> 结果变成"整幅画布纯色 + 矢量蒙版"，
 *     看起来就是"黑色填充 + 遮罩"，画面大变（差值最深 90/255、非零像素 372 万）。
 *     教训：兜底链不能随便往下掉 —— 掉到 FILLCONTENT 会得到"看似成功但结果错"的状态。
 *
 * ★★ 另一个必须知道的坑（ps 05 实测踩过）★★
 *   形状 / 填充 / 文字图层【天生就带一条矢量路径】，PS 在描述符里会报
 *   hasVectorMask = true。但那只是"定义这个形状的那条路径"，【不是蒙版】！
 *   所以：形状类层算 ①/②，【只有非形状类层】才算 ③。
 *   （用空对象合并时这个区分只影响"算哪一类"，不影响正确性 —— 三类都是同一套合并操作。）
 *
 * 用法：直接跑。开头弹窗选烘焙范围（会显示各类图层各有几个）；
 *       跑的过程有进度条；可选"建差值对比层"用来确认画面没变
 *       （跑完把差值层点亮读一次直方图，纯黑 = 一个像素都没变，再自动关灯）。
 * 日志：<文档所在目录>\_日志\<文档名>_烘焙矢量日志.txt
 * ========================================================================== */

(function () {

/* ==========================================================================
 * 选项
 * ========================================================================== */
var OPTIONS = {
    bakeShapes: true,        // 形状 / 填充图层
    bakeText: false,         // 文字图层（默认关：不可逆）
    bakeVectorMask: true,    // 普通图层上的真矢量蒙版
    bakeGroupVecMask: false, // 文件夹自己的矢量蒙版（默认关）
    includeNested: true,     // 包含嵌套在文件夹里的图层
    skipHidden: false,       // 跳过隐藏图层
    makeDiffLayer: true      // 建差值对比层
};

var PREF_NAME = "ps_烘焙所有矢量图层_选项.txt";

/* ==========================================================================
 * 全局状态
 * ========================================================================== */
var DOC = null;
var R = {
    shapes: 0, texts: 0, vmasks: 0, gvmasks: 0,   /* 扫描到的数量 */
    bakedShapes: 0, bakedTexts: 0, bakedVMasks: 0, bakedGV: 0,
    failed: [], skipped: [], notes: [],
    diffMade: false, diffWhy: "", diffMax: null
};

var DIFF_NAME = "__对比 烘焙矢量前(差值)";
var LOG_DIR = "_日志";

/* ==========================================================================
 * 小工具
 * ========================================================================== */
function cleanMsg(s) {
    try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 300); } catch (e) { return "" + s; }
}
function nowMs() { return (new Date()).getTime(); }
function cid(k) { try { return charIDToTypeID(k); } catch (e) { return false; } }
function sid(k) { try { return stringIDToTypeID(k); } catch (e) { return false; } }

function getId(L) { try { return L.id; } catch (e) { return -1; } }
function isGroup(L) { try { return (L.typename === "LayerSet"); } catch (e) { return false; } }
function safeName(L) { try { return L.name; } catch (e) { return "?"; } }
function isVisible(L) { try { return (L.visible !== false); } catch (e) { return true; } }
function kindOf(L) { try { return L.kind; } catch (e) { return null; } }

/* 递归遍历（含文件夹内部） */
function walk(container, fn) {
    var arr = null;
    try { arr = container.layers; } catch (e) { return; }
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
        fn(arr[i]);
        if (isGroup(arr[i])) walk(arr[i], fn);
    }
}
function byId(id) {
    var f = null;
    walk(DOC, function (L) { if (!f && getId(L) === id) f = L; });
    return f;
}

/* ---- 描述符 ---- */
function descOf(L) {
    try {
        var r = new ActionReference();
        r.putIdentifier(cid("Lyr "), getId(L));
        return executeActionGet(r);
    } catch (e) { return null; }
}
function keyTrue(d, k) {
    try {
        if (!d) return false;
        var sk = sid(k);
        if (sk === false || !d.hasKey(sk)) return false;
        return (d.getBoolean(sk) === true);
    } catch (e) { return false; }
}
function keyExists(d, k) {
    try {
        if (!d) return false;
        var sk = sid(k);
        if (sk === false) return false;
        return d.hasKey(sk);
    } catch (e) { return false; }
}
function hasTopKey(d, k) {
    try {
        if (!d) return false;
        var sk = sid(k);
        if (sk === false) return false;
        return d.hasKey(sk);
    } catch (e) { return false; }
}

/* ---- 是不是"形状类"图层（形状/填充/文字）----
 * ★ 这些层天生带矢量路径，但那不是蒙版。 */
function isShapeLikeLayer(L) {
    var k = kindOf(L);
    if (k === null) return false;
    if (k === LayerKind.SOLIDFILL) return true;
    if (k === LayerKind.GRADIENTFILL) return true;
    if (k === LayerKind.PATTERNFILL) return true;
    if (k === LayerKind.TEXT) return true;
    return false;
}
function isTextLayer(L) {
    try { return (L.kind === LayerKind.TEXT); } catch (e) { return false; }
}
function kindLabel(L) {
    var k = kindOf(L);
    if (k === LayerKind.SOLIDFILL) return "纯色填充/形状";
    if (k === LayerKind.GRADIENTFILL) return "渐变填充";
    if (k === LayerKind.PATTERNFILL) return "图案填充";
    if (k === LayerKind.TEXT) return "文字";
    if (k === LayerKind.SMARTOBJECT) return "智能对象";
    return "普通图层";
}

/* ---- 有没有【真】矢量蒙版（排除形状类层天生的那条路径）---- */
function hasVectorMask(L) {
    var d = descOf(L);
    if (!d) return false;
    if (keyTrue(d, "hasVectorMask")) return true;
    if (keyExists(d, "hasVectorMask")) return false;
    return hasTopKey(d, "vmsk");
}

/* ---- 选中某个图层（ActionManager，不依赖 DOM 的 activeLayer）---- */
function selectById(id) {
    try {
        var d = new ActionDescriptor();
        var r = new ActionReference();
        r.putIdentifier(cid("Lyr "), id);
        d.putReference(cid("null"), r);
        d.putBoolean(cid("MkVs"), false);
        executeAction(cid("slct"), d, DialogModes.NO);
        return true;
    } catch (e) { return false; }
}

/* ---- 路径字符串 ---- */
function pathOf(L) {
    var parts = [], cur = L;
    var guard = 0;
    while (cur && guard < 60) {
        guard++;
        try {
            if (cur.parent === DOC) break;
            parts.unshift(safeName(cur));
            cur = cur.parent;
        } catch (e) { break; }
    }
    return parts.join(" / ");
}

/* ==========================================================================
 * 扫描：找出所有需要烘焙的图层
 * ========================================================================== */
function scanDoc() {
    var res = { shapes: [], texts: [], vmasks: [], gvmasks: [] };
    (function rec(container, depth) {
        if (depth > 40) return;
        var arr = null;
        try { arr = container.layers; } catch (e) { return; }
        if (!arr) return;
        for (var i = 0; i < arr.length; i++) {
            var L = arr[i];
            var nm = safeName(L);
            /* 跳过本脚本/其它脚本生成的对比层 */
            if (nm.length >= 4 && nm.substring(0, 4) === "__对比") continue;
            if (nm.length >= 6 && nm.substring(0, 6) === "__AE_") continue;

            if (isGroup(L)) {
                /* 文件夹自己的矢量蒙版（默认不处理） */
                if (hasVectorMask(L)) {
                    res.gvmasks.push({ id: getId(L), name: nm, path: pathOf(L), visible: isVisible(L) });
                }
                rec(L, depth + 1);
                continue;
            }

            /* ---- 非文件夹层 ---- */
            var shapeLike = isShapeLikeLayer(L);
            var isText = isTextLayer(L);

            if (isText) {
                res.texts.push({ id: getId(L), name: nm, path: pathOf(L), visible: isVisible(L) });
            } else if (shapeLike) {
                res.shapes.push({ id: getId(L), name: nm, path: pathOf(L), visible: isVisible(L), kind: kindLabel(L) });
            } else if (hasVectorMask(L)) {
                /* ★ 只有【非形状类】层才可能是"真矢量蒙版" */
                res.vmasks.push({ id: getId(L), name: nm, path: pathOf(L), visible: isVisible(L) });
            }
        }
    })(DOC, 0);
    return res;
}

/* ==========================================================================
 * 烘焙一个图层：用「选择层空对象合并」的办法（★ 不用栅格化 ★）
 * --------------------------------------------------------------------------
 * 为什么弃用栅格化（实测踩过的坑，16:13 那次运行的日志）：
 *   这台 PS 上 rasterize(RasterizeType.SHAPELAYER) 对"纯色填充层"【全部失败】，
 *   于是走到兜底 rasterize(FILLCONTENT)（填充内容）—— 而"填充内容"只把填充变成
 *   像素、【矢量蒙版原封不动留着】 -> 结果变成"整幅画布纯色 + 矢量蒙版"，
 *   看起来就是"黑色填充 + 遮罩"，画面大变（差值最深 90/255，非零像素 372 万）。
 *   ★ 教训：兜底链不能随便往下掉 —— 掉到 FILLCONTENT 会得到"看似成功但结果错"的状态。
 *
 * 空对象合并的做法（与「ps 选择层空对象合并.jsx」一致）：
 *   ① 记下原图层的 混合模式 / 名字 / 可见性
 *   ② 选中它
 *   ③ 新建一个空图层，移到它【下面】
 *   ④ ★ 重新选中目标层（建完空层后活动图层是空层，不重选会合错层）
 *   ⑤ 合并向下（Mrg2）—— 填充 / 矢量蒙版 / 图层样式 / 智能滤镜 / 文字 全部烤成像素
 *   ⑥ 把 混合模式 / 名字 / 可见性 还回去
 * 它把整层外观烤成像素、而且【外观不变】—— 正是我们要的。
 * ========================================================================== */
function bakeByEmptyMerge(L) {
    var id = getId(L);
    var nm = safeName(L);
    var blend = null, vis = true, wasClipped = false;
    try { blend = L.blendMode; } catch (eB0) {}
    try { vis = (L.visible !== false); } catch (eV0) {}
    try { wasClipped = (L.grouped === true); } catch (eG0) {}

    if (!selectById(id)) throw new Error("选不中图层");

    var empty = null;
    try { empty = DOC.artLayers.add(); }
    catch (eA) { throw new Error("新建空图层失败：" + cleanMsg("" + eA)); }
    var emptyId = getId(empty);

    try { empty.move(L, ElementPlacement.PLACEAFTER); }
    catch (eM) {
        try { empty.remove(); } catch (eM2) {}
        throw new Error("把空层移到它下面失败：" + cleanMsg("" + eM));
    }

    /* ★ 关键：建完空层后活动图层是空层，合并前必须重新选中目标层 */
    if (!selectById(id)) throw new Error("重新选中目标层失败");

    var idsBefore = layerIdSet();
    var countBefore = countLayers(DOC);
    mergeDown();
    var countAfter = countLayers(DOC);

    var merged = null;
    try { merged = DOC.activeLayer; } catch (eL) {}
    if (!merged) throw new Error("合并后拿不到结果图层");

    /* 校验：只允许"我自己建的那个空层"消失，别的图层一个都不许少 */
    var warn = "";
    var lost = idsLostExcept(idsBefore, emptyId);
    if (lost.length > 0) warn = "★ 合并时少了 " + lost.length + " 个不该少的图层：" + lost.slice(0, 3).join(" / ");

    /* 还原（名字不还原就会被叫成"图层 N"；混合模式不还原外观会变） */
    if (blend !== null) { try { merged.blendMode = blend; } catch (eB1) {} }
    try { merged.name = nm; } catch (eN) {}
    try { merged.visible = vis; } catch (eV1) {}

    /* ★ 剪贴蒙版：新建的空层默认 grouped=false，合并会把"剪贴到下面图层"的关系弄丢，
       原来剪贴的就补回来（ps 07 那边验证过：写回 grouped=true 是有效的）。 */
    if (wasClipped) {
        var nowClip = false;
        try { nowClip = (merged.grouped === true); } catch (eG2) {}
        if (!nowClip) {
            try { merged.grouped = true; } catch (eG3) {}
            var okClip = false;
            try { okClip = (merged.grouped === true); } catch (eG4) {}
            if (!okClip) warn += (warn ? "；" : "") + "★ 原来是剪贴蒙版，合并后没能恢复剪贴状态（外观可能变）";
        }
    }

    return { id: getId(merged), warn: warn, countDelta: (countBefore - countAfter) };
}

/* ---- 空对象合并要用的小工具（与 ps 03 一致）---- */
function mergeDown() {
    executeAction(cid("Mrg2"), new ActionDescriptor(), DialogModes.NO);
}
function countLayers(container) {
    var n = 0;
    walk(container, function () { n++; });
    return n;
}
function layerIdSet() {
    var map = {};
    walk(DOC, function (L) { var id = getId(L); if (id >= 0) map[id] = safeName(L); });
    return map;
}
function idsLostExcept(before, emptyId) {
    var after = layerIdSet();
    var lost = [];
    for (var id in before) {
        if (parseInt(id, 10) === emptyId) continue;      /* 自己建的空层消失是正常的 */
        if (!after[id]) lost.push(before[id]);
    }
    return lost;
}

/* ==========================================================================
 * 建差值对比层（画面有没有变）
 *   suspendHistory 不能嵌套 → makeDiff 必须在主流程那个 suspendHistory 之外调用
 * ========================================================================== */
function makeDiff() {
    try {
        try { $.global.PSJSX_DIFF = makeDiffBody; } catch (eG) {}
        if (typeof $.global.PSJSX_DIFF !== "function") { makeDiffBody(); return; }
        DOC.suspendHistory("烘焙矢量 建对比层", "diffHook()");
    } catch (eH) {
        makeDiffBody();
    }
}
function diffHook() {
    try { return $.global.PSJSX_DIFF(); } catch (e) { return null; }
}
function clearOldDiff() {
    var guard = 0;
    try {
        var L = findByName(DOC, DIFF_NAME);
        while (L && guard < 20) { try { L.remove(); } catch (e) {} L = findByName(DOC, DIFF_NAME); guard++; }
    } catch (e2) {}
}
function findByName(container, name) {
    var hit = null;
    walk(container, function (L) { if (!hit && safeName(L) === name) hit = L; });
    return hit;
}
function selectTopVisible() {
    try {
        var r = new ActionReference();
        var d = new ActionDescriptor();
        r.putEnumerated(cid("Lyr "), cid("Ordn"), cid("Trgt"));
        d.putReference(cid("null"), r);
        executeAction(cid("slct"), d, DialogModes.NO);
        return true;
    } catch (e) { return false; }
}
function stampVisible() {
    try {
        var d = new ActionDescriptor();
        d.putBoolean(cid("Dplc"), true);
        executeAction(cid("MrgV"), d, DialogModes.NO);
        return true;
    } catch (e1) {}
    try {
        DOC.selection.selectAll();
        var evC = sid("copyMerged");
        if (evC === false) return false;
        executeAction(evC, new ActionDescriptor(), DialogModes.NO);
        var evP = sid("paste");
        if (evP === false) return false;
        var d2 = new ActionDescriptor();
        var kIn = sid("inPlace");
        if (kIn !== false) d2.putBoolean(kIn, true);
        executeAction(evP, d2, DialogModes.NO);
        try { DOC.selection.deselect(); } catch (eD) {}
        return true;
    } catch (e2) { return false; }
}
function makeDiffBody() {
    try {
        clearOldDiff();
        selectTopVisible();
        if (!stampVisible()) throw new Error("盖印失败（MrgV 与备用方式都不行）");

        var made = DOC.activeLayer;
        try { made.name = DIFF_NAME; } catch (eN) {}
        try {
            var top = DOC.layers[0];
            if (getId(top) !== getId(made)) made.move(top, ElementPlacement.PLACEBEFORE);
        } catch (eM) {}
        made = byId(getId(made)) || made;
        if (made.parent !== DOC) throw new Error("对比层没能移到文档最顶层");

        try { made.blendMode = BlendMode.DIFFERENCE; }
        catch (eB) { try { made.remove(); } catch (eB2) {} throw new Error("设差值失败"); }

        /* 建完立刻关灯（差值层可见时整个画面会变样；想看时手动点开） */
        try { made.visible = false; } catch (eVis) {}
        R.diffMade = true;
    } catch (e) {
        R.diffWhy = cleanMsg("" + e);
    }
}

/* 把差值层点亮 → 读直方图 → 再关掉。纯黑(0) = 一个像素都没变 */
function measureDiff() {
    if (!R.diffMade) return null;
    var L = findByName(DOC, DIFF_NAME);
    if (!L) return null;
    var h = null;
    try { L.visible = true; } catch (eV1) {}
    try { h = DOC.histogram; } catch (eH) { h = null; }
    try { L.visible = false; } catch (eV2) {}
    if (!h) return null;
    var maxIdx = 0, nonZero = 0;
    for (var i = 1; i < h.length; i++) { if (h[i] > 0) { nonZero += h[i]; maxIdx = i; } }
    return { maxIdx: maxIdx, nonZero: nonZero };
}

/* ==========================================================================
 * 进度条
 * ========================================================================== */
var PB = { win: null, bar: null, txt: null };
function pbOpen(total, title) {
    try {
        PB.win = new Window("palette", title);
        PB.win.orientation = "column";
        PB.win.alignChildren = "fill";
        PB.txt = PB.win.add("statictext", undefined, "准备中…");
        PB.bar = PB.win.add("progressbar", undefined, 0, (total > 0 ? total : 1));
        try { PB.bar.preferredSize.width = 360; } catch (e1) {}
        try { PB.win.preferredSize.width = 400; } catch (e2) {}
        PB.win.show();
    } catch (e) { PB.win = null; }
}
function pbStep(s) {
    if (!PB.win) return;
    try { PB.txt.text = s; PB.bar.value = PB.bar.value + 1; } catch (e) {}
}
function pbClose() {
    try { if (PB.win) PB.win.close(); } catch (e) {}
    PB.win = null;
}

/* ==========================================================================
 * 日志
 * ========================================================================== */
/* ★★ 日志每行即时落盘 ★★
   踩过的坑（ae08 那边）：先攒在内存、最后一次性写 -> 中途崩溃就什么都留不下；
   而且 close() 不放 finally 会泄漏句柄、把文件一直占住。
   所以这里：每写一行就"打开(追加) -> 写 -> 关闭"，立刻落盘、句柄立刻释放。 */
var LOG = { lines: [], path: "" };
function logAppend(line) {
    if (!LOG.path) return;
    var f = null;
    try {
        f = File(LOG.path);
        f.encoding = "UTF-8";
        if (!f.open("a")) return;
        try { f.write(line + "\r\n"); } catch (eW) {} finally { try { f.close(); } catch (eC) {} }
    } catch (e) { try { if (f) f.close(); } catch (e2) {} }
}
function plog(s) {
    var line = "[" + (new Date()).toTimeString().substring(0, 8) + "] " + s;
    LOG.lines.push(line);
    logAppend(line);
}
function logOpen() {
    try {
        var base = (DOC.path ? DOC.path.fsName : Folder.temp.fsName);
        var dir = Folder(base + "/" + LOG_DIR);
        if (!dir.exists) dir.create();
        var fname = ("" + DOC.name).replace(/\.[^.]+$/, "") + "_烘焙矢量日志.txt";
        LOG.path = dir.fsName + "/" + fname;
        var f = File(LOG.path);
        f.encoding = "UTF-8";
        if (f.open("w")) { try { f.write(""); } catch (eW0) {} finally { try { f.close(); } catch (eC0) {} } }
        else { try { f.close(); } catch (eC1) {} }
    } catch (e) { LOG.path = ""; }
    /* ★ 把 logOpen 之前就已经 plog 过的行补写进去（否则开头几行只留在内存里） */
    for (var i = 0; i < LOG.lines.length; i++) logAppend(LOG.lines[i]);
}
function logClose() { /* 每行都已即时落盘，无需再整体写一次 */ }
function logPath() { return LOG.path ? LOG.path : "(没写出)"; }

/* ==========================================================================
 * 主流程（放进一个 suspendHistory）
 * ========================================================================== */
/* 按选项算出"要处理哪些图层"（进度条在外面开，所以先算好） */
function buildTargets() {
    var targets = [];      /* { id, name, path, what } */

    /* ① 形状 / 填充 */
    if (OPTIONS.bakeShapes) {
        for (var i = 0; i < SCAN.shapes.length; i++) {
            var s = SCAN.shapes[i];
            if (OPTIONS.skipHidden && !s.visible) { R.skipped.push("隐藏：" + s.name); continue; }
            targets.push({ id: s.id, name: s.name, path: s.path, what: "shape" });
        }
    }
    /* ② 文字 */
    if (OPTIONS.bakeText) {
        for (var j = 0; j < SCAN.texts.length; j++) {
            var t = SCAN.texts[j];
            if (OPTIONS.skipHidden && !t.visible) { R.skipped.push("隐藏：" + t.name); continue; }
            targets.push({ id: t.id, name: t.name, path: t.path, what: "text" });
        }
    }
    /* ③ 真矢量蒙版 */
    if (OPTIONS.bakeVectorMask) {
        for (var k = 0; k < SCAN.vmasks.length; k++) {
            var v = SCAN.vmasks[k];
            if (OPTIONS.skipHidden && !v.visible) { R.skipped.push("隐藏：" + v.name); continue; }
            targets.push({ id: v.id, name: v.name, path: v.path, what: "vmask" });
        }
    }
    /* ④ 文件夹自己的矢量蒙版：空对象合并【不支持组】（参考脚本里也是"组不进行处理"），
       所以这一类只统计、不处理，日志和结果里会说明。 */

    return targets;
}

function doWork() {
    var t0 = nowMs();
    var targets = TARGETS;
    if (!targets || targets.length === 0) { R.notes.push("没有需要烘焙的矢量内容"); return; }
    for (var q = 0; q < targets.length; q++) {
        var it = targets[q];
        var label = ("" + (q + 1) + "/" + targets.length + "　" + it.name);
        pbStep(label);

        var L = byId(it.id);
        if (!L) { R.failed.push(it.path + "：找不到图层（id=" + it.id + "）"); plog("✗ " + it.name + "：找不到"); continue; }
        if (!selectById(it.id)) { R.failed.push(it.path + "：选不中"); plog("✗ " + it.name + "：选不中"); continue; }

        var kindBefore = kindLabel(L);          /* 先记下烤之前的类型 */
        var res = null;
        try {
            if (it.what === "shape") { res = bakeByEmptyMerge(L); R.bakedShapes++; }
            else if (it.what === "text") { res = bakeByEmptyMerge(L); R.bakedTexts++; }
            else if (it.what === "vmask") { res = bakeByEmptyMerge(L); R.bakedVMasks++; }
            else throw new Error("未知的处理类型：" + it.what);
        } catch (eR) {
            R.failed.push(it.path + "：" + cleanMsg("" + eR));
            plog("✗ " + it.name + " 失败：" + cleanMsg("" + eR));
            continue;
        }

        /* 校验：合并后的图层应该在、矢量内容应该没了、图层数只少了我建的那个空层 */
        var chk = [];
        if (res && res.warn) chk.push(res.warn);
        if (res && res.countDelta !== 1) chk.push("★ 图层总数变化 " + res.countDelta + "（应该正好少 1：只少了我建的那个空层）");
        var still = res ? byId(res.id) : null;
        if (!still) chk.push("★ 合并后的图层找不到");
        else {
            if (it.what === "shape" && isShapeLikeLayer(still)) chk.push("★ 还是形状类（没烤掉）");
            if (it.what === "vmask" && hasVectorMask(still)) chk.push("★ 矢量蒙版还在");
        }
        plog("✓ " + it.name + "（" + kindBefore + "）→ 空对象合并" +
             (chk.length ? ("　" + chk.join("；")) : ""));
    }
    plog("耗时 " + (Math.round((nowMs() - t0) / 100) / 10) + " 秒");
}

/* suspendHistory 用字符串回调 → 函数必须在全局找得到 */
function hookFn() {
    try { return $.global.PSJSX_HOOK(); } catch (e) { return null; }
}

/* ==========================================================================
 * 收尾：关掉所有脚本生成的对比层眼睛
 * ========================================================================== */
function hideAllDiffs() {
    try {
        walk(DOC, function (L) {
            var nm = safeName(L);
            if (nm.length >= 4 && nm.substring(0, 4) === "__对比") {
                try { L.visible = false; } catch (e) {}
            }
        });
    } catch (e2) {}
}

/* ==========================================================================
 * 选项弹窗（紧凑，保证按钮可见）
 * ========================================================================== */
function askDialog(counts) {
    if (typeof Window === "undefined") return true;
    var w = new Window("dialog", "烘焙所有矢量图层");
    w.orientation = "column";
    w.alignChildren = "fill";

    var g1 = w.add("panel", undefined, "烘焙什么（括号里是扫描到的数量）");
    g1.orientation = "column"; g1.alignChildren = "left"; g1.alignment = "fill";
    var cb1 = gAddCheckbox(g1, "形状 / 填充图层（纯色·渐变·图案）　[" + counts.shapes + " 个]", OPTIONS.bakeShapes);
    var cb2 = gAddCheckbox(g1, "文字图层（不可逆，改不了字了）　[" + counts.texts + " 个]", OPTIONS.bakeText);
    var cb3 = gAddCheckbox(g1, "普通图层上的真矢量蒙版 → 栅格化成图层蒙版　[" + counts.vmasks + " 个]", OPTIONS.bakeVectorMask);
    g1.add("statictext", undefined, "文件夹自己的矢量蒙版　[" + counts.gvmasks + " 个] —— 空对象合并不支持组，跳过");

    var g2 = w.add("panel", undefined, "范围与其它");
    g2.orientation = "column"; g2.alignChildren = "left"; g2.alignment = "fill";
    var g21 = g2.add("group");
    g21.add("statictext", undefined, "文件夹内部一律递归处理　　");
    var cb6 = gAddCheckbox(g21, "跳过隐藏图层", OPTIONS.skipHidden);
    var cb7 = gAddCheckbox(g2, "建差值对比层（跑完自动关灯；用来确认画面没变）", OPTIONS.makeDiffLayer);

    var gB = w.add("group");
    gB.alignment = "right";
    var btnHelp = gB.add("button", undefined, "说明…");
    btnHelp.onClick = function () {
        alert(
            "【这个脚本做什么】\n" +
            "  把文档里的矢量内容烤成像素：\n" +
            "    ① 形状 / 填充图层（纯色·渐变·图案）\n" +
            "    ② 文字图层（不可逆）\n" +
            "    ③ 普通图层上的真矢量蒙版\n" +
            "    ④ 文件夹自己的矢量蒙版 —— 空对象合并不支持组，只统计不处理\n\n" +
            "【怎么烤的：空对象合并，不是栅格化】\n" +
            "  在图层下面新建一个空层 -> 合并向下(Mrg2) -> 还原混合模式/名字/可见性。\n" +
            "  填充、矢量蒙版、图层样式、智能滤镜、文字全部烤成像素，外观不变。\n\n" +
            "  ★ 为什么不用栅格化：实测这台 PS 上 rasterize(SHAPELAYER) 对纯色填充层\n" +
            "    全部失败，兜底走到 FILLCONTENT(填充内容) —— 它只把填充变成像素、\n" +
            "    矢量蒙版原封不动留着，结果变成「整幅画布纯色 + 矢量蒙版」，\n" +
            "    看起来就是黑色填充+遮罩，画面大变（差值最深 90/255）。\n\n" +
            "【为什么要区分「形状类」和「矢量蒙版」】\n" +
            "  形状 / 填充 / 文字图层天生就带一条矢量路径，PS 也会报 hasVectorMask=true，\n" +
            "  但那只是定义形状的那条路径，不是蒙版。所以形状类层算 ①/②，\n" +
            "  只有非形状类层才算 ③。（用合并法时这个区分只影响归类，不影响正确性。）\n\n" +
            "【差值对比层】\n" +
            "  跑之前盖印一张可见图层，叠在最顶上并设成「差值」混合模式、然后关灯。\n" +
            "  跑完脚本会把它点亮读一次直方图：\n" +
            "    纯黑  = 一个像素都没变（最理想）\n" +
            "    个位数 = 只有边缘抗锯齿的细微差异（矢量转像素的正常现象）\n" +
            "  想看差异时手动点开它的眼睛即可。\n\n" +
            "【注意】\n" +
            "  · 不可逆操作 —— 建议先存一份备份，或跑完不一定保存。\n" +
            "  · 日志写在 <文档所在目录>\\_日志\\<文档名>_烘焙矢量日志.txt"
        );
    };
    gB.add("statictext", undefined, "　");
    gB.add("button", undefined, "开始", { name: "ok" });
    gB.add("button", undefined, "取消", { name: "cancel" });

    if (w.show() !== 1) return false;

    OPTIONS.bakeShapes = (cb1.value === true);
    OPTIONS.bakeText = (cb2.value === true);
    OPTIONS.bakeVectorMask = (cb3.value === true);
    OPTIONS.bakeGroupVecMask = false;      /* 空对象合并不支持组，一律不处理 */
    OPTIONS.skipHidden = (cb6.value === true);
    OPTIONS.makeDiffLayer = (cb7.value === true);
    return true;
}
function gAddCheckbox(parent, text, checked) {
    var cb = parent.add("checkbox", undefined, text);
    cb.value = !!checked;
    return cb;
}

/* ==========================================================================
 * 偏好读写
 * ========================================================================== */
function prefFile() {
    try {
        var dir = Folder.userData;
        var sub = Folder(dir.fsName + "/PS_jsx_loader");
        if (!sub.exists) sub.create();
        return File(sub.fsName + "/" + PREF_NAME);
    } catch (e) { return null; }
}
function loadPrefs() {
    try {
        var f = prefFile();
        if (!f || !f.exists) return;
        f.encoding = "UTF-8";
        f.open("r");
        var txt = f.read();
        f.close();
        var lines = ("" + txt).split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var p = lines[i].split("=");
            if (p.length < 2) continue;
            var k = p[0].replace(/^\s+|\s+$/g, "");
            var v = p[1].replace(/^\s+|\s+$/g, "");
            if (k === "bakeShapes") OPTIONS.bakeShapes = (v === "1");
            else if (k === "bakeText") OPTIONS.bakeText = (v === "1");
            else if (k === "bakeVectorMask") OPTIONS.bakeVectorMask = (v === "1");
            else if (k === "bakeGroupVecMask") OPTIONS.bakeGroupVecMask = (v === "1");
            else if (k === "skipHidden") OPTIONS.skipHidden = (v === "1");
            else if (k === "makeDiffLayer") OPTIONS.makeDiffLayer = (v === "1");
        }
    } catch (e) {}
}
function savePrefs() {
    try {
        var f = prefFile();
        if (!f) return;
        f.encoding = "UTF-8";
        f.open("w");
        f.write("bakeShapes=" + (OPTIONS.bakeShapes ? 1 : 0) + "\r\n");
        f.write("bakeText=" + (OPTIONS.bakeText ? 1 : 0) + "\r\n");
        f.write("bakeVectorMask=" + (OPTIONS.bakeVectorMask ? 1 : 0) + "\r\n");
        f.write("bakeGroupVecMask=" + (OPTIONS.bakeGroupVecMask ? 1 : 0) + "\r\n");
        f.write("skipHidden=" + (OPTIONS.skipHidden ? 1 : 0) + "\r\n");
        f.write("makeDiffLayer=" + (OPTIONS.makeDiffLayer ? 1 : 0) + "\r\n");
        f.close();
    } catch (e) {}
}

/* ==========================================================================
 * 结果弹窗
 * ========================================================================== */
function showResult() {
    var msg = "烘焙所有矢量图层 —— 完成\n\n";
    msg += "形状/填充：" + R.bakedShapes + " 个\n";
    msg += "文字：" + R.bakedTexts + " 个\n";
    msg += "矢量蒙版：" + R.bakedVMasks + " 个\n";
    if (OPTIONS.bakeGroupVecMask) msg += "文件夹矢量蒙版：" + R.bakedGV + " 个\n";
    if (R.failed.length) msg += "\n失败 " + R.failed.length + " 个：\n";
    for (var i = 0; i < R.failed.length && i < 8; i++) msg += "  · " + R.failed[i] + "\n";
    if (R.failed.length > 8) msg += "  · …（其余见日志）\n";

    if (R.diffMade) {
        if (R.diffMax === null) msg += "\n差值对比：读不到直方图（对比层已建，可手动点开看）\n";
        else if (R.diffMax === 0) msg += "\n★ 差值对比：纯黑 → 一个像素都没变 ✔\n";
        else msg += "\n★ 差值对比：最深 " + R.diffMax + "/255" +
                    (R.diffMax <= 3 ? "（只有边缘抗锯齿的细微差异，正常）" : "（差异偏大，建议点开对比层看看）") + "\n";
    } else if (R.diffWhy) {
        msg += "\n（没建差值对比层：" + R.diffWhy + "）\n";
    }

    msg += "\n日志：\n" + logPath();
    try { alert(msg); } catch (e) {}
}

/* ==========================================================================
 * 入口
 * ========================================================================== */
var SCAN = null;
var TARGETS = null;
function main() {
    if (app.documents.length === 0) { alert("没有打开的文档。"); return; }
    DOC = app.activeDocument;

    loadPrefs();

    SCAN = scanDoc();
    plog("===== ps 烘焙所有矢量图层 开始 =====");
    plog("文档：" + DOC.name);
    plog("扫描：形状/填充 " + SCAN.shapes.length + " 个；文字 " + SCAN.texts.length +
         " 个；矢量蒙版 " + SCAN.vmasks.length + " 个；文件夹矢量蒙版 " + SCAN.gvmasks.length + " 个");

    var total = SCAN.shapes.length + SCAN.texts.length + SCAN.vmasks.length + SCAN.gvmasks.length;
    if (total === 0) {
        logOpen(); logClose();
        alert("这个文档里没有找到任何矢量内容（形状/填充图层、文字、矢量蒙版）。\n\n日志：\n" + logPath());
        return;
    }

    if (!askDialog({
        shapes: SCAN.shapes.length,
        texts: SCAN.texts.length,
        vmasks: SCAN.vmasks.length,
        gvmasks: SCAN.gvmasks.length
    })) return;
    savePrefs();

    if (!OPTIONS.bakeShapes && !OPTIONS.bakeText && !OPTIONS.bakeVectorMask) {
        alert("一个都没勾，什么都没做。");
        return;
    }

    logOpen();
    plog("选项：形状=" + OPTIONS.bakeShapes + "　文字=" + OPTIONS.bakeText +
         "　矢量蒙版=" + OPTIONS.bakeVectorMask + "　文件夹矢量蒙版=" + OPTIONS.bakeGroupVecMask +
         "　跳过隐藏=" + OPTIONS.skipHidden + "　建对比层=" + OPTIONS.makeDiffLayer);

    /* ★ 先按选项算出待处理清单；进度条必须在 suspendHistory【之外】开
       （沿用 ps 04 / ps 05 的做法：pbOpen 在 suspendHistory 之前） */
    TARGETS = buildTargets();
    plog("待处理 " + TARGETS.length + " 个图层");
    if (TARGETS.length === 0) R.notes.push("按当前勾选没有需要烘焙的内容");

    /* ★ 差值层必须在主 suspendHistory 之外建（suspendHistory 不能嵌套） */
    if (OPTIONS.makeDiffLayer) makeDiff();

    if (TARGETS.length > 0 && typeof Window !== "undefined") pbOpen(TARGETS.length, "烘焙矢量图层");

    /* ---- 主流程：整体包进一个历史步骤 ---- */
    R.bakedShapes = 0; R.bakedTexts = 0; R.bakedVMasks = 0; R.bakedGV = 0;
    var ran = false;
    try {
        $.global.PSJSX_HOOK = doWork;
        if (typeof $.global.PSJSX_HOOK === "function") {
            DOC.suspendHistory("ps 烘焙所有矢量图层", "hookFn()");
            ran = true;
        }
    } catch (eS) {
        plog("（suspendHistory 不可用，改为直接跑：" + cleanMsg("" + eS) + "）");
    }
    if (!ran) {
        try { doWork(); } catch (eD) { R.failed.push("主流程出错：" + cleanMsg("" + eD)); plog("★ 主流程出错：" + cleanMsg("" + eD)); }
    }
    try { pbClose(); } catch (ePC) {}

    /* 收尾：对比层关灯 + 量化差异 */
    hideAllDiffs();
    if (OPTIONS.makeDiffLayer) {
        R.diffMax = measureDiff();
        if (R.diffMax) plog("差值对比：最深 " + R.diffMax.maxIdx + "/255，非零像素 " + R.diffMax.nonZero);
    }

    plog("");
    plog("========== 汇总 ==========");
    plog("形状/填充 " + R.bakedShapes + " 个；文字 " + R.bakedTexts + " 个；矢量蒙版 " + R.bakedVMasks + " 个" +
         (OPTIONS.bakeGroupVecMask ? ("；文件夹矢量蒙版 " + R.bakedGV + " 个") : ""));
    plog("失败 " + R.failed.length + " 个；跳过 " + R.skipped.length + " 个");
    for (var i = 0; i < R.failed.length; i++) plog("  ✗ " + R.failed[i]);
    logClose();

    showResult();
}

try { main(); } catch (eM) {
    plog("★ 整体出错：" + cleanMsg("" + eM));
    try { plog("（行 " + eM.line + "）"); } catch (e2) {}
    try { logClose(); } catch (e3) {}
    try { pbClose(); } catch (e4) {}
    alert("烘焙所有矢量图层 —— 出错：\n" + cleanMsg("" + eM) + "\n\n日志：\n" + logPath());
}

})();
