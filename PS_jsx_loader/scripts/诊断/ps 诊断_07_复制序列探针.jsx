#target photoshop
/* ==========================================================================
 * 诊断_07_复制序列探针
 * --------------------------------------------------------------------------
 * 上一轮（ps 诊断_07_复制落点探针）的结论：
 *   · duplicate() 各种落点【都不会】动原始剪贴层（✔都没被动）
 *     -> 之前以为"第二个副本会破坏原链"，真凶其实是 grouped=false 那句写入。
 *   · 但 A/B/C（搬进/搬进旁边）的副本 bounds 比源【四边各内缩 91px】
 *     -> 源 bounds 11846x6015，副本 11663x5832，差 183 = 2x91.5
 *     -> 典型的"bounds 少了图层样式"（例如 91px 描边会向外扩 91px）
 *   · E（原地复制、不搬走）bounds ✔一致
 *
 * 本探针继续查清两件事：
 *   ① bounds 内缩到底是"样式没复制"还是"只是报告差异"：
 *        对比源/副本的 layerEffects 键、以及把副本【移回原容器】后 bounds 会不会恢复
 *   ② 真实序列（连做两个剪贴层的副本）会不会出问题：
 *        A. 两个都【原地】复制 -> 再一起搬进文件夹
 *        B. 两个都【直接复制进】文件夹
 *        C. 两个都【原地】复制、并移回原容器（看 bounds 是否一致）
 *
 * 只读 + 每步历史回退。报告：%TEMP%\psjsx_07_dupseq.txt
 * ========================================================================== */

(function () {

var REPORT = [];
var FILE = "psjsx_07_dupseq.txt";
function rep(s) { REPORT.push(s); }
function clean(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 200); } catch (e) { return "" + s; } }
function flush() {
    var out = REPORT.join("\n"), path = "";
    try {
        var f = File(Folder.temp.fsName + "/" + FILE);
        f.encoding = "UTF-8"; f.open("w"); f.write(out + "\n"); f.close();
        path = f.fsName;
    } catch (e) { path = "(写失败 " + e + ")"; }
    try { alert("复制序列探针：已测完\n\n报告：\n" + path); } catch (e2) {}
}
function cid(k) { try { return charIDToTypeID(k); } catch (e) { return false; } }
function sid(k) { try { return stringIDToTypeID(k); } catch (e) { return false; } }
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

