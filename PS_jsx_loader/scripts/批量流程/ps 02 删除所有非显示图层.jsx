#target photoshop
/* --------------------------------------------------------------------------
 * 作用域隔离：本脚本会被批处理用 $.evalFile 依次加载，若直接暴露全局变量，
 * 会把上一个脚本的 OPTIONS / RESULT / plog 等覆盖掉（实测会让批处理直接报错）。
 * 所以整段包进立即执行函数，对外不留任何全局名。
 * -------------------------------------------------------------------------- */
(function () {

/* ==========================================================================
 * 删除所有非显示图层（连剪贴链 / 整组）
 * --------------------------------------------------------------------------
 * ★ 修的两个老问题
 *   1) 旧版会写 `layer.visible = false`（把"基底隐藏但自己可见"的剪贴层关掉）。
 *      在 Photoshop 里"写 visible"会被当成切换可见性 → 剪贴链的显示状态会乱跳。
 *      本脚本【绝不写任何图层的 visible】，一个眼睛都不碰。
 *   2) 旧版按"同一层里往下找基底"判断剪贴关系，跨图层组的剪贴链会判断失败 →
 *      删掉隐藏基底后，上方的剪贴层失去基底、被解除剪贴，于是"原本不显示的
 *      剪贴蒙版被显示出来"。本版改为：删一个隐藏基底时，把它上方整条剪贴链
 *      （连续 grouped 的图层）一起删掉。
 *
 * ★ 行为
 *   · 隐藏的图层组 → 整个组一起删（组内有未解锁图层导致删不掉时，先解锁组内再删）
 *   · 隐藏的普通图层 → 删除；如果它是剪贴链的基底，连同链上的剪贴层一起删
 *   · 可见的图层组 → 递归进去按同样规则处理
 *   · 全程快照"眼睛"与"剪贴关系"，收尾校验：存活图层必须与开始前完全一致
 *
 * ★ 新增：运行前选项面板（可勾选差值对比图层、可记住选择）
 * ========================================================================== */

var OPTIONS = {
    makeDiffLayer: true,
    askOptions: true,
    rememberOptions: true,
    diffName: "__对比 02-删除前(差值)"
};

var PREF_NAME = "ps_删除非显示图层_选项.txt";
var DOC = null;
var SNAP_EYES = null;
var SNAP_CLIP = null;
var RESULT = { skippedCmp: 0, chainKept: 0, chainKeptNames: [],  delLayers: 0, delGroups: 0, chains: 0, unlocked: 0, blocked: [], eyesFixed: [], clipFixed: [],
               diffMade: false, diffWhy: "", diffBase: null,
          diffEye: "", cmpOff: 0 };



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
   导致盖印失败或拿到空/黑结果（这就是"02 的对比层全黑"的原因）。 */
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

    pbOpen("删除非显示图层", countAll(DOC));

    /* ★ clearOldDiff 会删掉旧的对比层链 —— 原来在 suspendHistory 之外做，
       每删一层就记一条历史（用户看到"很多删除图层"）。先把它包成一条历史。 */
    try { if (typeof clearOldDiff === "function") {
        try { $.global.PSJSX_CLEAN = clearOldDiff; } catch (eG0) {}
        DOC.suspendHistory("ps02 清掉旧对比层", "PSJSX_CLEAN()");
    } } catch (eCL) { try { clearOldDiff(); } catch (eCL2) {} }
    try { hideCompareLayers(); } catch (eHC) {}
    SNAP_EYES = snapshotEyes();
    SNAP_CLIP = snapshotClip();

    if (OPTIONS.makeDiffLayer) makeDiff();

    /* ★ 整批删除包进【一个】历史步骤，Ctrl+Z 一次全撤。
       结构照 ps 01 那样写清楚（原来是压在一行的，容易出问题）。
       两条路都会在日志里留痕，方便确认到底走的哪条。 */
    var histOK = false;
    /* ★ 诊断：记录历史步数，确认删除到底有没有被包住 */
    var __hBefore = -1, __hAfter = -1, __hookIsFn = false;
    try { __hBefore = DOC.historyStates.length; } catch (eHB) {}
    try {
        try { $.global.PSJSX_HOOK = doDelete; } catch (eG) {}
        try { __hookIsFn = (typeof $.global.PSJSX_HOOK === "function"); } catch (eHF) {}
        DOC.suspendHistory("ps02 删除所有非显示图层", "PSJSX_HOOK()");
        histOK = true;
    } catch (eH) {
        /* suspendHistory 不行就直接执行（但那样历史里会是很多条） */
        try { if (typeof plog === "function") plog("⚠ suspendHistory 不可用，改为逐步执行（历史不会合并成一条）：" + eH); } catch (eL) {}
        doDelete();
    }
    RESULT.histGrouped = histOK;
    try { __hAfter = DOC.historyStates.length; } catch (eHA) {}
    try {
        if (typeof plog === "function") {
            plog("    [历史] 删除前 " + __hBefore + " 步，删除后 " + __hAfter +
                 " 步（差 " + (__hAfter - __hBefore) + "）；suspendHistory 成功=" + histOK +
                 "；PSJSX_HOOK 是函数=" + __hookIsFn);
            plog("    [历史] 判定：" + ((__hAfter - __hBefore) <= 2
                 ? "✔ 删除被包成一条了"
                 : "★ 删除没被包住（差 " + (__hAfter - __hBefore) + " 步，说明每条删除都单独记了一步）"));
        }
    } catch (eLG) {}

    pbClose();

    /* ★ 收尾校验会写 visible / grouped（恢复成快照）—— 原来也在 suspendHistory 之外，
       每写一次就多一条历史。把两件事一起包进它自己的历史步骤。 */
    try {
        try { $.global.PSJSX_VERIFY = function () {
            RESULT.eyesFixed = verifyEyes(SNAP_EYES);
            RESULT.clipFixed = verifyClip(SNAP_CLIP);
        }; } catch (eG1) {}
        DOC.suspendHistory("ps02 收尾校验", "PSJSX_VERIFY()");
    } catch (eV2) {
        try { RESULT.eyesFixed = verifyEyes(SNAP_EYES); } catch (eV3) {}
        try { RESULT.clipFixed = verifyClip(SNAP_CLIP); } catch (eC3) {}
    }

    /* ==============================================================
     * ★ 收尾：统一关掉所有"脚本生成的对比层"的眼睛（跑完就关着）
     * --------------------------------------------------------------
     * ps 02 原来只在【跑之前】hideCompareLayers() 关过一次，收尾没有再关一次。
     * 而对比层是全屏 DIFFERENCE（差值）层：万一它在中途被点亮
     * （盖印、复制粘贴、收尾恢复快照……任何一步都有可能），
     * 跑完就会留在画面上，整个画面颜色彻底变样。
     * 所以这里跟其它步骤对齐：结束时再强制关一次，不看前面发生了什么。
     * （对比层【不删除】—— 它是用户的参照物，只关灯；想看时手动点开眼睛。）
     * ============================================================== */
    var __off = 0;
    try { __off = hideCompareLayers(); } catch (eHCF) {}
    RESULT.cmpOff = __off;
    try {
        if (typeof plog === "function") {
            plog("收尾：对比层关灯 " + __off + " 个（" + OPTIONS.diffName + "）");
        }
    } catch (eL1) {}

    showResult();
}

/* 被 suspendHistory 以字符串调用 */
function doDelete() {
    RESULT.delLayers = 0; RESULT.delGroups = 0; RESULT.chains = 0; RESULT.chainKept = 0; RESULT.chainKeptNames = []; RESULT.unlocked = 0; RESULT.blocked = [];
    sweep(DOC);
}

/* ------------------------------ 删除主逻辑 ------------------------------ */
function sweep(container) {
    var layers = null;
    try { layers = container.layers; } catch (e) { return; }
    if (!layers) return;

    // 反向遍历：先处理下面的（基底），删掉后上面的索引不受影响
    for (var i = layers.length - 1; i >= 0; i--) {
        var L = layers[i];
        if (!L) continue;

        pbStep("处理 " + safeName(L));
        var vis = true;
        try { vis = (L.visible !== false); } catch (eV) { vis = true; }

        // ★ 永不删除脚本生成的对比层（__对比 开头）—— 它们是用户的参照物，只关灯不删除
        var __nm = "";
        try { __nm = L.name; } catch (eNm) { __nm = ""; }
        if (__nm && __nm.length >= 4 && __nm.substring(0, 4) === "__对比") {
            RESULT.skippedCmp = (RESULT.skippedCmp || 0) + 1;
            continue;
        }

        if (vis) {
            if (isGroup(L)) sweep(L);              // 可见的组：进去继续处理
            continue;
        }

        // ---- 不可见 ----
        if (isGroup(L)) {
            removeGroupSafely(L);                  // 隐藏的组：整组删
            continue;
        }

        /* ★★ 核心安全规则（踩过的坑）★★
           这个隐藏层可能是某条剪贴链的基底。删掉它时，上方那些剪贴层本来应该
           跟着一起删（否则会留下"孤立的剪贴层"，剪贴关系乱了）。
           但【只有在整条剪贴链都是隐藏的】时候才能一起删：
             剪贴到一个隐藏基底上的层，在 Photoshop 里【仍然可能是可见的】——
             如果它可见而我们把它删了，画面就会缺一块（用户反馈的"02 把画面损坏了"）。
           所以：链上有任何一层可见 → 只删基底自己会破坏关系 → 干脆整条都不删，记进报告。 */
        var chain = chainAbove(layers, i);
        var chainHasVisible = false;
        for (var cv = 0; cv < chain.length; cv++) {
            var cvVis = true;
            try { cvVis = (chain[cv].visible !== false); } catch (eCV) { cvVis = true; }
            if (cvVis) { chainHasVisible = true; break; }
        }
        if (chain.length > 0 && chainHasVisible) {
            RESULT.chainKept = (RESULT.chainKept || 0) + 1;
            RESULT.chainKeptNames = RESULT.chainKeptNames || [];
            try { RESULT.chainKeptNames.push(safeName(L) + "（剪贴链上有可见层，整条保留）"); } catch (eKN) {}
            continue;                                  // ★ 整条都不动
        }
        var toDelete = chain.slice(0);             // 链上的剪贴层（这里已确认全是隐藏的）
        toDelete.push(L);                          // 加基底自己
        if (chain.length > 0) RESULT.chains++;

        for (var k = 0; k < toDelete.length; k++) {
            removeLayerSafely(toDelete[k]);
        }
    }
}

/* 取 container 里 index 更小（= 更靠上）的连续 grouped 图层，也就是剪贴到 base 上的那些层 */
function chainAbove(layers, baseIndex) {
    var out = [];
    for (var j = baseIndex - 1; j >= 0; j--) {
        var L = layers[j];
        var g = false;
        try { g = (L.grouped === true); } catch (e) { g = false; }
        if (!g) break;
        out.push(L);
    }
    return out;
}

function removeLayerSafely(L) {
    var nm = safeName(L);
    try {
        L.remove();
        RESULT.delLayers++;
        return true;
    } catch (e) {
        RESULT.blocked.push(nm);
        return false;
    }
}

/* 删图层组：被"组内有未解锁图层"阻挡时，先解锁组内再删一次 */
function removeGroupSafely(G) {
    var nm = safeName(G);
    try {
        G.remove();
        RESULT.delGroups++;
        return true;
    } catch (e1) {
        // 第一方案失败 → 解锁组内所有图层再试
        var n = unlockInside(G);
        RESULT.unlocked += n;
        try {
            G.remove();
            RESULT.delGroups++;
            return true;
        } catch (e2) {
            // 还不行为：逐层删掉组里的内容再删组
            try {
                var inner = G.layers;
                for (var i = inner.length - 1; i >= 0; i--) {
                    try { inner[i].remove(); RESULT.delLayers++; } catch (e3) {
                        RESULT.blocked.push(nm + " / " + safeName(inner[i]));
                    }
                }
                G.remove();
                RESULT.delGroups++;
                return true;
            } catch (e4) {
                RESULT.blocked.push(nm);
                return false;
            }
        }
    }
}

/* 解锁一个图层组内部所有图层（用于"文件夹里有未解锁图层 → 整组删不掉"） */
function unlockInside(G) {
    var n = 0;
    try {
        for (var i = 0; i < G.layers.length; i++) {
            var L = G.layers[i];
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

/* ------------------------------ 快照 / 校验 ------------------------------ */
function snapshotEyes() {
    var map = {};
    walk(DOC, function (L) {
        var id = getId(L);
        if (id >= 0) { try { map[id] = (L.visible !== false); } catch (e) {} }
    });
    return map;
}

function snapshotClip() {
    var map = {};
    walk(DOC, function (L) {
        var id = getId(L);
        if (id < 0) return;
        try { map[id] = (L.grouped === true); } catch (e) {}
    });
    return map;
}

/* 存活图层的"眼睛"必须和开始前一样（被删掉的图层当然不在校验范围内） */
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
    return fixed;
}

/* 存活图层的"剪贴关系"必须和开始前一样（这就是"基底被删导致剪贴层被解除剪贴"的探针） */
function verifyClip(snap) {
    var bad = [];
    if (!snap) return bad;
    walk(DOC, function (L) {
        var id = getId(L);
        if (id < 0 || snap[id] === undefined) return;
        var cur = false;
        try { cur = (L.grouped === true); } catch (e) { return; }
        if (cur !== snap[id]) bad.push(safeName(L) + "（" + (snap[id] ? "原本是剪贴层，现在被解除剪贴" : "原本不是剪贴层，现在变成剪贴层") + "）");
    });
    return bad;
}

/* ------------------------------ 差值对比图层 ------------------------------ */
/* ------------------ 建立对比图层：打包成历史记录里的一步 ------------------
 * 盖印可见图层 → 改名 → 移到最顶层 → 设差值，这四步原来在历史记录里是三四条，
 * 现在整体包进一个 suspendHistory：历史里只出现一条「ps02 建对比层」，一次 Ctrl+Z 全撤。
 * 说明：suspendHistory 不允许嵌套，所以 makeDiff() 的调用点要在主流程那个之外 ——
 *       现有代码本来就是这么排的。 */
function makeDiff() {
    try {
        try { $.global.PSJSX_DIFF = makeDiffBody; } catch (eG) {}
        if (typeof $.global.PSJSX_DIFF !== "function") { makeDiffBody(); return; }
        DOC.suspendHistory("ps02 建对比层", "diffHookFn()");
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
    try {
        clearOldDiff();
        selectTopVisible();
        if (!stampVisible()) throw new Error("盖印可见图层失败（mergeVisible 与备用方式都不行）");

        var made = DOC.activeLayer;
        try { made.name = OPTIONS.diffName; } catch (eN) {}
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
        /* ★ 回读确认真的关上了（排查"跑完对比层还亮着"用） */
        try { RESULT.diffEye = (made.visible === false) ? "已关" : "★ 还是亮的"; }
        catch (eVR) { RESULT.diffEye = "读不出来"; }
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

function clearOldDiff() {
    var guard = 0;
    try {
        var L = findByName(DOC, OPTIONS.diffName);
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
        d.putBoolean(charIDToTypeID("Dplc"), true);
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
    if (typeof Window === "undefined") return true;
    var w = new Window("dialog", "删除所有非显示图层 —— 选项");
    w.orientation = "column";
    w.alignChildren = "left";

    var g0 = w.add("panel", undefined, "将要做的");
    g0.orientation = "column"; g0.alignChildren = "left";
    g0.add("statictext", undefined, "· 隐藏的图层组：整个组一起删（组内有未解锁图层时先解锁再删）");
    g0.add("statictext", undefined, "· 隐藏的图层：删除；若它是剪贴链基底且链上【全是隐藏层】，链上的剪贴层一起删");
    g0.add("statictext", undefined, "· 可见的图层组：递归进去按同样规则处理");

    var g1 = w.add("panel", undefined, "对比图层（用来验证删除有没有影响画面）");
    g1.orientation = "column"; g1.alignChildren = "left";
    var cbDiff = g1.add("checkbox", undefined, "先在最顶层盖印一层「" + OPTIONS.diffName + "」（混合模式=差值）");
    cbDiff.value = !!OPTIONS.makeDiffLayer;
    g1.add("statictext", undefined, "全黑 = 画面一个像素都没变（删掉的东西本来就看不见）；有亮处 = 画面变了（要查）。");

    var g2 = w.add("panel", undefined, "安全保证");
    g2.orientation = "column"; g2.alignChildren = "left";
    g2.add("statictext", undefined, "· 绝不写任何图层的显示/隐藏开关");
    g2.add("statictext", undefined, "· 收尾校验存活图层的「眼睛」和「剪贴关系」，被改动的立即还原并报告");
    g2.add("statictext", undefined, "· 全程包在一个历史步骤里，Ctrl+Z 可整段撤回");

    var cbRem = w.add("checkbox", undefined, "记住我的选择（下次自动带上）");
    cbRem.value = !!OPTIONS.rememberOptions;

    var gB = w.add("group"); gB.alignment = "right";
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
    var msg = "删除完成";
    msg += "\n· 图层 " + RESULT.delLayers + " 个";
    msg += "\n· 图层组 " + RESULT.delGroups + " 个";
    if (RESULT.chains > 0) msg += "\n· 连带删掉的剪贴链 " + RESULT.chains + " 条（基底不可见，链上的剪贴层一起删）";
    if (RESULT.chainKept > 0) msg += "\n· ★ 保留了 " + RESULT.chainKept + " 条剪贴链（链上有可见层，删了会损坏画面）";
    if (RESULT.unlocked > 0) msg += "\n· 为删掉被锁定的组，额外解锁了 " + RESULT.unlocked + " 个图层";
    if (RESULT.blocked.length > 0) msg += "\n⚠ " + RESULT.blocked.length + " 个删不掉（已跳过）：" + RESULT.blocked.slice(0, 5).join(" / ");
    if (RESULT.clipFixed.length > 0) msg += "\n⚠ 有剪贴关系发生变化，已记录：" + RESULT.clipFixed.slice(0, 3).join("；");
    else msg += "\n✔ 剪贴关系校验：存活图层与开始前一致";
    if (RESULT.eyesFixed.length > 0) msg += "\n⚠ 有 " + RESULT.eyesFixed.length + " 个图层的显示状态被改动，已还原：" + RESULT.eyesFixed.slice(0, 5).join(" / ");
    else msg += "\n✔ 显示状态校验：存活图层与开始前一致";
    if (RESULT.diffMade) {
        msg += "\n\n最顶层已建「" + OPTIONS.diffName + "」（差值）";
        msg += "\n显示状态：" + (RESULT.diffEye ? RESULT.diffEye : "已关") +
               "（跑完自动关灯，不挡画面；想看差异就手动点开它的眼睛）";
        if (RESULT.cmpOff > 0) msg += "\n收尾时关掉了 " + RESULT.cmpOff + " 个对比层的眼睛";
        if (RESULT.diffBase) {
            msg += (RESULT.diffBase.nonZero === 0)
                ? "\n差值自检：画面纯黑 → 一个像素都没变 ✔"
                : "\n差值自检：非黑 " + RESULT.diffBase.nonZero + " 个，最深 " + RESULT.diffBase.maxIdx + "/255";
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
    var __mk = File(Folder.temp.fsName + "/psjsx_02_started.txt");
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
        if (!batchOn()) alert("ps 02 运行出错：\n" + eMain + "\n行号: " + __ln + "\n文件: " + __fn);
    } catch (eAl) {}
}
})();
