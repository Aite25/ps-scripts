// ===========================================================================
// ps 连同上方图层合并（半自动版）
// ---------------------------------------------------------------------------
// 用法
//   1. 在【图层面板】里手动选中：
//        · 下方的"主要图层"（基底）
//        · 以及它上方那些剪贴蒙版图层
//      （就是平时手动 Ctrl+E 之前选的那样）
//   2. 跑本脚本
//   3. 脚本负责：合并 -> 把结果层名字改回主要图层的原名
//                      -> 把混合模式改回主要图层的原模式
//
// ⚠ 为什么必须【手动选】多层
//   实测在当前 PS 上，用 ActionManager 的 slct 命令【建不出多层选区】。
//   五种写法全试过（putEnumerated Lyr/Ordn/Trgt、putEnumerated Dcmn、
//   putClass Dcmn、putClass "Lyr "、putList 直接到 "null"）：
//     · putEnumerated 那两种不报错，但只选中 1 层（列表被静默忽略）
//     · putClass / putList 那三种直接报「命令"选择"当前不可用」
//   而且与"是否在文件夹里""是不是剪贴层""是不是智能对象"全都无关。
//   → 多选只能由人手完成；脚本只做后面的合并与还原。
//
// 规则
//   · 主要图层 = 选区里【最下面】那个（itemIndex 最大）
//   · 合并后：结果层名字 = 主要图层原名
//   · 合并后：结果层混合模式 = 主要图层原模式
//   · 例外：主要图层原模式是【穿透】(PassThrough) 时，合并结果是普通图层，
//     穿透不可能再应用（PS 会报"穿透只可用于图层组"），此时保持【正常】。
//   · 不栅格化智能对象（合并时 PS 自己处理；只在合并期间关掉确认框）
//   · 成功不弹窗；失败才提示。日志：%TEMP%\psjsx_merge_up_log.txt
// ===========================================================================