function boundsStr(L) {
    try { var b = L.bounds; return (b[0].value) + "," + (b[1].value) + "," + (b[2].value) + "," + (b[3].value) +
          " (" + (b[2].value - b[0].value) + "x" + (b[3].value - b[1].value) + ")"; }
    catch (e) { return "(读不到)"; }
}
/* 这一层有哪些图层样式键 */
function fxKeys(L) {
    try {
        var ref = new ActionReference();
        ref.putIdentifier(cid("Lyr "), getId(L));
        var d = executeActionGet(ref);
        var k = sid("layerEffects");
        if (k === false || !d.hasKey(k)) return "(无)";
        var fx = d.getObjectValue(k);
        var ks = [];
        for (var i = 0; i < fx.count; i++) {
            var kn = ""; try { kn = typeIDToStringID(fx.getKey(i)); } catch (e0) { kn = "?"; }
            var en = ""; try { var o = fx.getObjectValue(fx.getKey(i)); var ek = sid("enabled"); if (ek !== false && o.hasKey(ek)) en = (o.getBoolean(ek) ? "(开)" : "(关)"); } catch (e1) {}
            ks.push(kn + en);
        }
        return ks.join(", ");
    } catch (e) { return "(读不到 " + clean(e) + ")"; }
}

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
        m["" + ids[i]] = L ? { clip: isClip(L), vis: isVis(L), name: nameOf(L), b: boundsStr(L) } : null;
    }
    return m;
}
function checkOriginals(m) {
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
    rep("诊断_07_复制序列探针 —— " + (new Date()).toString());
    if (app.documents.length === 0) { rep("没有打开的文档"); flush(); return; }
    doc = app.activeDocument;
    rep("文档：" + doc.name);
    rep("");

    var seg = findSeg();
    if (!seg) { rep("★ 找不到「剪贴层紧跟文件夹」的结构"); flush(); return; }
    rep("段的路径 = " + seg.path + "　目标文件夹 =「" + seg.folderName + "」id=" + seg.folderId);
    rep("剪贴层 " + seg.clipIds.length + " 个：" + seg.clipIds.join(", "));
    rep("");

    rep("== 源的详细情况（重点看 bounds 和 图层样式）==");
    for (var i = 0; i < seg.clipIds.length; i++) {
        var L = byId(seg.clipIds[i]);
        if (!L) continue;
        rep("  「" + nameOf(L) + "」id=" + seg.clipIds[i]);
        rep("      bounds  = " + boundsStr(L));
        rep("      样式    = " + fxKeys(L));
        rep("      剪贴    = " + isClip(L) + "　不透明度 = " + (function () { try { return L.opacity; } catch (e) { return "?"; } })());
    }
    rep("");

    var h = null; try { h = doc.activeHistoryState; } catch (eH) {}
    function back() { try { if (h) { doc.activeHistoryState = h; return true; } } catch (e) {} return false; }
    var orig = snapOriginals(seg.clipIds);

    function makeHolder(tag) {
        var g = doc.layerSets.add();
        g.name = "__probe_seq_" + tag;
        try { g.visible = false; } catch (e) {}
        return g;
    }
    function reportCopy(L, srcL, tag) {
        if (!L) { rep("      " + tag + "：副本为空"); return; }
        rep("      " + tag + " 副本：bounds = " + boundsStr(L) + (boundsStr(L) === boundsStr(srcL) ? "　✔一致" : "　★★不一致"));
        rep("      " + tag + " 副本：样式 = " + fxKeys(L));
        rep("      " + tag + " 副本：剪贴 = " + isClip(L));
    }

    /* ---------- A. 两个都【原地】复制 -> 再一起搬进文件夹 ---------- */
    rep("=== A. 先【原地】复制两个 -> 再一起搬进文件夹 ===");
    (function () {
        var holder = null, cps = [];
        try {
            holder = makeHolder("A");
            for (var i = 0; i < seg.clipIds.length; i++) {
                var s = byId(seg.clipIds[i]);
                if (!s) continue;
                var cp = null;
                try { cp = s.duplicate(s, ElementPlacement.PLACEBEFORE); } catch (eD) { rep("      ★「" + nameOf(s) + "」原地复制失败：" + clean(eD)); }
                if (cp) { cps.push({ cp: cp, src: s }); rep("      原地复制 " + nameOf(s) + " -> id=" + getId(cp)); }
            }
            /* 原地复制之后先核对一次 */
            rep("      （原地复制后、搬走前）");
            for (var j = 0; j < cps.length; j++) reportCopy(cps[j].cp, cps[j].src, "原地");
            /* 再一起搬 */
            for (var k = 0; k < cps.length; k++) {
                try { cps[k].cp.move(holder, ElementPlacement.INSIDE); } catch (eM) { rep("      ★搬走失败：" + clean(eM)); }
            }
            rep("      （搬进文件夹后）");
            for (var m = 0; m < cps.length; m++) reportCopy(cps[m].cp, cps[m].src, "搬后");
        } catch (eA) { rep("  ★ " + clean(eA)); }
        checkOriginals(orig);
        back();
    })();
    rep("");

    /* ---------- B. 两个都直接复制进文件夹 ---------- */
    rep("=== B. 两个都【直接复制进】文件夹 ===");
    (function () {
        var holder = null, cps = [];
        try {
            holder = makeHolder("B");
            for (var i = 0; i < seg.clipIds.length; i++) {
                var s = byId(seg.clipIds[i]);
                if (!s) continue;
                var cp = null;
                try { cp = s.duplicate(holder, ElementPlacement.INSIDE); } catch (eD) { rep("      ★「" + nameOf(s) + "」复制失败：" + clean(eD)); }
                if (cp) { cps.push({ cp: cp, src: s }); }
            }
            for (var j = 0; j < cps.length; j++) reportCopy(cps[j].cp, cps[j].src, "直接");
            rep("      文件夹里的顺序（从上到下）：" + (function () {
                var names = [];
                try { for (var q = 0; q < holder.layers.length; q++) names.push(nameOf(holder.layers[q])); } catch (e) {}
                return names.join(" | ");
            })());
        } catch (eB) { rep("  ★ " + clean(eB)); }
        checkOriginals(orig);
        back();
    })();
    rep("");

    /* ---------- C. 原地复制 -> 再移回原容器（看 bounds 能否恢复） ---------- */
    rep("=== C. 原地复制 -> 搬进文件夹 -> 再搬回原容器（看 bounds 是否恢复）===");
    (function () {
        var holder = null, cp = null, src = null;
        try {
            holder = makeHolder("C");
            src = byId(seg.clipIds[0]);
            cp = src.duplicate(src, ElementPlacement.PLACEBEFORE);
            if (cp) {
                reportCopy(cp, src, "原地");
                cp.move(holder, ElementPlacement.INSIDE);
                reportCopy(cp, src, "搬走后");
                cp.move(seg.container, ElementPlacement.INSIDE);
                reportCopy(cp, src, "搬回原容器后");
            }
        } catch (eC) { rep("  ★ " + clean(eC)); }
        checkOriginals(orig);
        back();
    })();
    rep("");

    back();
    rep("=== 收尾回退检验 ===");
    checkOriginals(orig);
    rep("");
    rep("== 怎么读 ==");
    rep("  · A/B 里【两个副本都 ✔一致】且【原始层 ✔都没被动】的组合，就是 ps 07 该用的。");
    rep("  · C 能看出 bounds 内缩是不是「搬进文件夹」造成的（搬回去能否恢复）。");
    rep("  · 样式那一行能看出副本到底有没有丢掉图层样式。");
    back();
    flush();
}

try { main(); } catch (eM) {
    rep("整体出错：" + clean(eM));
    try { rep("（行 " + eM.line + "）"); } catch (e2) {}
    flush();
}

})();
