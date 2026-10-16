#target photoshop
/* ==========================================================================
 * 诊断_07_复制文件夹探针
 * --------------------------------------------------------------------------
 * 背景：ps 07 要"把遮罩源文件夹复制进镜像树"，试了两种方式都出问题：
 *   · srcGroup.copy()  -> 报"不是函数"（LayerSet 没有这个方法）
 *   · ActionManager Dplc -> ★ 把源文件夹和它上方的剪贴蒙版图层改坏了
 *     （用户反馈："07 脚本动了 ps 文件里的源文件夹以及其上方的剪贴蒙版图层"）
 *
 * 本探针【只读 + 每步历史回退】，逐个实测"复制文件夹"的办法，
 * 每步都检查【源文件夹自己的可见性】和【它上方剪贴层的剪贴状态】有没有被改。
 *
 * 测的办法：
 *   A. ActionManager Dplc（带 from 描述符，只给名字）
 *   B. ActionManager Dplc（带完整 from 描述符：从源层 dump 出来）
 *   C. 新建空文件夹 + 逐个 copy/paste 里面的子层（不碰剪贴关系）
 *   D. 只建空文件夹（对照：确认"建文件夹"本身是无害的）
 *
 * 报告：%TEMP%\psjsx_07_groupcopy_probe.txt
 * ========================================================================== */

(function () {

var REPORT = [];
var FILE = "psjsx_07_groupcopy_probe.txt";
function rep(s) { REPORT.push(s); }
function clean(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 220); } catch (e) { return "" + s; } }
function flush() {
    var out = REPORT.join("\n"), path = "";
    try {
        var f = File(Folder.temp.fsName + "/" + FILE);
        f.encoding = "UTF-8"; f.open("w"); f.write(out + "\n"); f.close();
        path = f.fsName;
    } catch (e) { path = "(写失败 " + e + ")"; }
    try { alert("复制文件夹探针：已测完\n\n报告：\n" + path); } catch (e2) {}
}
function cid(k) { try { return charIDToTypeID(k); } catch (e) { return false; } }
function sid(k) { try { return stringIDToTypeID(k); } catch (e) { return false; } }
function getId(L) { try { return L.id; } catch (e) { return -1; } }
function isGroup(L) { try { return (L.typename === "LayerSet"); } catch (e) { return false; } }
function nameOf(L) { try { return L.name; } catch (e) { return "?"; } }
function isVis(L) { try { return (L.visible !== false); } catch (e) { return true; } }
function isClip(L) { try { return (L.grouped === true); } catch (e) { return false; } }
function nowMs() { return (new Date()).getTime(); }

var doc = null;
function walk(container, fn) {
    var arr = null; try { arr = container.layers; } catch (e) { return; }
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) { fn(arr[i]); if (isGroup(arr[i])) walk(arr[i], fn); }
}
function byId(id) { var f = null; walk(doc, function (L) { if (!f && getId(L) === id) f = L; }); return f; }