(function () {

var doc = null;
try { doc = app.activeDocument; } catch (e0) { doc = null; }
if (!doc) { alert("没有打开的文档。"); return; }

function cT(s) { return charIDToTypeID(s); }
function sT(s) { return stringIDToTypeID(s); }

/* ==========================================================================
 * 日志
 * ========================================================================== */
var LOG = [];
function p(s) { try { LOG.push("" + s); } catch (e) {} }

function writeLog() {
    try {
        var f = File(Folder.temp.fsName + "/psjsx_merge_up_log.txt");
        f.encoding = "UTF-8";
        if (f.open("w")) {
            try {
                f.write("===== ps 连同上方图层合并（半自动）=====\n");
                f.write("时间：" + (new Date()).toString() + "\n");
                try { f.write("文档：" + doc.name + "\n"); } catch (e1) {}
                f.write("\n" + LOG.join("\n") + "\n");
            } finally { try { f.close(); } catch (e2) {} }
        } else { try { f.close(); } catch (e3) {} }
    } catch (e4) {}
}

/* ==========================================================================
 * 读选区
 * --------------------------------------------------------------------------
 * 这种读法（getIndex + 按 itemIndex 递归查找）是可用的。
 * （getIdentifier() 对 targetLayers 返回 -1，不可用，已排除。）
 * ========================================================================== */
/* ★ 只在【活动图层的父级】里按 itemIndex 找。
   原因：itemIndex 是"父级内的序号"，在整棵树里找会撞号 ——
   之前就是因此在有文件夹的文档里取到了别层的名字。 */
function layerInParent(index) {
    var par = null;
    try { par = doc.activeLayer.parent; } catch (e0) { par = null; }
    if (!par || !par.layers) return null;
    for (var i = 0; i < par.layers.length; i++) {
        var L = par.layers[i];
        var idx = -1;
        try { idx = L.itemIndex; } catch (e1) { idx = -1; }
        if (idx === index) return L;
    }
    return null;
}

/* 保留（未再使用）：整棵树按 itemIndex 找 —— 有撞号风险，仅作参考 */
function layerByIndex(root, index) {
    function rec(node) {
        for (var i = 0; i < node.layers.length; i++) {
            var L = node.layers[i];
            try { if (L.itemIndex === index) return L; } catch (e2) {}
            if (L.typename === "LayerSet") { var R = rec(L); if (R) return R; }
        }
        return null;
    }
    return rec(root);
}

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
            var idx = -1;
            try { idx = lst.getReference(i).getIndex() + 1; } catch (e1) { idx = -1; }
            if (idx < 0) continue;
            var L = layerInParent(idx);
            if (L) out.push({ layer: L, index: idx });
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

/* ==========================================================================
 * 主体
 * ========================================================================== */
function main() {
    /* ---- 1) 读选区 ---- */
    var sel = getSelected();
    var cnt = countSelection();

    p("选区：读出 " + sel.length + " 项，targetLayers 计数 " + cnt);

    if (!sel.length || cnt < 2) {
        p("");
        p("★ 选区不足 2 层 —— 无法合并。");
        p("  请在图层面板里手动选中：主要图层 + 它上方的剪贴蒙版图层。");
        writeLog();
        alert("请先在图层面板里选中【主要图层】以及它上方的【剪贴蒙版图层】（至少 2 层），再跑本脚本。\n\n" +
              "（当前读到 " + (cnt >= 0 ? cnt : sel.length) + " 层）\n\n" +
              "日志：%TEMP%\\psjsx_merge_up_log.txt");
        return;
    }

    /* ---- 2) 找"主要图层" = 选区里最下面那个（itemIndex 最大） ---- */
    /* ★ itemIndex 越大越靠上（实测：基底=20，上面的剪贴层=21）
       → 基底（应用层）= itemIndex 【最小】的那个 */
    var baseItem = sel[0];
    for (var i = 1; i < sel.length; i++) {
        if (sel[i].index < baseItem.index) baseItem = sel[i];
    }
    var base = baseItem.layer;

    var nameBefore = "";
    var blendBefore = null;
    try { nameBefore = "" + base.name; } catch (eN) { nameBefore = ""; }
    try { blendBefore = base.blendMode; } catch (eB) { blendBefore = null; }

    p("主要图层（最下面那个）：「" + nameBefore + "」　itemIndex=" + baseItem.index);
    p("选区共 " + sel.length + " 层，将执行合并（= Ctrl+E）");

    /* ---- 3) 合并（用【现有选区】，不重建） ---- */
    var prevDialogs = null;
    try { prevDialogs = app.displayDialogs; } catch (ePD) { prevDialogs = null; }
    try { app.displayDialogs = DialogModes.NO; } catch (ePD2) {}

    var merged = false;
    try {
        executeAction(cT("Mrg2"), new ActionDescriptor(), DialogModes.NO);
        merged = true;
        p("  OK 合并执行成功");
    } catch (eM) {
        p("  ★ 合并失败：" + eM);
    } finally {
        try { if (prevDialogs !== null) app.displayDialogs = prevDialogs; } catch (ePD3) {}
    }

    if (!merged) {
        writeLog();
        alert("合并失败：\n" + LOG[LOG.length - 1] + "\n\n日志：%TEMP%\\psjsx_merge_up_log.txt");
        return;
    }

    /* ---- 4) 结果层 ---- */
    var res = null;
    try { res = doc.activeLayer; } catch (eR) { res = null; }
    if (!res) {
        p("  ★ 合并后拿不到活动图层");
        writeLog();
        alert("合并执行了，但拿不到结果层。日志：%TEMP%\\psjsx_merge_up_log.txt");
        return;
    }

    /* ---- 5) 名字还原 ---- */
    if (nameBefore) {
        try {
            res.name = nameBefore;
            p("  OK 名字已还原：「" + nameBefore + "」");
        } catch (eName) {
            p("  ★ 还原名字失败：" + eName);
        }
    }

    /* ---- 6) 混合模式还原 ---- */
    var wantPass = false;
    try { wantPass = (blendBefore === BlendMode.PASSTHROUGH); } catch (eP) { wantPass = false; }

    if (wantPass) {
        try {
            res.blendMode = BlendMode.NORMAL;
            p("  · 原模式是【穿透】—— 结果是普通图层，保持【正常】（符合预期）");
        } catch (eN2) {
            p("  · 原模式是【穿透】—— 结果保持当前模式");
        }
    } else if (blendBefore !== null) {
        try {
            res.blendMode = blendBefore;
            var got = null;
            try { got = res.blendMode; } catch (eG) { got = null; }
            if (got === blendBefore) {
                p("  OK 混合模式已还原：" + blendBefore);
            } else {
                p("  · 混合模式请求 " + blendBefore + "，实际 " + got + "（该模式可能不适用于栅格层）");
            }
        } catch (eBM) {
            p("  ★ 设置混合模式失败：" + eBM);
        }
    }

    writeLog();
    /* 成功不弹窗（按之前的要求）—— 结果在画面上直接可见 */
}

/* ==========================================================================
 * 包成一个历史步骤（可一次 Ctrl+Z 撤销）
 * ★ suspendHistory 的第二个参数在【全局作用域】执行，所以入口先挂到 $.global
 * ★ 失败时不要重跑 main（否则合并会做两遍）
 * ========================================================================== */
try { $.global.PSJSX_MERGE_UP_HOOK = main; } catch (eG) {}
try {
    doc.suspendHistory("连同上方图层合并", "PSJSX_MERGE_UP_HOOK()");
} catch (eH) {
    try { alert("执行失败：" + eH); } catch (eH2) {}
} finally {
    try { delete $.global.PSJSX_MERGE_UP_HOOK; } catch (eD) { $.global.PSJSX_MERGE_UP_HOOK = null; }
}

})();
