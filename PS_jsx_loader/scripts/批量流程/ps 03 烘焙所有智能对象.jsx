#target photoshop
/* --------------------------------------------------------------------------
 * 作用域隔离：本脚本会被批处理用 $.evalFile 依次加载，若直接暴露全局变量，
 * 会把上一个脚本的 OPTIONS / RESULT / plog 等覆盖掉（实测会让批处理直接报错）。
 * 所以整段包进立即执行函数，对外不留任何全局名。
 * -------------------------------------------------------------------------- */
(function () {

/* ==========================================================================
 * ps 烘焙所有智能对象.jsx   （v2：进度条 / 无长弹窗 / 支持剪贴蒙版图层）
 *
 * 作用：把文档里所有「智能对象」图层烘焙成普通像素图层。
 *       智能对象（尤其嵌套 PSD 的那种）会一直占着源文件那份内存，烤成像素能明显降内存。
 *
 * 烘焙方法（= 直接在当前图层下面生成空图层，再向下合并）：
 *     记住原混合模式/名字 → 选中智能对象 → AM 新建空图层并放在它"下面"
 *     → 重新选中智能对象 → 向下合并(Mrg2) → 把混合模式和名字改回原来的
 *   注意：建完空层后活动图层是空层，合并前必须重新选中智能对象，
 *         否则 PS 会报「命令"合并图层"当前不可用」。
 *
 * 剪贴蒙版图层怎么烤（不破坏剪贴关系）：
 *     剪贴只影响合成、不影响图层自身像素 → 所以是
 *     临时 layer.grouped = false（取消剪贴）→ 烘焙 → layer.grouped = true 恢复
 *     全程不动其它图层，也不复制图层。
 *
 * 显示：跑的时候有一个进度条窗口（能看出进行到第几个/共几个，可中止）；
 *       结束后只弹一个很短的"结果"窗口（详细内容全部写进日志文件，不再弹长报告）。
 *
 * 安全：只动智能对象；不碰任何显示/隐藏开关；懒解锁（只解锁必要的）；
 *       每个都校验（图层总数不变 + 智能对象特征消失 + 剪贴状态已恢复），
 *       不对就记为失败并把临时状态收拾干净（恢复剪贴、删掉自己建的空层）。
 * ========================================================================== */

var OPTIONS = {
    // 运行前是否弹一个"选项窗"（勾选要做什么）。批量/无人值守时改成 false。
    askOptions: true,
    // 选项窗里勾了"记住我的选择"就会存到一个小配置文件，下次自动带上
    rememberOptions: true,
    // 只处理"当前选中的图层"（选几个烤几个）。用来逐个定位问题图层非常方便。
    // false = 处理整份文档里所有智能对象
    onlySelected: false,
    // 烘焙方式：
    //   "merge"     = 在图层下面建空层再向下合并（默认，与 选择层空对象合并.jsx 一致）
    //   "rasterize" = 原地栅格化（不动图层结构和位置，对"智能滤镜 + 剪贴调整层"这种结构更稳）
    bakeMethod: "auto",        // auto = 有蒙版走栅格化、没蒙版走合并（推荐）
    // ===== 分批烘焙（智能对象很多时用）=====
    // 勾选后：先烤 roundSize 个 → 重新扫描文档里还剩多少智能对象 → 再烤下一轮，直到烤完。
    roundMode: false,
    // 每轮最多烤几个（阈值）
    roundSize: 10,
    // 最多做几轮（防止意外死循环）
    maxRounds: 50,
    // 只处理"当前图层"（100% 可靠，不依赖选区解析）。逐个定位问题时用这个最省事。
    onlyCurrent: false,
    // 高级混合类图层是否跳过（混合裁剪/混合内部/挖空/透明形状图层/蒙版隐藏效果）。
    // 这类图层的效果是"和下面图层一起算出来的"，单独合并进空层会把观感改掉 → 默认跳过并报告。
    skipAdvancedBlending: true,
    // 隐藏的智能对象也烤吗？烤了更省内存（隐藏图层本来就不显示，观感不变）
    skipHidden: false,
    // 剪贴蒙版图层：默认照烤（实测不影响剪贴关系；烤完会校验剪贴状态）
    //                   true  = 直接跳过这类图层
    skipClipping: false,
    // 每轮最多烤几个。0 = 不限（默认）：一次全部烤完
    chunkSize: 0,
    // 跑完清一次缓存（大文件降内存压力；代价：Ctrl+Z 不能整段回退）
    purgeAfter: false,
    // 写进度日志（详细内容都在这里）
    progressLog: true,
    // 显示进度条窗口
    showProgress: true,
    // 结束后是否再弹一个"结果"窗。默认 false：跑完进度窗自己收起，结果全部写日志
    // （避免出现"关不掉的第二个窗口"）
    showResultWindow: false,
    // 把这一轮包成一个历史步骤
    groupUndo: true,
    // true = 只统计、不烘焙
    dryRun: false,

    // ===== ★ 临时功能（对比验证用，测完就去掉）=====
    // 开工前在最顶上盖印一个"对比-烘焙前"图层，并把混合模式设成「差值」。
    // 差值看结果：全黑 = 烘焙没改变任何像素；有亮的地方 = 那里被改动了。
    makeDiffLayer: true,
    // 对比图层的名字（脚本靠它清理上一次留下的那个）
    diffLayerName: "__对比 03-烘焙前(差值)"
};

var R = {
    docName: "?", psVersion: "?",
    total: 0, baked: [], skipped: [], failed: [],
    unlocked: [], elapsed: 0,
    activeId: -1,
    leftBakeable: -1, leftSkipped: -1, bakeableCount: 0, diffLayerMade: false,
    errors: [], attrChanged: [], onlyIds: null, visSnap: null, diffCheckBase: null, diffCheckEnd: null,
    origSOMeta: []
};
var PLOG = { file: null, path: "", enabled: false };
var UI = { win: null, bar: null, label: null, btn: null, cancel: false, ok: false };
var DOC = null;

// ⚠ 入口：所有带初值的全局变量必须定义在这一行之前（函数声明会提升，var 初值不会）

// 每一轮开始前重新扫描：拿到"当前文档里"还能烤的智能对象
function rescanForRound(round) {
    var keepTotal = R.total;
    var keepBakeable = R.bakeableCount;
    var keepSkip = R.skipped.length;

    R.origSOMeta = [];
    collectSmartObjects();

    // 报告口径保持"第一次扫描"的数字，别越滚越大
    R.total = keepTotal;
    R.bakeableCount = keepBakeable;
    while (R.skipped.length > keepSkip) R.skipped.pop();

    var n = countSmartObjectsLeft();
    plog("第 " + round + " 轮前重新扫描：文档里还剩可烤 " + n.bakeable +
         " 个 / 按规则跳过 " + n.skipped + " 个");
}

/* ========================== 主流程 ========================== */
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
    walkLayers(DOC, function (L) {
        var nm = "";
        try { nm = L.name; } catch (e) { return; }
        if (nm && nm.length >= 4 && nm.substring(0, 4) === "__对比") {
            try { if (L.visible !== false) { L.visible = false; n++; } } catch (e2) {}
        }
    });
    return n;
}

function main() {
    var t0 = new Date().getTime();
    try {
        DOC = app.activeDocument;
    } catch (e0) {
        finishShort("没有打开的文档。", "");
        return;
    }
    try { R.psVersion = app.version; } catch (e1) {}
    try { R.docName = DOC.name; } catch (e2) {}
    try { R.activeId = getIdOf(DOC.activeLayer); } catch (e3) {}

    stepMark("OK");   // ★ 先记成功；出错时会被覆盖成 FAIL
    plogSetup();
    plog("===== 烘焙智能对象 开始 =====");
    plog("Photoshop " + R.psVersion + "，文档：" + R.docName);

    // 0) 运行前选项窗（拿不到 ScriptUI 就跳过，走文件里的默认值）
    if (OPTIONS.askOptions) {
        loadOptionsFile();
        if (!askOptionsDialog()) {          // 用户点了取消
            return;
        }
    }

    uiOpen();

    // 0.5) 只烤选中的：先把选区里的图层 ID 取出来（用 AM layerId 精确解析，不靠索引猜）
    if (OPTIONS.onlyCurrent) {
        try { R.onlyIds = [getIdOf(DOC.activeLayer)]; } catch (eOC) { R.onlyIds = []; }
        var curName = "";
        try { curName = safeName(DOC.activeLayer); } catch (eON) {}
        plog("onlyCurrent = true：只处理当前图层【" + curName + "】");
        if (!R.onlyIds || R.onlyIds.length === 0 || R.onlyIds[0] < 0) {
            plog("读不到当前图层，什么都没做。");
            uiClose();
            finishShort("读不到当前图层，什么都没做。", PLOG.path);
            return;
        }
    }
    if (OPTIONS.onlySelected) {
        R.onlyIds = getSelectedLayerIds();
        var nmList = [];
        for (var qi = 0; qi < R.onlyIds.length && qi < 6; qi++) {
            var ql = byId(R.onlyIds[qi]);
            nmList.push(ql ? safeName(ql) : ("#" + R.onlyIds[qi]));
        }
        plog("onlySelected = true：只处理选中的 " + R.onlyIds.length + " 个图层：" +
             nmList.join(" / ") + (R.onlyIds.length > 6 ? " …" : ""));
        if (R.onlyIds.length === 0) {
            plog("没有选中任何图层，什么都没做。");
            uiClose();
            finishShort("没有选中任何图层。\n请先在图层／图层面板里选中要烘焙的图层，再运行。", PLOG.path);
            return;
        }
    }

    // 把本次"生效的选项"写进日志（以后再排查"到底勾没勾"一目了然）
    plog("生效选项：对比图层=" + (OPTIONS.makeDiffLayer ? "开" : "关") +
         "，分批=" + ((OPTIONS.roundMode && OPTIONS.roundSize > 0) ? ("开(每轮 " + OPTIONS.roundSize + ")") : "关") +
         "，方式=" + OPTIONS.bakeMethod +
         "，范围=" + (OPTIONS.onlyCurrent ? "当前图层" : (OPTIONS.onlySelected ? "选中图层" : "整份文档")) +
         "，dryRun=" + (OPTIONS.dryRun ? "开" : "关"));

    // 1) 扫描
    uiStep(0, 1, "正在扫描图层…");
    collectSmartObjects();
    R.bakeableCount = R.origSOMeta.length;
    plog("扫描完成：智能对象 " + R.total + " 个，可烘焙 " + R.bakeableCount +
         " 个，按规则跳过 " + R.skipped.length + " 个");

    // 1.5) ★ 临时：建立"差值"对比图层（盖印的是烘焙前的画面）
    // ★ 放在这里（任何"早退"之前）：只要勾了就要建，不能因为"没有可烤对象"就跳过
    // 记下全文每个图层的眼睛状态（收尾要校验"一个都没被改"）
    try { hideCompareLayers(); } catch (eHC) {}
    R.visSnap = snapshotVisibility();
    plog("已记录 " + countLayers(DOC) + " 个图层的显示状态，收尾会校验一遍");

    if (OPTIONS.makeDiffLayer) makeDiffLayer();


    if (R.total === 0) {
        plog("文档里没有智能对象，什么都没做。");
        uiClose();
        plog("===== 结束 =====");
        finishShort("文档里没有智能对象，什么都没做。", PLOG.path);
        return;
    }

    if (OPTIONS.dryRun) {
        plog("dryRun = true：只统计，不烘焙。");
        uiClose();
        logFullSummary();
        plog("===== 结束 =====");
        finishShort("只统计模式：智能对象 " + R.total + " 个（可烘焙 " + R.bakeableCount +
                    " 个，跳过 " + R.skipped.length + " 个）。", PLOG.path);
        return;
    }

    if (R.bakeableCount === 0) {
        plog("没有可烘焙的智能对象（都被跳过规则排除了）。");
        uiClose();
        logFullSummary();
        plog("===== 结束 =====");
        finishShort("没有可烘焙的智能对象（跳过 " + R.skipped.length + " 个）。", PLOG.path);
        return;
    }

    // 2) 烘焙（支持"分批多轮"：每轮最多 N 个，轮与轮之间重新扫描文档）
    doBakeRounds();

    // 3) 统计收尾
    try {
        var leftInfo = countSmartObjectsLeft();
        R.leftBakeable = leftInfo.bakeable;
        R.leftSkipped = leftInfo.skipped;
    } catch (eL) { R.leftBakeable = -1; R.leftSkipped = -1; }
    // 收尾：校验"没有任何图层的眼睛被改过"，被改过的立即还原
    // 烘焙结束：再测一次差值，和盖印基准对比
    try { checkDiffAfterBake(); } catch (eDC) { plog("（差值对比出错：" + cleanMsg("" + eDC) + "）"); }

    try {
        var visChanged = verifyAndFixVisibility(R.visSnap);
        if (visChanged.length > 0) {
            plog("⚠ 有 " + visChanged.length + " 个图层的显示状态被改动，已还原：" + visChanged.join(" / "));
            R.notes.push("有 " + visChanged.length + " 个图层的显示/隐藏开关在过程中被改过，已全部还原：" + visChanged.join("、"));
        } else {
            plog("✔ 可见性校验：所有图层的显示状态与开始前完全一致");
        }
    } catch (eVis) { plog("（可见性校验出错：" + cleanMsg("" + eVis) + "）"); }
    try { restoreActiveLayer(); } catch (eR) {}
    R.elapsed = Math.round((new Date().getTime() - t0) / 100) / 10;
    plog("本轮结束：已烤 " + R.baked.length + "，失败 " + R.failed.length +
         "；文档里还剩可烤 " + R.leftBakeable + " / 按规则跳过 " + R.leftSkipped);

    // 4) 详细汇总写日志
    logFullSummary();
    plog("===== 结束 =====");

    // 5) 只弹一个很短的结果窗口
    var shortTxt = "完成：烤了 " + R.baked.length + " 个";
    if (R.failed.length > 0) shortTxt += "，失败 " + R.failed.length + " 个";
    if (R.skipped.length > 0) shortTxt += "，跳过 " + R.skipped.length + " 个";
    shortTxt += "\n耗时约 " + R.elapsed + " 秒";
    if (R.leftBakeable > 0) shortTxt += "\n还有 " + R.leftBakeable + " 个没烤（再点一次脚本继续）";
    else if (R.leftBakeable === 0) shortTxt += "\n可烤的已经全部烤完了 ✔";
    if (R.failed.length > 0 || R.skipped.length > 0) shortTxt += "\n失败/跳过的原因都在日志里";
    if (R.diffLayerMade) shortTxt += "\n最上面已建「" + OPTIONS.diffLayerName + "」：\n  全黑=烘焙没改变任何像素；有亮处=被改动过。\n  确认后删掉它（测试完我会去掉这个功能）。";
    finishShort(shortTxt, PLOG.path);
}

/* ==========================================================================
 * 运行前选项窗 + 选项记忆（存在用户数据目录的小文件里）
 * 拿不到 ScriptUI（比如批量脚本环境）时全部跳过，直接跑文件里的默认值。
 * ========================================================================== */
function optionsFilePath() {
    try { return Folder.userData.fsName + "/ps_烘焙智能对象_选项.txt"; } catch (e) {}
    return null;
}

function loadOptionsFile() {
    if (!OPTIONS.rememberOptions) return;
    var p = optionsFilePath();
    if (!p) return;
    try {
        var f = new File(p);
        if (!f.exists) return;
        f.encoding = "UTF-8";
        if (!f.open("r")) return;
        var txt = f.read();
        f.close();
        var lines = ("" + txt).split("\n");
        for (var i = 0; i < lines.length; i++) {
            var t = lines[i].replace(/[\r\n]/g, "").replace(/^\s+|\s+$/g, "");
            if (!t || t.charAt(0) === "#") continue;
            var eq = t.indexOf("=");
            if (eq < 0) continue;
            var k = t.substring(0, eq).replace(/^\s+|\s+$/g, "");
            var v = t.substring(eq + 1).replace(/^\s+|\s+$/g, "");
            if (k === "onlySelected") OPTIONS.onlySelected = (v === "1" || v === "true");
            if (k === "onlyCurrent") OPTIONS.onlyCurrent = (v === "1" || v === "true");
            if (k === "skipAdvancedBlending") OPTIONS.skipAdvancedBlending = (v === "1" || v === "true");
            if (k === "makeDiffLayer") OPTIONS.makeDiffLayer = (v === "1" || v === "true");
            if (k === "roundMode") OPTIONS.roundMode = (v === "1" || v === "true");
            if (k === "roundSize") { var rsv = parseInt(v, 10); if (!isNaN(rsv) && rsv > 0) OPTIONS.roundSize = rsv; }
            if (k === "dryRun") OPTIONS.dryRun = (v === "1" || v === "true");
            if (k === "skipHidden") OPTIONS.skipHidden = (v === "1" || v === "true");
        }
        plog("（已读取上次记住的选项）");
    } catch (e) {}
}

function saveOptionsFile() {
    if (!OPTIONS.rememberOptions) return;
    var p = optionsFilePath();
    if (!p) return;
    try {
        var f = new File(p);
        f.encoding = "UTF-8";
        if (!f.open("w")) return;
        f.write("# 烘焙所有智能对象 的运行选项（脚本自动生成，可手动改）\n");
        f.write("onlySelected=" + (OPTIONS.onlySelected ? "1" : "0") + "\n");
        f.write("onlyCurrent=" + (OPTIONS.onlyCurrent ? "1" : "0") + "\n");
        f.write("skipAdvancedBlending=" + (OPTIONS.skipAdvancedBlending ? "1" : "0") + "\n");
        f.write("makeDiffLayer=" + (OPTIONS.makeDiffLayer ? "1" : "0") + "\n");
        f.write("roundMode=" + (OPTIONS.roundMode ? "1" : "0") + "\n");
        f.write("roundSize=" + OPTIONS.roundSize + "\n");
        f.write("dryRun=" + (OPTIONS.dryRun ? "1" : "0") + "\n");
        f.write("skipHidden=" + (OPTIONS.skipHidden ? "1" : "0") + "\n");
        f.close();
        plog("（已记住这次的选择：" + p + "）");
    } catch (e) {}
}

// 返回 false = 用户取消
function askOptionsDialog() {
    if (batchOn()) return true;
    try {
        if (typeof Window === "undefined") return true;
        var selCount = 0;
        try { selCount = getSelectedLayerIds().length; } catch (e) { selCount = 0; }

        var w = new Window("dialog", "烘焙所有智能对象 —— 运行选项");
        w.orientation = "column";
        w.alignChildren = "left";

        var t = w.add("statictext", undefined, "文档：" + R.docName, { truncate: "middle" });
        t.preferredSize = [430, 20];
        w.add("panel", undefined, "").preferredSize = [430, 1];

        var gScope = w.add("panel", undefined, "处理范围");
        gScope.orientation = "column";
        gScope.alignChildren = "left";
        var curNm = "";
        try { curNm = safeName(DOC.activeLayer); } catch (eCN) {}
        var rbAll = gScope.add("radiobutton", undefined, "整份文档里所有智能对象");
        var rbCur = gScope.add("radiobutton", undefined, "只处理当前图层（【" + curNm + "】）");
        var rbSel = gScope.add("radiobutton", undefined, "只处理当前选中的图层（现在选中 " + selCount + " 个）");
        rbAll.value = !OPTIONS.onlySelected && !OPTIONS.onlyCurrent;
        rbCur.value = !!OPTIONS.onlyCurrent;
        rbSel.value = !!OPTIONS.onlySelected;
        if (selCount === 0) { rbSel.enabled = false; }

        var gWhat = w.add("panel", undefined, "做什么");
        gWhat.orientation = "column";
        gWhat.alignChildren = "left";
        var cbDiff = gWhat.add("checkbox", undefined, "顺便在最上面建一个「差值」对比图层（测试用）");
        var cbAdv = gWhat.add("checkbox", undefined, "跳过高级混合类图层（混合裁剪/混合内部/挖空/透明形状图层）");
        var cbDry = gWhat.add("checkbox", undefined, "只统计、不烘焙（dryRun）");
        var cbHid = gWhat.add("checkbox", undefined, "隐藏的智能对象也跳过");
        cbDiff.value = !!OPTIONS.makeDiffLayer;
        cbAdv.value = !!OPTIONS.skipAdvancedBlending;
        cbDry.value = !!OPTIONS.dryRun;
        cbHid.value = !!OPTIONS.skipHidden;

        var gMet = w.add("panel", undefined, "烘焙方式");
        gMet.orientation = "column";
        gMet.alignChildren = "left";
        var rbAuto = gMet.add("radiobutton", undefined, "自动（有蒙版→栅格化，没蒙版→合并）");
        var rbMerge = gMet.add("radiobutton", undefined, "空对象合并（默认，与你的脚本一致）");
        var rbRast = gMet.add("radiobutton", undefined, "原地栅格化（智能滤镜/剪贴层更稳，不改结构）");
        rbAuto.value = (OPTIONS.bakeMethod === "auto");
        rbMerge.value = (OPTIONS.bakeMethod === "merge");
        rbRast.value = (OPTIONS.bakeMethod === "rasterize");

        var gRound = w.add("panel", undefined, "分批烘焙（智能对象很多时推荐）");
        gRound.orientation = "column";
        gRound.alignChildren = "left";
        var cbRound = gRound.add("checkbox", undefined, "分批做：每轮烤固定个数，轮与轮之间自动重新扫描，直到烤完");
        var gRn = gRound.add("group");
        gRn.add("statictext", undefined, "每轮最多烤：");
        var etRound = gRn.add("edittext", undefined, "" + (OPTIONS.roundSize > 0 ? OPTIONS.roundSize : 10));
        etRound.characters = 5;
        gRn.add("statictext", undefined, "个");
        cbRound.value = !!OPTIONS.roundMode;

        var cbRem = w.add("checkbox", undefined, "记住我的选择（下次自动带上）");
        cbRem.value = !!OPTIONS.rememberOptions;

        var gBtn = w.add("group");
        gBtn.alignment = "right";
        var okBtn = gBtn.add("button", undefined, "开始", { name: "ok" });
        gBtn.add("button", undefined, "取消", { name: "cancel" });

        try { placeWindowOnHostScreen(w); } catch (ePL) {}
        var res = w.show();
        // ScriptUI：对话框点"确定"返回 1，点"取消"返回 0
        if (res !== 1) {
            plog("用户在选项窗点了取消，本次不做任何事。");
            return false;
        }

        // 分批烘焙
        OPTIONS.roundMode = (cbRound.value === true);
        var rv = parseInt(etRound.text, 10);
        if (!isNaN(rv) && rv > 0) OPTIONS.roundSize = rv;

        if (rbRast.value === true) OPTIONS.bakeMethod = "rasterize";
        else if (rbMerge.value === true) OPTIONS.bakeMethod = "merge";
        else OPTIONS.bakeMethod = "auto";
        OPTIONS.onlyCurrent = rbCur.value === true;
        OPTIONS.onlySelected = (rbSel.value === true) && !OPTIONS.onlyCurrent;
        OPTIONS.makeDiffLayer = cbDiff.value === true;
        OPTIONS.skipAdvancedBlending = cbAdv.value === true;
        OPTIONS.dryRun = cbDry.value === true;
        OPTIONS.skipHidden = cbHid.value === true;
        OPTIONS.rememberOptions = cbRem.value === true;
        saveOptionsFile();
        return true;
    } catch (e) {
        // 弹窗出问题就当"用文件里的默认值继续"，绝不因此不干活
        return true;
    }
}

/* ==========================================================================
 * ★ 临时功能：在最顶上盖印一个"差值"对比图层（测试完可以去掉了）
 *   · 盖印用 mergeVisible + duplicate（= Ctrl+Shift+Alt+E），只"多出一层"，
 *     万一没按预期执行（图层数不是 +1）就回滚到操作前的历史状态，绝不吃掉可见图层。
 *   · 混合模式设成「差值」：和下面烘焙后的画面一比，全黑=一个像素都没变。
 * ========================================================================== */
function findTopLevelLayerByName(name) {
    var arr = DOC.layers;
    for (var i = 0; i < arr.length; i++) {
        var nm = "";
        try { nm = arr[i].name; } catch (e) {}
        if (nm === name) return arr[i];
    }
    return null;
}

// 清掉上一次留下的对比图层（避免重复运行越叠越多）
function removeOldDiffLayer() {
    var n = 0, guard = 0;
    var old = findTopLevelLayerByName(OPTIONS.diffLayerName);
    while (old && guard++ < 20) {
        try { old.remove(); n++; } catch (e) { break; }
        old = findTopLevelLayerByName(OPTIONS.diffLayerName);
    }
    if (n > 0) plog("（清掉了上次留下的对比图层 " + n + " 个）");
    return n;
}

// 把图层设成「差值」：先试 DOM，再试 ActionManager，最后核对一次
function setDifferenceBlend(layer) {
    try { layer.blendMode = BlendMode.DIFFERENCE; } catch (e) {}
    if (isDifferenceBlend(layer)) return true;
    try {
        var d = new ActionDescriptor();
        var r = new ActionReference();
        r.putIdentifier(charIDToTypeID("Lyr "), getIdOf(layer));
        d.putReference(charIDToTypeID("null"), r);
        d.putEnumerated(charIDToTypeID("BlnM"), charIDToTypeID("BlnM"), charIDToTypeID("Diff"));
        executeAction(charIDToTypeID("setd"), d, DialogModes.NO);
    } catch (e2) {}
    return isDifferenceBlend(layer);
}

function isDifferenceBlend(layer) {
    try { return ("" + layer.blendMode).toUpperCase().indexOf("DIFFERENCE") >= 0; } catch (e) { return false; }
}
// 读"差值模式下"合成图的直方图：返回 {nonZero, maxIdx}
// nonZero = 非黑像素数；maxIdx = 最深差值（0-255）
function readDiffHistogram() {
    try {
        var hist = DOC.histogram;
        var nonZero = 0, maxIdx = 0;
        for (var hi = 1; hi < hist.length; hi++) {
            if (hist[hi] > 0) { nonZero += hist[hi]; maxIdx = hi; }
        }
        return { nonZero: nonZero, maxIdx: maxIdx };
    } catch (e) { return null; }
}

// 跑完再测一次，和基准对比给结论
function checkDiffAfterBake() {
    if (!R.diffLayerMade || !R.diffCheckBase) return;
    var now = readDiffHistogram();
    if (!now) return;
    R.diffCheckEnd = now;
    var baseMax = R.diffCheckBase.maxIdx;
    var tol = baseMax + 3;                    // 允许比基准稍大一点（噪声波动）
    if (now.nonZero === 0) {
        plog("  ✔ 差值对比（跑完）：画面纯黑 → 烘焙一个像素都没改");
    } else if (now.maxIdx <= tol) {
        plog("  ✔ 差值对比（跑完）：最深 " + now.maxIdx + "/255，与盖印基准 " + baseMax +
             "/255 同量级 → 烘焙没有引入新差异（那点淡色差是盖印自身的噪声）");
    } else {
        plog("  ⚠ 差值对比（跑完）：最深 " + now.maxIdx + "/255，明显超过盖印基准 " + baseMax +
             "/255 → 烘焙改变了像素，请点差值图上的亮处定位图层");
    }
}

// ==========================================================================
// 建立对比图层：打包成历史记录里的一步
//   盖印可见图层 → 改名 → 移到最顶层 → 设差值，这四步原来在历史记录里是三四条，
//   现在整体包进一个 suspendHistory：历史里只出现一条「ps03 建对比层」，一次 Ctrl+Z 全撤。
//   说明：suspendHistory 不允许嵌套，所以 makeDiffLayer() 的调用点要在主流程那个之外——
//         现有代码里 makeDiffLayer() 就是在烘焙的 suspendHistory 之前调的。
// ==========================================================================
function makeDiffLayer() {
    try {
        try { $.global.PSJSX_DIFF = makeDiffLayerBody; } catch (eG) {}
        if (typeof $.global.PSJSX_DIFF !== "function") { return makeDiffLayerBody(); }
        DOC.suspendHistory("ps03 建对比层", "diffHookFn()");
        return true;
    } catch (eH) {
        return makeDiffLayerBody();         // 不支持就退回原样（拆成几步，不影响功能）
    }
}

// 被 suspendHistory 以字符串调用（必须在全局作用域里找得到这个名字）
function diffHookFn() {
    try { return $.global.PSJSX_DIFF(); } catch (e) { return null; }
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


function makeDiffLayerBody() {
    if (diffSkipped()) return false;   // 批处理不建；ps 00_single 会放行
    selectTopVisible();
    removeOldDiffLayer();
    var countBefore = countLayers(DOC);
    var histBefore = null;
    try { histBefore = DOC.activeHistoryState; } catch (eH) {}

    plog("建立对比图层「" + OPTIONS.diffLayerName + "」：盖印当前可见画面 + 混合模式=差值");
    try {
        // 先选中"最上面的图层"，盖印出来的图层才会落在最顶层
        var top = null;
        try { top = DOC.layers[0]; } catch (eT) { top = null; }
        if (top) { try { selectLayerById(getIdOf(top)); } catch (eS) {} }

        if (!stampVisibleWithDuplicate()) {
            plog("  （mergeVisible 不行，改用备用方式：拷贝合并 + 原位粘贴）");
            if (!stampByCopyMerged()) throw new Error("两种盖印方式都失败（mergeVisible / 拷贝合并+粘贴）");
        }

        var made = null;
        try { made = DOC.activeLayer; } catch (eA) { made = null; }
        if (!made) throw new Error("盖印后拿不到活动图层");

        var after = countLayers(DOC);
        if (after !== countBefore + 1) {
            throw new Error("盖印后图层数 " + countBefore + " → " + after + "（不是 +1，可能把可见图层合并掉了）");
        }
        try { made.name = OPTIONS.diffLayerName; } catch (eN) {}

        // ★ 关键：盖印出来的图层必须移到"文档最顶层"，且不能留在图层组里。
        //   否则它会被所在组的混合模式/蒙版/剪贴/不透明度再作用一次 → 出现淡淡色差。
        try {
            var topL = null;
            try { topL = DOC.layers[0]; } catch (eT2) { topL = null; }
            if (topL && getIdOf(topL) !== getIdOf(made)) {
                made.move(topL, ElementPlacement.PLACEBEFORE);
            }
            made = byId(getIdOf(made)) || made;
        } catch (eMv) { plog("  （移到最顶层失败：" + cleanMsg("" + eMv) + "）"); }

        // 校验：它现在必须是"顶层图层"，不能还在组里
        var parentIsDoc = false;
        try { parentIsDoc = (made.parent === DOC); } catch (eP2) { parentIsDoc = false; }
        if (!parentIsDoc) {
            throw new Error("对比图层没能移到文档最顶层（可能还在图层组里），已放弃并撤掉该图层");
        }
        // 差值必须设上：设不上就撤掉这一层 —— 否则它会是一张盖住全图的不透明层
        if (!setDifferenceBlend(made)) {
            try { made.remove(); } catch (eRM) {}
            throw new Error("没法把对比图层设成「差值」混合模式，已撤掉该图层");
        }

        /* ★ 建完立刻关掉对比层的眼睛：
           它是全屏 DIFFERENCE（差值）层，可见时整个画面颜色会彻底变样，
           自动流水线里绝不能留着（用户确认：自动关掉，想看时手动点开）。 */
        try { made.visible = false; } catch (eVis) {}

        R.diffLayerMade = true;
        plog("  ✓ 已建立（最顶层，混合模式=差值）");

        // 数值自检：差值模式下，画面应该是纯黑；不完全黑也正常，那是盖印本身的舍入噪声。
        // 把这个数记成"基准"，跑完再测一次做对比，就能判断烘焙到底有没有改变像素。
        var base = readDiffHistogram();
        if (base) {
            R.diffCheckBase = base;
            if (base.nonZero === 0) {
                plog("  ✔ 差值自检（基准）：画面纯黑（0 个非黑像素）→ 盖印与画面完全一致");
            } else {
                plog("  ℹ 差值自检（基准）：有 " + base.nonZero + " 个非黑像素，最深 " +
                     base.maxIdx + "/255 → 这是盖印本身的舍入噪声（" +
                     (base.maxIdx <= 6 ? "很轻，属正常" : "偏大，留意") + "），不代表烘焙有问题");
            }
        } else {
            plog("  （差值自检不可用：读不到直方图）");
        }
        return true;
    } catch (e) {
        // 回滚到操作前的历史状态，绝不留下"可见图层被吃掉"的后果
        try {
            if (histBefore && DOC.activeHistoryState !== histBefore) DOC.activeHistoryState = histBefore;
            plog("  （已回滚到操作前的历史状态）");
        } catch (eR) {}
        plog("  ✗ 建立对比图层失败：" + cleanMsg("" + e));
        R.errors.push("建立对比图层失败（不影响烘焙）：" + cleanMsg("" + e));
        return false;
    }
}

// 备用盖印：全选 → 拷贝合并 → 原位粘贴（之后会被移到最顶层）
function stampByCopyMerged() {
    try {
        DOC.selection.selectAll();
        var evCopy = sid("copyMerged");
        if (evCopy === false) return false;
        executeAction(evCopy, new ActionDescriptor(), DialogModes.NO);

        var evPaste = sid("paste");
        if (evPaste === false) return false;
        var d = new ActionDescriptor();
        var kInPlace = sid("inPlace");
        if (kInPlace !== false) d.putBoolean(kInPlace, true);
        executeAction(evPaste, d, DialogModes.NO);

        try { DOC.selection.deselect(); } catch (eD) {}
        return true;
    } catch (e) {
        plog("  （备用盖印也出错：" + cleanMsg("" + e) + "）");
        return false;
    }
}

// 盖印可见图层（= Ctrl+Shift+Alt+E；duplicate:true 表示"盖印"而不是"合并"）
function stampVisibleWithDuplicate() {
    var evt = sid("mergeVisible");
    if (evt === false) return false;
    try {
        var d = new ActionDescriptor();
        d.putBoolean(sid("duplicate"), true);
        executeAction(evt, d, DialogModes.NO);
        return true;
    } catch (e) {
        return false;
    }
}

/* ---------- 全文可见性快照 + 收尾校验还原 ----------
 * 原则：脚本绝不改变任何图层的"眼睛"。中途万一被 PS 副作用改掉，收尾时还原并报告。 */
function snapshotVisibility() {
    var map = {};
    walkLayers(DOC, function (layer) {
        var id = getIdOf(layer);
        if (id < 0) return;
        try { map[id] = (layer.visible !== false); } catch (e) {}
    });
    return map;
}

function verifyAndFixVisibility(snap) {
    var changed = [];
    if (!snap) return changed;
    walkLayers(DOC, function (layer) {
        var id = getIdOf(layer);
        if (id < 0 || snap[id] === undefined) return;
        var cur = true;
        try { cur = (layer.visible !== false); } catch (e) { return; }
        if (cur !== snap[id]) {
            try { layer.visible = snap[id]; changed.push(safeName(layer)); } catch (e2) {}
        }
    });
    return changed;
}

/* ---------- 扫描：找出所有智能对象 ---------- */
function collectSmartObjects() {
    walkLayers(DOC, function (layer, path) {
        var id = getIdOf(layer);
        if (id < 0) return;
        var desc = getLayerDescriptor(id);
        if (!desc) return;
        var keySet = {};
        try { collectKeyNames(desc, keySet, 2); } catch (eK) {}
        if (!isSmartObject(keySet)) return;

        // 只烤选中的：不在选区里就整条忽略（不算"跳过"，不写进报告以免噪音）
        if (R.onlyIds && !inIdList(R.onlyIds, id)) return;

        R.total++;
        var whySkip = skipReasonFor(layer);
        if (whySkip) {
            R.skipped.push({ path: path, why: whySkip });
            return;
        }
        // 特殊结构：先记下来（报告里会写清楚），高级混合这类默认跳过
        var traits = specialTraits(getLayerDescriptor(id), keySet);
        if (OPTIONS.skipAdvancedBlending && traits.hard.length > 0) {
            R.skipped.push({ path: path, why: "高级混合类，单独烘焙会改观感 → 已跳过（" + traits.hard.join("、") + "）" });
            return;
        }
        R.origSOMeta.push({
            id: id, path: path,
            traits: traits.soft,
            hadMask: (keySet["userMaskEnabled"] || keySet["userMask"] ||
                      keySet["vectorMaskEnabled"] || keySet["vmsk"]) ? true : false,
            hadFilter: (keySet["filterFX"] || keySet["filterFXList"] ||
                        keySet["class:FilterFX"]) ? true : false
        });
    });
}

/* ---------- 取"当前选中的图层"ID ----------
 * targetLayers 给的是一串索引；索引怎么解释交给 Photoshop 自己（问它 layerId），
 * 我们不做索引→图层的猜测，避免烤错图层。 */
function getSelectedLayerIds() {
    var ids = [];
    var raw = "";
    try {
        var ref = new ActionReference();
        ref.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("targetLayers"));
        ref.putEnumerated(charIDToTypeID("Dcmn"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        var d = executeActionGet(ref);
        var key = stringIDToTypeID("targetLayers");
        if (d.hasKey(key)) {
            var lst = d.getList(key);
            raw = "targetLayers 共 " + lst.count + " 项";
            for (var i = 0; i < lst.count; i++) {
                var idx = -1;
                try { idx = lst.getReference(i).getIndex(); } catch (e1) { idx = -1; }
                if (idx <= 0) continue;
                var lid = idBySelectingIndex(idx);
                if (lid > 0 && !inIdList(ids, lid)) ids.push(lid);
            }
        } else {
            raw = "描述符里没有 targetLayers 键";
        }
    } catch (e) {
        raw = "读 targetLayers 失败：" + cleanMsg("" + e);
    }
    plog("选区解析：" + raw + " → 解析出 " + ids.length + " 个图层");
    if (ids.length === 0) {
        try { ids.push(getIdOf(DOC.activeLayer)); } catch (e2) {}
        plog("选区没解析出来，退回【当前图层】这一个。");
    }
    return ids;
}

// 最稳的做法：让 PS 按 AM 序号选中它，再问"当前图层"的 id（不猜任何属性名）
function idBySelectingIndex(idx) {
    try {
        var d = new ActionDescriptor();
        var r = new ActionReference();
        r.putIndex(charIDToTypeID("Lyr "), idx);
        d.putReference(charIDToTypeID("null"), r);
        d.putBoolean(charIDToTypeID("MkVs"), false);
        executeAction(charIDToTypeID("slct"), d, DialogModes.NO);
        return getIdOf(DOC.activeLayer);
    } catch (e) { return -1; }
}

function inIdList(list, id) {
    for (var i = 0; i < list.length; i++) { if (list[i] === id) return true; }
    return false;
}

/* ---------- 特殊结构检测 ----------
 * hard = 单独合并会改观感的（高级混合类）→ 默认跳过
 * soft = 只是"要知道"的（图层样式/填充不透明度等）→ 照烤，但写进日志 */
function specialTraits(desc, keySet) {
    var hard = [], soft = [];
    if (truthyDeep(desc, "blendClipped")) hard.push("高级混合：混合裁剪元素");
    if (truthyDeep(desc, "blendInterior")) hard.push("高级混合：混合内部元素");
    if (keySet["knockout"]) {
        var ko = readValueDeep(desc, "knockout", 3);
        var kov = (ko.found && ko.value !== null) ? ("" + ko.value).toLowerCase() : "";
        if (kov && kov.indexOf("none") < 0) hard.push("挖空：" + kov);
    }
    if (truthyDeep(desc, "transparencyShapesLayer")) hard.push("透明形状图层");
    if (truthyDeep(desc, "layerMaskAsGlobalMask")) hard.push("蒙版隐藏本图层效果");
    if (truthyDeep(desc, "vectorMaskAsGlobalMask")) hard.push("矢量蒙版隐藏本图层效果");
    if (keySet["Lefx"] || keySet["layerEffects"] || keySet["class:layerEffects"]) soft.push("带图层样式");
    if (keySet["fillOpacity"]) {
        var fo = readFillOpacity(desc);
        if (fo !== null && fo < 99.99) soft.push("填充不透明度 " + fo + "%");
    }
    return { hard: hard, soft: soft };
}

function truthyDeep(o, keyName, depth) {
    var d = (depth === undefined) ? 3 : depth;
    var r = readValueDeep(o, keyName, d);
    return (r.found && r.value === true) ? true : false;
}

function readValueDeep(o, keyName, depth) {
    if (!o) return { found: false, value: null };
    var n = 0;
    try { n = o.count; } catch (e) { return { found: false, value: null }; }
    for (var i = 0; i < n; i++) {
        var k = null;
        try { k = o.getKey(i); } catch (e2) { continue; }
        var ks = "";
        try { ks = typeIDToStringID(k); } catch (e3) { ks = ""; }
        if (ks === keyName) {
            var v = null;
            try { v = o.getInteger(k); } catch (e4) {
                try { v = o.getBoolean(k); } catch (e5) {
                    try { v = o.getDouble(k); } catch (e6) { v = null; }
                }
            }
            return { found: true, value: v };
        }
    }
    if (depth <= 0) return { found: false, value: null };
    for (var j = 0; j < n; j++) {
        var k2 = null;
        try { k2 = o.getKey(j); } catch (e7) { continue; }
        var t = null;
        try { t = o.getType(k2); } catch (e8) { continue; }
        if (t == DescValueType.OBJECTTYPE) {
            var r1 = readValueDeep(o.getObjectValue(k2), keyName, depth - 1);
            if (r1.found) return r1;
        } else if (t == DescValueType.LISTTYPE) {
            try {
                var lst = o.getList(k2);
                for (var m = 0; m < lst.count; m++) {
                    if (lst.getType(m) == DescValueType.OBJECTTYPE) {
                        var r2 = readValueDeep(lst.getObjectValue(m), keyName, depth - 1);
                        if (r2.found) return r2;
                    }
                }
            } catch (e9) {}
        }
    }
    return { found: false, value: null };
}

function readFillOpacity(desc) {
    var r = readValueDeep(desc, "fillOpacity", 1);
    if (!r.found) return null;
    try { return Math.round((r.value * 100) * 100) / 100; } catch (e) { return null; }
}

/* ---------- 烘焙前后属性对比 ---------- */
function layerAttrs(layer) {
    var a = { name: "", blend: "", opacity: "", fill: "", grouped: "", visible: "" };
    try { a.name = layer.name; } catch (e0) {}
    try { a.blend = "" + layer.blendMode; } catch (e1) {}
    try { a.opacity = "" + layer.opacity; } catch (e2) {}
    try { a.fill = "" + layer.fillOpacity; } catch (e3) {}
    try { a.grouped = (layer.grouped === true) ? "true" : "false"; } catch (e4) {}
    try { a.visible = (layer.visible !== false) ? "true" : "false"; } catch (e5) {}
    return a;
}

// 返回 { hard:[], soft:[] }
//   hard = 真的会影响观感（混合模式/填充不透明度/剪贴/可见性）
//   soft = 会被"烤进像素"、观感不受影响的（不透明度：04 那份差值纯黑已实测证明）
function attrsDiff(before, after) {
    var hard = [], soft = [];
    if (before.blend !== after.blend) hard.push("混合模式 " + before.blend + " → " + after.blend);
    if (before.fill !== after.fill) hard.push("填充不透明度 " + before.fill + " → " + after.fill);
    if (before.grouped !== after.grouped) hard.push("剪贴 " + before.grouped + " → " + after.grouped);
    if (before.visible !== after.visible) hard.push("可见性 " + before.visible + " → " + after.visible);
    if (before.opacity !== after.opacity) soft.push("不透明度 " + before.opacity + " → " + after.opacity);
    return { hard: hard, soft: soft };
}

/* ---------- 这个智能对象该不该跳过 ---------- */
function skipReasonFor(layer) {
    if (isBackground(layer)) return "背景层（下面插不进图层）";
    if (OPTIONS.skipClipping && isGroupedLayer(layer)) {
        return "剪贴蒙版图层（OPTIONS.skipClipping = true 时跳过）";
    }
    var vis = true;
    try { vis = (layer.visible !== false); } catch (eV) {}
    if (!vis && OPTIONS.skipHidden) return "隐藏图层（OPTIONS.skipHidden = true）";
    return null;
}

/* ---------- 烘焙一段（给 suspendHistory 用，参数必须全局可见） ---------- */
function bakeRange(from, to) {
    R.rangeStarted = true;
    for (var i = from; i < to; i++) {
        if (UI.cancel) {
            plog("用户点了中止，停在 " + i + "/" + to);
            R.failed.push({ path: "（用户中止）", why: "在第 " + (i + 1) + " 个处点了中止" });
            break;
        }
        var meta = R.origSOMeta[i];
        if (!meta) continue;
        try {
            bakeOneSmartObject(meta, i + 1, to);
        } catch (eOne) {
            R.failed.push({ path: meta.path, why: cleanMsg("" + eOne) });
            plog("  ✗ 单个烘焙异常：" + cleanMsg("" + eOne));
        }
    }
}

function bakeOneSmartObject(meta, idx, total) {
    var tags = [];
    if (meta.hadMask) tags.push("带蒙版");
    if (meta.hadFilter) tags.push("带智能滤镜");
    plog("烘焙：" + meta.path + (tags.length ? ("（" + tags.join("/") + "）") : ""));
    uiStep(idx - 1, total, meta.path);

    var layer = byId(meta.id);
    if (!layer) {
        R.failed.push({ path: meta.path, why: "找不到图层了（可能已被合并）" });
        plog("  ✗ 找不到图层了");
        return;
    }
    var d0 = getLayerDescriptor(meta.id);
    var ks0 = {};
    try { collectKeyNames(d0, ks0, 2); } catch (eK0) {}
    if (!isSmartObject(ks0)) {
        R.skipped.push({ path: meta.path, why: "已经不是智能对象了" });
        plog("  - 已经不是智能对象，跳过");
        return;
    }

    var blendBefore = null, nameBefore = "";
    try { blendBefore = layer.blendMode; } catch (eB) {}
    try { nameBefore = layer.name; } catch (eN) {}
    var attrsBefore = layerAttrs(layer);
    var visibleBefore = true;
    try { visibleBefore = (layer.visible !== false); } catch (eVB) {}
    if (meta.traits && meta.traits.length > 0) {
        plog("  （结构提示：" + meta.traits.join("、") + "）");
    }
    plog("  属性（前）：混合=" + attrsBefore.blend + " 不透明度=" + attrsBefore.opacity +
         " 填充=" + attrsBefore.fill + " 剪贴=" + attrsBefore.grouped + " 可见=" + attrsBefore.visible);
    var wasClipped = isGroupedLayer(layer);
    // 这张图层有没有"会限制显示"的蒙版（合并会把它弄丢 → 这种情况必须用原地栅格化）
    var descNow = getLayerDescriptor(meta.id);
    var ksNow = {};
    try { collectKeyNames(descNow, ksNow, 2); } catch (eKs) {}
    var hasMaskNow = (ksNow["userMaskEnabled"] || ksNow["userMask"] ||
                      ksNow["vectorMaskEnabled"] || ksNow["vmsk"] ||
                      ksNow["hasFilterMask"] || ksNow["filterMaskEnabled"]) ? true : false;
    var method = OPTIONS.bakeMethod;
    if (method === "auto") method = hasMaskNow ? "rasterize" : "merge";
    if (hasMaskNow && method === "merge") {
        plog("  ⚠ 这个图层有蒙版，而方式是【空对象合并】—— 合并可能把蒙版弄丢（观感会变）");
    }
    if (method === "rasterize" && hasMaskNow) {
        plog("  （有蒙版 → 自动改用原地栅格化，蒙版和结构都不动）");
    }
    var countBefore = countLayers(DOC);
    var emptyId = -1;
    var unclipped = false;

    try {
        // 只解锁"这一个图层 + 挡住它的上级组"
        var unlocked = unlockForEdit(layer);
        for (var u = 0; u < unlocked.length; u++) {
            R.unlocked.push({ path: meta.path, what: unlocked[u] });
            plog("  （解锁：" + unlocked[u] + "）");
        }

        // （实测不需要取消剪贴：下面建空层再向下合并，不会影响剪贴蒙版图层）
        if (false && wasClipped) {   // 已停用：实测不需要取消剪贴
            try { layer.grouped = false; unclipped = true; plog("  （临时取消剪贴）"); } catch (eG) {}
        }

        // ---- 烘焙：直接在当前图层"下面"生成空图层，再向下合并 ----
        // 隐藏图层不能"向下合并"（PS 会报 命令"合并图层"当前不可用）→ 先临时显示，烤完再藏回去
        if (visibleBefore === false) {
            try { layer.visible = true; markDirty(); plog("  （临时显示：隐藏图层无法向下合并）"); } catch (eV1) {}
        }
        // ---- 方式二：原地栅格化（不建空层、不改位置结构）----
        if (method === "rasterize") {
            selectLayerById(meta.id);
            var okR = false;
            try { layer.rasterize(RasterizeType.PLACED); okR = true; } catch (eR1) {}
            if (!okR) { try { layer.rasterize(RasterizeType.ENTIRELAYER); okR = true; } catch (eR2) {} }
            if (!okR) throw new Error("原地栅格化失败（PLACED / ENTIRELAYER 都不行）");
            // 校验：还是同一个图层（id 不变）、总数不变、不再是智能对象
            var still = byId(meta.id);
            if (!still) throw new Error("栅格化后图层 id 变了（不应该）");
            if (countLayers(DOC) !== countBefore) throw new Error("栅格化后图层数变了（不应该）");
            var ksR = {};
            try { collectKeyNames(getLayerDescriptor(meta.id), ksR, 2); } catch (eK3) {}
            if (isSmartObject(ksR)) throw new Error("栅格化后它还是智能对象");
            R.baked.push({ path: meta.path, diffs: [] });
            plog("  ✓ 成功（原地栅格化，图层 id 未变）");
            return;
        }

        selectLayerById(meta.id);
        // ★ 与「选择层空对象合并.jsx」完全一致：新建图层 → 移到当前图层"下面"
        //   （之前用 AM 的 Mk+below，在"带多个智能滤镜 + 剪贴调整层"的这种结构上会合错层）
        var emptyLayer = null;
        try { emptyLayer = DOC.artLayers.add(); } catch (eAdd) { emptyLayer = null; }
        if (!emptyLayer) throw new Error("新建空图层失败（artLayers.add）");
        try { emptyLayer.move(layer, ElementPlacement.PLACEAFTER); } catch (eMv0) {
            throw new Error("把空层移到本图层下面失败：" + cleanMsg("" + eMv0));
        }
        try { emptyId = getIdOf(emptyLayer); } catch (eA1) { emptyId = -1; }
        // ★★ 关键：建完空层后活动图层是空层，合并前必须重新选中智能对象
        selectLayerById(meta.id);
        var idsBefore2 = layerIdSet();                 // 合并前记下所有图层 id
        mergeDown();                                   // Mrg2
        // 校验：只允许"我自己建的那个空层"消失，别的图层一个都不许少（合错层会被抓到）
        try {
            var missing = idsLostExcept(idsBefore2, emptyId);
            if (missing.length > 0) {
                plog("  ⚠ 合并时少了 " + missing.length + " 个不该少的图层（可能合错了层）：" +
                     missing.slice(0, 5).join(" / "));
            }
        } catch (eChk) {}
        var merged = null;
        try { merged = DOC.activeLayer; } catch (eA) { merged = null; }
        if (!merged) throw new Error("合并后拿不到活动图层");
        if (blendBefore !== null) { try { merged.blendMode = blendBefore; } catch (eBM) {} }
        if (nameBefore) { try { merged.name = nameBefore; } catch (eNM) {} }

        // ★ 还原可见性：向下合并的结果继承的是"下面那个空层"的可见性，
        //   所以隐藏的智能对象会被点亮（观感直接变了）→ 必须还原
        try {
            if (visibleBefore === false) { merged.visible = false; }
            else { merged.visible = true; }
        } catch (eVis) {
            throw new Error("烘好了但可见性还原失败，请手动把这个图层设回原来的显示状态");
        }

        // 事后校验：原本是剪贴蒙版的话，合并结果也必须是剪贴蒙版（没继承就补回）
        if (wasClipped && !isGroupedLayer(merged)) {
            try { merged.grouped = true; plog("  （剪贴状态没继承，已补回）"); } catch (eG2) {
                throw new Error("烘好了但剪贴状态没恢复，请手动把这个图层设为剪贴蒙版");
            }
        }

        // 恢复剪贴
        if (unclipped) {
            try { merged.grouped = true; unclipped = false; plog("  （剪贴已恢复）"); } catch (eG2) {
                throw new Error("烘好了但剪贴恢复失败，请手动把这个图层设为剪贴蒙版");
            }
        }

        // 校验
        var countAfter = countLayers(DOC);
        if (countAfter !== countBefore) {
            throw new Error("烘焙后图层数从 " + countBefore + " 变成 " + countAfter + "（不对劲）");
        }
        var d1 = getLayerDescriptor(getIdOf(merged));
        var ks1 = {};
        try { collectKeyNames(d1, ks1, 2); } catch (eK1) {}
        if (isSmartObject(ks1)) throw new Error("合并后它还是智能对象（可能被锁挡住了）");
        if (wasClipped && !isGroupedLayer(merged)) throw new Error("剪贴状态没恢复成剪贴蒙版");

        // 烘焙后属性比对：有差异就明确写出来（这是"整块观感变了"最常见的根因）
        // 校验：原本有蒙版的，合并后蒙版不该凭空消失
        if (hasMaskNow) {
            var ksChk = {};
            try { collectKeyNames(getLayerDescriptor(getIdOf(merged)), ksChk, 2); } catch (eKc) {}
            var stillMask = (ksChk["userMaskEnabled"] || ksChk["userMask"] ||
                             ksChk["vectorMaskEnabled"] || ksChk["filterMaskEnabled"]) ? true : false;
            if (!stillMask) {
                plog("  ⚠ 合并后这个图层的蒙版不见了 —— 观感可能已经变了，这类图层请改用【原地栅格化】");
                R.notes.push("图层「" + meta.path + "」原本有蒙版，用空对象合并后蒙版消失（观感可能变）—— " +
                             "这类图层请改用原地栅格化。");
            }
        }

        var attrsAfter = layerAttrs(merged);
        var diffs = attrsDiff(attrsBefore, attrsAfter);
        R.baked.push({ path: meta.path, diffs: diffs.hard });
        if (diffs.hard.length > 0 || diffs.soft.length > 0) {
            plog("  属性（后）：混合=" + attrsAfter.blend + " 不透明度=" + attrsAfter.opacity +
                 " 填充=" + attrsAfter.fill + " 剪贴=" + attrsAfter.grouped + " 可见=" + attrsAfter.visible);
        }
        if (diffs.hard.length > 0) {
            plog("  ⚠ 属性发生变化：" + diffs.hard.join("；") + "（这可能就是观感变了的根因，请重点看这个图层）");
            R.attrChanged.push({ path: meta.path, diffs: diffs.hard });
        }
        if (diffs.soft.length > 0) {
            plog("  ℹ " + diffs.soft.join("；") + "（不透明度会被烤进像素，观感不受影响）");
        }
        plog("  ✓ 成功（图层数 " + countAfter + "，混合模式 " + blendBefore +
             (wasClipped ? "，仍为剪贴蒙版" : "") + "）");
    } catch (e) {
        R.failed.push({ path: meta.path, why: cleanMsg("" + e) });
        plog("  ✗ 失败：" + cleanMsg("" + e));
        // 失败也要把可见性还原（可能刚被临时显示过）
        try {
            var backVis = byId(meta.id);
            if (backVis && visibleBefore === false) { backVis.visible = false; }
        } catch (eVB2) {}
        // 把临时状态收拾干净：剪贴恢复、自己建的空层删掉
        try {
            var back = byId(meta.id);
            if (back && wasClipped) { try { back.grouped = true; } catch (eG3) {} }
        } catch (eB2) {}
        try {
            if (emptyId > 0) {
                var stray = byId(emptyId);
                if (stray) { stray.remove(); plog("  （已清掉刚才多建的空层）"); }
            }
        } catch (eC) { plog("  （清理空层失败，你可以手动删或 Ctrl+Z）"); }
    }
}

/* ---------- 在当前图层下面新建一个空图层（AM：Mk + below） ---------- */
// 全文图层 id 集合（合并前后对比用；id 唯一，比名字可靠）
function layerIdSet() {
    var map = {};
    walkLayers(DOC, function (layer) {
        var id = getIdOf(layer);
        if (id >= 0) map[id] = safeName(layer);
    });
    return map;
}

// 合并后：除了"我自己建的空层"(emptyId)，还有哪些图层消失了？（返回名字列表）
function idsLostExcept(before, emptyId) {
    var after = layerIdSet();
    var lost = [];
    for (var id in before) {
        if (parseInt(id, 10) === emptyId) continue;      // 自己建的空层消失是正常的
        if (!after[id]) lost.push(before[id]);
    }
    return lost;
}

function makeLayerBelow(name) {
    var belowKey = sid("below");
    if (belowKey === false) return false;
    try {
        var d = new ActionDescriptor();
        var r = new ActionReference();
        r.putClass(charIDToTypeID("Lyr "));
        d.putReference(charIDToTypeID("null"), r);
        d.putBoolean(belowKey, true);
        var u = new ActionDescriptor();
        u.putString(charIDToTypeID("Nm  "), name);
        d.putObject(charIDToTypeID("Usng"), charIDToTypeID("Lyr "), u);
        executeAction(charIDToTypeID("Mk  "), d, DialogModes.NO);
        return true;
    } catch (e) {
        return false;
    }
}

/* ---------- 解锁：只解锁这个图层 + 挡住它的上级组 ---------- */
function unlockForEdit(layer) {
    var rec = [];
    var l = layer;
    var guard = 0;
    while (l && guard++ < 60) {
        try {
            if (l.allLocked) {
                l.allLocked = false;
                rec.push(safeName(l));
                markDirty();
            } else {
                var changed = false;
                try { if (l.protectTransparency) { l.protectTransparency = false; changed = true; } } catch (e1) {}
                try { if (l.protectPosition) { l.protectPosition = false; changed = true; } } catch (e2) {}
                try { if (l.protectComposite) { l.protectComposite = false; changed = true; } } catch (e3) {}
                if (changed) { rec.push(safeName(l) + "（部分锁定）"); markDirty(); }
            }
        } catch (e0) {}
        if (l == DOC) break;
        var next = null;
        try { next = l.parent; } catch (eP) { next = null; }
        if (!next || next == l) break;
        l = next;
    }
    return rec;
}

/* ---------- 统计 ---------- */
function countSmartObjectsLeft() {
    var bakeable = 0, skipped = 0;
    walkLayers(DOC, function (layer) {
        var id = getIdOf(layer);
        if (id < 0) return;
        var d = getLayerDescriptor(id);
        var ks = {};
        try { collectKeyNames(d, ks, 2); } catch (e) {}
        if (!isSmartObject(ks)) return;
        if (skipReasonFor(layer)) skipped++; else bakeable++;
    });
    return { bakeable: bakeable, skipped: skipped };
}

/* ---------- 判断 ---------- */
function isSmartObject(keySet) {
    return (keySet["smartObject"] || keySet["class:smartObject"] ||
            keySet["placedLayer"] || keySet["class:placedLayer"]) ? true : false;
}

function isBackground(layer) {
    try { return layer.isBackgroundLayer ? true : false; } catch (e) { return false; }
}

function isGroupedLayer(layer) {
    try { return layer.grouped ? true : false; } catch (e) { return false; }
}

/* ---------- 遍历图层（带路径） ---------- */
function walkLayers(container, cb) { walkLayersWithPath(container, "", cb); }

function walkLayersWithPath(container, prefix, cb) {
    var arr = container.layers;
    for (var i = 0; i < arr.length; i++) {
        var l = arr[i];
        var nm = safeName(l);
        var full = (prefix ? (prefix + " / ") : "") + nm;
        cb(l, full);
        var isGroup = false;
        try { isGroup = (l.typename == "LayerSet"); } catch (e) {}
        if (isGroup) walkLayersWithPath(l, full, cb);
    }
}

function walkAll(container, cb) {
    var arr = container.layers;
    for (var i = 0; i < arr.length; i++) {
        cb(arr[i]);
        var isGroup = false;
        try { isGroup = (arr[i].typename == "LayerSet"); } catch (e) {}
        if (isGroup) walkAll(arr[i], cb);
    }
}

function byId(id) {
    var found = null;
    walkAll(DOC, function (l) {
        if (found) return;
        if (getIdOf(l) === id) found = l;
    });
    return found;
}

function countLayers(container) {
    var n = 0;
    walkAll(container, function () { n++; });
    return n;
}

function getIdOf(layer) {
    try { return layer.id; } catch (e) { return -1; }
}

function safeName(layer) {
    try { return layer.name; } catch (e) { return "?"; }
}

function selectLayerById(id) {
    var d = new ActionDescriptor();
    var r = new ActionReference();
    r.putIdentifier(charIDToTypeID("Lyr "), id);
    d.putReference(charIDToTypeID("null"), r);
    d.putBoolean(charIDToTypeID("MkVs"), false);
    executeAction(charIDToTypeID("slct"), d, DialogModes.NO);
}

function mergeDown() {
    executeAction(charIDToTypeID("Mrg2"), new ActionDescriptor(), DialogModes.NO);
}

function getLayerDescriptor(id) {
    try {
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), id);
        return executeActionGet(ref);
    } catch (e) { return null; }
}

function collectKeyNames(desc, out, depth) {
    if (!desc) return out;
    var n = 0;
    try { n = desc.count; } catch (e) { return out; }
    for (var i = 0; i < n; i++) {
        var k = null;
        try { k = desc.getKey(i); } catch (e2) { continue; }
        var ks = "";
        try { ks = typeIDToStringID(k); } catch (e3) { ks = ""; }
        if (ks) out[ks] = true;
        var cls = null;
        try { cls = desc.getObjectType(k); } catch (e4) { cls = null; }
        if (cls !== null && cls !== undefined) {
            var cs = "";
            try { cs = typeIDToStringID(cls); } catch (e5) { cs = ""; }
            if (cs) out["class:" + cs] = true;
        }
        if (depth <= 0) continue;
        var t = null;
        try { t = desc.getType(k); } catch (e6) { continue; }
        if (t == DescValueType.OBJECTTYPE) {
            try { collectKeyNames(desc.getObjectValue(k), out, depth - 1); } catch (e7) {}
        } else if (t == DescValueType.LISTTYPE) {
            try {
                var lst = desc.getList(k);
                for (var j = 0; j < lst.count; j++) {
                    if (lst.getType(j) == DescValueType.OBJECTTYPE) {
                        collectKeyNames(lst.getObjectValue(j), out, depth - 1);
                    }
                }
            } catch (e8) {}
        }
    }
    return out;
}

function restoreActiveLayer() {
    if (R.activeId >= 0) {
        try { selectLayerById(R.activeId); } catch (e) {}
    }
}

function markDirty() { try { app.activeDocument.activeLayer = app.activeDocument.activeLayer; } catch (e) {} }

function sid(name) { try { return stringIDToTypeID(name); } catch (e) { return false; } }

/* ---------- 进度窗口（ScriptUI；拿不到就只用日志） ---------- */
function uiOpen() {
    if (!OPTIONS.showProgress) return;
    try {
        if (typeof Window === "undefined") return;
        UI.win = new Window("palette", "烘焙智能对象", undefined, { resizeable: false });
        UI.win.orientation = "column";
        UI.win.alignChildren = "fill";
        UI.label = UI.win.add("statictext", undefined, "准备中…", { truncate: "middle" });
        UI.label.preferredSize = [420, 34];
        UI.bar = UI.win.add("progressbar", undefined, 0, 100);
        UI.bar.preferredSize = [420, 14];
        var row = UI.win.add("group");
        row.alignment = "right";
        UI.btn = row.add("button", undefined, "中止");
        UI.btn.onClick = function () { UI.cancel = true; UI.label.text = "正在中止…（做完当前这个就停）"; };
        try { placeWindowOnHostScreen(UI.win); } catch (ePL) {}
        UI.win.show();
        UI.ok = true;
    } catch (e) {
        UI.ok = false;
        plog("（进度窗口打不开，只用日志：" + cleanMsg("" + e) + "）");
    }
}

function uiStep(done, total, text) {
    if (!UI.ok || !UI.win) return;
    try {
        UI.bar.value = total > 0 ? Math.round(done * 100 / total) : 0;
        UI.label.text = "(" + done + "/" + total + ") " + ("" + text).substring(0, 60);
        UI.win.update();
    } catch (e) {}
}

function uiClose() {
    if (!UI.win) { UI.ok = false; return; }
    try { UI.win.hide(); } catch (e0) {}
    try { UI.win.visible = false; } catch (e1) {}
    try { UI.win.close(); } catch (e2) { plog("（进度窗关不掉，你可以手动点右上角关闭：" + cleanMsg("" + e2) + "）"); }
    try { UI.win = null; } catch (e3) {}
    UI.ok = false;
}

// 结束前把进度窗变成"结果"显示，用户点关闭后脚本再结束（一个窗口搞定，不留僵尸窗）
function uiFinishWindow(shortText) {
    if (batchOn()) return;
    if (!UI.win) return;
    try {
        if (UI.label) UI.label.text = shortText;
        if (UI.bar) UI.bar.value = 100;
        if (UI.btn) {                       // 把"中止"换成"关闭"，避免歧义
            UI.btn.text = "关闭";
            UI.btn.onClick = function () { try { UI.win.close(); } catch (e) {} };
        }
        UI.win.text = "烘焙智能对象 —— 完成";
        UI.win.update();
    } catch (e) {}
    // 不用第二个窗口：这一句就是最后一步，用户点"关闭"即结束
    // 不再保留窗口、也不再弹第二个窗口：结果全部写进日志
    uiClose();
}

/* ---------- 结束：简短结果窗口 + 详细汇总写日志（不弹长 alert） ---------- */
function finishShort(shortText, logPath) {
    var txt = shortText;
    if (logPath) txt += "\n\n详细日志：\n" + logPath;

    // 窗口里显示的内容也写进日志（这样日志是完整的，不用回头找窗口）
    var sl = ("" + shortText).split("\n");
    for (var si = 0; si < sl.length; si++) plog("结果：" + sl[si]);

    // 默认不弹第二个窗口：进度窗自己变成"结果"，用户点关闭就结束
    if (!OPTIONS.showResultWindow) {
        uiFinishWindow(shortText);
        return;
    }
    try {
        if (typeof Window === "undefined") return;
        var w = new Window("dialog", "烘焙智能对象 —— 结果");
        w.orientation = "column";
        w.alignChildren = "left";
        var t = w.add("statictext", undefined, txt, { multiline: true });
        t.preferredSize = [460, 120];
        var g = w.add("group");
        g.alignment = "right";
        g.add("button", undefined, "关闭", { name: "ok" });
        try { placeWindowOnHostScreen(w); } catch (ePL) {}
        w.show();
    } catch (e) {}
}

/* ---------- 日志 ---------- */
function plogTime() {
    var d = new Date();
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }

function plog(s) {
    if (!PLOG.enabled || !PLOG.file) return;
    try {
        PLOG.file.encoding = "UTF-8";
        if (PLOG.file.open("a")) {
            PLOG.file.write("[" + plogTime() + "] " + s + "\r\n");
            PLOG.file.close();
        }
    } catch (e) {}
}

function logFullSummary() {
    var full = buildSummary("").split("\r\n");
    plog("");
    plog("========== 汇总 ==========");
    for (var i = 0; i < full.length; i++) plog(full[i]);
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

function plogSetup() {
    if (!OPTIONS.progressLog) return;
    var name = baseName(R.docName) + "_烘焙智能对象日志.txt";
    var f = null;
    try { var __ld = ensureLogFolder(); if (__ld) f = new File(__ld.fsName + "/" + name); } catch (e) {}
    if (!f) { try { f = new File(Folder.desktop.fsName + "/" + name); } catch (e2) {} }
    if (!f) return;
    try { if (f.exists) f.remove(); } catch (e3) {}
    PLOG.file = f;
    PLOG.path = f.fsName;
    PLOG.enabled = true;
}

function baseName(n) {
    var s = "" + n;
    var i = s.lastIndexOf(".");
    return (i > 0) ? s.substring(0, i) : s;
}

function cleanMsg(s) {
    if (!s) return "";
    s = ("" + s).replace(/[\r\n\t]+/g, " ");
    if (s.length > 200) s = s.substring(0, 200) + "…";
    return s;
}

/* ---------- 详细汇总（写进日志） ---------- */
function buildSummary(extra) {
    var L = [];
    var nBake = R.baked.length, nFail = R.failed.length, nSkip = R.skipped.length;
    L.push(OPTIONS.dryRun ? "智能对象烘焙 —— 只统计，未改动文档" : "智能对象烘焙完成");
    if (extra) { L.push(""); L.push(extra); }
    L.push("");
    L.push("文档：" + R.docName);
    var line = "智能对象共 " + R.total + " 个：成功烘焙 " + nBake + "，失败 " + nFail +
               "，按规则跳过 " + nSkip;
    if (!OPTIONS.dryRun && R.leftBakeable > 0) line += "，本轮未处理 " + R.leftBakeable;
    L.push(line);
    if (OPTIONS.dryRun) L.push("其中可烘焙 " + R.bakeableCount + " 个（正式跑就是处理这些）");
    else L.push("耗时约 " + R.elapsed + " 秒");

    if (OPTIONS.dryRun) {
        if (R.bakeableCount > 0) {
            L.push("");
            L.push("★ 这是只统计模式：把 OPTIONS.dryRun 改成 false 就会真的开烤。");
        }
    } else if (R.leftBakeable > 0) {
        L.push("");
        L.push("★ 文档里还有 " + R.leftBakeable + " 个可烤的智能对象没烤。");
        L.push("  继续：先存盘 → 再点一次脚本 → 会接着烤剩下的（烤过的不会再烤）。");
    } else if (R.leftBakeable === 0) {
        L.push("");
        L.push("✔ 可烤的智能对象已经全部烤完了。");
    }
    if (!OPTIONS.dryRun && R.leftSkipped > 0) {
        L.push("（另有 " + R.leftSkipped + " 个智能对象按规则跳过，不会被烘焙）");
    }

    if (nSkip > 0) {
        L.push("");
        L.push("跳过明细" + (nSkip > 12 ? ("（只列前 12 个，共 " + nSkip + " 个）") : "："));
        var sMax = Math.min(nSkip, 12);
        for (var i = 0; i < sMax; i++) L.push("  · " + R.skipped[i].path + "　" + R.skipped[i].why);
        if (nSkip > sMax) L.push("  · …还有 " + (nSkip - sMax) + " 个");
    }
    if (nFail > 0) {
        L.push("");
        L.push("失败明细（这些图层保持原样，没被改动）：");
        var fMax = Math.min(nFail, 12);
        for (var j = 0; j < fMax; j++) L.push("  · " + R.failed[j].path + "　" + R.failed[j].why);
        if (nFail > fMax) L.push("  · …还有 " + (nFail - fMax) + " 个");
    }
    if (R.attrChanged.length > 0) {
        L.push("");
        L.push("⚠ 烘焙前后属性发生变化的图层（" + R.attrChanged.length + " 个，最可疑，会影响观感）：");
        var aMax = Math.min(R.attrChanged.length, 12);
        for (var ac = 0; ac < aMax; ac++) {
            L.push("  · " + R.attrChanged[ac].path + "　" + R.attrChanged[ac].diffs.join("；"));
        }
        if (R.attrChanged.length > aMax) L.push("  · …还有 " + (R.attrChanged.length - aMax) + " 个");
    }
    if (R.unlocked.length > 0) {
        L.push("");
        L.push("为完成烘焙解锁了 " + R.unlocked.length + " 处（只解锁被挡住的那些）：");
        var uMax = Math.min(R.unlocked.length, 8);
        for (var k = 0; k < uMax; k++) L.push("  · " + R.unlocked[k].path + " → " + R.unlocked[k].what);
        if (R.unlocked.length > uMax) L.push("  · …还有 " + (R.unlocked.length - uMax) + " 处");
    }

    L.push("");
    L.push("脚本做过 / 没做的事：");
    L.push("  · 只动了智能对象图层；其它图层一律没碰。");
    L.push("  · 每个都校验过：图层总数不变、智能对象特征消失、剪贴状态已恢复，不对就记为失败并保持原样。");
    L.push("  · 没有修改任何图层的显示/隐藏开关。");
    if (!OPTIONS.dryRun) {
        L.push("  · " + (OPTIONS.purgeAfter ? "已清理缓存（所以 Ctrl+Z 不能整段回退）"
                                            : "没有清理缓存（Ctrl+Z 可整段回退）"));
        L.push("  · 脚本没有自动存盘 —— 确认没问题后你自己存。");
    }
    if (!OPTIONS.makeDiffLayer) {
        L.push("");
        L.push("（OPTIONS.makeDiffLayer = false：没有建对比图层）");
    } else {
        L.push("");
        L.push("★ 临时对比图层（测试用）：");
        if (R.diffLayerMade) {
            L.push("  · 文档最上面已建「" + OPTIONS.diffLayerName + "」，混合模式=差值。");
            L.push("  · 看法：全黑 = 烘焙一个像素都没改；有亮的地方 = 那里被改动了（要查）。");
            if (R.diffCheckBase) {
                L.push("  · 盖印噪声基准：非黑 " + R.diffCheckBase.nonZero + " 个，最深 " +
                       R.diffCheckBase.maxIdx + "/255" +
                       (R.diffCheckBase.maxIdx <= 6 ? "（很轻，属正常舍入噪声）" : "（偏大，留意）"));
            }
            if (R.diffCheckEnd) {
                var bm = R.diffCheckBase ? R.diffCheckBase.maxIdx : 0;
                if (R.diffCheckEnd.nonZero === 0) {
                    L.push("  · ✔ 跑完后的差值：画面纯黑 → 烘焙一个像素都没改");
                } else if (R.diffCheckEnd.maxIdx <= bm + 3) {
                    L.push("  · ✔ 跑完后的差值：最深 " + R.diffCheckEnd.maxIdx +
                           "/255，与盖印基准同量级 → 烘焙没引入新差异");
                } else {
                    L.push("  · ⚠ 跑完后的差值：最深 " + R.diffCheckEnd.maxIdx +
                           "/255，明显超过基准 " + bm + "/255 → 烘焙改变了像素，请点亮处定位");
                }
            }
            L.push("  · 确认没问题后删掉它；再跑本脚本时也会自动清掉上一次留下的那个。");
        } else {
            L.push("  · 本次没能建立（见上面的日志），不影响烘焙结果。");
        }
    }
    if (PLOG.path) L.push("  · 详细日志：" + PLOG.path);
    return L.join("\r\n");
}
main();

/* ==========================================================================
 * 分批多轮烘焙
 *   单轮模式（roundMode = false）：和以前一样，按 chunkSize 跑一次就结束。
 *   分批模式（roundMode = true） ：每轮最多烤 roundSize 个；
 *     每一轮之前都"重新扫描文档"，拿到当前真正还能烤的智能对象（不用过期清单），
 *     扫描后如果还剩就继续下一轮，直到没有可烤的为止。
 * ========================================================================== */
function doBakeRounds() {
    var round = 0;
    var roundCap = (OPTIONS.maxRounds > 0) ? OPTIONS.maxRounds : 50;
    var lastBaked = R.baked.length;
    var batched = (OPTIONS.roundMode === true && OPTIONS.roundSize > 0);

    while (true) {
        round++;
        if (round > 1) rescanForRound(round);

        var left = R.origSOMeta.length;
        if (left === 0) break;

        var limit;
        if (batched) limit = OPTIONS.roundSize;
        else limit = (OPTIONS.chunkSize > 0 ? OPTIONS.chunkSize : left);
        var to = Math.min(limit, left);

        var label = "烘焙智能对象 第" + round + "轮（" + to + " / " + left + "）";
        plog("--- " + label + (batched ? ("（分批模式：每轮最多 " + OPTIONS.roundSize + " 个）") : ""));
        uiStep(0, to, "第 " + round + " 轮开始…");

        R.rangeStarted = false;
        if (OPTIONS.groupUndo) {
            try { $.global.PSJSX_HOOK = bakeRange; } catch (eG) {}
            try { DOC.suspendHistory(label, "PSJSX_HOOK(0," + to + ")"); }
            catch (eU) { plog("（suspendHistory 出错：" + cleanMsg("" + eU) + "）"); }
        }
        if (!R.rangeStarted) bakeRange(0, to);
        uiStep(to, to, "第 " + round + " 轮结束");

        if (OPTIONS.purgeAfter) {
            try { app.purge(PurgeTarget.ALLCACHES); } catch (eP) {}
        }

        if (!batched) break;                       // 单轮模式：跑完就结束
        if (R.baked.length === lastBaked) {        // 这一轮一个都没烤成 → 停（防死循环）
            plog("第 " + round + " 轮没有烤成任何图层，停止（避免死循环）");
            break;
        }
        lastBaked = R.baked.length;
        if (round >= roundCap) {
            plog("已达最大轮数 " + roundCap + "，停止（剩下的可以再点一次脚本继续）");
            break;
        }
    }
    uiClose();
}

})();
