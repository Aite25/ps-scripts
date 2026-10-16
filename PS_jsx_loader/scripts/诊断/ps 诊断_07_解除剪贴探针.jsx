#target photoshop
/* ==========================================================================
 * 诊断_07_解除剪贴探针
 * --------------------------------------------------------------------------
 * 背景：新写的 ps 07 里，复制"文件夹上方的剪贴蒙版图层"之后调用
 *       unclipLayer() 取消剪贴状态，结果【把不该取消的图层的剪贴蒙版也取消了】，
 *       画面被损坏。
 *
 * 本探针【只读 + 全部历史回退】，把真相测清楚：
 *   A) 先 dump 出文档里所有"剪贴段 + 紧跟的文件夹"的真实结构
 *   B) 对第一段做实验，每一步之后都完整记录【全文档】的 grouped / visible：
 *        ① 基线
 *        ② duplicate(firstClip, PLACEBEFORE) 之后        <- 这一步动了谁？
 *        ③ selectById(copyId) + Dgrp 之后                <- 这一步动了谁？
 *        ④ copy.grouped = false 之后（如果 Dgrp 失败）
 *        ⑤ copy.visible = false 之后
 *      每步都把"和基线不一样的地方"打出来 —— 一眼就能看出哪一步改错了。
 *   C) 每步都检查：原始那些剪贴层的 grouped 还在不在
 *
 * 报告：%TEMP%\psjsx_07_unclip_probe.txt
 * ========================================================================== */

(function () {

var REPORT = [];
var FILE = "psjsx_07_unclip_probe.txt";

function rep(s) { REPORT.push(s); }
function clean(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 200); } catch (e) { return "" + s; } }
function flush() {
    var out = REPORT.join("\n"), path = "";
    try {
        var f = File(Folder.temp.fsName + "/" + FILE);
        f.encoding = "UTF-8"; f.open("w"); f.write(out + "\n"); f.close();
        path = f.fsName;
    } catch (e) { path = "(写失败 " + e + ")"; }
    try { alert("解除剪贴探针：已测完\n\n报告：\n" + path); } catch (e2) {}
    return out;
}
function cid(k) { try { return charIDToTypeID(k); } catch (e) { return false; } }
function sid(k) { try { return stringIDToTypeID(k); } catch (e) { return false; } }
function getId(L) { try { return L.id; } catch (e) { return -1; } }
function isGroup(L) { try { return (L.typename === "LayerSet"); } catch (e) { return false; } }
function nameOf(L) { try { return L.name; } catch (e) { return "?"; } }
function isVis(L) { try { return (L.visible !== false); } catch (e) { return true; } }
function isClip(L) { try { return (L.grouped === true); } catch (e) { return false; } }

function walk(container, fn) {
    var arr = null; try { arr = container.layers; } catch (e) { return; }
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) { fn(arr[i]); if (isGroup(arr[i])) walk(arr[i], fn); }
}
function byId(id) { var f = null; walk(doc, function (L) { if (!f && getId(L) === id) f = L; }); return f; }

/* 全文档状态快照：id -> {clip, vis, name} */
function snapState() {
    var m = {};
    walk(doc, function (L) {
        var id = getId(L);
        if (id < 0) return;
        m[id] = { clip: isClip(L), vis: isVis(L), name: nameOf(L), grp: isGroup(L) };
    });
    return m;
}
/* 两份快照的差异 */
function diffState(a, b) {
    var out = { added: [], removed: [], changed: [] };
    for (var id in b) {
        if (!a[id]) { out.added.push(id + " " + b[id].name); continue; }
        var A = a[id], B = b[id];
        if (A.clip !== B.clip) out.changed.push(id + "「" + B.name + "」剪贴 " + (A.clip ? "有" : "无") + " -> " + (B.clip ? "有" : "无"));
        if (A.vis !== B.vis) out.changed.push(id + "「" + B.name + "」显示 " + (A.vis ? "开" : "关") + " -> " + (B.vis ? "开" : "关"));
    }
    for (var id2 in a) { if (!b[id2]) out.removed.push(id2 + " " + a[id2].name); }
    return out;
}
function reportDiff(label, base, cur) {
    var d = diffState(base, cur);
    rep("  --- " + label + " 的差异 ---");
    if (d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0) {
        rep("      ✔ 什么都没变");
    } else {
        for (var i = 0; i < d.added.length; i++) rep("      + 新增 " + d.added[i]);
        for (var j = 0; j < d.removed.length; j++) rep("      - 消失 " + d.removed[j]);
        for (var k = 0; k < d.changed.length; k++) rep("      ★ 改变 " + d.changed[k]);
    }
    return d;
}

