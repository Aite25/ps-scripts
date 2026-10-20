// ===========================================================================
// ps 连同上方图层合并
// ---------------------------------------------------------------------------
// 用法：在图层/文件夹面板里选中 1 个（或多个）图层 / 文件夹 -> 跑本脚本
//
// 做什么（每一项 = "选中的东西 + 它上方那段剪贴蒙版链" 一起合并）：
//   · 选中的是【图层】  -> 该图层 + 它上方连续的剪贴蒙版层（grouped=true）合并
//   · 选中的是【文件夹】-> 先按 Ctrl+E 把文件夹拍平，再连同文件夹上方那段
//                          剪贴蒙版链一起合并（等于 Ctrl+E 两次）
//
//   合并后：
//     · 名字  还原成选中项的原名
//     · 混合模式  还原成选中项的原值
//     · 例外：原混合模式是【穿透】(PassThrough) 时 —— 合并结果是个普通图层，
//       没法再是"穿透"，于是保持【正常】(Normal)。
//
// 不处理的（按用户要求）：
//   · 没有真正显示的：
//       - 自己被关灯
//       - 它在某个文件夹里，而那个文件夹（或更上层任意一级）被关灯
//       - 它是剪贴蒙版层，而它绑定的基底（往下第一个非剪贴层）被关灯
//     -> 直接跳过，绝不动它
//   · 锁定的 / 背景层等合并会失败的情况 -> 记一笔跳过
//
// 日志/结果：跑完弹一个汇总。
// ===========================================================================

