#target photoshop
/* ==========================================================================
 * 诊断_07_复制顺序探针（最后一测）
 * --------------------------------------------------------------------------
 * 前两轮探针的结论：
 *   · duplicate() 各种落点【都不丢内容】：bounds 的 91px 差异只是"容器相关的报告差异"
 *     —— C 证明 搬走 -> 内缩 91px、搬回原容器 -> 完全恢复，而 move() 不可能改像素。
 *   · 单个剪贴层复制是安全的（原始层 ✔ 都没被动）。
 *   · ★ 两个一起复制就会把「图层 11」的剪贴状态清掉（true -> false）。
 *     推断：图层 11 剪贴到 图层 10、图层 10 剪贴到「名字」文件夹（链式），
 *           在链中间插入副本再移走，PS 就重算了 图层 11 的剪贴。
 *   · 源层【没有图层样式】，所以 91px 不是样式问题。
 *
 * 本探针只做一件事：找出【两个剪贴层都能安全复制】的顺序/方式。
 *   A. 现有顺序：duplicate(holder, INSIDE) 图层11 -> 图层10      （已知会坏）
 *   B. 反序：    duplicate(holder, INSIDE) 图层10 -> 图层11
 *   C. 先全部原地复制（PLACEBEFORE），再统一搬进 holder
 *   D. 一次选中全部剪贴层，只调用一次 duplicate(holder, INSIDE)
 *   E. 逐个来：复制图层11 -> 搬走 -> 复制图层10 -> 搬走（模拟 ps 07 现在的时序，但用 duplicate）
 *   F. 逐个来 + 反序：复制图层10 -> 搬走 -> 复制图层11 -> 搬走
 *
 * 每步都核对【原始剪贴层的剪贴状态/可见性/bounds】。
 * 只读 + 每步历史回退。报告：%TEMP%\psjsx_07_duporder.txt
 * ========================================================================== */

(function () {

var REPORT = [];
var FILE = "psjsx_07_duporder.txt";
function rep(s) { REPORT.push(s); }
function clean(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 200); } catch (e) { return "" + s; } }
function flush() {
    var out = REPORT.join("\n"), path = "";
    try {
        var f = File(Folder.temp.fsName + "/" + FILE);
        f.encoding = "UTF-8"; f.open("w"); f.write(out + "\n"); f.close();
        path = f.fsName;
    } catch (e) { path = "(写失败 " + e + ")"; }
    try { alert("复制顺序探针：已测完\n\n报告：\n" + path); } catch (e2) {}
}
function cid(k) { try { return charIDToTypeID(k); } catch (e) { return false; } }
function getId(L) { try { return L.id; } catch (e) { return -1; } }
function isGroup(L) { try { return (L.typename === "LayerSet"); } catch (e) { return false; } }
function nameOf(L) { try { return L.name; } catch (e) { return "?"; } }
function isVis(L) { try { return (L.visible !== false); } catch (e) { return true; } }
function isClip(L) { try { return (L.grouped === true); } catch (e) { return false; } }

var doc = null;
function walk(container, fn) {
    var arr = null; try { arr = container.layers; } catch (e) { return; }
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) { fn(arr[i]); if (isGroup(arr[i])) walk(arr[i], fn); }
}
function byId(id) { var f = null; walk(doc, function (L) { if (!f && getId(L) === id) f = L; }); return f; }

