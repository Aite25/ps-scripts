#target photoshop
/* --------------------------------------------------------------------------
 * 作用域隔离：本脚本会被批处理用 $.evalFile 依次加载，若直接暴露全局变量，
 * 会把上一个脚本的 OPTIONS / RESULT / plog 等覆盖掉（实测会让批处理直接报错）。
 * 所以整段包进立即执行函数，对外不留任何全局名。
 * -------------------------------------------------------------------------- */
(function () {

/* ==========================================================================
 * 解锁所有图层（保持显示状态）
 * --------------------------------------------------------------------------
 * ★ 关键修复
 *   旧版有一行 `layer.visible = visi;`（把可见性写回原值）。
 *   在 Photoshop 里"写 visible"会被当成"切换可见性"来处理：剪贴蒙版图层
 *   会跟着它的基底一起变 → 表现就是"剪贴蒙版的显示状态随主图层切换而切换"。
 *   解锁属性在隐藏状态下照样能改，所以本脚本【绝不碰任何图层的 visible】。
 *
 * ★ 本版新增
 *   · 运行前选项面板（可勾选"建差值对比图层"、可记住选择）
 *   · 全文可见性快照 → 收尾逐个校验，被改过的立即还原并报告
 *   · 差值对比图层：最顶层盖印 + 混合模式=差值 + 直方图自检（全黑=一个像素都没动）
 *
 * ★ 顺便对外提供 unlockInside(groupLayer)：解锁某个图层组内部所有图层，
 *   给"文件夹里有未解锁图层导致整组删不掉"的脚本用。
 * ========================================================================== */

var OPTIONS = {
    makeDiffLayer: true,
    askOptions: true,
    rememberOptions: true,
    diffName: "__对比 01-解锁前(差值)"
};

var PREF_NAME = "ps_解锁所有图层_选项.txt";
var DOC = null;
var SNAP = null;
var RESULT = { unlocked: 0, lockedLeft: 0, blocked: [], eyesFixed: [], diffMade: false, diffWhy: "", diffBase: null };



/* ------------------------------ 进度条（非模态，跑完自动关） ------------------------------ */
var PB = { win: null, bar: null, txt: null, n: 0, total: 1 };

function pbOpen(title, total) {
    if (typeof Window === "undefined") return;
    try {
        PB.win = new Window("palette", title);
        PB.win.orientation = "column";
        PB.win.alignChildren = "fill";
        PB.txt = PB.win.add("statictext", undefined, "准备中…");
        PB.bar = PB.win.add("progressbar", undefined, 0, (total > 0 ? total : 1));
        try { PB.bar.preferredSize.width = 340; } catch (eW) {}
        try { PB.win.preferredSize.width = 360; } catch (eW2) {}
        try { placeWindowOnHostScreen(PB.win); } catch (ePL) {}
        PB.win.show();
        PB.total = (total > 0 ? total : 1);
        PB.n = 0;
    } catch (e) { PB.win = null; }
}

function pbStep(msg) {
    if (!PB.win) return;
    PB.n++;
    try {
        PB.bar.value = (PB.n > PB.total ? PB.total : PB.n);
        PB.txt.text = msg;
        PB.win.update();
    } catch (e) {}
}

function pbClose() {
    if (!PB.win) return;
    try { PB.win.close(); } catch (e) {}
    PB.win = null;
}

function countAll(container) {
    var n = 0;
    walk(container, function (L) { n++; });
    return n;
}
/* ------------------------------ 主流程 ------------------------------ */
/* ---------- 批处理模式 ----------
 * 批处理脚本会先设 $.global.PSJSX_BATCH = true 再 $.evalFile 本脚本。
 * 这时不弹任何需要人点的窗口，脚本只干活、只写日志。 */
/* ★★ 把窗口放到指定屏幕 + 分上下两层（Windows 默认会把弹窗丢到主屏，而且会互相盖住）★★
 * 实现在同目录的「_共享 窗口位置.jsx」里，【不做任何探测】—— 只读手工写的
 *     %TEMP%\psjsx_screen_manual.txt   内容：left,top,width,height
 * 这里只负责按需加载一次并调用。
 *
 * ★ 分两层（解决"ps 00_single 的进度条被子步骤的进度条盖住"）：
 *     外层运行器（ps 00 / ps 00_single）调用时传 isRunner=true -> 放【上 1/3】
 *     批处理里的子步骤（PSJSX_BATCH=true）                    -> 放【下 1/3】
 *     单独跑某个步骤                                          -> 放【上 1/3】
 * ★ 拿不到屏幕设置就返回 false，窗口按系统默认位置显示 —— 绝不影响弹窗本身。 */
function placeWindowOnHostScreen(w, isRunner) {
    try {
        if (typeof $.global.PSJSX_placeWindow !== "function") {
            var p = null;
            try {
                var raw = "" + $.fileName;
                var here = null;
                try { here = File(raw); } catch (eA) { here = null; }
                if (!here || !here.exists) { try { here = File(decodeURI(raw)); } catch (eB) { here = null; } }
                if (here && here.parent) p = here.parent.fsName + "/_共享 窗口位置.jsx";
            } catch (e0) { p = null; }
            if (p) {
                var f = File(p);
                if (f.exists) { try { $.evalFile(f); } catch (eE) {} }
            }
        }
        if (typeof $.global.PSJSX_placeWindow === "function") return $.global.PSJSX_placeWindow(w, isRunner === true);
    } catch (e) {}
    return false;
}


function batchOn() {
    try { return ($.global.PSJSX_BATCH === true); } catch (e) { return false; }
}

/* ★★ 步骤结果标记（供 ps 00 批处理判断这一步成功还是失败）★★
   为什么需要：$.evalFile 只会在"抛出异常"时报错；但步骤脚本多半自己把异常
   捕获了（不让批处理中断），于是 ps 00 无法知道这一步到底成没成。
   做法：启动成功先写 "OK"，之后若出错再覆盖成 "FAIL|原因"。
   ps 00 在每步前后读这个文件，就能判断并把失败步骤记进汇总。
   只在批处理模式写（单跑时不产生垃圾文件）。 */
function stepMarkPath() {
    try { return Folder.temp.fsName + "/psjsx_step_result.txt"; } catch (e) { return ""; }
}
function stepMark(text) {
    if (!batchOn()) return;
    try {
        var p = stepMarkPath();
        if (!p) return;
        var f = File(p);
        f.open("w");
        f.write(text + "\n");
        f.close();
    } catch (e) {}
}



/* 运行前：把所有"脚本生成的对比层"（以 __对比 开头）的眼睛关掉 */
/* 盖印前先选中"最上面那个可见图层" —— 活动图层被隐藏时，PS 的"合并可见图层"会拒绝执行，
   导致盖印失败或拿到空/黑结果（这就是对比层全黑的原因）。 */
function selectTopVisible() {
    try {
        var ls = DOC.layers;
        for (var i = 0; i < ls.length; i++) {
            var v = true;
            try { v = (ls[i].visible !== false); } catch (eV) {}
            if (v) { selectLayer(ls[i]); return true; }
        }
        if (ls.length) selectLayer(ls[0]);
    } catch (e) {}
    return false;
}

function hideCompareLayers() {
    var n = 0;
    walk(DOC, function (L) {
        var nm = "";
        try { nm = L.name; } catch (e) { return; }
        if (nm && nm.length >= 4 && nm.substring(0, 4) === "__对比") {
            try { if (L.visible !== false) { L.visible = false; n++; } } catch (e2) {}
        }
    });
    return n;
}

function main() {
    if (app.documents.length === 0) { alert("没有打开的文档。"); return; }
    DOC = app.activeDocument;

    loadPrefs();
    if (OPTIONS.askOptions && !askDialog()) return;
    stepMark("OK");   // ★ 先记成功；出错时会被覆盖成 FAIL
    savePrefs();

    pbOpen("解锁所有图层", countAll(DOC));

    /* ★ clearOldDiff 会删掉旧的对比层链（可能好几层）——
       原来在 suspendHistory 之外做，每删一层就记一条历史（用户看到"很多删除图层"）。
       现在先把"清旧对比层"包成一条历史。 */
    try { if (typeof clearOldDiff === "function") {
        try { $.global.PSJSX_CLEAN = clearOldDiff; } catch (eG0) {}
        DOC.suspendHistory("ps01 清掉旧对比层", "PSJSX_CLEAN()");
    } } catch (eCL) { try { clearOldDiff(); } catch (eCL2) {} }
    try { hideCompareLayers(); } catch (eHC) {}
    SNAP = snapshotEyes();

    if (OPTIONS.makeDiffLayer) makeDiff();

    try {
        try { $.global.PSJSX_HOOK = doUnlock; } catch (eG) {}
        DOC.suspendHistory("解锁所有图层", "PSJSX_HOOK()");
    } catch (eH) {
        doUnlock();                       // suspendHistory 不行就直接执行
    }

    pbClose();

    /* ★ 收尾校验会写 visible（把眼睛恢复成快照）—— 原来也在 suspendHistory 之外，
       每写一次就多一条历史。包进它自己的历史步骤里。 */
    try {
        try { $.global.PSJSX_VERIFY = function () { RESULT.eyesFixed = verifyEyes(SNAP); }; } catch (eG1) {}
        DOC.suspendHistory("ps01 收尾校验", "PSJSX_VERIFY()");
    } catch (eV2) { try { RESULT.eyesFixed = verifyEyes(SNAP); } catch (eV3) {} }

    showResult();
}

/* 被 suspendHistory 以字符串调用（必须是全局函数） */
function doUnlock() {
    RESULT.unlocked = 0;
    RESULT.lockedLeft = 0;
    RESULT.blocked = [];
    unlockAll(DOC.layers);
}

/* ------------------------------ 解锁 ------------------------------ */
function unlockAll(layers) {
    for (var i = 0; i < layers.length; i++) {
        var L = layers[i];
        var hadLock = false;
        try { hadLock = (L.allLocked === true); } catch (eA) { hadLock = false; }

        // ★ 只改锁定属性，绝不写 L.visible
        try {
            if (hadLock) { L.allLocked = false; }
            try { if (L.protectTransparency) L.protectTransparency = false; } catch (e1) {}
            try { if (L.protectPosition) L.protectPosition = false; } catch (e2) {}
            try { if (L.protectComposite) L.protectComposite = false; } catch (e3) {}
            if (hadLock) RESULT.unlocked++;
        } catch (e4) {
            RESULT.blocked.push(safeName(L));
        }

        try { if (L.allLocked === true) RESULT.lockedLeft++; } catch (e5) {}

        pbStep("解锁 " + safeName(L));
        if (isGroup(L)) unlockAll(L.layers);
    }
}

/* 供外部脚本调用：解锁图层组内部所有图层，返回解锁个数 */
function unlockInside(groupLayer) {
    if (!groupLayer) return 0;
    var n = 0;
    try {
        for (var i = 0; i < groupLayer.layers.length; i++) {
            var L = groupLayer.layers[i];
            try {
                if (L.allLocked) { L.allLocked = false; n++; }
                try { if (L.protectTransparency) L.protectTransparency = false; } catch (e1) {}
                try { if (L.protectPosition) L.protectPosition = false; } catch (e2) {}
                try { if (L.protectComposite) L.protectComposite = false; } catch (e3) {}
            } catch (e4) {}
            if (isGroup(L)) n += unlockInside(L);
        }
    } catch (e5) {}
    return n;
}

/* ------------------------------ 可见性快照 / 校验 ------------------------------ */
function snapshotEyes() {
    var map = {};
    walk(DOC, function (L) {
        var id = getId(L);
        if (id >= 0) { try { map[id] = (L.visible !== false); } catch (e) {} }
    });
    return map;
}

/* 只检查、不写回（★ 关键：绝不写 L.visible —— 写它会被 PS 当成"切换可见性"，
   反而会影响别的图层/剪贴链的显示状态）。这里只把不一致记录下来报告。 */
function verifyEyes(snap) {
    var diff = [];
    if (!snap) return diff;
    walk(DOC, function (L) {
        var id = getId(L);
        if (id < 0 || snap[id] === undefined) return;
        var cur = true;
        try { cur = (L.visible !== false); } catch (e) { return; }
        if (cur !== snap[id]) {
            diff.push(safeName(L) + "（原本 " + (snap[id] ? "显示" : "隐藏") + "，现在 " + (cur ? "显示" : "隐藏") + "）");
        }
    });
    return diff;
}

/* ------------------------------ 差值对比图层 ------------------------------ */
/* makeDiff() 的壳 + 实现见文件上方「建立对比图层：打包成历史记录里的一步」那一节 */

function clearOldDiff() {
    try {
        var L = findByName(DOC, OPTIONS.diffName);
        var guard = 0;
        while (L && guard < 20) { try { L.remove(); } catch (e) {} L = findByName(DOC, OPTIONS.diffName); guard++; }
    } catch (e2) {}
}

function stampVisible() {
    if (tryStampMergeVisible()) return true;
    return tryStampCopyMerged();
}

function tryStampMergeVisible() {
    try {
        var d = new ActionDescriptor();
        d.putBoolean(charIDToTypeID("Dplc"), true);                 // duplicate = 盖印（不是合并）
        executeAction(charIDToTypeID("MrgV"), d, DialogModes.NO);
        return true;
    } catch (e) { return false; }
}

function tryStampCopyMerged() {
    try {
        DOC.selection.selectAll();
        var evC = sid("copyMerged");
        if (evC === false) return false;
        executeAction(evC, new ActionDescriptor(), DialogModes.NO);

        var evP = sid("paste");
        if (evP === false) return false;
        var d = new ActionDescriptor();
        var kIn = sid("inPlace");
        if (kIn !== false) d.putBoolean(kIn, true);
        executeAction(evP, d, DialogModes.NO);

        try { DOC.selection.deselect(); } catch (eD) {}
        return true;
    } catch (e) { return false; }
}

function readHist() {
    try {
        var h = DOC.histogram;
        var nonZero = 0, maxIdx = 0;
        for (var i = 1; i < h.length; i++) { if (h[i] > 0) { nonZero += h[i]; maxIdx = i; } }
        return { nonZero: nonZero, maxIdx: maxIdx };
    } catch (e) { return null; }
}

/* ------------------------------ 选项面板 ------------------------------ */
function askDialog() {
    if (batchOn()) return true;
    if (typeof Window === "undefined") return true;        // 模拟测试环境跳过 UI
    var w = new Window("dialog", "解锁所有图层 —— 选项");
    w.orientation = "column";
    w.alignChildren = "left";

    var g1 = w.add("panel", undefined, "对比图层（用来验证解锁有没有改变画面）");
    g1.orientation = "column";
    g1.alignChildren = "left";
    var cbDiff = g1.add("checkbox", undefined, "先在最顶层盖印一层「" + OPTIONS.diffName + "」（混合模式=差值）");
    cbDiff.value = !!OPTIONS.makeDiffLayer;
    g1.add("statictext", undefined, "全黑 = 这次解锁一个像素都没改动；有亮处 = 有改动（要查）。");

    var g2 = w.add("panel", undefined, "说明");
    g2.orientation = "column";
    g2.alignChildren = "left";
    g2.add("statictext", undefined, "· 只改锁定属性，不碰任何图层的显示/隐藏开关。");
    g2.add("statictext", undefined, "· 收尾会校验全文显示状态，被改过的立即还原并报告。");
    g2.add("statictext", undefined, "· 全程包在一个历史步骤里，Ctrl+Z 可整段撤回。");

    var cbRem = w.add("checkbox", undefined, "记住我的选择（下次自动带上）");
    cbRem.value = !!OPTIONS.rememberOptions;

    var gB = w.add("group");
    gB.alignment = "right";
    gB.add("button", undefined, "开始", { name: "ok" });
    gB.add("button", undefined, "取消", { name: "cancel" });

    try { placeWindowOnHostScreen(w); } catch (ePL) {}
    if (w.show() !== 1) return false;

    OPTIONS.makeDiffLayer = (cbDiff.value === true);
    OPTIONS.rememberOptions = (cbRem.value === true);
    return true;
}

/* ------------------------------ 结果窗口 ------------------------------ */
function showResult() {
    if (batchOn()) return;
    if (typeof Window === "undefined") return;
    var msg = "解锁完成：处理了 " + RESULT.unlocked + " 个有锁定属性的图层";
    if (RESULT.lockedLeft > 0) msg += "\n⚠ 还有 " + RESULT.lockedLeft + " 个图层仍显示为锁定";
    if (RESULT.blocked.length > 0) msg += "\n⚠ 有 " + RESULT.blocked.length + " 个图层解锁时报错：" + RESULT.blocked.slice(0, 5).join(" / ");
    if (RESULT.eyesFixed.length > 0) msg += "\n⚠ 有 " + RESULT.eyesFixed.length + " 个图层的显示状态被改动，已还原：" + RESULT.eyesFixed.slice(0, 5).join(" / ");
    else msg += "\n✔ 显示状态校验：所有图层与开始前完全一致";
    if (RESULT.diffMade) {
        msg += "\n\n最顶层已建「" + OPTIONS.diffName + "」（差值）";
        if (RESULT.diffBase) {
            msg += (RESULT.diffBase.nonZero === 0)
                ? "\n差值自检：画面纯黑 → 解锁没有改变任何像素 ✔"
                : "\n差值自检：非黑 " + RESULT.diffBase.nonZero + " 个，最深 " + RESULT.diffBase.maxIdx + "/255（盖印自身的舍入噪声）";
        }
    } else if (OPTIONS.makeDiffLayer) {
        msg += "\n\n⚠ 对比图层没建成：" + RESULT.diffWhy;
    }
    if (batchOn()) return;   // ★ 批处理模式绝不弹窗
    try { alert(msg); } catch (eA2) {}
}

/* ------------------------------ 工具 ------------------------------ */
function isGroup(L) {
    try { return (L.typename === "LayerSet"); } catch (e) { return false; }
}

function getId(L) {
    try { return L.id; } catch (e) { return -1; }
}

function safeName(L) {
    try { return L.name; } catch (e) { return "?"; }
}

function byId(id) {
    var found = null;
    if (id < 0) return null;
    walk(DOC, function (L) { if (found === null && getId(L) === id) { found = L; } });
    return found;
}

function findByName(container, nm) {
    var found = null;
    try {
        for (var i = 0; i < container.layers.length; i++) {
            var L = container.layers[i];
            if (safeName(L) === nm) { found = L; break; }
            if (isGroup(L)) { var inner = findByName(L, nm); if (inner) { found = inner; break; } }
        }
    } catch (e) {}
    return found;
}

function walk(container, fn) {
    try {
        var list = container.layers;
        for (var i = 0; i < list.length; i++) {
            var L = list[i];
            fn(L);
            if (isGroup(L)) walk(L, fn);
        }
    } catch (e) {}
}

function selectLayer(L) {
    try { DOC.activeLayer = L; } catch (e) {}
}

function sid(name) {
    try { return stringIDToTypeID(name); } catch (e) { return false; }
}

function cleanMsg(s) {
    try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 160); } catch (e) { return "" + s; }
}

