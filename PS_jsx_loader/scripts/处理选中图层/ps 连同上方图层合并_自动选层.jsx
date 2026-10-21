// ===========================================================================
// ps 连同上方图层合并（自动选层版）
// ---------------------------------------------------------------------------
// ★ 只选中【一个文件夹（或图层）】，脚本自己把"它上方的剪贴层"也加进选区，
//   然后一次合并（= Ctrl+E），最后还原名字与混合模式。
//
// 原理（本轮实测发现）：
//   ActionManager 的 slct 是【累加】的 —— 每次调用往选区里【加】一层。
//   所以脚本可以：
//       deselect() -> slct(第1层) -> slct(第2层) -> ...  得到真实多层选区 ✔
//   这是之前所有"slct 只能选 1 层"结论的根源：那时是一次性塞列表（无效），
//   而不是逐层累加。
//
// 行为：
//   1. 读当前选区。必须恰好 1 项（文件夹或图层都行）。
//   2. 找它上方的剪贴链（grouped === true，同父级、序号连续往上）。
//   3. deselect -> 逐层 slct，把"基底 + 上方剪贴链"全部加进选区。
//   4. 校验选区层数 = 期望值（不一致就中止，不动图层）。
//   5. Mrg2 合并（= Ctrl+E）。
//   6. 还原名字 = 基底原名；混合模式 = 基底原模式（穿透 -> 正常）。
//
// 额外功能（并入自"穿透检查"版）：
//   若基底是【穿透】文件夹，合并前递归扫描内部所有图层（含子文件夹 ✗），
//   收集混合模式不是【正常】的层；合并成功后弹窗报告数量 + 名称 + 模式。
//
// 日志：%TEMP%\psjsx_merge_up_auto_log.txt
// 成功不弹窗；失败/选区异常才弹。
// ===========================================================================

(function () {

var doc = null;
try { doc = app.activeDocument; } catch (e0) { doc = null; }
if (!doc) { alert("没有打开的文档。"); return; }

function cT(s) { return charIDToTypeID(s); }
function sT(s) { return stringIDToTypeID(s); }
function clean(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 200); } catch (e) { return "" + s; } }

var LOG = [];
function p(s) { try { LOG.push("" + s); } catch (e) {} }

function writeLog() {
    try {
        var f = File(Folder.temp.fsName + "/psjsx_merge_up_auto_log.txt");
        f.encoding = "UTF-8";
        if (f.open("w")) {
            try {
                f.write("===== ps 连同上方图层合并（自动选层）=====\n");
                f.write("时间：" + (new Date()).toString() + "\n");
                try { f.write("文档：" + doc.name + "\n"); } catch (e1) {}
                f.write("\n" + LOG.join("\n") + "\n");
            } finally { try { f.close(); } catch (e2) {} }
        } else { try { f.close(); } catch (e3) {} }
    } catch (e4) {}
}

/* ---------------- 读选区（itemIndex 列表 + 计数） ---------------- */
function getSelectedIndexes() {
    var out = [];
    try {
        var ref = new ActionReference();
        ref.putProperty(sT("property"), sT("targetLayers"));
        ref.putEnumerated(sT("document"), sT("ordinal"), sT("targetEnum"));
        var desc = executeActionGet(ref);
        if (!desc.hasKey(sT("targetLayers"))) return out;
        var lst = desc.getList(sT("targetLayers"));
        for (var i = 0; i < lst.count; i++) {
            var idx = -1;
            try { idx = lst.getReference(i).getIndex() + 1; } catch (e1) { idx = -1; }
            if (idx >= 0) out.push(idx);
        }
    } catch (e) {}
    return out;
}

function countSelection() {
    try {
        var ref = new ActionReference();
        ref.putProperty(sT("property"), sT("targetLayers"));
        ref.putEnumerated(sT("document"), sT("ordinal"), sT("targetEnum"));
        var d = executeActionGet(ref);
        if (!d.hasKey(sT("targetLayers"))) return 0;
        return d.getList(sT("targetLayers")).count;
    } catch (e) { return -1; }
}

