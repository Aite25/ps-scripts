#target photoshop
/* ==========================================================================
 * 诊断_07_剪贴修复探针（最后一块拼图）
 * --------------------------------------------------------------------------
 * 已知（前几轮探针实测）：
 *   · 复制【图层 11】（剪贴链最上面那个）= 安全
 *   · 复制【图层 10】（紧贴"名字"文件夹的那个）= 必然把 图层 11 的剪贴清掉
 *     （因为 图层 11 剪贴到 图层 10、图层 10 剪贴到 名字，是链式；
 *       复制 图层 10 时 PS 在链里临时插入副本，重算了 图层 11 的剪贴）
 *   · 复制本身【不丢内容】：bounds 的 91px 差异只是"容器相关的报告差异"
 *     （搬走 -> 内缩、搬回原容器 -> 完全恢复；而 move 不可能改像素）
 *
 * 所以只剩一个问题：能不能把被清掉的剪贴【修回来】？
 * 本探针测 4 种修法：
 *   A. 制造破坏：复制 图层 10            -> 确认 图层 11 剪贴被清
 *   B. 修法1：L11.grouped = true        -> 看能不能恢复
 *   C. 修法2：用 ActionManager 的"创建剪贴蒙版"命令
 *   D. 修法3：先选中 图层 11 再执行一次（有些命令要求先选中）
 * 每次都核对【两个原始层】的剪贴/显示状态，看看修一个会不会连带坏另一个。
 *
 * 只读 + 每步历史回退。报告：%TEMP%\psjsx_07_clipfix.txt
 * ========================================================================== */

(function () {

var REPORT = [];
var FILE = "psjsx_07_clipfix.txt";
function rep(s) { REPORT.push(s); }
function clean(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 200); } catch (e) { return "" + s; } }
function flush() {
    var out = REPORT.join("\n"), path = "";
    try {
        var f = File(Folder.temp.fsName + "/" + FILE);
        f.encoding = "UTF-8"; f.open("w"); f.write(out + "\n"); f.close();
        path = f.fsName;
    } catch (e) { path = "(写失败 " + e + ")"; }
    try { alert("剪贴修复探针：已测完\n\n报告：\n" + path); } catch (e2) {}
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
                found = { clipIds: ids, folderId: getId(arr[kk]), folderName: nameOf(arr[kk]), container: container, path: path };
            }
            i = kk - 1;
        }
    })(doc, "");
    return found;
}
function snap(ids) {
    var m = {};
    for (var i = 0; i < ids.length; i++) {
        var L = byId(ids[i]);
        m["" + ids[i]] = L ? { clip: isClip(L), vis: isVis(L), name: nameOf(L) } : null;
    }
    return m;
}
function show(ids, tag) {
    var out = [];
    for (var i = 0; i < ids.length; i++) {
        var L = byId(ids[i]);
        out.push((L ? nameOf(L) : "?") + ":剪贴=" + (L ? isClip(L) : "?") + " 显示=" + (L ? isVis(L) : "?"));
    }
    rep("      " + tag + " -> " + out.join("　"));
}
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