/* 列出某个容器里的层级顺序（带剪贴标记） */
function listLevel(container, label) {
    rep("  " + label + "：");
    var arr = null; try { arr = container.layers; } catch (e) { rep("    (读不到)"); return; }
    for (var i = 0; i < arr.length && i < 40; i++) {
        rep("    [" + i + "] " + (isClip(arr[i]) ? "CLIP " : "     ") +
            (isGroup(arr[i]) ? "[组] " : "     ") +
            "id=" + getId(arr[i]) + "  " + nameOf(arr[i]) + (isVis(arr[i]) ? "" : "  (关灯)"));
    }
}

/* 找出第一段"剪贴层 + 紧跟文件夹" */
function findFirstSeg() {
    var found = null;
    (function rec(container, pathPrefix) {
        if (found) return;
        var arr = null; try { arr = container.layers; } catch (e) { return; }
        if (!arr) return;
        for (var i = 0; i < arr.length; i++) {
            if (found) return;
            if (isGroup(arr[i])) { rec(arr[i], pathPrefix + " / " + nameOf(arr[i])); continue; }
            if (!isClip(arr[i])) continue;
            var ids = [], k = i, kk = i;
            while (kk < arr.length && isClip(arr[kk])) { ids.push(getId(arr[kk])); kk++; }
            if (kk < arr.length && isGroup(arr[kk])) {
                found = { clipIds: ids, folderId: getId(arr[kk]), folderName: nameOf(arr[kk]),
                          container: container, path: pathPrefix, firstIndex: i, folderIndex: kk };
            }
            i = kk - 1;
        }
    })(doc, "");
    return found;
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
function activeInfo() {
    try { var L = doc.activeLayer; return "id=" + getId(L) + "  " + nameOf(L) + "  剪贴=" + (isClip(L) ? "有" : "无"); }
    catch (e) { return "(读不到)"; }
}

var doc = null;

function main() {
    rep("诊断_07_解除剪贴探针 —— " + (new Date()).toString());
    if (app.documents.length === 0) { rep("没有打开的文档"); flush(); return; }
    doc = app.activeDocument;
    rep("文档：" + doc.name);
    rep("");

    var seg = findFirstSeg();
    if (!seg) {
        rep("★ 这份文档里找不到「剪贴层紧跟文件夹」的结构。");
        rep("  请在【还没跑过 07】的原始文件上跑本诊断。");
        rep("");
        rep("== 顺便列出根级结构，看看到底长什么样 ==");
        listLevel(doc, "文档根级");
        flush(); return;
    }

    rep("== 找到的第一段 ==");
    rep("  路径：" + seg.path);
    rep("  剪贴层 " + seg.clipIds.length + " 个，下面的文件夹 =「" + seg.folderName + "」(id=" + seg.folderId + ")");
    rep("");
    listLevel(seg.container, "这一段的原始顺序");
    rep("");

    var h = null; try { h = doc.activeHistoryState; } catch (eH) {}
    function back() { try { if (h) { doc.activeHistoryState = h; return true; } } catch (e) {} return false; }

    var base = snapState();
    rep("基线：全文档 " + (function () { var n = 0; for (var k in base) n++; return n; })() + " 个图层");
    rep("");

    /* ---------- ② duplicate(firstClip, PLACEBEFORE) ---------- */
    rep("=== ② duplicate(第一个剪贴层, PLACEBEFORE) ===");
    var firstClip = byId(seg.clipIds[0]);
    rep("  第一个剪贴层：" + nameOf(firstClip) + " (id=" + seg.clipIds[0] + ")");
    var copyId = -1, copyObj = null;
    try {
        copyObj = firstClip.duplicate(firstClip, ElementPlacement.PLACEBEFORE);
        copyId = copyObj ? getId(copyObj) : -1;
        rep("  复制返回：id=" + copyId + (copyObj ? ("  " + nameOf(copyObj)) : "  (null)"));
    } catch (eD) { rep("  ★ 复制抛错：" + clean(eD)); }
    rep("  当前活动图层：" + activeInfo());
    var s2 = snapState();
    reportDiff("复制之后", base, s2);
    listLevel(seg.container, "复制之后的顺序");
    rep("");

    /* ---------- ③ selectById + Dgrp ---------- */
    rep("=== ③ selectById(copyId) + Dgrp ===");
    rep("  selectById 返回：" + selectById(copyId));
    rep("  选中后活动图层：" + activeInfo() + "　（期望 id=" + copyId + "）");
    var dgrpOK = false;
    try { executeAction(cid("Dgrp"), new ActionDescriptor(), DialogModes.NO); dgrpOK = true; }
    catch (eG) { rep("  ★ Dgrp 抛错：" + clean(eG)); }
    rep("  Dgrp " + (dgrpOK ? "未抛错" : "失败"));
    var s3 = snapState();
    var d3 = reportDiff("Dgrp 之后", base, s3);
    rep("  ★ 只关心这个：原始剪贴层有没有被解除剪贴？");
    var bad = 0;
    for (var q = 0; q < seg.clipIds.length; q++) {
        var oid = seg.clipIds[q];
        var nowClip = s3[oid] ? s3[oid].clip : null;
        var wasClip = base[oid] ? base[oid].clip : null;
        rep("      id=" + oid + "  " + (base[oid] ? base[oid].name : "?") +
            "　原来剪贴=" + wasClip + "　现在剪贴=" + nowClip + (wasClip !== nowClip ? "　★★★ 被改了！" : "　正常"));
        if (wasClip !== nowClip) bad++;
    }
    rep("  结论：" + (bad === 0 ? "✔ 原始剪贴层没被动" : ("★ 有 " + bad + " 个原始剪贴层被解除了剪贴 —— 这就是画面损坏的原因")));
    listLevel(seg.container, "Dgrp 之后的顺序");
    rep("");

    back();

    /* ---------- ③b：copy.grouped = false（Dgrp 失败时的兜底，最可疑） ---------- */
    rep("=== ③b 兜底方案：copy.grouped = false ===");
    var c2 = null, c2id = -1;
    try {
        var f2 = byId(seg.clipIds[0]);
        c2 = f2.duplicate(f2, ElementPlacement.PLACEBEFORE);
        c2id = c2 ? getId(c2) : -1;
        rep("  复制返回：id=" + c2id);
        rep("  复制后活动图层：" + activeInfo());
    } catch (eD2) { rep("  ★ 复制抛错：" + clean(eD2)); }
    if (c2id >= 0) {
        var okSet = false, setErr = "";
        try { c2.grouped = false; okSet = true; } catch (eS2) { setErr = clean(eS2); }
        rep("  copy.grouped = false " + (okSet ? "未抛错" : ("★抛错：" + setErr)));
        var s3b = snapState();
        rep("  ★ 只关心这个：原始剪贴层有没有被解除剪贴？");
        var bad3b = 0;
        for (var q3 = 0; q3 < seg.clipIds.length; q3++) {
            var o3 = seg.clipIds[q3];
            var w3 = base[o3] ? base[o3].clip : null;
            var n3 = s3b[o3] ? s3b[o3].clip : null;
            rep("      id=" + o3 + "  " + (base[o3] ? base[o3].name : "?") +
                "　原来=" + w3 + "　现在=" + n3 + (w3 !== n3 ? "　★★★ 被改了！" : "　正常"));
            if (w3 !== n3) bad3b++;
        }
        rep("  结论：" + (bad3b === 0 ? "✔ 原始剪贴层没被动" : ("★ 有 " + bad3b + " 个被解除了剪贴 —— ★ 这就是画面损坏的原因！")));
        reportDiff("copy.grouped=false 之后", base, s3b);
        listLevel(seg.container, "copy.grouped=false 之后");
        /* 顺便看副本自己的状态 */
        var sc = s3b["" + c2id];
        rep("  副本自己：剪贴=" + (sc ? sc.clip : "?") + "　显示=" + (sc ? sc.vis : "?"));
    }
    rep("");
    back();

    /* ---------- ③c：替代方案 —— 用 move 把副本移出剪贴链，完全不写 grouped ---------- */
    rep("=== ③c 替代方案：把副本 move 到剪贴链之外（不写 grouped） ===");
    var c3 = null, c3id = -1;
    try {
        var f3 = byId(seg.clipIds[0]);
        c3 = f3.duplicate(f3, ElementPlacement.PLACEBEFORE);
        c3id = c3 ? getId(c3) : -1;
        rep("  复制返回：id=" + c3id);
    } catch (eD3) { rep("  ★ 复制抛错：" + clean(eD3)); }
    if (c3id >= 0) {
        /* 找一个"剪贴链之上"的参照层：这一层里第一个不属于本剪贴段的层 */
        var arr3 = null; try { arr3 = seg.container.layers; } catch (eA3) {}
        var target3 = null;
        if (arr3) {
            for (var z3 = 0; z3 < arr3.length; z3++) {
                var zid = getId(arr3[z3]);
                var inSeg = false;
                for (var y3 = 0; y3 < seg.clipIds.length; y3++) { if (seg.clipIds[y3] === zid) { inSeg = true; break; } }
                if (!inSeg && zid !== c3id) { target3 = arr3[z3]; break; }
            }
        }
        if (target3) {
            rep("  参照层（剪贴段之外、同层级的第一个）：" + nameOf(target3) + " (id=" + getId(target3) + ")");
            var mvOK = false, mvErr = "";
            try { c3.move(target3, ElementPlacement.PLACEBEFORE); mvOK = true; } catch (eM3) { mvErr = clean(eM3); }
            rep("  move " + (mvOK ? "未抛错" : ("★抛错：" + mvErr)));
            var s3c = snapState();
            var bad3c = 0;
            for (var q4 = 0; q4 < seg.clipIds.length; q4++) {
                var o4 = seg.clipIds[q4];
                var w4 = base[o4] ? base[o4].clip : null;
                var n4 = s3c[o4] ? s3c[o4].clip : null;
                rep("      id=" + o4 + "  " + (base[o4] ? base[o4].name : "?") +
                    "　原来=" + w4 + "　现在=" + n4 + (w4 !== n4 ? "　★★★ 被改了！" : "　正常"));
                if (w4 !== n4) bad3c++;
            }
            var sc3 = s3c["" + c3id];
            rep("  副本自己：剪贴=" + (sc3 ? sc3.clip : "?") + "　显示=" + (sc3 ? sc3.vis : "?"));
            rep("  结论：" + (bad3c === 0
                ? "✔ 原始剪贴层没被动；副本自己剪贴=" + (sc3 ? sc3.clip : "?")
                : ("★ 有 " + bad3c + " 个原始剪贴层被改了")));
            reportDiff("move 之后", base, s3c);
            listLevel(seg.container, "move 之后");
        } else {
            rep("  （找不到剪贴段之外的参照层，这一层里全是这段剪贴层 + 文件夹）");
        }
    }
    rep("");
    back();

    /* ---------- ③d：完整复刻 ps 07 的多层循环（关键！）---------- */
    rep("=== ③d 复刻 ps 07 的循环：逐层复制 + 解除剪贴（整段 " +
        seg.clipIds.length + " 层）===");
    rep("  做法和 ps 07 的 copyClipLayerAboveClip 完全一致：");
    rep("    每一层都 duplicate(clipIds[0], PLACEBEFORE) -> grouped=false -> visible=false");
    var madeIds = [];
    for (var li = 0; li < seg.clipIds.length; li++) {
        var srcId = seg.clipIds[li];
        var srcL2 = byId(srcId);
        if (!srcL2) { rep("  [" + li + "] 源层 id=" + srcId + " 找不到，跳过"); continue; }
        var refL = byId(seg.clipIds[0]);
        var cp = null, cpId = -1;
        try { cp = srcL2.duplicate(refL, ElementPlacement.PLACEBEFORE); cpId = cp ? getId(cp) : -1; }
        catch (eD4) { rep("  [" + li + "] ★ 复制抛错：" + clean(eD4)); continue; }
        rep("  [" + li + "] 复制 " + nameOf(srcL2) + "(id=" + srcId + ") -> id=" + cpId);
        /* 解除剪贴 */
        var unOK = false, unErr = "";
        try {
            var d4 = new ActionDescriptor(), r4 = new ActionReference();
            r4.putIdentifier(cid("Lyr "), cpId);
            d4.putReference(cid("null"), r4);
            d4.putBoolean(cid("MkVs"), false);
            executeAction(cid("slct"), d4, DialogModes.NO);
            executeAction(cid("Dgrp"), new ActionDescriptor(), DialogModes.NO);
            unOK = true;
        } catch (eU4) { unErr = clean(eU4); }
        if (!unOK) {
            try { cp.grouped = false; rep("      Dgrp失败，走了 grouped=false 兜底"); }
            catch (eG4) { rep("      ★ grouped=false 也抛错：" + clean(eG4)); }
        } else { rep("      Dgrp 成功"); }
        try { cp.visible = false; } catch (eV4) {}
        madeIds.push(cpId);

        /* 每步之后立刻检查原始剪贴层 */
        var sd = snapState();
        var badD = [];
        for (var qd = 0; qd < seg.clipIds.length; qd++) {
            var od = seg.clipIds[qd];
            var wd = base[od] ? base[od].clip : null;
            var nd = sd[od] ? sd[od].clip : null;
            if (wd !== nd) badD.push("id=" + od + " " + (base[od] ? base[od].name : "?") + " " + wd + "->" + nd);
        }
        var cpSt = sd["" + cpId];
        rep("      副本状态：剪贴=" + (cpSt ? cpSt.clip : "?") + "  显示=" + (cpSt ? cpSt.vis : "?"));
        if (badD.length === 0) {
            rep("      ✔ 原始剪贴层都还在");
        } else {
            rep("      ★★★ 原始剪贴层被改了：" + badD.join("；"));
        }
    }
    rep("");
    rep("  最终顺序：");
    listLevel(seg.container, "③d 循环结束后");
    rep("");
    var s3d = snapState();
    reportDiff("③d 循环结束 vs 基线", base, s3d);
    rep("");
    back();

    /* ---------- ③e：正确方案 —— 复制后立刻移出剪贴链，再解除剪贴 ---------- */
    rep("=== ③e 正确方案：复制 -> 立刻移到容器最上方（离开剪贴链）-> 解除剪贴 -> 关灯 ===");
    rep("  和 ③d 的唯一区别：解除剪贴之前先 move 出剪贴链，不让副本挤在链内部。");
    for (var lj = 0; lj < seg.clipIds.length; lj++) {
        var srcId2 = seg.clipIds[lj];
        var srcL3 = byId(srcId2);
        if (!srcL3) { rep("  [" + lj + "] 源层 id=" + srcId2 + " 找不到"); continue; }
        var cp2 = null, cp2id = -1;
        try {
            /* 复制到"这段剪贴段的最上面那个"的位置（临时落点） */
            var refL2 = byId(seg.clipIds[0]);
            cp2 = srcL3.duplicate(refL2, ElementPlacement.PLACEBEFORE);
            cp2id = cp2 ? getId(cp2) : -1;
        } catch (eD5) { rep("  [" + lj + "] ★ 复制抛错：" + clean(eD5)); continue; }
        rep("  [" + lj + "] 复制 " + nameOf(srcL3) + "(id=" + srcId2 + ") -> id=" + cp2id);
        var st0 = snapState();
        rep("      复制后副本剪贴=" + (st0["" + cp2id] ? st0["" + cp2id].clip : "?"));

        /* ★ 关键一步：把副本移到【容器最上方】（arr[0] 之上）——离开剪贴链 */
        var arr5 = null; try { arr5 = seg.container.layers; } catch (eA5) {}
        if (arr5 && arr5.length > 0) {
            var topL = arr5[0];
            if (getId(topL) !== cp2id) {
                var mvOK2 = false, mvErr2 = "";
                try { cp2.move(topL, ElementPlacement.PLACEBEFORE); mvOK2 = true; }
                catch (eM5) { mvErr2 = clean(eM5); }
                rep("      move 到容器最上方（" + nameOf(topL) + " 之上）：" + (mvOK2 ? "未抛错" : ("★抛错：" + mvErr2)));
            } else { rep("      已经在最上方了"); }
        }
        var stM = snapState();
        rep("      move 之后副本剪贴=" + (stM["" + cp2id] ? stM["" + cp2id].clip : "?"));

        /* 再解除剪贴（此时副本已在链外，理论上已经不需要，但保险起见） */
        var unOK2 = false;
        try {
            var d5 = new ActionDescriptor(), r5 = new ActionReference();
            r5.putIdentifier(cid("Lyr "), cp2id);
            d5.putReference(cid("null"), r5);
            d5.putBoolean(cid("MkVs"), false);
            executeAction(cid("slct"), d5, DialogModes.NO);
            executeAction(cid("Dgrp"), new ActionDescriptor(), DialogModes.NO);
            unOK2 = true;
        } catch (eU5) {}
        if (!unOK2) { try { cp2.grouped = false; } catch (eG5) {} }
        try { cp2.visible = false; } catch (eV5) {}

        var st5 = snapState();
        var bad5 = [];
        for (var q5 = 0; q5 < seg.clipIds.length; q5++) {
            var o5 = seg.clipIds[q5];
            var w5 = base[o5] ? base[o5].clip : null;
            var n5 = st5[o5] ? st5[o5].clip : null;
            if (w5 !== n5) bad5.push("id=" + o5 + " " + (base[o5] ? base[o5].name : "?") + " " + w5 + "->" + n5);
        }
        rep("      副本最终：剪贴=" + (st5["" + cp2id] ? st5["" + cp2id].clip : "?") +
            "  显示=" + (st5["" + cp2id] ? st5["" + cp2id].vis : "?"));
        rep("      " + (bad5.length === 0 ? "✔ 原始剪贴层都还在" : ("★★★ 原始剪贴层被改了：" + bad5.join("；"))));
    }
    rep("");
    rep("  最终顺序：");
    listLevel(seg.container, "③e 结束后");
    rep("");
    reportDiff("③e 结束 vs 基线", base, snapState());
    rep("");
    back();

    /* ---------- ③f：放进新建文件夹，完全不碰 grouped ---------- */
    rep("=== ③f 完全不碰 grouped：把副本放进新建的 __AE_jsonCopies 文件夹 ===");
    rep("  思路：文件夹里只有一层时它天然不剪贴；全程不写 grouped，就不可能牵连原剪贴链。");
    var box = null;
    try {
        box = doc.layerSets.add();
        box.name = "__AE_jsonCopies";
        var arrF = null; try { arrF = seg.container.layers; } catch (eAF) {}
        if (arrF && arrF.length > 0 && getId(arrF[0]) !== getId(box)) {
            try { box.move(arrF[0], ElementPlacement.PLACEBEFORE); } catch (eMF) {}
        }
        rep("  建好文件夹 id=" + getId(box));
    } catch (eB) { rep("  ★ 建文件夹失败：" + clean(eB)); }

    if (box) {
        for (var lk = 0; lk < seg.clipIds.length; lk++) {
            var sid6 = seg.clipIds[lk];
            var sL6 = byId(sid6);
            if (!sL6) { rep("  [" + lk + "] 源层 " + sid6 + " 找不到"); continue; }
            var cF = null, cFid = -1;
            try {
                cF = sL6.duplicate();
                cFid = cF ? getId(cF) : -1;
                if (cF) {
                    try { cF.name = "__AE_" + nameOf(sL6); } catch (eN6) {}
                    cF.move(box, ElementPlacement.INSIDE);
                    rep("  [" + lk + "] 复制 " + nameOf(sL6) + " -> id=" + cFid + "，已移进文件夹");
                }
            } catch (eD6) { rep("  [" + lk + "] ★ 出错：" + clean(eD6)); continue; }
            var st6 = snapState();
            rep("      副本状态：剪贴=" + (st6["" + cFid] ? st6["" + cFid].clip : "?") + "  显示=" + (st6["" + cFid] ? st6["" + cFid].vis : "?"));
            var bad6 = [];
            for (var q6 = 0; q6 < seg.clipIds.length; q6++) {
                var o6 = seg.clipIds[q6];
                var w6 = base[o6] ? base[o6].clip : null;
                var n6 = st6[o6] ? st6[o6].clip : null;
                if (w6 !== n6) bad6.push("id=" + o6 + " " + (base[o6] ? base[o6].name : "?") + " " + w6 + "->" + n6);
            }
            rep("      " + (bad6.length === 0 ? "✔ 原始剪贴层都还在（关键！）" : ("★★★ 原始剪贴层被改了：" + bad6.join("；"))));
        }
        rep("");
        try {
            rep("  文件夹 __AE_jsonCopies 里 " + box.layers.length + " 层：");
            for (var z6 = 0; z6 < box.layers.length; z6++) {
                rep("      " + (box.layers[z6].grouped === true ? "CLIP " : "     ") + "id=" + getId(box.layers[z6]) + "  " + nameOf(box.layers[z6]));
            }
        } catch (eL6) {}
        listLevel(seg.container, "③f 结束后（容器层级）");
        rep("");
        reportDiff("③f 结束 vs 基线", base, snapState());
    }
    rep("");
    back();

    /* ---------- ③g：改用 copy()/paste() 代替 duplicate() ---------- */
    rep("=== ③g 用 copy()/paste() 代替 duplicate()（不接触原链）===");
    rep("  动机：③f 证明真凶是【对剪贴链里的层执行 duplicate】这个动作本身，跟副本去哪无关。copy() 是进剪贴板，理论上不碰文档结构。");
    var boxG = null;
    try {
        boxG = doc.layerSets.add();
        boxG.name = "__AE_jsonCopies";
        var arrG = null; try { arrG = seg.container.layers; } catch (eAG) {}
        if (arrG && arrG.length > 0 && getId(arrG[0]) !== getId(boxG)) {
            try { boxG.move(arrG[0], ElementPlacement.PLACEBEFORE); } catch (eMG) {}
        }
        rep("  建好文件夹 id=" + getId(boxG));
    } catch (eBG) { rep("  ★ 建文件夹失败：" + clean(eBG)); }

    if (boxG) {
        for (var lm = 0; lm < seg.clipIds.length; lm++) {
            var sidG = seg.clipIds[lm];
            var sLG = byId(sidG);
            if (!sLG) { rep("  [" + lm + "] 源层 " + sidG + " 找不到"); continue; }
            var okSel = false, okCopy = false, okPaste = false, errG = "";
            try { okSel = selectById(sidG); } catch (eS) { errG = clean(eS); }
            if (okSel) { try { sLG.copy(); okCopy = true; } catch (eC) { errG = clean(eC); } }
            var stBefore = snapState();
            if (okCopy) { try { doc.paste(); okPaste = true; } catch (eP) { errG = clean(eP); } }
            rep("  [" + lm + "] " + nameOf(sLG) + "：select=" + okSel + " copy=" + okCopy + " paste=" + okPaste + (errG ? ("  错误=" + errG) : ""));
            var newId = -1;
            try { newId = getId(doc.activeLayer); } catch (eAL) {}
            var stG = snapState();
            rep("      粘贴后活动图层 id=" + newId + "  剪贴=" + (stG["" + newId] ? stG["" + newId].clip : "?") + "  显示=" + (stG["" + newId] ? stG["" + newId].vis : "?"));
            /* 把新层挪进文件夹（不写 grouped） */
            if (newId >= 0) {
                try { var nl = byId(newId); if (nl) { nl.name = "__AE_" + nameOf(sLG); nl.move(boxG, ElementPlacement.INSIDE); } }
                catch (eMvG) { rep("      ★ 移进文件夹失败：" + clean(eMvG)); }
            }
            var stG2 = snapState();
            var badG = [];
            for (var qG = 0; qG < seg.clipIds.length; qG++) {
                var oG = seg.clipIds[qG];
                var wG = base[oG] ? base[oG].clip : null;
                var nG = stG2[oG] ? stG2[oG].clip : null;
                if (wG !== nG) badG.push("id=" + oG + " " + (base[oG] ? base[oG].name : "?") + " " + wG + "->" + nG);
            }
            rep("      " + (badG.length === 0 ? "✔ 原始剪贴层都还在（关键！）" : ("★★★ 原始剪贴层被改了：" + badG.join("；"))));
        }
        rep("");
        try {
            rep("  文件夹 __AE_jsonCopies 里 " + boxG.layers.length + " 层：");
            for (var zG = 0; zG < boxG.layers.length; zG++) {
                rep("      " + (boxG.layers[zG].grouped === true ? "CLIP " : "     ") + "id=" + getId(boxG.layers[zG]) + "  " + nameOf(boxG.layers[zG]));
            }
        } catch (eLG) {}
        listLevel(seg.container, "③g 结束后（容器层级）");
        rep("");
        reportDiff("③g 结束 vs 基线", base, snapState());
    }
    rep("");
    back();
    var s4 = snapState();
    rep("=== ④ 历史回退检验 ===");
    reportDiff("回退之后", base, s4);
    rep("");

    rep("== 怎么读这份报告 ==");
    rep("  · 如果 ② 就出现『★ 改变 … 剪贴 有 -> 无』→ duplicate 本身就会动剪贴关系");
    rep("  · 如果 ③ 才出现 → 是 Dgrp 打到了错的层上（多半是 selectById 没选对）");
    rep("  · 如果原始剪贴层在 ③ 里被改了 → 修法：不要用 Dgrp/grouped 去解除副本的剪贴，");
    rep("    改成『把副本移到那段剪贴链之外』来自然脱离（move 到链的最上方之上）");
    rep("");
    rep("（本诊断每一步之后都会历史回退，不会留下改动。）");
    flush();
}

try { main(); } catch (eMain) {
    rep("整体出错：" + clean(eMain));
    try { rep("（行 " + eMain.line + "）"); } catch (e2) {}
    flush();
}

})();