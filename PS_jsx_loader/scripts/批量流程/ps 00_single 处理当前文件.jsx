#target photoshop
/* ==========================================================================
 * ps 00_single 处理当前文件（跑完整流程）
 * --------------------------------------------------------------------------
 * 和 ps 00 的区别
 *   ps 00：选一个文件夹，挨个打开里面的 psd/psb 批量处理（无人值守）。
 *   ps 00_single：只处理【你当前打开的这个文档】—— 从面板点一下就跑完整条流水线。
 *         不选路径、不遍历文件夹，适合"手工修完一份就顺手整理一下"。
 *
 * 按顺序跑（顺序与 ps 00 完全一致，用的是同一份脚本列表）：
 *     ps 01 解锁所有图层并保持显示状态
 *     ps 02 删除所有非显示图层
 *     ps 03 烘焙所有智能对象
 *     ps 04 烘焙不支持的效果
 *     ps 05 合并带蒙版的图层
 *     ps 06 提取文件夹蒙版
 *     ── 到 06 为止都是"加图层 / 烤像素"，对工程结构破坏性小 ──
 *     ★ 可选的自动备份（默认在第 06 号之后存一份 psb）
 *     ps 07 烘焙文件夹剪贴蒙版
 *     ps 08 烘焙文件夹样式/效果   ← 待写（写好加到下面 batchScripts 即可）
 *
 * 特点
 *   · 全程不弹"选项面板"：点一下就开始跑（跑完只弹一次结果）
 *   · 进度条显示当前第几步 / 共几步 + 步骤名
 *   · 出错的步骤只跳过、继续往下跑，最后在结果里点名
 *   · 日志写在 <文档目录>\_日志\ 下（和 ps 00 一致）
 *   · 可选的"跑完自动保存"：默认不勾，跑完弹窗问你一次
 *   · 可选的整体 Ctrl+Z：默认关（大文件上把整条流水线包进一个历史步骤很吃内存）
 *
 * 按既有约定：IIFE 隔离 / $.global.PSJSX_BATCH 让子脚本进入批处理模式（不弹各自的窗）/
 * 进度条不写 preferredSize / 启动块放文件末尾 / ES3 安全。
 * ========================================================================== */

