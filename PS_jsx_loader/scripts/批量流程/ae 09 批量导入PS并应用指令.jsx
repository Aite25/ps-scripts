// ===========================================================================
// ae 09 批量导入PS并应用AE指令
// ---------------------------------------------------------------------------
// 用途
//   选一个文件夹 -> 批量导入其中的 psd/psb -> 每导入一个，立刻用 ae_lib 引擎
//   应用它配套的 <原名>_ae.json（等价于「手动跑 ae 08 并选那个 JSON」）。
//
// ★★ 为什么必须"导入一个 -> 立刻跑一次"，不能先把 N 个都导进来 ★★
//   引擎 ae_lib 是【纯按名字】定位合成 / 图层 / 文件夹的：
//       function AE_findItemByName(name, inFolder) {
//           for (var i = 1; i <= folder.numItems && !res; i++) {
//               var it = folder.item(i);
//               if (it.name === name) { ... }        // 只比名字
//   如果先把 N 个 PSD 全导进来：
//     · 两个 PSD 里同名的图层组（比如都叫"名字"）会生成重名合成；
//     · AE 会把后导入的同名项改名成 "名字 2"，而 JSON 里写的是 "名字" -> 永远对不上；
//     · 即使没被改名，AE_findItemByName 也只拿到【第一个】找到的 ->
//       可能把 A 文件的样式/蒙版应用到 B 文件的合成上。
//   所以本脚本严格串行：导入 -> 应用 -> 下一个，让工程里始终只有一份相关合成。
//
// 前提
//   1) PS 侧已经跑过 ps 07，每个 psd/psb 旁边都有 <原名>_ae.json
//   2) AE 的 PSD 导入选项要先在 UI 里设一次（AE 脚本接口没有暴露这两项）：
//        文件 > 导入 > 文件 -> 选一个 psd
//        Import Kind: Composition - Retain Layer Sizes
//        勾上 Editable Layer Styles
//      设过一次之后，脚本的 importFile() 会沿用这份设置。
//
// 特点
//   · 静默：不逐文件弹窗（本脚本会打开引擎的 $.global.AE_HANDOFF_QUIET），
//     最后一次性汇总
//   · 报告：%TEMP%\ae09批量报告_<时间戳>.txt
//     每个文件的引擎报告：JSON 旁边的 <原名>_ae08报告.txt
//   · 缺 JSON 的 psd 自动跳过，不中断
//   · 单个失败只记一笔，继续下一个
// ===========================================================================