/* ---------------- ★★ 一次 slct 选中多层 ★★ ----------------
 * 正确写法（来自用户笔记，诊断脚本里验证得到 2 层 ✔）：
 *   在【同一个 ActionReference】上连续多个 putIndex，再 putReference("null", ref)，
 *   并带 MkVs=false，最后只调用【一次】slct。
 *
 * ✗ 错的写法：每层调一次 slct（每次 1 个 putIndex）—— 后一次会替换前一次，
 *   结果永远只有 1 层。
 * ------------------------------------------------------- */
function selectManyInOneCall(indexList) {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    for (var i = 0; i < indexList.length; i++) {
        ref.putIndex(cT("Lyr "), indexList[i]);
    }
    desc.putReference(cT("null"), ref);
    desc.putBoolean(cT("MkVs"), false);
    executeAction(cT("slct"), desc, DialogModes.NO);
}

/* ---------------- 在父级里按 itemIndex 找 ---------------- */
function layerInParent(par, index) {
    if (!par || !par.layers) return null;
    for (var i = 0; i < par.layers.length; i++) {
        var L = par.layers[i];
        var idx = -1;
        try { idx = L.itemIndex; } catch (e1) { idx = -1; }
        if (idx === index) return L;
    }
    return null;
}

/* ==========================================================================
 * 递归扫描：找出混合模式【不是"正常"】的图层
 *   （并入自 ps 连同上方图层合并_穿透检查.jsx）
 * ========================================================================== */
function collectNonNormal(folder, out, depth, pathPrefix) {
    if (!folder || !folder.layers || depth > 30) return;
    var prefix = pathPrefix || "";
    for (var i = 0; i < folder.layers.length; i++) {
        var L = folder.layers[i];
        var nm = "";
        try { nm = "" + L.name; } catch (e1) { nm = "?"; }
        var tn = "";
        try { tn = "" + L.typename; } catch (e2) { tn = "?"; }

        if (tn === "LayerSet") {
            var gMode = "";
            try { gMode = "" + L.blendMode; } catch (e3) { gMode = "?"; }
            if (gMode !== "BlendMode.NORMAL" && gMode !== "BlendMode.PASSTHROUGH") {
                out.push({ name: nm, mode: gMode, path: prefix + nm + "（文件夹）" });
            }
            collectNonNormal(L, out, depth + 1, prefix + nm + " / ");
            continue;
        }

        var mode = "";
        try { mode = "" + L.blendMode; } catch (e4) { mode = "?"; }
        if (mode !== "BlendMode.NORMAL") {
            out.push({ name: nm, mode: mode, path: prefix + nm });
        }
    }
}

function safeName(L) { try { return "" + L.name; } catch (e) { return "?"; } }
function isClipped(L) { try { return (L.grouped === true); } catch (e) { return false; } }

/* ==========================================================================
 * 主体
 * ========================================================================== */
