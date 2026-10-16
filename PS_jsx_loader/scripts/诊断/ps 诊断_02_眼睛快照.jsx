#target photoshop
/* ==========================================================================
 * 诊断_02_眼睛快照
 * --------------------------------------------------------------------------
 * 对应步骤：02 删除所有非显示图层
 *
 * 为什么要它：
 *   用户反馈跑 00_single 时，02 这一步"打开了很多图层的眼睛"，
 *   导致画面和原来不一样。但 02 的代码里【只有两处】会写 visible：
 *     · hideCompareLayers() —— 只关 __对比 开头的对比层
 *     · verifyEyes()        —— 收尾把眼睛恢复成快照的样子
 *   删除逻辑（sweep/removeLayerSafely/removeGroupSafely）只读不写。
 *   所以需要实测：到底哪些层的眼睛真的变了。
 *
 * 用法（关键）：
 *   跑 02 之前跑一次本诊断 → 存下 A
 *   跑 02 之后跑一次本诊断 → 存下 B
 *   报告带时间戳，两份不会互相覆盖；对比两份就知道谁的眼睛被动了。
 *
 * 另外本诊断会顺便统计：
 *   · 当前有多少隐藏层 / 可见层
 *   · 每个隐藏层的名字和路径（这是最可能被"打开"的对象）
 *   · 有多少 __对比 层、它们的眼睛状态
 *
 * 只读，不改任何东西。报告：%TEMP%\psjsx_02_eyes_<时间戳>.txt
 * ========================================================================== */

(function () {

var REPORT = [];
var STAMP = "";
var FILE_PREFIX = "psjsx_02_eyes_";

function rep(s) { REPORT.push(s); }
function clean(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 150); } catch (e) { return "" + s; } }
function flush() {
    var out = REPORT.join("\n");
    var path = "";
    try {
        var f = File(Folder.temp.fsName + "/" + FILE_PREFIX + STAMP + ".txt");
        f.open("w"); f.write(out + "\n"); f.close();
        path = f.fsName;
    } catch (e) { path = "(写报告失败：" + e + ")"; }
    try { alert("眼睛快照已保存\n\n对比用：跑 02 前后各跑一次，然后比两份报告\n\n报告：\n" + path); } catch (e2) {}
    return out;
}
function cid(k) { try { return charIDToTypeID(k); } catch (e) { return false; } }
function getId(L) { try { return L.id; } catch (e) { return -1; } }
function isGroup(L) { try { return (L.typename === "LayerSet"); } catch (e) { return false; } }
function nameOf(L) { try { return L.name; } catch (e) { return "?"; } }
function isVisible(L) { try { return (L.visible !== false); } catch (e) { return true; } }
function kindOf(L) { try { return ("" + L.kind); } catch (e) { return "?"; } }
function isClipped(L) { try { return (L.grouped === true); } catch (e) { return false; } }

function walk(container, fn) {
    var arr = null; try { arr = container.layers; } catch (e) { return; }
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) { fn(arr[i]); if (isGroup(arr[i])) walk(arr[i], fn); }
}
function pathOf(L) {
    var parts = [], cur = L, guard = 0;
    try {
        while (cur && guard < 60) {
            var nm = nameOf(cur);
            if (nm === "") break;
            if (cur.typename === "Document") break;
            parts.unshift(nm);
            cur = cur.parent;
            guard++;
        }
    } catch (e) {}
    return parts.join(" / ");
}

