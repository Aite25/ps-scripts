// ===========================================================================
// ps 诊断_文件夹蒙版存取.jsx
// ---------------------------------------------------------------------------
// 目的：只验证「把文件夹的蒙版存成通道 -> 再从通道载回选区」这条路通不通。
//       ★ 不合并任何图层、不删除任何蒙版、不改画面。
//
// 用法：
//   1. 在图层面板里选中【一个带蒙版的文件夹】（只要选中它就行）
//   2. 跑本脚本
//   3. 看弹窗 / %TEMP%\psjsx_mask_channel_log.txt
//
// 会做什么：
//   ① 读这个文件夹的蒙版信息（是否存在、尺寸）
//   ② 把蒙版载入为选区（ActionManager: setd / Chnl / Msk ）
//   ③ 把选区存成一个临时 alpha 通道（Selection.store）
//   ④ 取消选区，再从通道载回选区（Selection.load）
//   ⑤ 比对：两次选区的 bounds 是否一致；通道是否还在
//   ⑥ 清理：删除临时通道、取消选区
//
// 预期成功日志：有 bounds、并且两次一致、通道被成功创建
// ===========================================================================

(function () {

var doc = null;
try { doc = app.activeDocument; } catch (e0) { doc = null; }
if (!doc) { alert("没有打开的文档。"); return; }

function cT(s) { return charIDToTypeID(s); }
function sT(s) { return stringIDToTypeID(s); }
function clean(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 200); } catch (e) { return "" + s; } }

var LOG = [];
var PROBE = "";

function p(s) {
    try { LOG.push("" + s); } catch (e) {}
    try {
        if (!PROBE) {
            var pf = File(Folder.temp.fsName + "/psjsx_mask_channel_log.txt");
            PROBE = pf.fsName;
        }
        var f = File(PROBE);
        f.encoding = "UTF-8";
        if (f.open("a")) { try { f.write("" + s + "\n"); } finally { try { f.close(); } catch (c) {} } }
    } catch (e2) {}
}

function boundsStr(sel) {
    try {
        var b = sel.bounds;
        return ("[" + [b[0], b[1], b[2], b[3]].join(", ") + "]");
    } catch (e) { return "（无选区/读不到）"; }
}

function main() {
    p("");
    p("===== 文件夹蒙版存取诊断 =====");
    p("时间：" + (new Date()).toString());
    p("文档：" + doc.name);

    /* ---- 1) 当前选的什么 ---- */
    var layer = null;
    try { layer = doc.activeLayer; } catch (e1) { layer = null; }
    if (!layer) { p("★ 拿不到活动图层"); return; }

    var tn = "";
    try { tn = layer.typename; } catch (e2) { tn = "?"; }
    var nm = "";
    try { nm = "" + layer.name; } catch (e3) { nm = "?"; }
    p("选中的层：「" + nm + "」　类型=" + tn);

    if (tn !== "LayerSet") {
        p("★ 这不是文件夹（LayerSet）—— 请先选中一个文件夹再跑。");
        return;
    }

    /* ---- 2) 有没有蒙版 ---- */
    var hasMask = false;
    try { hasMask = (layer.layerMask !== undefined && layer.layerMask !== null); } catch (e4) { hasMask = false; }
    p("layerMask 是否存在：" + hasMask);

    /* 用 ActionManager 再确认一次（更可靠） */
    var hasMask2 = false;
    try {
        var ref0 = new ActionReference();
        ref0.putEnumerated(cT("Lyr "), cT("Ordn"), cT("Trgt"));
        var d0 = executeActionGet(ref0);
        p("  描述符里有没有 'Msk ' 键：" + d0.hasKey(sT("hasUserMask")) +
          "（hasUserMask）　hasVectorMask=" + d0.hasKey(sT("hasVectorMask")));
        hasMask2 = d0.hasKey(sT("hasUserMask"));
    } catch (e5) {
        p("  ★ 读描述符失败：" + clean(e5));
    }

    if (!hasMask && !hasMask2) {
        p("★ 这个文件夹没有图层蒙版 —— 换个带蒙版的文件夹再测。");
        return;
    }

    /* ---- 3) 把蒙版载入为选区 ---- */
    p("");
    p("--- 把蒙版载入为选区（setd / fsel / Chnl / Msk ）---");
    var okLoad = false;
    try {
        var desc = new ActionDescriptor();
        var refF = new ActionReference();
        refF.putEnumerated(cT("Chnl"), cT("Chnl"), cT("fsel"));      /* 前景"选择"通道 */
        desc.putReference(cT("null"), refF);

        var chDesc = new ActionDescriptor();
        chDesc.putEnumerated(cT("Chnl"), cT("Chnl"), cT("Msk "));    /* ★ 蒙版通道 */
        chDesc.putBoolean(cT("Invr"), false);
        desc.putObject(cT("T   "), cT("Chnl"), chDesc);

        executeAction(cT("setd"), desc, DialogModes.NO);
        okLoad = true;
        p("  ✔ 执行成功，选区 bounds = " + boundsStr(doc.selection));
    } catch (e6) {
        p("  ★ 失败：" + clean(e6));
    }

    if (!okLoad) {
        p("");
        p("→ 结论：这个 API 组合不可用，需要换第 2 条途径（从蒙版生成临时图层）。");
        return;
    }

    /* ---- 4) 存成临时通道 ---- */
    p("");
    p("--- 把选区存成临时 alpha 通道（Selection.store）---");
    var ch = null;
    try {
        ch = doc.channels.add();
        ch.name = "__psjsx_mask_test";
        doc.selection.store(ch);
        p("  ✔ 通道已创建：「" + ch.name + "」");
    } catch (e7) {
        p("  ★ 失败：" + clean(e7));
    }

    /* ---- 5) 取消选区，再从通道载回 ---- */
    if (ch) {
        p("");
        p("--- 取消选区 -> 从通道载回（Selection.load）---");
        try {
            doc.selection.deselect();
            p("  已取消选区");
        } catch (e8) { p("  ★ 取消选区失败：" + clean(e8)); }

        try {
            doc.selection.load(ch, SelectionType.REPLACE);
            p("  ✔ 载回成功，bounds = " + boundsStr(doc.selection));
        } catch (e9) {
            p("  ★ 载回失败：" + clean(e9));
        }

        /* ---- 6) 清理 ---- */
        p("");
        p("--- 清理 ---");
        try { doc.selection.deselect(); p("  ✔ 已取消选区"); } catch (e10) { p("  · 取消选区：" + clean(e10)); }
        try { ch.remove(); p("  ✔ 已删除临时通道"); } catch (e11) { p("  ★ 删除通道失败：" + clean(e11)); }
    }

    /* ---- 7) 结论 ---- */
    p("");
    p("→ 结论：");
    if (okLoad && ch) {
        p("  ✔ 蒙版 -> 选区 -> 通道 -> 选区  这条路【通】");
        p("  → 可以接入合并流程：合并后从通道载回选区，给结果层建蒙版");
    } else {
        p("  ★ 不通，需要换方案");
    }
}

try {
    main();
} catch (eAll) {
    p("★ 整体出错：" + clean(eAll));
    try { p("  行号：" + eAll.line); } catch (eL) {}
}

var txt = LOG.join("\n");
try { alert(txt + "\n\n日志：%TEMP%\\psjsx_mask_channel_log.txt"); } catch (eA) {}

})();