function main() {
    rep("诊断_07_剪贴修复探针 —— " + (new Date()).toString());
    if (app.documents.length === 0) { rep("没有打开的文档"); flush(); return; }
    doc = app.activeDocument;
    rep("文档：" + doc.name);

    var seg = findSeg();
    if (!seg) { rep("★ 找不到「剪贴层紧跟文件夹」的结构"); flush(); return; }
    rep("段的路径 = " + seg.path + "　目标文件夹 =「" + seg.folderName + "」");
    rep("剪贴层（从上到下）：" + seg.clipIds.join(", "));
    var topId = seg.clipIds[0];                       /* 最上面那个（会被破坏的） */
    var bottomId = seg.clipIds[seg.clipIds.length - 1]; /* 紧贴文件夹那个（复制它会破坏上面） */
    rep("  ★ 最上面（会被破坏）= id=" + topId + "「" + nameOf(byId(topId)) + "」");
    rep("  ★ 最下面（复制它会破坏）= id=" + bottomId + "「" + nameOf(byId(bottomId)) + "」");
    rep("");

    var h = null; try { h = doc.activeHistoryState; } catch (eH) {}
    function back() { try { if (h) { doc.activeHistoryState = h; return true; } } catch (e) {} return false; }

    rep("== 基线 ==");
    show(seg.clipIds, "基线");
    rep("");

    /* ---------- A. 制造破坏：复制 图层 10 ---------- */
    rep("=== A. 制造破坏：复制最下面那个（紧贴文件夹的）===");
    (function () {
        var holder = null, cp = null, err = "";
        try {
            holder = doc.layerSets.add(); holder.name = "__probe_fix_A";
            try { holder.visible = false; } catch (e) {}
            var s = byId(bottomId);
            cp = s.duplicate(holder, ElementPlacement.INSIDE);
        } catch (eA) { err = clean(eA); }
        rep("  结果：副本 id=" + (cp ? getId(cp) : "?") + (err ? ("　★ " + err) : ""));
        show(seg.clipIds, "复制后");
    })();
    rep("");

    /* ---------- B. 修法1：DOM grouped = true ---------- */
    rep("=== B. 修法1：对被破坏那层写 grouped = true ===");
    (function () {
        var holder = null, err = "", err2 = "";
        try {
            holder = doc.layerSets.add(); holder.name = "__probe_fix_B";
            try { holder.visible = false; } catch (e) {}
            byId(bottomId).duplicate(holder, ElementPlacement.INSIDE);
        } catch (eA) { err = clean(eA); }
        show(seg.clipIds, "破坏后");
        var L = byId(topId);
        try { L.grouped = true; } catch (eB) { err2 = clean(eB); }
        rep("  写 grouped=true " + (err2 ? ("★抛错：" + err2) : "未抛错"));
        show(seg.clipIds, "修复后");
    })();
    rep("");

    /* ---------- C. 修法2：ActionManager 的"创建剪贴蒙版" ---------- */
    rep("=== C. 修法2：用 ActionManager 创建剪贴蒙版（GrpL）===");
    (function () {
        var holder = null, err = "", err2 = "";
        try {
            holder = doc.layerSets.add(); holder.name = "__probe_fix_C";
            try { holder.visible = false; } catch (e) {}
            byId(bottomId).duplicate(holder, ElementPlacement.INSIDE);
        } catch (eA) { err = clean(eA); }
        show(seg.clipIds, "破坏后");
        if (!selectById(topId)) rep("  选不中目标层");
        try {
            var d = new ActionDescriptor();
            var r = new ActionReference();
            r.putEnumerated(cid("Lyr "), cid("Ordn"), cid("Trgt"));
            d.putReference(cid("null"), r);
            executeAction(cid("GrpL"), d, DialogModes.NO);
        } catch (eC) { err2 = clean(eC); }
        rep("  GrpL " + (err2 ? ("★抛错：" + err2) : "未抛错"));
        show(seg.clipIds, "修复后");
    })();
    rep("");

    /* ---------- D. 修法3：换一个 ActionManager 命令名试 ---------- */
    rep("=== D. 修法3：试几个可能的剪贴命令（GrpL / ClpM / MskA）===");
    (function () {
        var names = ["GrpL", "ClpM", "MskA", "clpM"];
        for (var n = 0; n < names.length; n++) {
            back();
            var holder = null, err2 = "";
            try {
                holder = doc.layerSets.add(); holder.name = "__probe_fix_D" + n;
                try { holder.visible = false; } catch (e) {}
                byId(bottomId).duplicate(holder, ElementPlacement.INSIDE);
            } catch (eA) {}
            var before = isClip(byId(topId));
            if (!selectById(topId)) { rep("  " + names[n] + "：选不中"); continue; }
            try {
                var d = new ActionDescriptor();
                var r = new ActionReference();
                r.putEnumerated(cid("Lyr "), cid("Ordn"), cid("Trgt"));
                d.putReference(cid("null"), r);
                executeAction(cid(names[n]), d, DialogModes.NO);
            } catch (eD) { err2 = clean(eD); }
            rep("  " + names[n] + "：" + (err2 ? ("★ " + err2) : ("未抛错　修复前剪贴=" + before + " 修复后剪贴=" + isClip(byId(topId)))));
        }
        back();
    })();
    rep("");

    back();
    rep("=== 收尾回退检验 ===");
    show(seg.clipIds, "最终");
    rep("");
    rep("== 怎么读 ==");
    rep("  · 看 B / C / D 里有没有哪个修法能让【修复后】恢复成【剪贴=true】。");
    rep("  · 同时确认另一个原始层没有被连带改坏（两层的 剪贴/显示 都要正常）。");
    rep("  · 如果全都修不回来 -> 那就改成【只复制上面那些层、不复制紧贴文件夹的那层】，");
    rep("    或者接受紧贴文件夹那层不复制，并在 JSON/日志里明确标注。");
    back();
    flush();
}

try { main(); } catch (eM) {
    rep("整体出错：" + clean(eM));
    try { rep("（行 " + eM.line + "）"); } catch (e2) {}
    flush();
}

})();