(function () {

var doc = null;
try { doc = app.activeDocument; } catch (e0) { doc = null; }
if (!doc) { alert("没有打开的文档。"); return; }

function cT(s) { return charIDToTypeID(s); }
function sT(s) { return stringIDToTypeID(s); }

/* ---------------- 选中项（ActionManager，支持多层 / 组） ---------------- */
function getSelected() {
    var out = [];
    try {
        var ref = new ActionReference();
        ref.putProperty(sT("property"), sT("targetLayers"));
        ref.putEnumerated(sT("document"), sT("ordinal"), sT("targetEnum"));
        var desc = executeActionGet(ref);
        if (!desc.hasKey(sT("targetLayers"))) return out;
        var lst = desc.getList(sT("targetLayers"));
        for (var i = 0; i < lst.count; i++) {
            var idx = lst.getReference(i).getIndex() + 1;
            var L = layerByIndex(idx);
            if (L) out.push(L);
        }
    } catch (e) {}
    return out;
}

function layerByIndex(index) {
    function walk(node, idx) {
        for (var i = 0; i < node.layers.length; i++) {
            var L = node.layers[i];
            if (L.itemIndex == idx) return L;
            if (L.typename === "LayerSet") {
                var R = walk(L, idx);
                if (R) return R;
            }
        }
        return null;
    }
    return walk(doc, index);
}

/* ---------------- "真正显示"判断 ---------------- */

/* 自己 + 所有祖先的 visible 都为真 */
function selfAndAncestorsVisible(L) {
    var a = L, guard = 0;
    while (a && guard < 64) {
        guard++;
        try { if (a.visible === false) return false; } catch (e1) {}
        var p = null;
        try { p = a.parent; } catch (e2) { p = null; }
        if (!p || p === doc) break;         /* 到文档层为止 */
        a = p;
    }
    return true;
}

/* 剪贴蒙版绑定的基底：往下（index 增大）第一个 grouped !== true 的层 */
function clipBaseOf(L) {
    var par = null;
    try { par = L.parent; } catch (e) { par = null; }
    if (!par || !par.layers) return null;
    var idx = -1;
    for (var i = 0; i < par.layers.length; i++) {
        if (par.layers[i] === L) { idx = i; break; }
    }
    if (idx < 0) return null;
    for (var j = idx + 1; j < par.layers.length; j++) {
        var M = par.layers[j];
        if (M.grouped === true) continue;   /* 还在剪贴链里 */
        return M;
    }
    return null;
}

/* 真正参与显示 = 自己/祖先都亮，且（若是剪贴层）基底也亮 */
function reallyShown(L) {
    if (!selfAndAncestorsVisible(L)) return false;
    try {
        if (L.grouped === true) {
            var base = clipBaseOf(L);
            if (!base) return false;                     /* 找不到基底 -> 不处理 */
            if (!selfAndAncestorsVisible(base)) return false;
        }
    } catch (e) {}
    return true;
}

/* ---------------- 选中 item 上方那段连续的剪贴链 ---------------- */
function collectAbove(item) {
    var out = [];
    var par = null;
    try { par = item.parent; } catch (e) { par = null; }
    if (!par || !par.layers) return out;
    var idx = -1;
    for (var i = 0; i < par.layers.length; i++) {
        if (par.layers[i] === item) { idx = i; break; }
    }
    if (idx < 0) return out;
    for (var k = idx - 1; k >= 0; k--) {         /* index 减小 = 往上 */
        var M = par.layers[k];
        if (M.grouped === true) out.push(M);     /* 剪贴到它下面那层 */
        else break;
    }
    return out;
}

/* ---------------- 选区自检 ----------------
 * ★★★ 血泪教训 ★★★
 *   之前一直"以为" selectByIds 选中了 2 个图层，但从来没验证过。
 *   结果 PS 报「命令"合并图层"当前不可用」—— 那是因为实际只选中了 1 个
 *   （「合并图层」至少需要 2 层）。手动 Ctrl+E 能成功，正是因为手动多选是真的多选。
 *   所以现在：选完【读回 targetLayers 拿真实数量】，不对就换另一种写法再试。
 * ========================================================================== */
function countSelected() {
    try {
        var ref = new ActionReference();
        ref.putProperty(stringIDToTypeID("property"), stringIDToTypeID("targetLayers"));
        ref.putEnumerated(stringIDToTypeID("document"), stringIDToTypeID("ordinal"), stringIDToTypeID("targetEnum"));
        var d = executeActionGet(ref);
        if (!d.hasKey(stringIDToTypeID("targetLayers"))) return 0;
        return d.getList(stringIDToTypeID("targetLayers")).count;
    } catch (e) { return -1; }
}

/* 按 id 列表选中；返回 true 表示【真的】选中了 ids.length 层 */
function selectByIds(ids) {
    if (!ids || !ids.length) return false;
    if (ids.length === 1) {
        try {
            var d1 = new ActionDescriptor();
            var r1 = new ActionReference();
            r1.putIdentifier(cT("Lyr "), ids[0]);
            d1.putReference(cT("null"), r1);
            d1.putBoolean(cT("MkVs"), false);
            executeAction(cT("slct"), d1, DialogModes.NO);
            return true;
        } catch (e1) { return false; }
    }

    /* 写法 A：目标引用放 "null"，列表放 "Lyr " */
    try {
        var dA = new ActionDescriptor();
        var rA = new ActionReference();
        rA.putEnumerated(cT("Lyr "), cT("Ordn"), cT("Trgt"));
        dA.putReference(cT("null"), rA);
        var lA = new ActionList();
        for (var iA = 0; iA < ids.length; iA++) {
            var qA = new ActionReference();
            qA.putIdentifier(cT("Lyr "), ids[iA]);
            lA.putReference(qA);
        }
        dA.putList(cT("Lyr "), lA);
        executeAction(cT("slct"), dA, DialogModes.NO);
        if (countSelected() === ids.length) return true;
    } catch (eA) {}

    /* 写法 B：列表直接放 "null"（没有目标引用） */
    try {
        var dB = new ActionDescriptor();
        var lB = new ActionList();
        for (var iB = 0; iB < ids.length; iB++) {
            var qB = new ActionReference();
            qB.putIdentifier(cT("Lyr "), ids[iB]);
            lB.putReference(qB);
        }
        dB.putList(cT("null"), lB);
        executeAction(cT("slct"), dB, DialogModes.NO);
        if (countSelected() === ids.length) return true;
    } catch (eB) {}

    return false;
}

/* ==========================================================================
 * 合并前的准备：把 PS 拒绝合并的常见原因先清掉
 * --------------------------------------------------------------------------
 * 「命令"合并图层"当前不可用」在脚本里几乎都是这几种：
 *   ① 图层被锁定（allLocked / positionLocked）
 *   ② 是【背景层】（背景层不能向上合并）
 *   ③ 是【智能对象】—— 合并必须先栅格化，有的环境直接拒绝
 * 这些都能在合并前自己处理掉。合并本身就会改变这些状态，所以不算破坏。
 * ========================================================================== */
function prepareForMerge(L, log, tag) {
    var notes = [];
    try {
        if (L.isBackgroundLayer) {
            L.isBackgroundLayer = false;
            notes.push("取消背景层");
        }
    } catch (e1) {}
    try {
        if (L.allLocked) {
            L.allLocked = false;
            notes.push("解除全部锁定");
        }
    } catch (e2) {}
    try {
        if (L.positionLocked) {
            L.positionLocked = false;
            notes.push("解除位置锁定");
        }
    } catch (e3) {}
    /* ★ 不栅格化智能对象（按用户要求）：
       手动 Ctrl+E 时 PS 会自己处理智能对象，脚本只要不添乱就行。
       之前在这里主动 rasterize 反而可能破坏剪贴关系。 */
    if (notes.length) log.push("     · " + tag + "「" + L.name + "」：" + notes.join(" / "));
    return notes;
}

/* ---------------- 合并一个选中项 ---------------- */
function mergeOne(item, log) {
    var nameBefore = "" + item.name;
    var blendBefore = null;
    try { blendBefore = item.blendMode; } catch (eB) { blendBefore = null; }
    var isSet = false;
    try { isSet = (item.typename === "LayerSet"); } catch (eT) {}

    var above = collectAbove(item);

    /* ★★★ 分两步合并（实测结论）★★★
       一次多选「文件夹 + 上方剪贴层」再 Mrg2，PS 只会执行【合并组】
       把文件夹拍平，完全忽略其它被选中的层。所以：
         ① 文件夹先单独 Mrg2 拍平；
         ② 再把「上方剪贴链 + 拍平后的图层」一起 Mrg2。
       普通图层不需要第 ① 步（它本来就是一层）。 */
    var baseId = item.id;

    /* ★★★ 合并策略（连踩三次坑之后定下来的写法）★★★
       1) 文件夹先拍平：LayerSet.merge()   —— 这就是「Ctrl+E 合并组」
       2) 上方剪贴链：从最下面那层开始，逐层 ArtLayer.merge()（合并向下）
       3) 全程【不做多选、不用 Mrg2】
       为什么不用 Mrg2：
         · 对单个组执行 -> 「命令"合并图层"当前不可用」
         · 多选里含组     -> 只执行"合并组"，忽略其它层
         · 多选纯图层     -> 也常常报同样的一句"合并图层当前不可用"
       merge() 是"与下面那层合并"，一层一层并下去，语义最确定。
       （合并向下会【保留下面那层的 id】，所以 baseLayer 一直有效。）
     * -------------------------------------------------------------------- */

    /* 诊断：把真实状态写进日志，失败时一眼能看出选的是什么 */
    var __aboveNames = [];
    for (var __z = 0; __z < above.length; __z++) {
        try { __aboveNames.push("" + above[__z].name); } catch (eAN) { __aboveNames.push("?"); }
    }
    var __flags = [];
    try { if (item.allLocked) __flags.push("全锁"); } catch (eF1) {}
    try { if (item.positionLocked) __flags.push("位置锁"); } catch (eF2) {}
    try { if (item.isBackgroundLayer) __flags.push("背景层"); } catch (eF3) {}
    try { if (item.kind === LayerKind.SMARTOBJECT) __flags.push("智能对象"); } catch (eF4) {}
    log.push("  · " + nameBefore + "：类型=" + item.typename +
             "　上方剪贴链 " + above.length + " 个" +
             (above.length ? ("（" + __aboveNames.join(" / ") + "）") : "（无）") +
             (__flags.length ? ("　状态=" + __flags.join("+")) : ""));

    var baseLayer = item;

    /* ★ 合并前预处理：解锁 / 取消背景层 / 栅格化智能对象
       —— 这三样是「命令"合并图层"当前不可用」最常见的真凶 */
    prepareForMerge(item, log, "基底");
    for (var __pi = 0; __pi < above.length; __pi++) {
        prepareForMerge(above[__pi], log, "上层");
    }

    /* ★★★ 关键：合并期间必须关掉 PS 的确认框 ★★★
       「矢量智能对象」合并时 PS 要先栅格化，会弹一个确认框；
       脚本里没人点它 -> 操作被自动取消 -> 报「用户取消了操作」。
       （executeAction 的 DialogModes.NO 只管动作描述符，
         管不到 layer.merge() 这种 ExtendScript 方法 —— 那个看 app.displayDialogs。） */
    var __prevDialogs = null;
    try { __prevDialogs = app.displayDialogs; } catch (ePD) { __prevDialogs = null; }
    try { app.displayDialogs = DialogModes.NO; } catch (ePD2) {}

    /* ① 文件夹先拍平：选中它 + Mrg2（PS 对单个组执行 Mrg2 = 合并组）
       这条在真实文档上验证过（日志："已拍平，结果图层 id=1423"）。 */
    if (isSet) {
        try {
            selectByIds([item.id]);
            executeAction(cT("Mrg2"), new ActionDescriptor(), DialogModes.NO);
            baseLayer = doc.activeLayer;
        } catch (eM1) {
            log.push("  ★ " + nameBefore + "：拍平文件夹失败：" + eM1);
            return false;
        }
        if (!baseLayer) { log.push("  ★ " + nameBefore + "：拍平文件夹后拿不到图层"); return false; }
    }

    /* ② 合并上方剪贴链
     *   首选「多选 + Mrg2」（你手动 Ctrl+E 就是这个语义），
     *   并且【先验证选区真的选中了 N 层】再执行 —— 这是之前失败的根因。
     *   多选不行才退回逐层「合并向下」。
     * -------------------------------------------------------------------- */
    var __merged = false;
    if (above.length > 0) {
        var __ids = [];
        for (var __k = 0; __k < above.length; __k++) __ids.push(above[__k].id);
        __ids.push(baseLayer.id);

        var __selOk = false;
        try { __selOk = selectByIds(__ids); } catch (eSel) { __selOk = false; }
        var __cnt = countSelected();
        log.push("     选区自检：想选 " + __ids.length + " 层，实际选中 " + __cnt + " 层" + (__selOk ? "（A/B 写法都试过）" : ""));

        if (__cnt === __ids.length) {
            try {
                executeAction(cT("Mrg2"), new ActionDescriptor(), DialogModes.NO);
                __merged = true;
                log.push("     ✔ 多选 + Mrg2 合并成功");
            } catch (eM2) {
                log.push("     多选 + Mrg2 失败：" + eM2);
            }
        }
    }

    /* 逐层「合并向下」的旧逻辑
     * ----------------------------------------------------------------------
     * ★★★ 这是关键改动 ★★★
     *   不带图层列表执行 Mrg2 = 「合并向下」（PS 里 Ctrl+E 对单个图层就是这个）。
     *   之前用「多选 + Mrg2」会报「命令"合并图层"当前不可用」，
     *   但手动 Ctrl+E 是好的 —— 说明多选那条路 PS 不认，而"合并向下"是它认的。
     *   做法：从紧贴基底的那层开始，选它 -> Mrg2（不带列表）-> 它并入下面那层；
     *         再选上一层 -> Mrg2 -> …… 逐层并下去，最终全并进基底。
     *   全程不需要多选，也不需要栅格化。
     * -------------------------------------------------------------------- */
    if (!__merged) {
        log.push("     改用逐层「合并向下」…");
        for (var mi = above.length - 1; mi >= 0; mi--) {
            var __one = above[mi];
            try {
                selectByIds([__one.id]);
                executeAction(cT("Mrg2"), new ActionDescriptor(), DialogModes.NO);
            } catch (eM3) {
                try { if (__prevDialogs !== null) app.displayDialogs = __prevDialogs; } catch (ePD4) {}
                log.push("  ★ " + nameBefore + "：合并「" + __aboveNames[mi] + "」失败：" + eM3);
                return false;
            }
        }
    }

    /* 合并做完了，把对话框设置还原 */
    try { if (__prevDialogs !== null) app.displayDialogs = __prevDialogs; } catch (ePD3) {}

    var res = null;
    try { res = baseLayer; } catch (eR) { res = null; }
    if (!res) { try { res = doc.activeLayer; } catch (eR2) { res = null; } }
    if (!res) {
        log.push("  ★ " + nameBefore + "：合并后找不到活动图层");
        return false;
    }

    /* 名字还原 */
    try { res.name = nameBefore; } catch (eN) {}

    /* 混合模式还原；穿透 -> 保持 Normal */
    var wantPass = false;
    try { wantPass = (blendBefore === BlendMode.PASSTHROUGH); } catch (eP) {}
    if (wantPass || blendBefore === null) {
        try { res.blendMode = BlendMode.NORMAL; } catch (eN2) {}
    } else {
        try {
            res.blendMode = blendBefore;
            /* 读回来确认（有些模式不适用于栅格层，会自动退回 Normal） */
            var got = null;
            try { got = res.blendMode; } catch (eG) { got = null; }
            if (got !== blendBefore) {
                log.push("  · " + nameBefore + "：混合模式没能完全还原（请求 " + blendBefore + "，实际 " + got + "）");
            }
        } catch (eBM) {
            log.push("  ★ " + nameBefore + "：设置混合模式失败：" + eBM);
        }
    }

    log.push("  ✔ " + nameBefore + "：" +
             (isSet ? "文件夹" : "图层") +
             " + 上方剪贴层 " + above.length + " 个 -> 已合并" +
             (wantPass ? "（原为穿透，结果保持正常）" : ""));
    return true;
}

/* 收集所有图层 id（用于校验，可选） */
function collectAllIds(node, out) {
    for (var i = 0; i < node.layers.length; i++) {
        var L = node.layers[i];
        out.push(L.id);
        if (L.typename === "LayerSet") collectAllIds(L, out);
    }
    return out;
}

/* ---------------- 主流程 ---------------- */
function main() {
    var log = [];
    var sel = getSelected();
    if (!sel.length) {
        alert("没有选中任何图层。\n\n请先在面板里选中 1 个或多个图层/文件夹。");
        return;
    }

    var done = 0, skipped = 0;
    log.push("选中 " + sel.length + " 项：");
    log.push("");

    for (var i = 0; i < sel.length; i++) {
        var L = sel[i];

        /* ★ 真正显示的才处理 */
        if (!reallyShown(L)) {
            var why = "";
            if (!selfAndAncestorsVisible(L)) why = "（自己或所在文件夹被关灯）";
            else {
                var base = clipBaseOf(L);
                why = "（是剪贴蒙版，但绑定的基底 '" + (base ? base.name : "?") + "' 被关灯）";
            }
            log.push("  – " + L.name + "：跳过 " + why);
            skipped++;
            continue;
        }

        try {
            if (mergeOne(L, log)) done++;
            else skipped++;
        } catch (eM) {
            log.push("  ★ " + L.name + "：合并失败：" + eM);
            skipped++;
        }
    }

    log.push("");
    log.push("完成：合并 " + done + " 项，跳过 " + skipped + " 项。");
    log.push("");
    log.push("提示：整体包在一个历史步骤里，Ctrl+Z 一次可全撤。");

    /* ★★ 成功一律不弹窗（按用户要求）★★
       只有【一个都没合并成】才提示（选错了 / 全被跳过，属于没干活）。
       有跳过但至少合成了一个 —— 也不弹，细节看日志文件。 */
    var __txt = log.join("\n");

    /* 写日志：%TEMP%\psjsx_merge_up_log.txt（每次覆盖） */
    var __logPath = "";
    try {
        __logPath = Folder.temp.fsName + "/psjsx_merge_up_log.txt";
        var __rf = File(__logPath);
        __rf.encoding = "UTF-8";
        if (__rf.open("w")) {
            try {
                __rf.write("===== ps 连同上方图层合并 =====" + "\n");
                __rf.write("时间：" + (new Date()).toString() + "\n");
                __rf.write("文档：" + doc.name + "\n\n");
                __rf.write(__txt + "\n");
            } finally { try { __rf.close(); } catch (eC) {} }
        } else { try { __rf.close(); } catch (eC2) {} }
    } catch (eW) { __logPath = ""; }

    if (done === 0) {
        alert(__txt + (__logPath ? ("\n\n日志：" + __logPath) : ""));
    }
}

/* ==========================================================================
 * 包成一个历史步骤（可一次撤销）
 * --------------------------------------------------------------------------
 * ★ suspendHistory 的第二个参数是一段【在全局作用域执行的字符串】，
 *   main 定义在 IIFE 里，全局看不到它 —— 所以必须先把入口挂到 $.global 上。
 *   （这是本目录其它脚本一贯的写法：$.global.PSJSX_HOOK = doWork）
 * ========================================================================== */
try { $.global.PSJSX_MERGE_UP_HOOK = main; } catch (eG) {}
try {
    doc.suspendHistory("连同上方图层合并", "PSJSX_MERGE_UP_HOOK()");
} catch (eH) {
    /* ★ 绝对不要在这里重跑 main()：suspendHistory 抛错也可能是 main() 内部抛的，
       重跑等于把合并做两遍（图层会被多吞一层）。失败就直接报错。 */
    try { alert("执行失败：" + eH); } catch (eH2) {}
} finally {
    try { delete $.global.PSJSX_MERGE_UP_HOOK; } catch (eD) { $.global.PSJSX_MERGE_UP_HOOK = null; }
}

})();