function findSeg() {
    var found = null;
    (function rec(container, path) {
        if (found) return;
        var arr = null; try { arr = container.layers; } catch (e) { return; }
        if (!arr) return;
        for (var i = 0; i < arr.length; i++) {
            if (found) return;
            if (isGroup(arr[i])) { rec(arr[i], path + " / " + nameOf(arr[i])); continue; }
            if (!isClip(arr[i])) continue;
            var ids = [], kk = i;
            while (kk < arr.length && isClip(arr[kk])) { ids.push(getId(arr[kk])); kk++; }
            if (kk < arr.length && isGroup(arr[kk])) {
                found = { clipIds: ids, folderId: getId(arr[kk]), folderName: nameOf(arr[kk]),
                          container: container, path: path };
            }
            i = kk - 1;
        }
    })(doc, "");
    return found;
}
function snapOriginals(ids) {
    var m = {};
    for (var i = 0; i < ids.length; i++) {
        var L = byId(ids[i]);
        m["" + ids[i]] = L ? { clip: isClip(L), vis: isVis(L), name: nameOf(L) } : null;
    }
    return m;
}
function checkOriginals(m, tag) {
    var bad = [];
    for (var id in m) {
        var o = m[id];
        if (!o) continue;
        var L = byId(parseInt(id, 10));
        if (!L) { bad.push(o.name + " 消失了"); continue; }
        if (isClip(L) !== o.clip) bad.push(o.name + " 剪贴 " + o.clip + "->" + isClip(L));
        if (isVis(L) !== o.vis) bad.push(o.name + " 显示 " + o.vis + "->" + isVis(L));
    }
    rep("      原始层核对：" + (bad.length === 0 ? "✔ 都没被动" : ("★★ " + bad.join("；"))));
    return bad;
}

/* 选中多个图层（ActionManager 的 targetLayers） */
function selectMany(ids) {
    try {
        var d = new ActionDescriptor();
        var list = new ActionList();
        for (var i = 0; i < ids.length; i++) {
            var r = new ActionReference();
            r.putIdentifier(cid("Lyr "), ids[i]);
            list.putReference(r);
        }
        d.putList(cid("null"), list);
        d.putBoolean(cid("MkVs"), false);
        executeAction(cid("slct"), d, DialogModes.NO);
        return true;
    } catch (e) { return false; }
}