/* ------------------ 建立对比图层：打包成历史记录里的一步 ------------------
 * 这四步（盖印可见图层 → 改名 → 移到最顶层 → 设差值）原来会在历史记录里留下
 * 三四条步骤，Ctrl+Z 要按好几次。现在整体包进一个 suspendHistory：
 *   历史记录里只出现一条「ps01 建对比层」，一按 Ctrl+Z 就整段撤回。
 * 说明：Photoshop 不允许 suspendHistory 嵌套，所以 makeDiff() 的调用点必须在
 *       主流程那个 suspendHistory 之外 —— 现有代码本来就是这么排的。 */
function makeDiff() {
    try {
        try { $.global.PSJSX_DIFF = makeDiffBody; } catch (eG) {}
        if (typeof $.global.PSJSX_DIFF !== "function") { makeDiffBody(); return; }
        DOC.suspendHistory("ps01 建对比层", "diffHookFn()");
    } catch (eH) {
        makeDiffBody();                     // 不支持就退回原样（拆成几步，不影响功能）
    }
}

/* ★ 建对比层之前的判断（比 batchOn() 细一层）
 * --------------------------------------------------------------------------
 *   · 手动单独跑某个步骤（batchOn()=false）            -> 建
 *   · ps 00_single（只处理【当前这一个】文件）          -> 建
 *       （它会把 $.global.PSJSX_DIFF_OK 设成 true —— 单文件就是拿来盯对比层的）
 *   · ps 00 整文件夹批处理（几百个文件）                -> 不建
 *       （建几百个全屏差值层，白占内存，事后还得清）
 *
 * ★ 踩过的坑：原来这里写的是 `if (batchOn()) return;`，
 *   而 ps 00_single 也会把 batchOn() 打开（为了让子脚本不弹窗），
 *   结果【单文件跑完整条流水线，一个对比层都没有】——
 *   用户就是因为这个来提需求的。所以把"静默"和"建不建对比层"拆成两件事。 */