function main() {
    var idxList = getSelectedIndexes();
    var cnt = countSelection();
    p("选区：itemIndex = [" + idxList.join(", ") + "]，计数 " + cnt);

    if (cnt !== 1 || idxList.length !== 1) {
        p("★ 请只选中【一个】文件夹或图层（当前 " + cnt + " 个）");
        writeLog();
        alert("请只选中【一个】文件夹或图层，再跑本脚本。\n\n" +
              "脚本会自动把它上方的剪贴层一起加进选区并合并。\n\n" +
              "（当前读到 " + cnt + " 项）\n\n日志：%TEMP%\\psjsx_merge_up_auto_log.txt");
        return;
    }

    var par = null;
    try { par = doc.activeLayer.parent; } catch (eP) { par = null; }
    var base = layerInParent(par, idxList[0]);
    if (!base) {
        p("★ 在父级里找不到选中的层（itemIndex=" + idxList[0] + "）");
        writeLog();
        alert("找不到选中的层，请重新选中后再跑。\n\n日志：%TEMP%\\psjsx_merge_up_auto_log.txt");
        return;
    }

    var baseName = safeName(base);
    var baseBlend = null;
    try { baseBlend = base.blendMode; } catch (eB) { baseBlend = null; }

    /* ★ 若是【穿透】文件夹 -> 合并前扫描内部非"正常"混合模式（合并后对象会失效 ✗） */
    var passReport = [];
    var isPassThroughFolder = false;
    try {
        var bType0 = "";
        try { bType0 = "" + base.typename; } catch (eT0) { bType0 = ""; }
        if (bType0 === "LayerSet" && baseBlend === BlendMode.PASSTHROUGH) {
            isPassThroughFolder = true;
            collectNonNormal(base, passReport, 0, "");
            p("  · 基底是【穿透】文件夹，内部非正常混合模式：" + passReport.length + " 个");
            for (var __pr = 0; __pr < passReport.length; __pr++) {
                p("      - " + passReport[__pr].path + "  →  " + passReport[__pr].mode);
            }
        }
    } catch (eScan) {
        p("  · 扫描内部混合模式出错（忽略）：" + clean(eScan));
    }
    var baseIdx = idxList[0];
    var baseIsSet = false;
    try { baseIsSet = (base.typename === "LayerSet"); } catch (eT) {}

    p("基底：「" + baseName + "」　itemIndex=" + baseIdx + "　类型=" + (baseIsSet ? "文件夹" : "图层"));
    p("  原混合模式：" + baseBlend);

    /* ---- 找上方剪贴链：序号 ≥ baseIdx+1 且连续、且 grouped === true ---- */
    var chainIdx = [];
    var maxIdx = -1;
    try {
        var all = par.layers;
        for (var i = 0; i < all.length; i++) {
            var ix = -1;
            try { ix = all[i].itemIndex; } catch (e5) { ix = -1; }
            if (ix > maxIdx) maxIdx = ix;
        }
    } catch (e6) { maxIdx = -1; }

    var cursor = baseIdx + 1;
    while (cursor <= maxIdx) {
        var L = layerInParent(par, cursor);
        if (!L) break;
        if (!isClipped(L)) break;                 /* 不剪贴 -> 剪贴链到此结束 */
        chainIdx.push(cursor);
        cursor++;
    }

    p("上方剪贴链：" + chainIdx.length + " 个" +
      (chainIdx.length ? ("（itemIndex " + chainIdx.join(", ") + "）") : "（无）"));

    /* ★★★ 关键兜底：如果只有基底 1 个对象 ★★★
     *   PS 会把它当成「合并组」（对带矢量蒙版的文件夹会报"程序错误"）。
     *   所以这里【新建一个空图层放到基底下面】，让选区变成 2 个对象，
     *   从而走「合并图层」—— 那条路能正常处理带蒙版的文件夹。
     *   （空图层不会影响画面：它完全透明，合并后就是结果层。） */
    var tempEmptyId = -1;
    var tempEmptyIdx = -1;
    if (chainIdx.length === 0) {
        p("只有基底 1 个对象 -> 建一个空图层放在它下面，凑成 2 个（走「合并图层」）");
        try {
            /* ★ artLayers.add() 永远加到【文档根】，而这个文件夹在深层嵌套里 ✗
               （实测落到 itemIndex=111，根本不在旁边 ✗）。
               -> 建完之后用 move 把它搬到【文件夹正上方】：
                  PLACEAFTER = 组内容之后（会跑到组下面 ✗）
                  PLACEBEFORE = 组之前（= 正上方 ✔） */
            var emptyL = doc.artLayers.add();
            try { emptyL.name = "__psjsx_合并临时底"; } catch (eEN) {}
            try {
                emptyL.move(base, ElementPlacement.PLACEBEFORE);
                p("  · move(PLACEBEFORE) 成功");
            } catch (eMV1) {
                p("  · move(PLACEBEFORE) 失败：" + clean(eMV1));
                try { emptyL.move(base, ElementPlacement.PLACEAFTER); p("  · 改用 PLACEAFTER 成功"); }
                catch (eMV2) { p("  ★ PLACEAFTER 也失败：" + clean(eMV2)); }
            }
            try { tempEmptyId = emptyL.id; } catch (eID) { tempEmptyId = -1; }
            try { tempEmptyIdx = emptyL.itemIndex; } catch (eIX) { tempEmptyIdx = -1; }
            p("  空图层已建：id=" + tempEmptyId + "　itemIndex=" + tempEmptyIdx);
            if (tempEmptyIdx >= 0) { chainIdx.push(tempEmptyIdx); }
        } catch (eEmpty) {
            p("  ★ 建空图层失败：" + clean(eEmpty) + "（将只选基底 1 层）");
        }
    }

    /* ★★★ 极其关键：建空图层会让【所有图层的 itemIndex 变化】★★★
     *   doc.artLayers.add() 会把新层加在文档最上面，下面每一层的序号都 +1。
     *   所以必须【重新读一遍】基底和剪贴链的序号，否则 putIndex 会指到别的层上
     *   （之前的现象：以为选了文件夹，实际选中的是它内部的图层 ✗）。 */
    try {
        var newBaseIdx = -1;
        try { newBaseIdx = base.itemIndex; } catch (eNB) { newBaseIdx = -1; }
        if (newBaseIdx >= 0 && newBaseIdx !== baseIdx) {
            p("  · 序号已变化：基底 " + baseIdx + " -> " + newBaseIdx + "（因为新建了图层）");
            baseIdx = newBaseIdx;
        }
        /* 剪贴链也重新算一遍 */
        var newChain = [];
        var cur2 = baseIdx + 1;
        var max2 = -1;
        try {
            for (var q2 = 0; q2 < par.layers.length; q2++) {
                var ix2 = -1;
                try { ix2 = par.layers[q2].itemIndex; } catch (eQ2) { ix2 = -1; }
                if (ix2 > max2) max2 = ix2;
            }
        } catch (eM2) { max2 = -1; }
        while (cur2 <= max2) {
            var L2 = layerInParent(par, cur2);
            if (!L2) break;
            if (!isClipped(L2)) break;
            newChain.push(cur2);
            cur2++;
        }
        chainIdx = newChain;

        /* ★★★ 关键：重算只收"grouped===true"的剪贴层，会把我们刚建的空图层丢掉 ✗
           空层不是剪贴层，但它必须参与这次合并（否则又只剩 1 个对象 ✗）。
           所以这里把它补回去。 */
        if (tempEmptyIdx >= 0) {
            var hasIt = false;
            for (var kk = 0; kk < chainIdx.length; kk++) {
                if (chainIdx[kk] === tempEmptyIdx) { hasIt = true; break; }
            }
            if (!hasIt) {
                chainIdx.push(tempEmptyIdx);
                p("  · 把临时空图层（itemIndex=" + tempEmptyIdx + "）补回选区");
            }
        }

        p("  · 重算后：基底 itemIndex=" + baseIdx + "，参与合并的其它层 " + chainIdx.length + " 个" +
          (chainIdx.length ? ("（" + chainIdx.join(", ") + "）") : ""));
    } catch (eReIdx) {
        p("  ★ 重算序号失败：" + clean(eReIdx));
    }

    /* ---- 建真实多层选区：deselect -> 逐层 slct 累加 ---- */
    var want = 1 + chainIdx.length;
    p("准备选中 " + want + " 层（基底 + 上方剪贴链）");

    try { doc.selection.deselect(); } catch (eDS) { p("  · deselect 失败（忽略）：" + clean(eDS)); }

    var added = 0;
    var allIdx = [baseIdx];
    for (var k = 0; k < chainIdx.length; k++) { allIdx.push(chainIdx[k]); }
    try {
        selectManyInOneCall(allIdx);
        added = allIdx.length;
    } catch (eAdd) {
        p("  ★ 一次多选失败：" + clean(eAdd));
    }

    var got = countSelection();
    p("  选区自检：期望 " + want + " 层，实际 " + got + " 层（加选 " + added + " 次）");

    if (got !== want) {
        p("★ 选区层数不对，中止（不动图层）");
        writeLog();
        alert("选中图层失败：期望 " + want + " 层，实际只选中 " + got + " 层。\n\n" +
              "已中止，没有改动任何图层。\n\n日志：%TEMP%\\psjsx_merge_up_auto_log.txt");
        return;
    }

    /* ---- 合并 ---- */
    var prevD = null;
    try { prevD = app.displayDialogs; } catch (ePD) { prevD = null; }
    try { app.displayDialogs = DialogModes.NO; } catch (ePD2) {}

    var merged = false;
    try {
        executeAction(cT("Mrg2"), new ActionDescriptor(), DialogModes.NO);
        merged = true;
        p("  OK 合并执行成功");
    } catch (eM) {
        p("  ★ 合并失败：" + clean(eM));
    } finally {
        try { if (prevD !== null) app.displayDialogs = prevD; } catch (ePD3) {}
    }

    if (!merged) {
        /* 兜底：把临时空图层删掉，别留在文档里 */
        if (tempEmptyId >= 0) {
            try {
                var rDel = new ActionReference();
                rDel.putIdentifier(cT("Lyr "), tempEmptyId);
                var dDel = new ActionDescriptor();
                dDel.putReference(cT("null"), rDel);
                executeAction(cT("Dlt "), dDel, DialogModes.NO);
                p("  · 已删除临时空图层（id=" + tempEmptyId + "）");
            } catch (eDel) { p("  · 删除临时空图层失败：" + clean(eDel)); }
        }
        writeLog();
        alert("合并失败：\n" + LOG[LOG.length - 1] + "\n\n日志：%TEMP%\\psjsx_merge_up_auto_log.txt");
        return;
    }

    /* ---- 结果层：还原名字 / 混合模式 ---- */
    var res = null;
    try { res = doc.activeLayer; } catch (eR) { res = null; }

    if (!res) {
        p("  ★ 合并后拿不到结果层");
    } else {
        if (baseName) {
            try { res.name = baseName; p("  OK 名字已还原：「" + baseName + "」"); }
            catch (eN) { p("  ★ 还原名字失败：" + clean(eN)); }
        }
        var wantPass = false;
        try { wantPass = (baseBlend === BlendMode.PASSTHROUGH); } catch (eP2) { wantPass = false; }
        if (wantPass) {
            try { res.blendMode = BlendMode.NORMAL; } catch (eNP) {}
            p("  · 原模式是【穿透】—— 结果是普通图层，保持【正常】（符合预期）");
        } else if (baseBlend !== null) {
            try {
                res.blendMode = baseBlend;
                p("  OK 混合模式已还原：" + baseBlend);
            } catch (eBS) { p("  ★ 设置混合模式失败：" + clean(eBS)); }
        }
    }

    writeLog();

    /* ★ 成功不弹窗 —— 唯一例外：穿透文件夹内部有非"正常"混合模式时报告一次 */
    if (isPassThroughFolder && passReport.length > 0) {
        var lines = [];
        lines.push("合并成功。");
        lines.push("");
        lines.push("但要注意：这个文件夹原本是【穿透】模式，而它内部下面这些图层的");
        lines.push("混合模式不是【正常】（共 " + passReport.length + " 个）：");
        lines.push("");
        for (var __q = 0; __q < passReport.length; __q++) {
            var __m = passReport[__q].mode;
            try { __m = ("" + __m).replace("BlendMode.", ""); } catch (eNm) {}
            lines.push("  " + (__q + 1) + ". " + passReport[__q].path);
            lines.push("       混合模式 = " + __m);
        }
        lines.push("");
        lines.push("说明：文件夹是穿透时，内部这些混合模式会与文件夹下方的内容相互作用；");
        lines.push("      合并成一个普通图层后，这种相互作用就没有了，画面可能与原来不同。");
        lines.push("      如果确认看起来没问题，可以忽略这条提示。");
        lines.push("");
        lines.push("（日志：%TEMP%\\psjsx_merge_up_auto_log.txt）");
        try { alert(lines.join("\n")); } catch (eAl) {}
    }
}

try { $.global.PSJSX_MERGE_UP_AUTO_HOOK = main; } catch (eG) {}
try {
    doc.suspendHistory("连同上方图层合并（自动选层）", "PSJSX_MERGE_UP_AUTO_HOOK()");
} catch (eH) {
    try { alert("执行失败：" + eH); } catch (eH2) {}
} finally {
    try { delete $.global.PSJSX_MERGE_UP_AUTO_HOOK; } catch (eD) { $.global.PSJSX_MERGE_UP_AUTO_HOOK = null; }
}

})();