(function () {

var ENGINE_PATH = "C:/Program Files (x86)/Common Files/Adobe/CEP/extensions/PS_jsx_loader/scripts/批量流程/ae_lib 引擎_应用AE指令.jsx";
var ENGINE_NAME = "ae_lib 引擎_应用AE指令.jsx";
var JSON_SUFFIX = "_ae.json";

var OUT = [];
var RPT = "";

function p(s) { OUT.push(s); }
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function stamp() {
    var d = new Date();
    return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
           "_" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}
function tryFile(s) {
    try { var f = File(s); return (f && f.exists) ? f : null; } catch (e) { return null; }
}
function baseName(fn) {
    var s = "" + fn;
    var i = s.lastIndexOf(".");
    return (i > 0) ? s.substring(0, i) : s;
}
function isPs(fn) {
    var s = ("" + fn).toLowerCase();
    return (s.length > 4) && (s.substring(s.length - 4) === ".psd" || s.substring(s.length - 4) === ".psb");
}

/* ===================== 1) 选文件夹 ===================== */
var dir = null;
try {
    dir = Folder.selectDialog("选择包含 psd/psb 的文件夹（每个文件旁边要有 <原名>_ae.json）");
} catch (eD) {}
if (!dir) { alert("没有选择文件夹，已取消。"); return; }
p("文件夹：" + dir.fsName);
p("");

/* ===================== 2) 列出 psd / psb ===================== */
var files = [];
try {
    var arr = dir.getFiles();
    for (var i = 0; i < arr.length; i++) {
        var f = arr[i];
        if (!(f instanceof File)) continue;
        if (isPs(f.name)) files.push(f);
    }
} catch (eL) {}

if (!files.length) {
    alert("这个文件夹里没有 psd/psb：\n" + dir.fsName);
    return;
}

/* ===================== 3) 找并加载引擎（只加载一次） ===================== */
var eng = tryFile(ENGINE_PATH);
if (!eng) {
    var dirs = [];
    try {
        var self = File(decodeURI("" + $.fileName));
        if (self && self.parent) dirs.push(self.parent.fsName);
    } catch (eS1) {}
    dirs.push("C:/Program Files (x86)/Common Files/Adobe/CEP/extensions/PS_jsx_loader/scripts/批量流程");
    for (var di = 0; di < dirs.length; di++) {
        if (!dirs[di]) continue;
        var c = tryFile(dirs[di] + "/" + ENGINE_NAME);
        if (c) { eng = c; break; }
    }
}
if (!eng) {
    alert("找不到引擎文件。\n\n请把它的完整路径填到本脚本开头的 ENGINE_PATH。\n\n默认路径：\n" + ENGINE_PATH);
    return;
}
p("引擎：" + eng.fsName);
p("");

try {
    $.evalFile(eng);
} catch (eEval) {
    alert("加载引擎失败：\n" + eEval);
    return;
}
if (typeof AEHandoffRun !== "function") {
    alert("引擎里没有找到 AEHandoffRun() 入口。");
    return;
}

/* ===================== 4) 报告文件路径 ===================== */
try { RPT = Folder.temp.fsName + "/ae09批量报告_" + stamp() + ".txt"; } catch (eT) { RPT = ""; }

/* ===================== 5) 逐个导入 + 应用（静默） ===================== */
var okN = 0, failN = 0, skipN = 0;
var okList = [], failList = [], skipList = [];

for (var k = 0; k < files.length; k++) {
    var pf = files[k];
    var base = baseName(pf.name);
    var dirOf = (pf.parent ? pf.parent.fsName : dir.fsName);
    var jsonPath = dirOf + "/" + base + JSON_SUFFIX;
    var jf = tryFile(jsonPath);

    p("-------- " + (k + 1) + " / " + files.length + " --------");
    p("PS 文件 : " + pf.name);

    if (!jf) {
        p("JSON    : 找不到 " + base + JSON_SUFFIX);
        p("结果    : 跳过（没有配套 JSON）");
        p("");
        skipN++;
        skipList.push(pf.name);
        continue;
    }
    p("JSON    : " + jf.name);

    /* 5.1 导入 */
    var imported = null;
    try {
        var io = new ImportOptions(pf);
        try { io.importAs = ImportOptions.ImportAsType.COMP; } catch (eIA) {}
        imported = app.project.importFile(io);
        p("导入    : OK  " + (imported ? imported.name : "?") +
          (imported && imported.typeName ? "  (" + imported.typeName + ")" : ""));
    } catch (eImp) {
        p("导入    : 失败：" + eImp);
        p("");
        failN++;
        failList.push(pf.name + " -- 导入失败：" + eImp);
        continue;
    }

    /* 5.2 应用指令（等价于 ae 08；静默，不弹窗） */
    var prevQuiet = false;
    try { prevQuiet = !!$.global.AE_HANDOFF_QUIET; } catch (eQ0) {}
    try {
        $.global.AE_HANDOFF_QUIET = true;
        $.global.AE_HANDOFF_JSON = jsonPath;
        AEHandoffRun();
        p("应用    : OK  已执行引擎（报告：" + base + "_ae08报告.txt）");
        okN++;
        okList.push(pf.name);
    } catch (eRun) {
        p("应用    : 失败：" + eRun);
        failN++;
        failList.push(pf.name + " -- 应用失败：" + eRun);
    } finally {
        try { $.global.AE_HANDOFF_QUIET = prevQuiet; } catch (eQ1) {}
    }
    p("");
}

/* ===================== 6) 汇总 ===================== */
var head = "批量导入完成：成功 " + okN + " / 失败 " + failN + " / 跳过 " + skipN +
           "（共 " + files.length + " 个）";

p("======== 汇总 ========");
p(head);
if (okList.length) {
    p("");
    p("OK 成功：");
    for (var a = 0; a < okList.length; a++) p("   - " + okList[a]);
}
if (failList.length) {
    p("");
    p("!! 失败：");
    for (var b = 0; b < failList.length; b++) p("   - " + failList[b]);
}
if (skipList.length) {
    p("");
    p(".. 跳过（没有 JSON）：");
    for (var c = 0; c < skipList.length; c++) p("   - " + skipList[c]);
}

var full = OUT.join("\n") + "\n";

/* 写报告 */
if (RPT) {
    try {
        var rf = File(RPT);
        rf.encoding = "UTF-8";
        if (rf.open("w")) {
            try { rf.write(full); } finally { try { rf.close(); } catch (eC) {} }
        } else {
            try { rf.close(); } catch (eC2) {}
        }
    } catch (eW) {}
}

p("");
p("报告文件：" + (RPT ? RPT : "（没写成功）"));

/* 一次性汇总弹窗 */
var msg = head;
if (failList.length) {
    msg += "\n\n失败 " + failList.length + " 个，详见报告：\n" + RPT;
} else {
    msg += "\n\n全部成功。" + (skipN ? ("\n跳过 " + skipN + " 个（没有配套 JSON）。") : "");
}
try { alert(msg); } catch (eA) {}

})();