function main() {
    rep("诊断_07_复制顺序探针 —— " + (new Date()).toString());
    if (app.documents.length === 0) { rep("没有打开的文档"); flush(); return; }
    doc = app.activeDocument;
    rep("文档：" + doc.name);

    var seg = findSeg();
    if (!seg) { rep("★ 找不到「剪贴层紧跟文件夹」的结构"); flush(); return; }
    rep("段的路径 = " + seg.path + "　目标文件夹 =「" + seg.folderName + "」");
    rep("剪贴层（从上到下）" + seg.clipIds.length + " 个：" + seg.clipIds.join(", "));
    rep("");

    var h = null; try { h = doc.activeHistoryState; } catch (eH) {}
    function back() { try { if (h) { doc.activeHistoryState = h; return true; } } catch (e) {} return false; }
    var orig = snapOriginals(seg.clipIds);

    function makeHolder(tag) {
        var g = doc.layerSets.add();
        g.name = "__probe_ord_" + tag;
        try { g.visible = false; } catch (e) {}
        return g;
    }
    function holderOrder(holder) {
        var names = [];
        try { for (var q = 0; q < holder.layers.length; q++) names.push(nameOf(holder.layers[q])); } catch (e) {}
        return names.join(" | ");
    }

    function runTest(tag, title, fn) {
        rep("=== " + tag + ". " + title + " ===");
        try { fn(); } catch (e) { rep("  ★ 抛错：" + clean(e)); }
        checkOriginals(orig, tag);
        back();
        rep("");
    }

    /* A. 现有顺序：逐个 duplicate(holder, INSIDE)，从上到下 */
    runTest("A", "逐个 duplicate(holder, INSIDE)：图层11 -> 图层10（ps 07 类似时序）", function () {
        var holder = makeHolder("A");
        for (var i = 0; i < seg.clipIds.length; i++) {
            var s = byId(seg.clipIds[i]);
            if (!s) continue;
            try { s.duplicate(holder, ElementPlacement.INSIDE); } catch (e) { rep("      ★「" + nameOf(s) + "」失败：" + clean(e)); }
            checkOriginals(orig, "A");
        }
        rep("      holder 顺序：" + holderOrder(holder));
    });

    /* B. 反序：从下到上 */
    runTest("B", "逐个 duplicate(holder, INSIDE)：反序（从下到上）", function () {
        var holder = makeHolder("B");
        for (var i = seg.clipIds.length - 1; i >= 0; i--) {
            var s = byId(seg.clipIds[i]);
            if (!s) continue;
            try { s.duplicate(holder, ElementPlacement.INSIDE); } catch (e) { rep("      ★「" + nameOf(s) + "」失败：" + clean(e)); }
            checkOriginals(orig, "B");
        }
        rep("      holder 顺序：" + holderOrder(holder));
    });

    /* C. 先全部原地复制，再统一搬进 holder */
    runTest("C", "先全部原地复制(PLACEBEFORE)，再统一搬进 holder", function () {
        var holder = makeHolder("C");
        var cps = [];
        for (var i = 0; i < seg.clipIds.length; i++) {
            var s = byId(seg.clipIds[i]);
            if (!s) continue;
            var cp = null;
            try { cp = s.duplicate(s, ElementPlacement.PLACEBEFORE); } catch (e) { rep("      ★「" + nameOf(s) + "」失败：" + clean(e)); }
            if (cp) cps.push(cp);
            checkOriginals(orig, "C-原地" + i);
        }
        for (var j = 0; j < cps.length; j++) {
            try { cps[j].move(holder, ElementPlacement.INSIDE); } catch (eM) { rep("      ★搬走失败：" + clean(eM)); }
        }
        checkOriginals(orig, "C-搬走后");
        rep("      holder 顺序：" + holderOrder(holder));
    });

    /* D. 一次选中全部，只调用一次 duplicate */
    runTest("D", "一次选中全部剪贴层，只调用一次 duplicate(holder, INSIDE)", function () {
        var holder = makeHolder("D");
        rep("      选中全部：" + selectMany(seg.clipIds));
        var cp = null;
        try { cp = doc.activeLayer.duplicate(holder, ElementPlacement.INSIDE); } catch (e) { rep("      ★失败：" + clean(e)); }
        rep("      返回：" + (cp ? ("id=" + getId(cp) + " 「" + nameOf(cp) + "」") : "空"));
        checkOriginals(orig, "D");
        rep("      holder 顺序：" + holderOrder(holder));
    });

    /* E. 逐个：复制 -> 立刻搬走 -> 再下一个（从上到下） */
    runTest("E", "逐个：复制(原地) -> 立刻搬走 -> 再下一个（从上到下）", function () {
        var holder = makeHolder("E");
        for (var i = 0; i < seg.clipIds.length; i++) {
            var s = byId(seg.clipIds[i]);
            if (!s) continue;
            var cp = null;
            try { cp = s.duplicate(s, ElementPlacement.PLACEBEFORE); } catch (e) { rep("      ★复制失败：" + clean(e)); }
            if (cp) { try { cp.move(holder, ElementPlacement.INSIDE); } catch (eM) { rep("      ★搬走失败：" + clean(eM)); } }
            checkOriginals(orig, "E-" + i);
        }
        rep("      holder 顺序：" + holderOrder(holder));
    });

    /* F. 逐个 + 反序 */
    runTest("F", "逐个：复制(原地) -> 立刻搬走（从下到上）", function () {
        var holder = makeHolder("F");
        for (var i = seg.clipIds.length - 1; i >= 0; i--) {
            var s = byId(seg.clipIds[i]);
            if (!s) continue;
            var cp = null;
            try { cp = s.duplicate(s, ElementPlacement.PLACEBEFORE); } catch (e) { rep("      ★复制失败：" + clean(e)); }
            if (cp) { try { cp.move(holder, ElementPlacement.INSIDE); } catch (eM) { rep("      ★搬走失败：" + clean(eM)); } }
            checkOriginals(orig, "F-" + i);
        }
        rep("      holder 顺序：" + holderOrder(holder));
    });

    back();
    rep("=== 收尾回退检验 ===");
    checkOriginals(orig, "最终");
    rep("");
    rep("== 怎么读 ==");
    rep("  · 找【每次核对都显示 ✔ 都没被动】的那个办法（A~F 之一），ps 07 就用它。");
    rep("  · 如果 A~F 全都坏了 -> 只能一个一个文件分多次跑，或者改用别的思路。");
    rep("  · holder 顺序那一行看复制的顺序对不对（要和 PS 里原顺序一致）。");
    back();
    flush();
}

try { main(); } catch (eM) {
    rep("整体出错：" + clean(eM));
    try { rep("（行 " + eM.line + "）"); } catch (e2) {}
    flush();
}

})();