/* 全文档状态：id -> {clip, vis, name} */
function snap() {
    var m = {};
    walk(doc, function (L) {
        var id = getId(L); if (id < 0) return;
        m["" + id] = { clip: isClip(L), vis: isVis(L), name: nameOf(L), grp: isGroup(L) };
    });
    return m;
}
function diff(base, cur) {
    var out = { added: [], removed: [], changed: [] };
    for (var id in cur) {
        if (!base[id]) { out.added.push(id + "「" + cur[id].name + "」"); continue; }
        if (base[id].clip !== cur[id].clip) out.changed.push("「" + cur[id].name + "」id=" + id + " 剪贴 " + (base[id].clip ? "有" : "无") + " -> " + (cur[id].clip ? "有" : "无"));
        if (base[id].vis !== cur[id].vis) out.changed.push("「" + cur[id].name + "」id=" + id + " 显示 " + (base[id].vis ? "开" : "关") + " -> " + (cur[id].vis ? "开" : "关"));
    }
    for (var id2 in base) { if (!cur[id2]) out.removed.push(id2 + "「" + base[id2].name + "」"); }
    return out;
}
function reportDiff(label, base, cur, focusIds) {
    var d = diff(base, cur);
    rep("  --- " + label + " ---");
    if (d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0) {
        rep("      ✔ 全文档什么都没变（除了预期新增）");
    } else {
        for (var i = 0; i < d.added.length && i < 12; i++) rep("      + 新增 " + d.added[i]);
        for (var j = 0; j < d.removed.length && j < 12; j++) rep("      - 消失 " + d.removed[j]);
        for (var k = 0; k < d.changed.length && k < 20; k++) rep("      ★ 改变 " + d.changed[k]);
    }
    /* 重点：源文件夹 + 它上方剪贴层的状态 */
    if (focusIds && focusIds.length) {
        for (var q = 0; q < focusIds.length; q++) {
            var fid = "" + focusIds[q];
            var b = base[fid], c = cur[fid];
            if (!b) { rep("      关注 id=" + fid + " 基线里没有"); continue; }
            if (!c) { rep("      ★★ 关注「" + b.name + "」id=" + fid + " 消失了！"); continue; }
            var bad = [];
            if (b.clip !== c.clip) bad.push("剪贴 " + b.clip + "->" + c.clip);
            if (b.vis !== c.vis) bad.push("显示 " + b.vis + "->" + c.vis);
            rep("      关注「" + b.name + "」id=" + fid + "：" + (bad.length ? ("★★ " + bad.join("，")) : "正常"));
        }
    }
    return d;
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
                          container: container, path: path, folderIndex: kk };
            }
            i = kk - 1;
        }
    })(doc, "");
    return found;
}

