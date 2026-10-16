#target photoshop
/* ==========================================================================
 * 诊断_07_复制落点探针
 * --------------------------------------------------------------------------
 * 背景：ps 07 要把"剪贴蒙版图层的副本"搬进镜像树。已实测的问题：
 *   · copy()/paste()  -> 源和副本的 bounds 不一致，而且【尺寸都变了】
 *                         图层 11：11846x6015 -> 3840x2160（正好画布）
 *                         图层 10：2072x993   -> 1889x810
 *                         （取消选区也没用 -> 不是选区问题）
 *   · duplicate() 连续调用两次 -> 会把原始剪贴层的剪贴状态解除（破坏原链）
 *   · Dplc 复制文件夹          -> 同上
 *
 * 本探针【只读 + 每步历史回退】，逐个实测"复制剪贴层"的办法，
 * 每步都记录：
 *   ① 副本的 bounds 和源是否一致（位置 + 尺寸）
 *   ② 原始剪贴层的剪贴状态有没有被改
 *   ③ 原始剪贴层的可见性有没有被改
 *
 * 测的办法：
 *   A. duplicate() 无参  -> move(镜像文件夹, INSIDE)     （ps 07 现在的做法）
 *   B. duplicate(镜像文件夹, INSIDE)                      （直接复制进目标文件夹）
 *   C. duplicate(镜像文件夹, PLACEBEFORE)
 *   D. copy()/paste() -> translate 回原位（核对尺寸能不能修回来）
 *   E. 对照组：duplicate(原位置的上一层, PLACEBEFORE)（只复制、不搬走）
 *
 * 报告：%TEMP%\psjsx_07_dupprobe.txt
 * ========================================================================== */

(function () {

var REPORT = [];
var FILE = "psjsx_07_dupprobe.txt";
function rep(s) { REPORT.push(s); }
function clean(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 220); } catch (e) { return "" + s; } }
function flush() {
    var out = REPORT.join("\n"), path = "";
    try {
        var f = File(Folder.temp.fsName + "/" + FILE);
        f.encoding = "UTF-8"; f.open("w"); f.write(out + "\n"); f.close();
        path = f.fsName;
    } catch (e) { path = "(写失败 " + e + ")"; }
    try { alert("复制落点探针：已测完\n\n报告：\n" + path); } catch (e2) {}
}
function cid(k) { try { return charIDToTypeID(k); } catch (e) { return false; } }
function getId(L) { try { return L.id; } catch (e) { return -1; } }
function isGroup(L) { try { return (L.typename === "LayerSet"); } catch (e) { return false; } }
function nameOf(L) { try { return L.name; } catch (e) { return "?"; } }
function isVis(L) { try { return (L.visible !== false); } catch (e) { return true; } }
function isClip(L) { try { return (L.grouped === true); } catch (e) { return false; } }
function nowMs() { return (new Date()).getTime(); }
function ms(t0) { return Math.round((nowMs() - t0) / 100) / 10; }

var doc = null;
function walk(container, fn) {
    var arr = null; try { arr = container.layers; } catch (e) { return; }
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) { fn(arr[i]); if (isGroup(arr[i])) walk(arr[i], fn); }
}
function byId(id) { var f = null; walk(doc, function (L) { if (!f && getId(L) === id) f = L; }); return f; }

function boundsStr(L) {
    try { var b = L.bounds; return (b[0].value) + "," + (b[1].value) + "," + (b[2].value) + "," + (b[3].value) +
          "  (" + (b[2].value - b[0].value) + "x" + (b[3].value - b[1].value) + ")"; }
    catch (e) { return "(读不到)"; }
}
function sameBounds(a, b) { return (boundsStr(a) === boundsStr(b)); }

function selectById(id) {
    try {
        var d = new ActionDescriptor(), r = new ActionReference();
        r.putIdentifier(cid("Lyr "), id);
        d.putReference(cid("null"), r);
        d.putBoolean(cid("MkVs"), false);
        executeAction(cid("slct"), d, DialogModes.NO);
        return true;
    } catch (e) { return false; }
}

/* 找一个"剪贴层紧跟文件夹"的段 */
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