(function () {

var OPTIONS = {
    // ★ 流水线顺序 = 运行顺序。新脚本写好加到这里就行。
    batchScripts: [
        "ps 01 解锁所有图层并保持显示状态.jsx",
        "ps 02 删除所有非显示图层.jsx",
        "ps 03 烘焙所有智能对象.jsx",
        "ps 04 烘焙不支持的效果.jsx",
        "ps 05 合并带蒙版的图层.jsx",
        "ps 06 提取文件夹蒙版.jsx",
        "ps 07 输出AE指令JSON.jsx"
        // "ps 08 烘焙文件夹样式效果.jsx"   ← 写好之后放开
    ],

    // ★ 备份：跑到第 backupAfterStep 号之后，另存一份 psb 备份（0 = 关）
    //   默认 6：06 只是「加图层/烤像素」，之后的 07/08 要动文件夹结构，所以在这里留副本。
    //   备份文件名里的标记自动从"那一号脚本的名字"推出来（和 ps 00 的命名保持一致）。
    backupAfterStep: 6,

    // ★ 执行到第几号为止：99 = 列表里全部跑完；6 = 只跑 01~06（07 还没修好，测试期用这个）
    //   改回 99（或设一个大于列表最大号的值）就能恢复"全跑"。
    stopAtStep: 6,

    // 跑完是否自动保存（false = 弹窗问你一次；true = 直接存回原文件）
    autoSave: false,

    // 是否把整条流水线包进一个历史步骤（Ctrl+Z 一次全撤）。
    // 默认关：大文件上这样很吃内存，容易把 PS 拖崩；想要就改 true。
    singleUndoStep: false,

    // ★ 某一步失败时，是否跳过【这份文档剩下的步骤】
    //   true  = 失败即停下（省时间，避免在坏文档上继续折腾）
    //   false = 仍然跑完剩下的步骤（更容易看出是哪一步的问题）
    skipRestOnStepError: true,

    askFinish: true,       // 跑完是否弹结果窗（关掉就只写日志）

    // ★ 是否保留各步骤盖印的"差值对比层"（名字以 __对比 开头）
    //   子脚本原来在批处理模式下【一律不建】对比层（免得几百个文件都建、白占内存）。
    //   但 00_single 只处理【当前这一个】文件 —— 单文件恰恰就是拿来盯对比层的，
    //   所以这里默认开着：跑完你会得到 01/02/03/04/05 各自的对比层（都是隐藏的）。
    //   想看哪一步改了什么，就把那一层（或几层）的眼睛点开。
    //   false = 沿用老行为（一个对比层都不建）。
    keepDiffLayer: true
};

var SCRIPT_DIR = null;
var DOC = null;
var LOG = { f: null, path: "" };
var PB = { win: null, bar: null, txt: null, total: 1, n: 0 };
var R = { steps: [], failed: [], skippedSteps: [], elapsed: 0, backedUp: "", saved: "", aborted: false, stoppedEarly: false, diffKept: 0 };

/* ---------------- 步骤结果标记（读子脚本写的 psjsx_step_result.txt） ----------------
 * 子脚本在批处理模式下：启动成功先写 "OK"，之后出错覆盖成 "FAIL|原因"。
 * 因为 $.evalFile 只在"抛异常"时报错，而子脚本多半自己把异常吞了，
 * 所以必须靠这个文件才能知道这一步到底成没成。 */
function stepResultPath() { try { return Folder.temp.fsName + "/psjsx_step_result.txt"; } catch (e) { return ""; } }
function stepResultClear() {
    try { var p = stepResultPath(); if (!p) return; var f = File(p); if (f.exists) f.remove(); } catch (e) {}
}
function stepResultRead() {
    try {
        var p = stepResultPath();
        if (!p) return "";
        var f = File(p);
        if (!f.exists) return "";
        if (!f.open("r")) return "";
        var s = f.read();
        f.close();
        return ("" + s).replace(/[\r\n]+/g, " ").replace(/^\s+|\s+$/g, "");
    } catch (e) { return ""; }
}

/* 数一下文档里还剩多少个"脚本生成的对比层"（名字以 __对比 开头）
   —— 递归数，因为对比层有可能落在文件夹里（一般不会，但要数准）。 */
function countCompareLayers() {
    var n = 0;
    try {
        (function rec(c) {
            var arr = null;
            try { arr = c.layers; } catch (e) { return; }
            if (!arr) return;
            for (var i = 0; i < arr.length; i++) {
                var L2 = arr[i];
                var nm = "";
                try { nm = L2.name; } catch (eN) { nm = ""; }
                if (nm && nm.length >= 4 && nm.substring(0, 4) === "__对比") n++;
                try { if (L2.typename === "LayerSet") rec(L2); } catch (eT) {}
            }
        })(DOC);
    } catch (e) {}
    return n;
}

/* ------------------------------ 主流程 ------------------------------ */
function main() {
    if (app.documents.length === 0) { failHard("没有打开的文档。\n\n先打开要处理的 psd/psb，再运行这个脚本。"); return; }
    DOC = app.activeDocument;

    SCRIPT_DIR = resolveScriptDir();
    if (!SCRIPT_DIR) { failHard("找不到流水线脚本所在的文件夹（应该和本脚本在同一个目录下）。"); return; }

    logOpen();
    clearStopFlag();   // ★ 启动前清掉上次残留的停止信号
    plog("===== ps 00_single 处理当前文件 开始 =====");
    plog("文档：" + DOC.name);
    plog("文档路径：" + (DOC.path ? DOC.path.fsName : "(未保存过)"));
    plog("脚本目录：" + SCRIPT_DIR.fsName);
    plog("执行计划：" + describePlan());

    // 缺脚本先报警（别跑到一半才发现）
    var miss = missingScripts();
    if (miss.length > 0) plog("⚠ 列表里这些脚本没找到，会跳过：" + miss.join(" / "));

    var t0 = nowMs();
    try {
        if (OPTIONS.singleUndoStep) {
            try {
                try { $.global.PSJSX_HOOK = runAllSteps; } catch (eG) {}
                DOC.suspendHistory("ps00_single 处理当前文件（整条流水线）", "PSJSX_HOOK()");
            } catch (eH) {
                plog("（suspendHistory 不可用，改为逐步执行）");
                runAllSteps();
            }
        } else {
            runAllSteps();
        }
    } catch (eMain) {
        plog("✗ 流水线整体出错：" + cleanMsg("" + eMain));
        R.failed.push("整体：" + cleanMsg("" + eMain));
    }
    R.elapsed = Math.round((nowMs() - t0) / 100) / 10;

    // 保存
    try { finishSave(); } catch (eS) { plog("✗ 保存环节出错：" + cleanMsg("" + eS)); }

    writeSummary();
    logClose();
    if (OPTIONS.askFinish) showFinish();
}

/* 逐步执行整个列表 */
function runAllSteps() {
    var total = OPTIONS.batchScripts.length;
    pbOpen("ps 00_single 处理当前文件", total + 1);

    // ★ 让子脚本进入批处理模式：不弹它们各自的选项面板/结果窗
    $.global.PSJSX_BATCH = true;
    /* ★★ 但"建不建对比层"要单独放行 ★★
       子脚本原来的守卫是 `if (batchOn()) return;` —— 只要进了批处理模式就不建，
       于是单文件跑完整条流水线一个对比层都没有。现在改成 diffSkipped()：
         · ps 00（几百个文件的整文件夹批处理）  -> PSJSX_DIFF_OK 不设 -> 仍然不建
         · ps 00_single（只处理当前这一个文件）-> 设成 true -> 照常建，跑完保留
       注意：得在 $.evalFile 之前设，子脚本才会读到。 */
    try { $.global.PSJSX_DIFF_OK = (OPTIONS.keepDiffLayer === true); } catch (eDOK) {}
    try {
        for (var i = 0; i < total; i++) {
            var name = OPTIONS.batchScripts[i];
            var no = stepNumberOf(name);

            /* ★★ 守卫：ae 开头的脚本永远不在 PS 里执行（ae 08 是给 After Effects 的，
               要在 AE 里手动跑；万一被写进 batchScripts，这里也会拦下来）。 */
            if (/^ae\s/i.test("" + name)) {
                plog("· 跳过 AE 侧脚本（要在 AE 里手动跑）：" + name);
                R.skippedSteps.push("(AE侧) " + labelOf(name));
                continue;
            }

            // 执行到第几号为止
            if (no > 0 && OPTIONS.stopAtStep < 90 && no > OPTIONS.stopAtStep) {
                plog("· 跳过（执行到第 " + OPTIONS.stopAtStep + " 号为止）：" + name);
                R.skippedSteps.push(labelOf(name));
                continue;
            }

            // 备份点
            if (OPTIONS.backupAfterStep > 0 && no === OPTIONS.backupAfterStep) {
                doBackup();
            }

            // ★ 每步开始前检查一次"停止信号文件"
            if (checkStopFlag() || pbCancelled()) {
                plog("⚠ 已收到中止请求：已跑 " + i + " / " + total + " 步，剩下的跳过");
                R.aborted = true;
                break;
            }
            pbStep("(" + (i + 1) + "/" + total + ") " + labelOf(name));
            var sr = runOneStep(name, i, total);

            // ★ 这一步失败了：按开关决定要不要跳过剩下的步骤
            if (sr && !sr.ok && OPTIONS.skipRestOnStepError) {
                plog("★ 「" + labelOf(name) + "」失败 → 按设置跳过剩下的步骤（skipRestOnStepError=开）");
                R.stoppedEarly = true;
                break;
            }
        }

        // 备份点设在"列表末尾"（列表里没有那一号）时，跑完再备份
        if (OPTIONS.backupAfterStep > 0 && !R.backedUp && stepNumberOf(scriptNameForStep(OPTIONS.backupAfterStep)) === -1) {
            doBackup();
        }
    } finally {
        $.global.PSJSX_BATCH = false;
        try { $.global.PSJSX_DIFF_OK = false; } catch (eDOK2) {}
        /* ★ 数一下文档里留下了多少个对比层（__对比 开头），写进日志和结果窗 */
        try { R.diffKept = countCompareLayers(); } catch (eCK) { R.diffKept = 0; }
        try {
            if (R.diffKept > 0) {
                plog("★ 保留了 " + R.diffKept + " 个对比层（都是隐藏的）—— 想看哪一步改了什么，" +
                     "就把那一层的眼睛点开（名字形如「__对比 0N-…(差值)」）");
            } else if (OPTIONS.keepDiffLayer) {
                plog("（没有对比层：可能各步骤的「建对比层」选项被关掉了，或者盖印失败 —— 看各步日志）");
            }
        } catch (eLK) {}
        pbClose();
    }
}

/* 跑一个步骤脚本 */
function runOneStep(scriptName, i, total) {
    var f = File(SCRIPT_DIR.fsName + "/" + scriptName);
    var label = labelOf(scriptName);
    if (!f.exists) {
        plog("✗ 找不到脚本：" + scriptName);
        R.failed.push(label + "：找不到脚本");
        R.steps.push(label + "（缺失）");
        return;
    }
    var t = nowMs();
    var err = "";
    stepResultClear();                       // ★ 清掉上一次的结果标记
    try {
        $.evalFile(f);
    } catch (e) {
        err = cleanMsg("" + e);
    }
    /* ★ 再看子脚本自己写的标记：抓"子脚本自己吞掉异常"的情况 */
    var mk = stepResultRead();
    if (mk && mk.indexOf("FAIL") === 0) {
        err = mk.replace(/^FAIL\|?/, "");
        plog("  ! " + label + " 自报失败：" + err);
    }
    var sec = Math.round((nowMs() - t) / 100) / 10;
    if (err) {
        plog("✗ " + label + " 出错（" + sec + " 秒）：" + err);
        R.failed.push(label + "：" + err);
        R.steps.push(label + " ✗");
        return { ok: false, err: err };
    }
    plog("  ✓ " + label + "　" + sec + " 秒");
    R.steps.push(label + " " + sec + "s");
    return { ok: true, err: "" };
}

/* ------------------------------ 备份 / 保存 ------------------------------ */
/* 备份：另存一份 <原名>_备份<标记>.psb（放文档同级；绝不覆盖文档本身）
   一律存 .psb：psd 有 2GB / 30000 像素上限，大图容易超；psb 没限制。
   saveAs 用 asCopy=true，所以文档不会换路径，后面的步骤照常在原文档上跑。 */
function doBackup() {
    try {
        if (!DOC.path) {
            plog("· 文档还没保存过（没有路径），跳过备份");
            return;
        }
        var dir = Folder(DOC.path);
        var base = DOC.name.replace(/\.[^.]+$/, "");
        var dest = File(dir.fsName + "/" + base + "_备份" + backupTag() + ".psb");

        var t = nowMs();
        var so = new PhotoshopSaveOptions();
        try { so.embedColorProfile = true; } catch (e1) {}
        try { so.alphaChannels = true; } catch (e2) {}
        try { so.layers = true; } catch (e3) {}
        DOC.saveAs(dest, so, true, Extension.LOWERCASE);

        var sec = Math.round((nowMs() - t) / 100) / 10;
        R.backedUp = dest.fsName;
        plog("★ 已备份（第 " + OPTIONS.backupAfterStep + " 号之后）：" + dest.fsName + "　" + sec + " 秒");
        pbStep("已备份 → " + dest.name);
    } catch (e) {
        plog("⚠ 备份失败（继续往下跑，原文档未受影响）：" + cleanMsg("" + e));
        R.failed.push("备份：" + cleanMsg("" + e));
    }
}

/* 跑完怎么保存 */
function finishSave() {
    if (!DOC.path) {
        plog("· 文档没有路径（新建未保存），不自动存；需要的话你自己「另存为」");
        return;
    }
    var doSave = OPTIONS.autoSave;
    if (!doSave && OPTIONS.askFinish && typeof Window !== "undefined") {
        var w = new Window("dialog", "ps 00_single —— 流水线跑完了");
        w.orientation = "column"; w.alignChildren = "left";
        w.add("statictext", undefined, "文档：" + DOC.name);
        w.add("statictext", undefined, R.failed.length
            ? ("⚠ 有 " + R.failed.length + " 步出错（明细见日志）")
            : "✔ 所有步骤都完成了");
        w.add("statictext", undefined, "耗时约 " + R.elapsed + " 秒");
        w.add("statictext", undefined, "");
        w.add("statictext", undefined, "现在要保存回原文件吗？");
        w.add("statictext", undefined, "（不保存的话，可以自己 Ctrl+S 或 Ctrl+Z 逐步回退）");
        var g = w.add("group"); g.alignment = "right";
        g.add("button", undefined, "保存", { name: "ok" });
        g.add("button", undefined, "先不保存", { name: "cancel" });
        try { placeWindowOnHostScreen(w, true); } catch (ePL) {}
        doSave = (w.show() === 1);
    }
    if (!doSave) {
        plog("· 按你的选择：没有保存（文档仍是未保存状态）");
        return;
    }
    var t = nowMs();
    try {
        DOC.save();
        var sec = Math.round((nowMs() - t) / 100) / 10;
        R.saved = DOC.path.fsName;
        plog("✔ 已保存：" + DOC.path.fsName + "　" + sec + " 秒");
    } catch (e) {
        plog("✗ 保存失败：" + cleanMsg("" + e));
        R.failed.push("保存：" + cleanMsg("" + e));
    }
}

/* ------------------------------ 计划 / 辅助 ------------------------------ */
function stepNumberOf(scriptName) {
    var m = /^ps\s+(\d+)/i.exec("" + scriptName);
    if (!m) return -1;
    return parseInt(m[1], 10);
}

function labelOf(scriptName) {
    return ("" + scriptName).replace(/^ps\s*\d+\s*/, "").replace(/\.jsx$/i, "");
}

function scriptNameForStep(no) {
    for (var i = 0; i < OPTIONS.batchScripts.length; i++) {
        if (stepNumberOf(OPTIONS.batchScripts[i]) === no) return OPTIONS.batchScripts[i];
    }
    return "";
}

/* 备份文件名的标记：从"备份点那一号的脚本名"推出来，去掉扩展名/空白/非法字符
   "ps 06 提取文件夹蒙版.jsx" → "ps06提取文件夹蒙版"（和 ps 00 的命名一致） */
function backupTag() {
    var nm = scriptNameForStep(OPTIONS.backupAfterStep);
    if (!nm) return "ps" + OPTIONS.backupAfterStep;
    return nm.replace(/\.jsx$/i, "").replace(/[\s\\\/:*?"<>|]+/g, "");
}

function describePlan() {
    var parts = [];
    for (var i = 0; i < OPTIONS.batchScripts.length; i++) {
        var no = stepNumberOf(OPTIONS.batchScripts[i]);
        if (no > 0 && OPTIONS.stopAtStep < 90 && no > OPTIONS.stopAtStep) continue;
        parts.push(labelOf(OPTIONS.batchScripts[i]));
    }
    return "共 " + parts.length + " 步：" + parts.join(" → ") +
           "；备份点=" + (OPTIONS.backupAfterStep > 0 ? ("第 " + OPTIONS.backupAfterStep + " 号之后") : "关");
}

function missingScripts() {
    var out = [];
    for (var i = 0; i < OPTIONS.batchScripts.length; i++) {
        var f = File(SCRIPT_DIR.fsName + "/" + OPTIONS.batchScripts[i]);
        if (!f.exists) out.push(OPTIONS.batchScripts[i]);
    }
    return out;
}

/* 本脚本在哪（ExtendScript 里没有 __dirname，只能从 $.fileName 取，失败了再兜底找） */
function resolveScriptDir() {
    var tried = [];
    function ok(d) {
        try { return d && d.exists && File(d.fsName + "/" + OPTIONS.batchScripts[0]).exists; } catch (e) { return false; }
    }
    // ① 本脚本所在目录
    try {
        var d1 = File($.fileName).parent;
        tried.push("" + (d1 ? d1.fsName : "?"));
        if (ok(d1)) return d1;
    } catch (e1) {}
    // ② 按已知的扩展安装位置兜底
    var guesses = [
        Folder("C:/Program Files (x86)/Common Files/Adobe/CEP/extensions/PS_jsx_loader/scripts/批量流程"),
        Folder("C:/Program Files/Common Files/Adobe/CEP/extensions/PS_jsx_loader/scripts/批量流程")
    ];
    for (var i = 0; i < guesses.length; i++) {
        tried.push(guesses[i].fsName);
        if (ok(guesses[i])) return guesses[i];
    }
    plog("⚠ 找脚本目录失败，试过：" + tried.join(" / "));
    return null;
}

function nowMs() { return (new Date()).getTime(); }
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


function cleanMsg(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 220); } catch (e) { return "" + s; } }

/* ------------------------------ 日志（<文档目录>/_日志/） ------------------------------ */
function ensureLogFolder() {
    try {
        var d = (DOC && DOC.path) ? Folder(DOC.path) : null;
        if (!d) return null;
        var sub = Folder(d.fsName + "/_日志");
        if (!sub.exists) { try { sub.create(); } catch (eC) {} }
        return (sub.exists ? sub : d);
    } catch (e) { return null; }
}

function logOpen() {
    try {
        var d = ensureLogFolder();
        if (!d) d = Folder(Folder.temp);
        LOG.path = d.fsName + "/" + DOC.name.replace(/\.[^.]+$/, "") + "_ps00_single日志.txt";
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
    try { LOG.f.write("[" + (new Date()).toTimeString().substring(0, 8) + "] " + s + "\n"); LOG_FLUSH(); } catch (e) {}
}

/* ------------------------------ 进度条（不写 preferredSize） ------------------------------ */
function pbOpen(title, total) {
    if (typeof Window === "undefined") return;
    try {
        PB.win = new Window("palette", title);
        PB.win.orientation = "column";
        PB.win.alignChildren = "fill";
        PB.txt = PB.win.add("statictext", undefined, "准备中…");
        PB.bar = PB.win.add("progressbar", undefined, 0, (total > 0 ? total : 1));
        PB.cancel = false;
        try { placeWindowOnHostScreen(PB.win, true); } catch (ePL) {}
        PB.win.show();
        PB.total = (total > 0 ? total : 1);
        PB.n = 0;
        PB.cancel = false;
        PB.btn = null;
    } catch (e) { PB.win = null; }
}

function pbStep(msg) {
    checkStopFlag();
    if (!PB.win) return;
    PB.n++;
    try {
        PB.bar.value = (PB.n > PB.total ? PB.total : PB.n);
        PB.txt.text = msg;
        PB.win.update();
    } catch (e) {}
}

/* ------------------------------ 中止（取消）支持 ------------------------------
 * 进度条上加一个"中止"按钮。点一下只是把 PB.cancel 置位，
 * 真正的停止发生在【下一次 pbCancelled() 检查处】——
 * 也就是每处理完一个单位（一层 / 一个文件夹 / 一个步骤）才停，
 * 绝不会打断半层，也绝不会丢日志（会正常走收尾流程）。
 * 点过之后按钮文字会变成"正在停止…"，让你知道点到了。
 * ------------------------------------------------------------------------------ */
function pbCancelled() {
    if (!PB.cancel) return false;
    if (PB.txt) { try { PB.txt.text = "已收到中止请求，正在收尾…"; PB.win.update(); } catch (eT) {} }
    return true;
}

/* 停止信号文件的路径（和 "停止运行.bat" 里写的一致） */
function stopFlagPath() {
    try { return Folder.temp.fsName + "/psjsx_STOP.txt"; } catch (e) { return ""; }
}
/* 清掉停止信号（启动时清一次，避免上次的残留误停） */
function clearStopFlag() {
    try { var p = stopFlagPath(); if (p) { var f = File(p); if (f.exists) f.remove(); } } catch (e) {}
}
/* ★ 中止检查：只看"停止信号文件在不在"。
   为什么不用按钮：实测（ps 诊断_中止按钮探针）palette 的按钮
   在脚本执行期间根本收不到点击 —— Photoshop 的脚本是同步的，
   事件要等脚本跑完才处理。读文件则没这个问题。 */
function checkStopFlag() {
    try {
        var p = stopFlagPath();
        if (!p) return false;
        var f = File(p);
        if (f.exists) { PB.cancel = true; return true; }
    } catch (e) {}
    return false;
}
function pbClose() {
    if (!PB.win) return;
    try { PB.win.close(); } catch (e) {}
    PB.win = null;
}

/* ------------------------------ 结果 ------------------------------ */
function writeSummary() {
    plog("");
    plog("========== 汇总 ==========");
    if (R.aborted) plog("⚠ 本次被用户中止（只跑了前面几步）");
    if (R.stoppedEarly) plog("★ 有步骤失败，剩下的步骤已跳过（skipRestOnStepError=开）");
    plog("文档：" + DOC.name);
    plog("总耗时约 " + R.elapsed + " 秒");
    plog("步骤执行情况：");
    for (var i = 0; i < R.steps.length; i++) plog("  " + (i + 1) + ". " + R.steps[i]);
    if (R.skippedSteps.length) plog("按「执行到」跳过：" + R.skippedSteps.join(" / "));
    if (R.backedUp) plog("备份：" + R.backedUp);
    else if (OPTIONS.backupAfterStep > 0) plog("备份：本次没有生成（可能没跑到备份点，或文档没有路径）");
    if (R.saved) plog("已保存：" + R.saved);
    else plog("没有保存（文档仍是未保存状态）");
    if (R.failed.length) {
        plog("");
        plog("⚠ 出错明细（这些步骤没做完，其余步骤照常跑了）：");
        for (var j = 0; j < R.failed.length; j++) plog("  · " + R.failed[j]);
    } else {
        plog("✔ 所有步骤都正常完成");
    }
    plog("日志：" + LOG.path);
    plog("===== 结束 =====");
}

function showFinish() {
    if (typeof Window === "undefined") return;
    var t = "ps 00_single 流水线跑完\n\n文档：" + DOC.name + "\n耗时约 " + R.elapsed + " 秒";
    t += "\n\n步骤：" + R.steps.length + " 步";
    if (R.failed.length) t += "\n⚠ 出错 " + R.failed.length + " 步（明细在日志里）";
    else t += "\n✔ 全部完成";
    if (R.backedUp) t += "\n\n备份：" + baseNameOf(R.backedUp);
    if (R.saved) t += "\n已保存：" + baseNameOf(R.saved);
    else t += "\n（未保存）";
    if (R.diffKept > 0) {
        t += "\n\n★ 保留了 " + R.diffKept + " 个对比层（隐藏状态）";
        t += "\n  名字形如「__对比 0N-…(差值)」，想看哪一步改了什么就点开它的眼睛。";
        t += "\n  （送去 AE 前记得先删掉它们，免得在 AE 工程里多出隐藏层）";
    }
    if (R.failed.length) {
        t += "\n\n失败明细：";
        for (var i = 0; i < R.failed.length && i < 6; i++) t += "\n· " + R.failed[i];
    }
    t += "\n\n详细日志：\n" + LOG.path;
    try { alert(t); } catch (e) {}
}

function baseNameOf(p) {
    try {
        var s = "" + p;
        var i = s.lastIndexOf("/");
        return (i >= 0) ? s.substring(i + 1) : s;
    } catch (e) { return "" + p; }
}

function failHard(msg) {
    logOpen();
    plog("✗ " + msg);
    logClose();
    if (OPTIONS.askFinish) { try { alert(msg); } catch (e) {} }
}

/* ==========================================================================
 * 启动块（放文件末尾：上面所有 var 都已赋过值）
 * ========================================================================== */
try {
    main();
} catch (eOuter) {
    try { pbClose(); } catch (eP) {}
    try {
        var __ln = ""; try { __ln = eOuter.line; } catch (eL) {}
        logOpen();
        plog("✗ 整体出错：" + eOuter + "（行 " + __ln + "）");
        logClose();
        if (OPTIONS.askFinish) {
            alert("ps 00_single 运行出错：\n" + eOuter + "\n行号: " + __ln + "\n日志: " + LOG.path);
        }
    } catch (eAl) {}
}

})();
