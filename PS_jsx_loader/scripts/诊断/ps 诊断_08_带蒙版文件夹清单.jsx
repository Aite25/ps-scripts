#target photoshop
/* ==========================================================================
 * 诊断_08_带蒙版文件夹清单（只读）
 * --------------------------------------------------------------------------
 * 用途：快速找出"哪些文件里有【带蒙版的文件夹】"，用来验证
 *       ps 06 提取蒙版 -> ps 07 输出 op -> ae 08 设亮度遮罩 这条通路。
 *
 * 只读：不修改文档、不改图层、不建任何东西。
 *
 * 会列出：
 *   · 每个【图层组(LayerSet)】是否带 图层蒙版 / 矢量蒙版
 *   · 它在文档里的路径
 *   · ps 06 是否已经为它生成了黑白图（名字 = 文件夹名 + " mask"，在它上方）
 *   · 顺带统计"剪贴蒙版图层位于文件夹上方"的段（clipAboveFolder）有多少
 *
 * 报告：%TEMP%\psjsx_08_maskedfolders.txt
 * ========================================================================== */

(function () {

var REPORT = [];
var FILE = "psjsx_08_maskedfolders.txt";
function rep(s) { REPORT.push(s); }
function clean(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 200); } catch (e) { return "" + s; } }
function flush() {
    var out = REPORT.join("\n"), path = "";
    try {
        var f = File(Folder.temp.fsName + "/" + FILE);
        f.encoding = "UTF-8"; f.open("w"); f.write(out + "\n"); f.close();
        path = f.fsName;
    } catch (e) { path = "(写失败 " + e + ")"; }
    try { alert("带蒙版文件夹清单：已扫完\n\n报告：\n" + path); } catch (e2) {}
}
function cid(k) { try { return charIDToTypeID(k); } catch (e) { return false; } }
function sid(k) { try { return stringIDToTypeID(k); } catch (e) { return false; } }
function isGroup(L) { try { return (L.typename === "LayerSet"); } catch (e) { return false; } }
function nameOf(L) { try { return L.name; } catch (e) { return "?"; } }
function isVis(L) { try { return (L.visible !== false); } catch (e) { return true; } }
function isClip(L) { try { return (L.grouped === true); } catch (e) { return false; } }
function getId(L) { try { return L.id; } catch (e) { return -1; } }
function descOf(L) {
    try {
        var r = new ActionReference();
        r.putIdentifier(cid("Lyr "), getId(L));
        return executeActionGet(r);
    } catch (e) { return null; }
}
function keyTrue(d, k) {
    try {
        if (!d) return false;
        var sk = sid(k);
        if (sk === false || !d.hasKey(sk)) return false;
        return (d.getBoolean(sk) === true);
    } catch (e) { return false; }
}

var doc = null;
var folders = [];      /* 带蒙版的文件夹 */
var allFolders = 0;
var clipSegs = [];     /* 剪贴层位于文件夹上方的段 */
var maskDonors = [];   /* 名字以 " mask" 结尾的普通图层 */