/* 记录原始剪贴层的状态，用于每步后核对 */
function snapOriginals(ids) {
    var m = {};
    for (var i = 0; i < ids.length; i++) {
        var L = byId(ids[i]);
        m["" + ids[i]] = L ? { clip: isClip(L), vis: isVis(L), name: nameOf(L), b: boundsStr(L) } : null;
    }
    return m;
}
function checkOriginals(m, label) {
    var bad = [];
    for (var id in m) {
        var o = m[id];
        if (!o) continue;
        var L = byId(parseInt(id, 10));
        if (!L) { bad.push(o.name + " 消失了"); continue; }
        if (isClip(L) !== o.clip) bad.push(o.name + " 剪贴 " + o.clip + "->" + isClip(L));
        if (isVis(L) !== o.vis) bad.push(o.name + " 显示 " + o.vis + "->" + isVis(L));
        if (boundsStr(L) !== o.b) bad.push(o.name + " 位置变了 " + o.b + " -> " + boundsStr(L));
    }
    rep("      原始层核对：" + (bad.length === 0 ? "✔ 都没被动" : ("★★ " + bad.join("；"))));
    return bad;
}

function main() {
    rep("诊断_07_复制落点探针 —— " + (new Date()).toString());
    if (app.documents.length === 0) { rep("没有打开的文档"); flush(); return; }
    doc = app.activeDocument;
    rep("文档：" + doc.name);
    rep("");

    var seg = findSeg();
    if (!seg) { rep("★ 找不到「剪贴层紧跟文件夹」的结构（请在没跑过新 07 的原始文件上测）"); flush(); return; }
    var src = byId(seg.clipIds[0]);
    rep("找到的段：路径 = " + seg.path);
    rep("  目标文件夹 =「" + seg.folderName + "」id=" + seg.folderId);
    rep("  剪贴层 " + seg.clipIds.length + " 个：" + seg.clipIds.join(", "));
    rep("  拿第 1 个当实验对象：「" + nameOf(src) + "」id=" + seg.clipIds[0]);
    rep("    它的 bounds = " + boundsStr(src));
    rep("    它的 不透明度 = " + (function () { try { return src.opacity; } catch (e) { return "?"; } })());
    rep("");
    rep("判据：① 副本 bounds 要和源一致　② 原始剪贴层不能被动");
    rep("");

    var h = null; try { h = doc.activeHistoryState; } catch (eH) {}
    function back() { try { if (h) { doc.activeHistoryState = h; return true; } } catch (e) {} return false; }

    var orig = snapOriginals(seg.clipIds);

    /* 每次实验都新建一个"目标文件夹" */
    function makeHolder(tag) {
        var g = doc.layerSets.add();
        g.name = "__probe_" + tag;
        try { g.visible = false; } catch (e) {}
        return g;
    }

    /* ---------- A. duplicate() 无参 -> move(holder, INSIDE) ---------- */
    rep("=== A. duplicate() 无参 -> move(holder, INSIDE)（ps 07 现在的做法）===");
    (function () {
        var holder = null, cp = null, err = "";
        var t0 = nowMs();
        try {
            holder = makeHolder("A");
            cp = src.duplicate();
            if (cp) { try { cp.move(holder, ElementPlacement.INSIDE); } catch (eM) { err = "move:" + clean(eM); } }
        } catch (eA) { err = clean(eA); }
        rep("  结果：副本 id=" + (cp ? getId(cp) : "?") + "　耗时 " + ms(t0) + "s" + (err ? ("　★ " + err) : ""));
        if (cp) {
            rep("      源  bounds = " + boundsStr(src));
            rep("      副本 bounds = " + boundsStr(cp) + (sameBounds(src, cp) ? "　✔一致" : "　★★不一致"));
            rep("      副本 不透明度 = " + (function () { try { return cp.opacity; } catch (e) { return "?"; } })());
        }
        checkOriginals(orig, "A");
        back();
    })();
    rep("");

    /* ---------- B. duplicate(holder, INSIDE) ---------- */
    rep("=== B. duplicate(holder, INSIDE)（直接复制进目标文件夹）===");
    (function () {
        var holder = null, cp = null, err = "";
        var t0 = nowMs();
        try {
            holder = makeHolder("B");
            cp = src.duplicate(holder, ElementPlacement.INSIDE);
        } catch (eB) { err = clean(eB); }
        rep("  结果：副本 id=" + (cp ? getId(cp) : "?") + "　耗时 " + ms(t0) + "s" + (err ? ("　★ " + err) : ""));
        if (cp) {
            rep("      源  bounds = " + boundsStr(src));
            rep("      副本 bounds = " + boundsStr(cp) + (sameBounds(src, cp) ? "　✔一致" : "　★★不一致"));
            rep("      副本 不透明度 = " + (function () { try { return cp.opacity; } catch (e) { return "?"; } })());
        } else {
            rep("      （duplicate(holder, INSIDE) 没返回对象）");
        }
        checkOriginals(orig, "B");
        back();
    })();
    rep("");

    /* ---------- C. duplicate(holder, PLACEBEFORE) ---------- */
    rep("=== C. duplicate(holder, PLACEBEFORE) ===");
    (function () {
        var holder = null, cp = null, err = "";
        try {
            holder = makeHolder("C");
            cp = src.duplicate(holder, ElementPlacement.PLACEBEFORE);
        } catch (eC) { err = clean(eC); }
        rep("  结果：副本 id=" + (cp ? getId(cp) : "?") + (err ? ("　★ " + err) : ""));
        if (cp) {
            rep("      副本 bounds = " + boundsStr(cp) + (sameBounds(src, cp) ? "　✔一致" : "　★★不一致"));
        }
        checkOriginals(orig, "C");
        back();
    })();
    rep("");

    /* ---------- D. copy/paste + translate ---------- */
    rep("=== D. copy()/paste() 然后 translate 回原位（看尺寸能不能修回来）===");
    (function () {
        var holder = null, cp = null, err = "";
        try {
            holder = makeHolder("D");
            try { doc.selection.deselect(); } catch (eDs) {}
            if (!selectById(seg.clipIds[0])) throw new Error("选不中源层");
            src.copy();
            doc.paste();
            var nid = -1; try { nid = getId(doc.activeLayer); } catch (eAL) {}
            cp = byId(nid);
            if (!cp) throw new Error("paste 后找不到新层");
            var sb = src.bounds, cb = cp.bounds;
            var dx = sb[0].value - cb[0].value, dy = sb[1].value - cb[1].value;
            rep("      粘贴后 bounds = " + boundsStr(cp));
            cp.translate(dx, dy);
            rep("      平移(" + dx + "," + dy + ") 后 bounds = " + boundsStr(cp));
            cp.move(holder, ElementPlacement.INSIDE);
        } catch (eD) { err = clean(eD); }
        if (err) rep("  ★ " + err);
        if (cp) {
            rep("      源  bounds = " + boundsStr(src));
            rep("      副本 bounds = " + boundsStr(cp) + (sameBounds(src, cp) ? "　✔一致" : "　★★不一致（尺寸修不回来）"));
            try {
                var w1 = src.bounds[2].value - src.bounds[0].value;
                var w2 = cp.bounds[2].value - cp.bounds[0].value;
                rep("      宽度 " + w1 + " -> " + w2 + "　比例 " + (Math.round((w2 / w1) * 10000) / 10000));
            } catch (eW) {}
        }
        checkOriginals(orig, "D");
        back();
    })();
    rep("");

    /* ---------- E. 对照：duplicate(原位置的上一层, PLACEBEFORE)，不搬走 ---------- */
    rep("=== E. 对照：duplicate(源层自己, PLACEBEFORE)（只复制、不搬走）===");
    (function () {
        var cp = null, err = "";
        try { cp = src.duplicate(src, ElementPlacement.PLACEBEFORE); } catch (eE) { err = clean(eE); }
        rep("  结果：副本 id=" + (cp ? getId(cp) : "?") + (err ? ("　★ " + err) : ""));
        if (cp) {
            rep("      副本 bounds = " + boundsStr(cp) + (sameBounds(src, cp) ? "　✔一致" : "　★★不一致"));
        }
        checkOriginals(orig, "E");
        back();
    })();
    rep("");

    back();
    rep("=== 收尾回退检验 ===");
    checkOriginals(orig, "最终");
    rep("");
    rep("== 怎么读 ==");
    rep("  · 找【副本 bounds ✔一致】且【原始层 ✔都没被动】的那一行，那个办法就是我要用的。");
    rep("  · 加粗 ★★ 的都是有问题的：bounds 不一致 -> 位置/尺寸丢了；原始层被动 -> 会损坏原图。");
    back();
    flush();
}

try { main(); } catch (eM) {
    rep("整体出错：" + clean(eM));
    try { rep("（行 " + eM.line + "）"); } catch (e2) {}
    flush();
}

})();