function main() {
    var d0 = new Date();
    STAMP = "" + d0.getFullYear() +
            ("0" + (d0.getMonth() + 1)).slice(-2) +
            ("0" + d0.getDate()).slice(-2) + "_" +
            ("0" + d0.getHours()).slice(-2) +
            ("0" + d0.getMinutes()).slice(-2) +
            ("0" + d0.getSeconds()).slice(-2);

    rep("诊断_02_眼睛快照 —— " + d0.toString());
    if (app.documents.length === 0) { rep("没有打开的文档"); flush(); return; }
    var doc = app.activeDocument;
    rep("文档：" + doc.name);
    rep("");
    rep("用法：跑 02 之前跑一次（存 A），跑 02 之后跑一次（存 B），对比 A/B。");
    rep("");

    var all = [], hidden = [], cmp = [];
    walk(doc, function (L) {
        var rec = { id: getId(L), name: nameOf(L), path: pathOf(L), vis: isVisible(L),
                    grp: isGroup(L), kind: kindOf(L), clip: isClipped(L) };
        all.push(rec);
        if (!rec.vis) hidden.push(rec);
        if (rec.name.length >= 4 && rec.name.substring(0, 4) === "__对比") cmp.push(rec);
    });

    var visN = 0;
    for (var i = 0; i < all.length; i++) if (all[i].vis) visN++;

    rep("== 总览 ==");
    rep("  图层总数（递归）=" + all.length + "　可见 " + visN + "　★隐藏 " + hidden.length);
    rep("  __对比 层 " + cmp.length + " 个");
    rep("");

    rep("== 隐藏的图层（最可能被误「打开」的就是它们）==");
    if (hidden.length === 0) rep("  （没有隐藏层）");
    for (var h = 0; h < hidden.length; h++) {
        rep("  [H" + (h + 1) + "] id=" + hidden[h].id + "　" + (hidden[h].grp ? "[文件夹] " : "") + hidden[h].path +
            "　kind=" + hidden[h].kind + "　剪贴=" + (hidden[h].clip ? "是" : "否"));
    }
    rep("");

    rep("== __对比 层 ==");
    if (cmp.length === 0) rep("  （没有）");
    for (var c = 0; c < cmp.length; c++) {
        rep("  id=" + cmp[c].id + "　" + cmp[c].path + "　眼睛=" + (cmp[c].vis ? "★开着" : "关着"));
    }
    rep("");

    rep("== 全部图层（id / 眼睛 / 名字）——用于逐行比对两份报告 ==");
    for (var k = 0; k < all.length; k++) {
        rep("  " + (all[k].vis ? "V" : "H") + "  id=" + all[k].id + "  " + (all[k].grp ? "[G] " : "    ") + all[k].path);
    }
    rep("");
    /* ★★ 自动对比上一次快照 ★★
       这样只需在跑完 02 之后跑一次本诊断，就能看到"哪些层的眼睛被动了"。
       上一次快照取 psjsx_02_eyes_*.txt 里时间最近的那个（排除本次）。 */
    rep("");
    rep("== ★ 与上一次快照的对比（眼睛变化）==");
    var prevText = "";
    try {
        var tf = Folder(Folder.temp);
        var cands = tf.getFiles("psjsx_02_eyes_*.txt");
        var best = null, bestT = "";
        for (var c = 0; c < cands.length; c++) {
            var cn = "" + cands[c].name;
            if (cn === (FILE_PREFIX + STAMP + ".txt")) continue;      // 跳过本次
            var ct = ""; try { ct = cands[c].created ? ("" + cands[c].created.getTime()) : ""; } catch (eC) { ct = ""; }
            if (ct && ct > bestT) { bestT = ct; best = cands[c]; }
        }
        if (best) {
            if (best.open("r")) { prevText = best.read(); best.close(); }
            rep("  上一次快照：" + best.fsName);
        } else {
            rep("  （没有找到更早的快照 —— 这是第一份，跑 02 之后再跑一次就能对比了）");
        }
    } catch (eP) { rep("  （找上一次快照失败：" + clean(eP) + "）"); }

    if (prevText) {
        /* 从两份报告里各抽一行行 "V/H  id=NNN  path"，然后逐条比对 */
        function parseEyes(txt) {
            var m = {};
            var ls = ("" + txt).split(/[\r\n]+/);
            for (var i = 0; i < ls.length; i++) {
                var mm = /^\s*([VH])\s+id=(-?\d+)\s+(.*)$/.exec(ls[i]);
                if (mm) m[mm[2]] = { vis: (mm[1] === "V"), path: mm[3] };
            }
            return m;
        }
        var prev = parseEyes(prevText);
        var nowMap = {};
        for (var q = 0; q < all.length; q++) nowMap["" + all[q].id] = { vis: all[q].vis, path: all[q].path };

        var turnedOn = [], turnedOff = [], goneL = [], newL = [];
        for (var kk in nowMap) {
            if (!prev[kk]) { newL.push(nowMap[kk].path); continue; }
            if (nowMap[kk].vis && !prev[kk].vis) turnedOn.push(nowMap[kk].path);
            if (!nowMap[kk].vis && prev[kk].vis) turnedOff.push(nowMap[kk].path);
        }
        for (var kk2 in prev) { if (!nowMap[kk2]) goneL.push(prev[kk2].path); }

        rep("  ★ 眼睛从【关】变【开】（= 被打开）的层：" + turnedOn.length + " 个");
        for (var t1 = 0; t1 < turnedOn.length && t1 < 30; t1++) rep("      + " + turnedOn[t1]);
        rep("  ★ 眼睛从【开】变【关】的层：" + turnedOff.length + " 个");
        for (var t2 = 0; t2 < turnedOff.length && t2 < 30; t2++) rep("      - " + turnedOff[t2]);
        rep("  被删掉的层：" + goneL.length + " 个");
        rep("  新增的层：" + newL.length + " 个");
        for (var t3 = 0; t3 < newL.length && t3 < 20; t3++) rep("      + " + newL[t3]);
        rep("");
        if (turnedOn.length === 0 && turnedOff.length === 0) {
            rep("  ✔ 结论：没有任何图层的眼睛被改动。");
            rep("     （画面颜色变化是【删除隐藏层】本身造成的，不是眼睛被打开）");
        } else {
            rep("  ★ 结论：确实有眼睛被改了 —— 上面列出的就是被改动的层，");
            rep("     把这些路径发给我即可定位原因。");
        }
    }

    rep("（本诊断只读，不改任何图层属性。）");
    flush();
}

try { main(); } catch (eMain) {
    rep("整体出错：" + clean(eMain));
    flush();
}

})();