function walk(container, pathPrefix, depth) {
    if (depth > 40) return;
    var arr = null; try { arr = container.layers; } catch (e) { return; }
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
        var L = arr[i];
        var nm = nameOf(L);
        var p = (pathPrefix ? (pathPrefix + " / ") : "") + nm;

        if (isGroup(L)) {
            allFolders++;
            var hu = keyTrue(descOf(L), "hasUserMask");
            var hv = keyTrue(descOf(L), "hasVectorMask");
            if (hu || hv) {
                /* 看它正上方（数组前面）的兄弟层里有没有「文件夹名 + " mask"」 */
                var donorNames = [];
                for (var k = i - 1; k >= 0; k--) {
                    var s = arr[k];
                    if (isGroup(s)) break;
                    var sn = nameOf(s);
                    if (sn.length > nm.length + 1 && sn.substring(0, nm.length + 5) === (nm + " mask")) {
                        donorNames.push(sn);
                    }
                }
                folders.push({
                    name: nm, path: p,
                    user: hu, vector: hv,
                    visible: isVis(L),
                    donors: donorNames
                });
            }
            walk(L, p, depth + 1);
            continue;
        }

        /* 收集"mask"结尾的普通图层 */
        var ln = nm;
        if (ln.length >= 5 && ln.substring(ln.length - 5) === " mask") {
            maskDonors.push(p);
        } else if (ln.length > 5 && ln.substring(ln.length - 6, ln.length - 1) === " mask" && /[0-9]$/.test(ln)) {
            maskDonors.push(p);
        }

        /* 剪贴段：连续的剪贴层后面紧跟一个文件夹 */
        if (isClip(L)) {
            var ids = [], kk = i;
            while (kk < arr.length && isClip(arr[kk])) { ids.push(nameOf(arr[kk])); kk++; }
            if (kk < arr.length && isGroup(arr[kk])) {
                clipSegs.push({ path: p, clipNames: ids, folderName: nameOf(arr[kk]) });
            }
            i = kk - 1;
        }
    }
}

function main() {
    rep("诊断_08_带蒙版文件夹清单 —— " + (new Date()).toString());
    if (app.documents.length === 0) { rep("★ 没有打开的文档"); flush(); return; }
    doc = app.activeDocument;
    rep("文档：" + doc.name + "　" + doc.width + "x" + doc.height);
    rep("");

    walk(doc, "", 0);

    rep("========== 结果 ==========");
    rep("图层组总数：" + allFolders);
    rep("★ 带蒙版的文件夹：" + folders.length + " 个");
    rep("剪贴层位于文件夹上方的段：" + clipSegs.length + " 段");
    rep("名字以「 mask」结尾的普通图层：" + maskDonors.length + " 个");
    rep("");

    rep("---------- 带蒙版的文件夹明细 ----------");
    if (folders.length === 0) {
        rep("  （没有）—— 这个文件不能用来验证 folderMask 通路");
    } else {
        for (var i = 0; i < folders.length; i++) {
            var f = folders[i];
            rep("  [" + (i + 1) + "] 「" + f.name + "」");
            rep("      路径：" + f.path);
            rep("      蒙版：图层蒙版=" + (f.user ? "有" : "无") + "　矢量蒙版=" + (f.vector ? "有" : "无") +
                "　可见=" + (f.visible ? "是" : "否"));
            rep("      ps 06 的黑白图：" + (f.donors.length ? f.donors.join(" / ") : "★ 还没有（需要先跑 ps 06）"));
        }
    }
    rep("");

    rep("---------- 剪贴段明细 ----------");
    if (clipSegs.length === 0) {
        rep("  （没有）");
    } else {
        for (var j = 0; j < clipSegs.length; j++) {
            var c = clipSegs[j];
            rep("  [" + (j + 1) + "] 文件夹「" + c.folderName + "」，剪贴层 " + c.clipNames.length + " 个：" +
                c.clipNames.join(" | "));
        }
    }
    rep("");

    rep("---------- 单看「 mask」结尾的图层 ----------");
    if (maskDonors.length === 0) rep("  （没有）");
    else for (var m = 0; m < maskDonors.length; m++) rep("  · " + maskDonors[m]);
    rep("");

    rep("== 怎么用 ==");
    rep("  1. 如果上面「带蒙版的文件夹」> 0，这个文件就能验证 folderMask 通路。");
    rep("  2. 如果「ps 06 的黑白图」显示 ★ 还没有，先跑 ps 06 提取蒙版，再跑 ps 07、ae 08。");
    rep("  3. 如果「带蒙版的文件夹」= 0，换一个文件再扫。");

    flush();
}

try { main(); } catch (eM) {
    rep("整体出错：" + clean(eM));
    try { rep("（行 " + eM.line + "）"); } catch (e2) {}
    flush();
}

})();
