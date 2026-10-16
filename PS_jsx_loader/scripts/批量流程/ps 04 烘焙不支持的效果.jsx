#target photoshop
/* ==========================================================================
 * ps 04 烘焙不支持的效果
 * --------------------------------------------------------------------------
 * 做什么：扫描【所有非文件夹图层】，找出 AE 不支持、又不属于"图层样式"的效果：
 *     · 智能对象（layerKind = 5）
 *     · 智能滤镜（描述符里有 filterFX）
 *     · 矢量蒙版（hasVectorMask）
 *     · 图层样式里 AE 不认的效果（目前：图案叠加 patternFill / patternFillMulti）
 *       —— AE 认不了"图案叠加"，带它的图层进 AE 会丢效果，所以也烤掉。
 *       清单在 BAKED_EFFECTS 里，要加别的效果往里加一条即可。
 *   命中就用【空对象合并】的方法烤掉（下面建空层 → 向下合并 → 还原混合模式/名字/可见性）。
 *   没命中的图层一律不动；图层样式不算（AE 认）、图层蒙版不算（交给 ps 05）。
 *
 * 带：运行前选项面板（含差值对比图层开关 + 记住选择）、进度条、差值对比图层、批处理钩子。
 * ========================================================================== */

(function () {

var OPTIONS = {
    askOptions: true,
    rememberOptions: true,
    makeDiffLayer: true,          // 建"对比-04前(差值)"图层，用来验证一个像素都没改
    dryRun: false,                // 只统计不烘焙
    skipHidden: true,             // 跳过隐藏图层（隐藏的不影响画面）
    diffName: "__对比 04-烘焙效果前(差值)"
};

var PREF_NAME = "ps_04_烘焙不支持的效果_选项.txt";
var DOC = null;
var SNAP = null;
var PB = { win: null, bar: null, txt: null };
var LOG = { f: null, path: "" };
var R = { total: 0, hits: 0, baked: [], failed: [], skipped: [], notes: [],
          eyesFixed: [], diffMade: false, diffWhy: "", diffBase: null, elapsed: 0 };


/* ------------------------------ 主流程 ------------------------------ */
function main() {
    if (app.documents.length === 0) { failOut("没有打开的文档。"); return; }
    DOC = app.activeDocument;

    // ★ 批处理模式（ps 00 用 $.evalFile 挨个调这些脚本）绝不弹窗、也不读记住的选项：
    //   一弹窗整批就会卡在那里等人点（实测卡了 17 小时，其它脚本都有这个判断，这个漏了）
    if (batchOn()) {
        OPTIONS.askOptions = false;
        OPTIONS.makeDiffLayer = false;
    } else {
        loadPrefs();
        if (OPTIONS.askOptions && !askDialog()) return;
        savePrefs();
    }

    logOpen();
            stepMark("OK");   // ★ 先记成功，出错时会被覆盖成 FAIL
    plog("===== ps 04 烘焙不支持的效果 开始 =====");
    plog("文档：" + DOC.name);
    plog("生效选项：对比图层=" + (OPTIONS.makeDiffLayer ? "开" : "关") +
         "，跳过隐藏=" + (OPTIONS.skipHidden ? "是" : "否") +
         "，dryRun=" + (OPTIONS.dryRun ? "开" : "关"));

    // 1) 扫描
    var targets = [];
    scan(DOC, targets);
    R.total = targets.length;

    // 2) 对比图层（放在任何早退之前）
    try { hideCompareLayers(); } catch (eHC) {}
    SNAP = snapshotEyes();
    if (OPTIONS.makeDiffLayer) makeDiff();

    if (R.total === 0) {
        plog("没有发现需要烘焙的不支持效果。");
        writeSummary();
        finishShort("没有发现需要烘焙的不支持效果。");
        return;
    }
    if (OPTIONS.dryRun) {
        plog("dryRun = true：只统计，不烘焙。命中 " + R.total + " 个图层。");
        writeSummary();
        finishShort("只统计：找到 " + R.total + " 个带不支持效果的图层。");
        return;
    }

    // 3) 烘焙
    pbOpen("烘焙不支持的效果：" + R.total + " 个", R.total);
    var t0 = nowMs();
    try { $.global.PSJSX_HOOK = doBake; } catch (eG) {}
    try { DOC.suspendHistory("ps04 烘焙不支持的效果", "PSJSX_HOOK()"); }
    catch (eH) { doBake(); }
    R.elapsed = Math.round((nowMs() - t0) / 100) / 10;
    pbClose();

    // 4) 收尾校验
    try { R.eyesFixed = verifyEyes(SNAP); } catch (eV) {}
    try { checkDiffAfterBake(); } catch (eD) {}

    writeSummary();
    finishShort("完成：烤了 " + R.baked.length + " 个" +
                (R.failed.length ? ("，失败 " + R.failed.length + " 个") : "") +
                "\n耗时约 " + R.elapsed + " 秒");
}

function doBake() {
    var list = [];
    scan(DOC, list);                       // 用最新清单
    for (var i = 0; i < list.length; i++) {
        var t = list[i];
        pbStep("(" + (i + 1) + "/" + list.length + ") " + t.name);
        if (t.hidden && OPTIONS.skipHidden) {
            R.skipped.push(t.path + "（隐藏）");
            plog("跳过（隐藏）：" + t.path);
            continue;
        }
        var ok = bakeOne(t);
        if (ok) {
            R.baked.push(t.path);
            plog("✓ 已烤：" + t.path + "　原因：" + t.why.join(" / "));
        } else {
            plog("✗ 失败：" + t.path);
        }
    }
}

/* ------------------------------ 扫描与判定 ------------------------------ */
function scan(container, out) {
    var layers = null;
    try { layers = container.layers; } catch (e) { return; }
    if (!layers) return;
    for (var i = 0; i < layers.length; i++) {
        var L = layers[i];
        if (isGroup(L)) { scan(L, out); continue; }        // 文件夹：递归，本身不处理
        var info = classify(L);
        if (info.hit) {
            out.push({ layer: L, id: getId(L), name: safeName(L), path: pathOf(L),
                       why: info.why, hidden: !isVisible(L) });
        }
    }
}

/* 判定：这一层有没有"AE 不支持、又不属于图层样式"的效果 */
function classify(L) {
    var why = [];
    var desc = getDescr(L);
    if (!desc) return { hit: false, why: why };

    var kind = 0;
    try { kind = desc.hasKey(sid("layerKind")) ? desc.getInteger(sid("layerKind")) : 0; } catch (e1) {}

    // 调整层绝对不动
    if (kind === 2 || hasTopKey(desc, "adjustment") || hasTopKey(desc, "Adjs")) {
        return { hit: false, why: why };
    }
    if (kind === 5 || hasTopKey(desc, "smartObject")) why.push("智能对象");
    if (hasTopKey(desc, "filterFX")) why.push("智能滤镜");
    try {
        if (desc.hasKey(sid("hasVectorMask")) && desc.getBoolean(sid("hasVectorMask"))) why.push("矢量蒙版");
    } catch (e2) {}

    /* ★ 图层样式里"AE 不认的效果"（目前：图案叠加）—— 命中也烤掉 */
    for (var be = 0; be < BAKED_EFFECTS.length; be++) {
        try {
            if (effectEnabled(desc, BAKED_EFFECTS[be].keys)) why.push(BAKED_EFFECTS[be].label);
        } catch (eBE) {}
    }

    // 去掉重复项
    var uniq = [];
    for (var i = 0; i < why.length; i++) {
        var dup = false; for (var q = 0; q < uniq.length; q++) { if (uniq[q] === why[i]) { dup = true; break; } } if (!dup) uniq.push(why[i]);
    }
    return { hit: uniq.length > 0, why: uniq };
}

/* ------------------------------ 烘焙单个图层 ------------------------------ */
function bakeOne(t) {
    var L = byId(t.id);
    if (!L) { R.failed.push(t.path + "（图层已不存在）"); return false; }

    var blendBefore = null, visBefore = true, nameBefore = safeName(L);
    try { blendBefore = L.blendMode; } catch (eB) {}
    try { visBefore = (L.visible !== false); } catch (eV) {}

    var emptyId = -1;
    try {
        selectById(t.id);

        // 与 选择层空对象合并.jsx 一致：新建图层 → 移到该图层下面
        var empty = null;
        try { empty = DOC.artLayers.add(); } catch (eA) { empty = null; }
        if (!empty) throw new Error("新建空图层失败");
        try { empty.move(L, ElementPlacement.PLACEAFTER); } catch (eM) {
            try { empty.remove(); } catch (eM2) {}
            throw new Error("空层移不到该图层下面");
        }
        emptyId = getId(empty);

        // ★ 合并前必须重新选中原图层（隐藏层要先临时显示，否则"合并图层"不可用）
        selectById(t.id);
        if (visBefore === false) { try { L.visible = true; } catch (eVs) {} }
        mergeDown();

        var merged = DOC.activeLayer;
        try { if (blendBefore !== null) merged.blendMode = blendBefore; } catch (eB2) {}
        try { merged.name = nameBefore; } catch (eN) {}
        try { merged.visible = visBefore; } catch (eV2) {}

        // 校验：原图层 id 不该变（合并是把原图层保留、吃掉空层）
        return true;
    } catch (e) {
        R.failed.push(t.path + "：" + cleanMsg("" + e));
        // 清理：删掉自己建的空层、还原可见性
        try { var st = byId(emptyId); if (st) st.remove(); } catch (eC) {}
        try { var back = byId(t.id); if (back && visBefore === false) back.visible = false; } catch (eC2) {}
        return false;
    }
}

/* ------------------------------ 进度条 ------------------------------ */
function pbOpen(title, total) {
    if (batchOn()) return;                       // ★ 批处理模式下不显示进度条
    if (typeof Window === "undefined") return;
    try {
        PB.win = new Window("palette", title);
        PB.win.orientation = "column";
        PB.win.alignChildren = "fill";
        PB.txt = PB.win.add("statictext", undefined, "准备中…");
        PB.bar = PB.win.add("progressbar", undefined, 0, (total > 0 ? total : 1));
        try { PB.bar.preferredSize.width = 360; } catch (eW) {}
        try { PB.win.preferredSize.width = 380; } catch (eW2) {}
        try { placeWindowOnHostScreen(PB.win); } catch (ePL) {}
        PB.win.show();
        PB.n = 0;
    } catch (e) { PB.win = null; }
}
function pbStep(msg) {
    if (!PB.win) return;
    try { PB.n++; PB.bar.value = PB.n; PB.txt.text = msg; PB.win.update(); } catch (e) {}
}
function pbClose() {
    if (!PB.win) return;
    try { PB.win.close(); } catch (e) {}
    PB.win = null;
}

/* ------------------------------ 差值对比图层 ------------------------------ */
/* ------------------ 建立对比图层：打包成历史记录里的一步 ------------------
 * 盖印可见图层 → 改名 → 移到最顶层 → 设差值，这四步原来在历史记录里是三四条，
 * 现在整体包进一个 suspendHistory：历史里只出现一条「ps04 建对比层」，一次 Ctrl+Z 全撤。
 * 说明：suspendHistory 不允许嵌套，所以 makeDiff() 的调用点要在主流程那个之外。 */
function makeDiff() {
    try {
        try { $.global.PSJSX_DIFF = makeDiffBody; } catch (eG) {}
        if (typeof $.global.PSJSX_DIFF !== "function") { makeDiffBody(); return; }
        DOC.suspendHistory("ps04 建对比层", "diffHookFn()");
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
        selectById(getId(DOC.layers[0]));
        if (!stampVisible()) throw new Error("盖印失败（mergeVisible 与备用方式都不行）");

        var made = DOC.activeLayer;
        try { made.name = OPTIONS.diffName; } catch (eN) {}
        try {
            var top = DOC.layers[0];
            if (getId(top) !== getId(made)) made.move(top, ElementPlacement.PLACEBEFORE);
        } catch (eM) {}
        made = byId(getId(made)) || made;
        if (made.parent !== DOC) throw new Error("对比图层没能移到文档最顶层");

        try { made.blendMode = BlendMode.DIFFERENCE; }
        catch (eB) { try { made.remove(); } catch (eB2) {} throw new Error("设差值失败"); }

        /* ★ 建完立刻关掉对比层的眼睛：
           它是全屏 DIFFERENCE（差值）层，可见时会让整个画面颜色彻底变样，
           自动流水线里绝不能留着（用户确认：自动关掉，想看时手动点开）。 */
        try { made.visible = false; } catch (eVis) {}
        R.diffMade = true;
        R.diffBase = readHist();
        if (R.diffBase) {
            plog("对比图层已建（最顶层，差值）。基准：非黑 " + R.diffBase.nonZero + " 个，最深 " + R.diffBase.maxIdx + "/255");
        }
    } catch (e) {
        R.diffWhy = cleanMsg("" + e);
        plog("建立对比图层失败：" + R.diffWhy);
    }
}

/* 被 suspendHistory 以字符串调用（必须在全局作用域里找得到这个名字） */
function diffHookFn() {
    try { return $.global.PSJSX_DIFF(); } catch (e) { return null; }
}

function clearOldDiff() {
    var guard = 0;
    try {
        var L = findByName(DOC, OPTIONS.diffName);
        while (L && guard < 20) { try { L.remove(); } catch (e) {} L = findByName(DOC, OPTIONS.diffName); guard++; }
    } catch (e2) {}
}

function stampVisible() {
    try {
        var d = new ActionDescriptor();
        d.putBoolean(charIDToTypeID("Dplc"), true);
        executeAction(charIDToTypeID("MrgV"), d, DialogModes.NO);
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

function readHist() {
    try {
        var h = DOC.histogram;
        var nonZero = 0, maxIdx = 0;
        for (var i = 1; i < h.length; i++) { if (h[i] > 0) { nonZero += h[i]; maxIdx = i; } }
        return { nonZero: nonZero, maxIdx: maxIdx };
    } catch (e) { return null; }
}

function checkDiffAfterBake() {
    if (!R.diffMade || !R.diffBase) return;
    var now = readHist();
    if (!now) return;
    if (now.nonZero === 0) plog("✔ 差值对比：画面纯黑 → 烘焙没改任何像素");
    else if (now.maxIdx <= R.diffBase.maxIdx + 3) {
        plog("✔ 差值对比：最深 " + now.maxIdx + "/255，与基准同量级 → 没引入新差异");
    } else {
        plog("⚠ 差值对比：最深 " + now.maxIdx + "/255，明显超过基准 " + R.diffBase.maxIdx + "/255 → 请看点差值图定位");
    }
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
function verifyEyes(snap) {
    var fixed = [];
    if (!snap) return fixed;
    walk(DOC, function (L) {
        var id = getId(L);
        if (id < 0 || snap[id] === undefined) return;
        var cur = true;
        try { cur = (L.visible !== false); } catch (e) { return; }
        if (cur !== snap[id]) {
            try { L.visible = snap[id]; fixed.push(safeName(L)); } catch (e2) {}
        }
    });
    if (fixed.length) plog("⚠ 有 " + fixed.length + " 个图层的显示状态被改动，已还原：" + fixed.join(" / "));
    else plog("✔ 可见性校验：所有图层与开始前一致");
    return fixed;
}

/* ------------------------------ 选项面板 ------------------------------ */
function askDialog() {
    if (batchOn()) return true;                  // ★ 批处理模式不弹窗（漏了这句会卡住整批）
    if (typeof Window === "undefined") return true;
    var w = new Window("dialog", "ps 04 烘焙不支持的效果 —— 选项");
    w.orientation = "column";
    w.alignChildren = "left";

    var g0 = w.add("panel", undefined, "将要做的");
    g0.orientation = "column"; g0.alignChildren = "left";
    g0.add("statictext", undefined, "· 扫描所有非文件夹图层，找出 AE 不支持的效果：");
    g0.add("statictext", undefined, "   智能对象 / 智能滤镜 / 矢量蒙版");
    g0.add("statictext", undefined, "   图层样式里 AE 不认的：图案叠加");
    g0.add("statictext", undefined, "· 命中的用【空对象合并】烤掉；图层样式与图层蒙版不算");
    g0.add("statictext", undefined, "· 调整图层、文件夹一律不动");

    var g1 = w.add("panel", undefined, "对比图层（验证有没有改动画面的像素）");
    g1.orientation = "column"; g1.alignChildren = "left";
    var cbDiff = g1.add("checkbox", undefined, "先在最顶层盖印一层「" + OPTIONS.diffName + "」（差值）");
    cbDiff.value = !!OPTIONS.makeDiffLayer;
    g1.add("statictext", undefined, "全黑 = 没改任何像素；有亮处 = 有改动（要看）。");

    var cbHidden = w.add("checkbox", undefined, "跳过隐藏图层（隐藏的不影响画面）");
    cbHidden.value = !!OPTIONS.skipHidden;
    var cbDry = w.add("checkbox", undefined, "只统计不烘焙（dryRun）");
    cbDry.value = !!OPTIONS.dryRun;
    var cbRem = w.add("checkbox", undefined, "记住我的选择（下次自动带上）");
    cbRem.value = !!OPTIONS.rememberOptions;

    var gB = w.add("group"); gB.alignment = "right";
    gB.add("button", undefined, "开始", { name: "ok" });
    gB.add("button", undefined, "取消", { name: "cancel" });

    try { placeWindowOnHostScreen(w); } catch (ePL) {}
    if (w.show() !== 1) return false;
    OPTIONS.makeDiffLayer = (cbDiff.value === true);
    OPTIONS.skipHidden = (cbHidden.value === true);
    OPTIONS.dryRun = (cbDry.value === true);
    OPTIONS.rememberOptions = (cbRem.value === true);
    return true;
}

/* ------------------------------ 结果 ------------------------------ */
function writeSummary() {
    plog("");
    plog("========== 汇总 ==========");
    plog("发现 " + R.total + " 个带不支持效果的图层：成功烘焙 " + R.baked.length +
         "，失败 " + R.failed.length + "，跳过 " + R.skipped.length);
    if (R.failed.length) {
        plog("失败明细：");
        for (var i = 0; i < R.failed.length; i++) plog("  · " + R.failed[i]);
    }
    if (R.skipped.length) {
        plog("跳过明细：");
        for (var j = 0; j < R.skipped.length; j++) plog("  · " + R.skipped[j]);
    }
    for (var k = 0; k < R.notes.length; k++) plog("备注：" + R.notes[k]);
    plog("脚本只动了命中的图层；调整图层与文件夹未动。");
    plog("没有清理缓存、没有自动存盘。");
    plog("日志：" + LOG.path);
    plog("===== 结束 =====");
    logClose();
}

function finishShort(msg) {
    if (typeof Window === "undefined") return;
    if (batchOn()) return;
    var t = msg;
    if (R.diffMade && R.diffBase) {
        t += "\n\n最顶层已建「" + OPTIONS.diffName + "」（差值）：\n  全黑=没改任何像素；有亮处=有改动。";
    } else if (OPTIONS.makeDiffLayer) {
        t += "\n\n⚠ 对比图层没建成：" + R.diffWhy;
    }
    t += "\n\n详细日志：\n" + LOG.path;
    if (batchOn()) return;   // ★ 批处理模式绝不弹窗（否则整个批处理会卡死）
    try { alert(t); } catch (eA1) {}
}

function failOut(msg) {
    if (batchOn()) {
        stepMark("FAIL|" + cleanMsg(msg));
        stepMark("FAIL|" + cleanMsg(msg));
        try {
            var f = File(Folder.temp.fsName + "/psjsx_04_error.txt");
            f.open("w"); f.write(msg + "\n"); f.close();
        } catch (e) {}
        return;
    }
    if (batchOn()) return;   // ★ 批处理模式绝不弹窗
    try { alert(msg); } catch (eA2) {}
}


/* ------------------------------ 日志目录（统一放 <文档目录>/_日志/） ------------------------------
 * 说明：以前日志直接写在文档旁边，文档一多就糊成一片。
 * 现在统一放进文档同级的 "_日志" 子文件夹里（例如 F:\Fwork\zmd1.6运营\process\_日志）。
 * 该文件夹不存在就新建；建不出来（只读盘等）就退回文档目录，再不行退回临时目录。 */
function logDirName() { return "_日志"; }

function ensureLogFolder() {
    try {
        var d = (DOC && DOC.path) ? Folder(DOC.path) : null;
        if (!d) return null;
        var sub = Folder(d.fsName + "/" + logDirName());
        if (!sub.exists) {
            try { sub.create(); } catch (eC) {}
        }
        if (sub.exists) return sub;
        return d;                       // 建不出来就退回文档目录
    } catch (e) { return null; }
}

/* ------------------------------ 日志 ------------------------------ */
function logOpen() {
    try {
        var d = ensureLogFolder();
        if (!d) d = Folder(Folder.temp);
        LOG.path = d.fsName + "/" + DOC.name.replace(/\.[^.]+$/, "") + "_ps04日志.txt";
        LOG.f = File(LOG.path);
        LOG.f.open("w");
    } catch (e) { LOG.f = null; LOG.path = "(无法写日志)"; }
}
function logClose() { if (LOG.f) { try { LOG.f.close(); } catch (e) {} LOG.f = null; } }
/* 日志落盘策略：不是每行都 close/open（那是 1 次文件 I/O 每行，很慢），
   而是每 25 行才真正 close+reopen 一次（ExtendScript 的 File 有写入缓冲，
   不 close 就不落盘；这样兼顾"崩了不丢太多"与"跑得快"）。 */
var LOG_LINES = 0;
function LOG_FLUSH() {
    LOG_LINES++;
    if (LOG_LINES % 25 !== 0) return;
    try { LOG.f.close(); LOG.f.open("a"); } catch (e) {}
}
function plog(s) {
    if (!LOG.f) return;
    try { LOG.f.write("[" + new Date().toTimeString().substring(0, 8) + "] " + s + "\n"); LOG_FLUSH(); } catch (e) {}
}

/* ------------------------------ 图层工具 ------------------------------ */
function isGroup(L) { try { return (L.typename === "LayerSet"); } catch (e) { return false; } }
function getId(L) { try { return L.id; } catch (e) { return -1; } }
function safeName(L) { try { return L.name; } catch (e) { return "?"; } }
function isVisible(L) { try { return (L.visible !== false); } catch (e) { return true; } }

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

function byId(id) {
    var found = null;
    if (id < 0) return null;
    walk(DOC, function (L) { if (found === null && getId(L) === id) found = L; });
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

function pathOf(L) {
    var parts = [];
    var cur = L;
    var guard = 0;
    while (cur && guard < 40) {
        guard++;
        try {
            parts.unshift(safeName(cur));
            var parent = cur.parent;
            if (!parent || parent === DOC) break;
            cur = parent;
        } catch (e) { break; }
    }
    return parts.join(" / ");
}

function countLayers() {
    var n = 0;
    walk(DOC, function () { n++; });
    return n;
}

function selectById(id) {
    try {
        var d = new ActionDescriptor();
        var r = new ActionReference();
        r.putIdentifier(charIDToTypeID("Lyr "), id);
        d.putReference(charIDToTypeID("null"), r);
        d.putBoolean(charIDToTypeID("MkVs"), false);
        executeAction(charIDToTypeID("slct"), d, DialogModes.NO);
    } catch (e) {}
}

function mergeDown() {
    var d = new ActionDescriptor();
    executeAction(charIDToTypeID("Mrg2"), d, DialogModes.NO);
}

/* 读某图层的 ActionManager 描述符 */
function getDescr(L) {
    try {
        var ref = new ActionReference();
        ref.putProperty(charIDToTypeID("Prpr"), charIDToTypeID("null"));
        ref.putIdentifier(charIDToTypeID("Lyr "), getId(L));
        return executeActionGet(ref);
    } catch (e) {
        try {
            var ref2 = new ActionReference();
            ref2.putIdentifier(charIDToTypeID("Lyr "), getId(L));
            return executeActionGet(ref2);
        } catch (e2) { return null; }
    }
}

/* 只看顶层键（不递归：智能滤镜参数里也有叫 adjustment 的键，会误判） */
function hasTopKey(desc, keyName) {
    if (!desc) return false;
    var n = 0;
    try { n = desc.count; } catch (e) { return false; }
    for (var i = 0; i < n; i++) {
        var ks = "";
        try { ks = typeIDToStringID(desc.getKey(i)); } catch (e2) { ks = ""; }
        if (ks === keyName) return true;
    }
    return false;
}

/* ==========================================================================
 * ★★ AE 不支持、需要烤掉的【图层样式效果】清单 ★★
 * --------------------------------------------------------------------------
 * 这里只列"图层样式里 AE 不认的效果"（图层蒙版 / 矢量蒙版 / 智能对象那些走另外的判断）。
 * 要加新效果就往数组里加一条 { keys: [...], label: "..." }。
 *
 * 图案叠加：PS 描述符里叫 patternFill；同一个效果有多个实例时，
 *   PS 会用【列表形式】存成 patternFillMulti（我们之前在 ae 那边也见过
 *   solidFillMulti / gradientFillMulti / frameFXMulti 这种键名）。
 *   所以两个键都要查，而且只有 enabled=true（真的在用它）才算命中。
 * ★ 为什么图案叠加要烤：AE 认不了这个效果，带它的图层进了 AE 会丢效果。
 * ========================================================================== */
var BAKED_EFFECTS = [
    { keys: ["patternFill", "patternFillMulti"], label: "图案叠加" }
];

/* 图层样式里某个效果有没有被"启用"（= 真的在用它）。
 * PS 的图层样式在描述符里是 layerEffects 对象，每个效果可能是：
 *   · 单个对象（例如 outerGlow）
 *   · 列表（例如 patternFillMulti），列表里可能有多个实例
 * 只有 enabled=true 的才算命中。 */
/* 图层样式里某个效果有没有被"启用"（= 真的在用它）。
 * PS 的图层样式在描述符里是 layerEffects 对象，每个效果可能是：
 *   · 列表（例如 patternFillMulti），列表里可能有多个实例
 *   · 单个对象（例如 outerGlow）
 * 只有 enabled=true 的才算命中。
 *
 * ★ 故意【不用 DescValueType 枚举】判断类型：
 *   万一某个 PS 版本里 DescValueType 取不到，比较会抛错、被外层 catch 吞掉，
 *   结果就是"永远检测不到图案叠加"这种静默失败。
 *   改成：先按"列表"试（getList 对非列表会抛错），不行再按"对象"试 —— 不依赖枚举。 */
function effectEnabled(desc, keys) {
    try {
        var kLE = sid("layerEffects");
        if (kLE === false || !desc.hasKey(kLE)) return false;
        var fx = desc.getObjectValue(kLE);
        if (!fx) return false;
        var kEn = sid("enabled");

        for (var i = 0; i < keys.length; i++) {
            var kk = sid(keys[i]);
            if (kk === false || !fx.hasKey(kk)) continue;

            /* ① 按"列表"试 */
            var got = false;
            try {
                var list = fx.getList(kk);
                if (list) {
                    got = true;
                    for (var j = 0; j < list.count; j++) {
                        try {
                            var one = list.getObjectValue(j);
                            if (one && kEn !== false && one.hasKey(kEn) && one.getBoolean(kEn)) return true;
                        } catch (eJ) {}
                    }
                }
            } catch (eL) { got = false; }
            if (got) continue;

            /* ② 不是列表 -> 按"单个对象"试 */
            try {
                var obj = fx.getObjectValue(kk);
                if (obj && kEn !== false && obj.hasKey(kEn) && obj.getBoolean(kEn)) return true;
            } catch (eO) {}
        }
    } catch (e) {}
    return false;
}

function sid(name) { try { return stringIDToTypeID(name); } catch (e) { return false; } }
function nowMs() { return (new Date()).getTime(); }
function cleanMsg(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 180); } catch (e) { return "" + s; } }

/* ------------------------------ 选项记忆 ------------------------------ */
function prefFile() { try { return File(Folder.userData + "/" + PREF_NAME); } catch (e) { return null; } }
function loadPrefs() {
    var f = prefFile();
    if (!f || !f.exists) return;
    try {
        f.open("r");
        var lines = f.read().split("\n");
        f.close();
        for (var i = 0; i < lines.length; i++) {
            var kv = lines[i].split("=");
            if (kv.length < 2) continue;
            var k = kv[0].replace(/^\s+|\s+$/g, "");
            var v = kv[1].replace(/^\s+|\s+$/g, "");
            if (k === "makeDiffLayer") OPTIONS.makeDiffLayer = (v === "1");
            if (k === "skipHidden") OPTIONS.skipHidden = (v === "1");
            if (k === "dryRun") OPTIONS.dryRun = (v === "1");
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
        f.write("skipHidden=" + (OPTIONS.skipHidden ? "1" : "0") + "\n");
        f.write("dryRun=" + (OPTIONS.dryRun ? "1" : "0") + "\n");
        f.close();
    } catch (e) {}
}

main();


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

/* ------------------------------ 批处理钩子 ------------------------------ */
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


})();