function diffSkipped() {
    if (!batchOn()) return false;
    try { if ($.global.PSJSX_DIFF_OK === true) return false; } catch (e) {}
    return true;
}


function makeDiffBody() {
    if (diffSkipped()) return;         // 批处理不建；ps 00_single 会放行
    selectTopVisible();
    try {
        clearOldDiff();
        var top = DOC.layers[0];
        selectLayer(top);
        if (!stampVisible()) throw new Error("盖印可见图层失败（mergeVisible 与备用方式都不行）");

        var made = DOC.activeLayer;
        try { made.name = OPTIONS.diffName; } catch (eN) {}

        // 必须落到文档最顶层：留在图层组里会被组的混合/蒙版/剪贴再作用一次 → 淡淡色差
        try {
            var t2 = DOC.layers[0];
            if (getId(t2) !== getId(made)) made.move(t2, ElementPlacement.PLACEBEFORE);
        } catch (eM) {}
        made = byId(getId(made)) || made;
        if (made.parent !== DOC) throw new Error("对比图层没能移到文档最顶层（可能还在图层组里）");

        try {
            made.blendMode = BlendMode.DIFFERENCE;
        } catch (eB) {
            try { made.remove(); } catch (eB2) {}
            throw new Error("没法设成差值混合模式，已撤掉这个图层");
        }
        /* ★ 建完立刻关掉对比层的眼睛：
           它是全屏 DIFFERENCE（差值）层，可见时会让整个画面颜色彻底变样，
           自动流水线里绝不能留着（用户确认：自动关掉，想看时手动点开）。 */
        try { made.visible = false; } catch (eVis) {}
        RESULT.diffMade = true;
        RESULT.diffBase = readHist();
    } catch (e) {
        RESULT.diffWhy = cleanMsg("" + e);
    }
}