function main() {
    rep("诊断_07_复制文件夹探针 —— " + (new Date()).toString());
    if (app.documents.length === 0) { rep("没有打开的文档"); flush(); return; }
    doc = app.activeDocument;
    rep("文档：" + doc.name);
    rep("");

    var seg = findSeg();
    if (!seg) {
        rep("★ 找不到「剪贴层紧跟文件夹」的结构（请在没跑过新 07 的原始文件上测）");
        flush(); return;
    }
    rep("找到的段：路径 = " + seg.path);
    rep("  源文件夹 =「" + seg.folderName + "」id=" + seg.folderId);
    rep("  它上方的剪贴层 " + seg.clipIds.length + " 个：" + seg.clipIds.join(", "));
    rep("");

    var h = null; try { h = doc.activeHistoryState; } catch (eH) {}
    function back() { try { if (h) { doc.activeHistoryState = h; return true; } } catch (e) {} return false; }

    var base = snap();
    /* 关注对象：源文件夹 + 它上方的剪贴层 */
    var focus = [seg.folderId];
    for (var q = 0; q < seg.clipIds.length; q++) focus.push(seg.clipIds[q]);
    rep("基线：全文档 " + (function () { var n = 0; for (var k in base) n++; return n; })() + " 个图层");
    rep("");

    var srcFolder = byId(seg.folderId);

    /* ============ A. Dplc + 只给名字的 from ============ */
    rep("=== A. ActionManager Dplc（from 只给名字）===");
    (function () {
        var newId = -1, err = "";
        var t0 = nowMs();
        try {
            var d = new ActionDescriptor();
            var r = new ActionReference(); r.putIdentifier(cid("Lyr "), seg.folderId);
            d.putReference(cid("null"), r);
            var fromD = new ActionDescriptor(); fromD.putString(cid("Nm  "), seg.folderName);
            d.putObject(cid("From"), cid("Lyr "), fromD);
            executeAction(cid("Dplc"), d, DialogModes.NO);
            try { newId = getId(doc.activeLayer); } catch (eAL) {}
        } catch (eA) { err = clean(eA); }
        rep("  结果：新 id=" + newId + (err ? ("　★ 抛错：" + err) : "") + "　耗时 " + (Math.round((nowMs()-t0)/100)/10) + "s");
        reportDiff("A 之后", base, snap(), focus);
        back();
        rep("  已历史回退：" + (back() ? "ok" : "失败"));
    })();
    rep("");

    /* ============ B. Dplc + 从源层 dump 的完整 from ============ */
    rep("=== B. ActionManager Dplc（from = 从源层 dump 的完整描述符）===");
    (function () {
        var newId = -1, err = "", dumpErr = "";
        try {
            var ref = new ActionReference();
            ref.putIdentifier(cid("Lyr "), seg.folderId);
            var srcDesc = executeActionGet(ref);
            var d = new ActionDescriptor();
            var r2 = new ActionReference(); r2.putIdentifier(cid("Lyr "), seg.folderId);
            d.putReference(cid("null"), r2);
            /* 完整 from：把源层的描述符（除 id/layerID 外）都带上 */
            var fromD = new ActionDescriptor();
            for (var i = 0; i < srcDesc.count; i++) {
                var key = srcDesc.getKey(i);
                var kn = ""; try { kn = typeIDToStringID(key); } catch (e0) { kn = "" + key; }
                if (kn === "layerID" || kn === "ID" || kn === "itemIndex" || kn === "layerSection") continue;
                var ty = srcDesc.getType(key);
                try {
                    if (ty === DescValueType.STRINGTYPE) fromD.putString(key, srcDesc.getString(key));
                    else if (ty === DescValueType.INTEGERTYPE) fromD.putInteger(key, srcDesc.getInteger(key));
                    else if (ty === DescValueType.BOOLEANTYPE) fromD.putBoolean(key, srcDesc.getBoolean(key));
                    else if (ty === DescValueType.DOUBLETYPE) fromD.putDouble(key, srcDesc.getDouble(key));
                    else if (ty === DescValueType.OBJECTTYPE) fromD.putObject(key, key, srcDesc.getObjectValue(key));
                    else if (ty === DescValueType.ENUMERATEDTYPE) fromD.putEnumerated(key, srcDesc.getEnumerationType(key), srcDesc.getEnumerationValue(key));
                } catch (ePut) {}
            }
            d.putObject(cid("From"), cid("Lyr "), fromD);
            executeAction(cid("Dplc"), d, DialogModes.NO);
            try { newId = getId(doc.activeLayer); } catch (eAL2) {}
        } catch (eB) { err = clean(eB); }
        rep("  结果：新 id=" + newId + (err ? ("　★ 抛错：" + err) : "") + (dumpErr ? ("　dump：" + dumpErr) : ""));
        reportDiff("B 之后", base, snap(), focus);
        back();
        rep("  已历史回退：" + (back() ? "ok" : "失败"));
    })();
    rep("");

    /* ============ C. 新建空文件夹 + 逐个 copy/paste 子层 ============ */
    rep("=== C. 新建空文件夹 + 逐个 copy()/paste() 子层（不碰剪贴关系）===");
    (function () {
        var newGrp = null, err = "";
        var copied = 0, failed = 0;
        try {
            newGrp = doc.layerSets.add();
            newGrp.name = "__probe_c_" + seg.folderName;
            try { newGrp.visible = false; } catch (eVc) {}
            var kids = null; try { kids = srcFolder.layers; } catch (eK) {}
            if (kids) {
                for (var i = 0; i < kids.length; i++) {
                    var kid = kids[i];
                    var kidId = getId(kid);
                    try {
                        if (!selectById(kidId)) { failed++; continue; }
                        kid.copy();
                        doc.paste();
                        var nid = -1; try { nid = getId(doc.activeLayer); } catch (eAL3) {}
                        var np = byId(nid);
                        if (np) { np.move(newGrp, ElementPlacement.INSIDE); copied++; }
                        else failed++;
                    } catch (eKid) { failed++; }
                }
            }
        } catch (eC) { err = clean(eC); }
        rep("  结果：新文件夹 id=" + (newGrp ? getId(newGrp) : "?") +
            "　子层复制 " + copied + " 个，失败 " + failed + " 个" + (err ? ("　★ 抛错：" + err) : ""));
        reportDiff("C 之后", base, snap(), focus);
        back();
        rep("  已历史回退：" + (back() ? "ok" : "失败"));
    })();
    rep("");

    /* ============ D. 只建空文件夹（对照） ============ */
    rep("=== D. 对照：只建一个空文件夹（不复制任何子层）===");
    (function () {
        var g = null, err = "";
        try {
            g = doc.layerSets.add();
            g.name = "__probe_d_empty";
            try { g.visible = false; } catch (eVd) {}
        } catch (eD) { err = clean(eD); }
        rep("  结果：新文件夹 id=" + (g ? getId(g) : "?") + (err ? ("　★ 抛错：" + err) : ""));
        reportDiff("D 之后", base, snap(), focus);
        back();
        rep("  已历史回退：" + (back() ? "ok" : "失败"));
    })();
    rep("");

    /* ============ E. 建空文件夹 + 递归复制文件夹内容（不碰剪贴关系） ============ */
    rep("=== E. 建空文件夹 + 递归复制【内容】（每个子层单独 copy/paste）===");
    (function () {
        var newGrp = null, err = "";
        var log2 = [];
        var copiedLayers = 0, copiedGroups = 0, failed = 0;

        /* 递归：把 srcContainer 的内容复制进 dstGroup */
        function copyContents(srcContainer, dstGroup, depth) {
            if (depth > 20) return;
            var kids = null;
            try { kids = srcContainer.layers; } catch (eK) { log2.push("      读不到子层：" + clean(eK)); return; }
            if (!kids) return;
            /* 从下往上复制，顺序更稳（放进目标文件夹时也用 INSIDE，天然在末尾） */
            for (var i = 0; i < kids.length; i++) {
                var kid = kids[i];
                var kidId = getId(kid);
                var kidName = nameOf(kid);
                try {
                    if (isGroup(kid)) {
                        /* 子文件夹：在目标里建一个同名空文件夹，再递归进去 */
                        var sub = dstGroup.layerSets.add();
                        try { sub.name = kidName; } catch (eSN) {}
                        try { sub.visible = false; } catch (eSV) {}
                        copiedGroups++;
                        copyContents(kid, sub, depth + 1);
                    } else {
                        /* 普通层：用 copy()/paste()（clip 层已实测这条路不碰剪贴关系） */
                        if (!selectById(kidId)) {
                            failed++; log2.push("      选不中「" + kidName + "」id=" + kidId);
                            continue;
                        }
                        kid.copy();
                        doc.paste();
                        var nid = -1; try { nid = getId(doc.activeLayer); } catch (eAL) {}
                        var np = byId(nid);
                        if (!np) { failed++; log2.push("      粘贴后找不到「" + kidName + "」"); continue; }
                        try { np.move(dstGroup, ElementPlacement.INSIDE); } catch (eMv) { log2.push("      搬进目标失败：" + clean(eMv)); }
                        try { np.visible = false; } catch (eVis) {}
                        copiedLayers++;
                    }
                } catch (eOne) {
                    failed++;
                    log2.push("      ★「" + kidName + "」出错：" + clean(eOne));
                }
            }
        }

        try {
            newGrp = doc.layerSets.add();
            newGrp.name = "__probe_e_" + seg.folderName;
            try { newGrp.visible = false; } catch (eVc) {}
            copyContents(srcFolder, newGrp, 0);
        } catch (eE) { err = clean(eE); }

        rep("  结果：新文件夹 id=" + (newGrp ? getId(newGrp) : "?") +
            "　复制普通层 " + copiedLayers + " 个，子文件夹 " + copiedGroups + " 个，失败 " + failed + " 个" +
            (err ? ("　★ 抛错：" + err) : ""));
        for (var li = 0; li < log2.length && li < 15; li++) rep(log2[li]);
        /* 把复制出来的结构列一下 */
        if (newGrp) {
            try {
                rep("  复制出来的结构：");
                (function listG(g, ind) {
                    var arr = null; try { arr = g.layers; } catch (e1) { return; }
                    if (!arr) return;
                    for (var i2 = 0; i2 < arr.length; i2++) {
                        rep("    " + ind + (isGroup(arr[i2]) ? "[组] " : "     ") + nameOf(arr[i2]) +
                            (isVis(arr[i2]) ? "" : "（关灯）"));
                        if (isGroup(arr[i2])) listG(arr[i2], ind + "    ");
                    }
                })(newGrp, "  ");
            } catch (eL2) {}
        }
        reportDiff("E 之后", base, snap(), focus);
        back();
        rep("  已历史回退：" + (back() ? "ok" : "失败"));
    })();
    rep("");

    /* ============ F. Dplc 不带 from（最朴素的复制） ============ */
    rep("=== F. ActionManager Dplc（不带 from 描述符）===");
    (function () {
        var newId = -1, err = "";
        try {
            var d = new ActionDescriptor();
            var r = new ActionReference(); r.putIdentifier(cid("Lyr "), seg.folderId);
            d.putReference(cid("null"), r);
            /* 不 putObject(From) —— 看会不会比 A/B 温和 */
            executeAction(cid("Dplc"), d, DialogModes.NO);
            try { newId = getId(doc.activeLayer); } catch (eAL) {}
        } catch (eF) { err = clean(eF); }
        rep("  结果：新 id=" + newId + (err ? ("　★ 抛错：" + err) : ""));
        reportDiff("F 之后", base, snap(), focus);
        back();
        rep("  已历史回退：" + (back() ? "ok" : "失败"));
    })();
    rep("");

    /* ============ G. 直接把源文件夹【移动】进一个新文件夹（不复制） ============ */
    rep("=== G. 移动源文件夹进一个新文件夹（测试 move 会不会牵连剪贴层）===");
    (function () {
        var holder = null, err = "";
        try {
            holder = doc.layerSets.add();
            holder.name = "__probe_g_holder";
            try { holder.visible = false; } catch (eVg) {}
            var f2 = byId(seg.folderId);
            if (f2) { f2.move(holder, ElementPlacement.INSIDE); }
            else err = "源文件夹找不到";
        } catch (eG) { err = clean(eG); }
        rep("  结果：holder id=" + (holder ? getId(holder) : "?") + (err ? ("　★ 抛错：" + err) : ""));
        reportDiff("G 之后", base, snap(), focus);
        back();
        rep("  已历史回退：" + (back() ? "ok" : "失败"));
    })();
    rep("");

    /* ============ H. 子层复制：先选中父文件夹再 copy 子层（换一种选法） ============ */
    rep("=== H. 子层复制试验：用 activeLayer 赋值选中，再 copy()/paste() ===");
    (function () {
        var holder2 = null;
        var names = [];
        try {
            holder2 = doc.layerSets.add();
            holder2.name = "__probe_h_holder";
            try { holder2.visible = false; } catch (eVh) {}
            var kids = null; try { kids = srcFolder.layers; } catch (eK) {}
            if (kids) {
                for (var i = 0; i < kids.length; i++) {
                    var kid = kids[i];
                    var kn = nameOf(kid);
                    var ok = false, e1 = "";
                    try {
                        doc.activeLayer = kid;      /* 换成 DOM 选中 */
                        kid.copy();
                        doc.paste();
                        var nid = -1; try { nid = getId(doc.activeLayer); } catch (eAL) {}
                        var np = byId(nid);
                        if (np) { np.move(holder2, ElementPlacement.INSIDE); try { np.visible = false; } catch (e2) {} ok = true; }
                    } catch (eH1) { e1 = clean(eH1); }
                    names.push((ok ? "✔ " : "✗ ") + kn + (e1 ? ("  " + e1) : ""));
                }
            }
        } catch (eH) { names.push("整体出错：" + clean(eH)); }
        rep("  结果：");
        for (var hi = 0; hi < names.length; hi++) rep("      " + names[hi]);
        reportDiff("H 之后", base, snap(), focus);
        back();
        rep("  已历史回退：" + (back() ? "ok" : "失败"));
    })();
    rep("");

    back();
    rep("=== 收尾回退检验 ===");
    reportDiff("最终回退 vs 基线", base, snap(), focus);
    rep("");
    rep("== 怎么读 ==");
    rep("  · 每个办法后面那三行【关注】就是判据：源文件夹和上方剪贴层有没有被改。");
    rep("  · 哪个办法的【关注】全部显示「正常」，那个办法就是安全的，我就用它。");
    rep("  · 如果全都不安全 -> 改方案：镜像里【不放】遮罩源文件夹副本，");
    rep("    AE 端改用原文档里那个文件夹合成当遮罩源（反正它在 AE 里也是合成）。");
    back();
    flush();
}

try { main(); } catch (eM) {
    rep("整体出错：" + clean(eM));
    try { rep("（行 " + eM.line + "）"); } catch (e2) {}
    try { if (doc) { } } catch (e3) {}
    flush();
}

})();