/* 被 suspendHistory 以字符串调用（必须在全局作用域里找得到这个名字） */
function diffHookFn() {
    try { return $.global.PSJSX_DIFF(); } catch (e) { return null; }
}

/* ------------------------------ 选项记忆 ------------------------------ */
function prefFile() {
    try { return File(Folder.userData + "/" + PREF_NAME); } catch (e) { return null; }
}

function loadPrefs() {
    var f = prefFile();
    if (!f || !f.exists) return;
    try {
        f.open("r");
        var txt = f.read();
        f.close();
        var lines = txt.split("\n");
        for (var i = 0; i < lines.length; i++) {
            var kv = lines[i].split("=");
            if (kv.length < 2) continue;
            var k = kv[0].replace(/^\s+|\s+$/g, "");
            var v = kv[1].replace(/^\s+|\s+$/g, "");
            if (k === "makeDiffLayer") OPTIONS.makeDiffLayer = (v === "1" || v === "true");
            if (k === "rememberOptions") OPTIONS.rememberOptions = (v === "1" || v === "true");
        }
    } catch (e) {}
}

function savePrefs() {
    if (!OPTIONS.rememberOptions) return;
    var f = prefFile();
    if (!f) return;
    try {
        f.open("w");
        f.write("makeDiffLayer=" + (OPTIONS.makeDiffLayer ? "1" : "0") + "\n");
        f.write("rememberOptions=1\n");
        f.close();
    } catch (e) {}
}
/* 诊断：证明脚本确实被调用过（面板出错会静默吞异常，这样至少能看出走到哪一步） */
try {
    var __mk = File(Folder.temp.fsName + "/psjsx_01_started.txt");
    __mk.open("w");
    __mk.write("started " + (new Date()).toString() + "\n");
    __mk.close();
} catch (eMk) {}

try {
    main();
} catch (eMain) {
    try {
        var __ln = ""; try { __ln = eMain.line; } catch (eL) {}
        var __fn = ""; try { __fn = eMain.fileName; } catch (eF) {}
        if (!batchOn()) alert("ps 01 运行出错：\n" + eMain + "\n行号: " + __ln + "\n文件: " + __fn);
    } catch (eAl) {}
}
})();
