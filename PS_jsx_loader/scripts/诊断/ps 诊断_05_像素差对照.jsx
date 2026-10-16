#target photoshop
/* ==========================================================================
 * 诊断_05_像素差对照
 * --------------------------------------------------------------------------
 * 对应步骤：05 合并带蒙版的图层
 *
 * 用户实测：用「ps 选择层空对象合并.jsx」（参考脚本，= 正确答案）跑同一层，
 *           和 ps 05 跑出来的结果像素颜色相差很大。
 *
 * 本诊断要回答的核心问题：
 *   ★ "空对象合并"（目标层 + 下方空层，然后 Mrg2）到底有没有把蒙版烤进像素？
 *     合并之后，目标层的【图层蒙版还在不在】？
 *
 *   如果合并后蒙版【还在层上】：
 *     那么 ps 05 的 deleteLeftoverMask=true 会把蒙版删掉 ——
 *     被蒙版遮住的部分会整片显现出来 → 画面自然"相差很大"。
 *     而参考脚本不删蒙版 → 画面不变 → 它是"正确答案"。
 *
 * 对每个候选层做（每步都量：单独显示该层时的 非零像素数 / 灰度均值 / 蒙版状态）：
 *   ① 原始状态
 *   ② 建空层 + 挪到目标下方（量：目标变了吗）
 *   ③ Mrg2 向下合并（量：结果层像素 = 目标？还是目标+空层？蒙版还在吗）
 *   ④ 若还在：把蒙版删掉（量：像素变成多少 —— 看"删蒙版"是不是元凶）
 *   ⑤ 历史回退
 *
 * 只读 + 全部历史回退。报告：%TEMP%\psjsx_05_pixdiff.txt
 * ========================================================================== */

var REPORT = [];
var REPORT_FILE = "psjsx_05_pixdiff.txt";

function rep(s) { REPORT.push(s); }
function clean(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 160); } catch (e) { return "" + s; } }
function flush() {
    var out = REPORT.join("\n");
    try { var f = File(Folder.temp.fsName + "/" + REPORT_FILE); f.open("w"); f.write(out + "\n"); f.close(); } catch (e) {}
    return out;
}
function finish(h) {
    try { flush(); } catch (e) {}
    var path = ""; try { path = File(Folder.temp.fsName + "/" + REPORT_FILE).fsName; } catch (e2) { path = "?"; }
    try { alert((h ? h + "\n\n" : "") + "报告：\n" + path); } catch (e3) {}
}
function cid(k) { try { return charIDToTypeID(k); } catch (e) { return false; } }
function sid(k) { try { return stringIDToTypeID(k); } catch (e) { return false; } }
function getId(L) { try { return L.id; } catch (e) { return -1; } }
function isGroup(L) { try { return (L.typename === "LayerSet"); } catch (e) { return false; } }
function nameOf(L) { try { return L.name; } catch (e) { return "?"; } }
function isClipped(L) { try { return (L.grouped === true); } catch (e) { return false; } }
function kindOf(L) { try { return ("" + L.kind); } catch (e) { return "?"; } }
function now() { return (new Date()).getTime(); }
function ms(t0) { return Math.round((now() - t0) / 100) / 10; }

function walk(doc, fn) {
    (function rec(c) {
        var a = null; try { a = c.layers; } catch (e) { return; }
        if (!a) return;
        for (var i = 0; i < a.length; i++) { fn(a[i]); if (isGroup(a[i])) rec(a[i]); }
    })(doc);
}
function byIdIn(doc, id) { var f = null; walk(doc, function (L) { if (!f && getId(L) === id) f = L; }); return f; }
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
function hs(doc) { try { return doc.activeHistoryState; } catch (e) { return null; } }
function back(doc, h) { try { if (h) { doc.activeHistoryState = h; return true; } } catch (e) {} return false; }

/* 这一层上有哪些蒙版（用布尔键判断，不用"键存在"） */
function maskInfo(doc, id) {
    var L = byIdIn(doc, id);
    if (!L) return "层不存在";
    var d = null;
    try {
        var ref = new ActionReference();
        ref.putProperty(cid("Prpr"), cid("null"));
        ref.putIdentifier(cid("Lyr "), id);
        d = executeActionGet(ref);
    } catch (e) { return "读不到描述符"; }
    if (!d) return "读不到描述符";
    var out = [];
    try { var k = sid("hasUserMask"); if (k !== false && d.hasKey(k) && d.getBoolean(k) === true) out.push("图层蒙版"); } catch (e1) {}
    try { var k2 = sid("hasVectorMask"); if (k2 !== false && d.hasKey(k2) && d.getBoolean(k2) === true) out.push("矢量蒙版"); } catch (e2) {}
    if (out.length === 0) return "无蒙版";
    return out.join("+");
}

/* 像素指纹：只显示这一层，量非零像素数 / 灰度均值 / 灰度和 */
function fp(doc, id) {
    var h = hs(doc);
    var hidden = [];
    var res = { px: -1, avg: -1, sum: -1 };
    try {
        var T = byIdIn(doc, id);
        if (!T) return res;
        walk(doc, function (L) {
            if (getId(L) === id) return;
            var v = true; try { v = (L.visible !== false); } catch (e) { v = true; }
            if (v) { hidden.push(L); try { L.visible = false; } catch (e2) {} }
        });
        try { if (T.visible === false) T.visible = true; } catch (e3) {}
        var hist = doc.histogram;
        var px = 0, sum = 0;
        for (var i = 1; i < hist.length; i++) { if (hist[i] > 0) { px += hist[i]; sum += hist[i] * i; } }
        res.px = px; res.sum = sum;
        res.avg = (px > 0) ? (Math.round(sum / px * 100) / 100) : 0;
    } catch (e) { }
    for (var k = 0; k < hidden.length; k++) { try { hidden[k].visible = true; } catch (e4) {} }
    if (h) back(doc, h);
    return res;
}

function describe(doc, id) {
    return "id=" + id + "　蒙版=" + maskInfo(doc, id) + "　非零像素=" + fp(doc, id).px +
           "　均值=" + fp(doc, id).avg;
}

/* 挑一个"带蒙版的普通层" */
function pickTarget(doc) {
    var out = null;
    walk(doc, function (L) {
        if (out) return;
        if (isGroup(L)) return;
        var d = null;
        try {
            var ref = new ActionReference();
            ref.putProperty(cid("Prpr"), cid("null"));
            ref.putIdentifier(cid("Lyr "), getId(L));
            d = executeActionGet(ref);
        } catch (e) { return; }
        if (!d) return;
        var hasU = false, hasV = false;
        try { var k = sid("hasUserMask"); if (k !== false && d.hasKey(k)) hasU = (d.getBoolean(k) === true); } catch (e1) {}
        try { var k2 = sid("hasVectorMask"); if (k2 !== false && d.hasKey(k2)) hasV = (d.getBoolean(k2) === true); } catch (e2) {}
        if (hasU || hasV) out = L;
    });
    return out;
}

function deleteUserMask() {
    try {
        var ref = new ActionReference();
        ref.putEnumerated(cid("Chnl"), cid("Chnl"), cid("Msk "));
        var d = new ActionDescriptor();
        d.putReference(cid("null"), ref);
        executeAction(cid("Dlt "), d, DialogModes.NO);
        return true;
    } catch (e) { return false; }
}

function main() {
    rep("诊断_05_像素差对照 —— " + (new Date()).toString());
    if (app.documents.length === 0) { rep("没有打开的文档"); flush(); return; }
    var doc = app.activeDocument;
    rep("文档：" + doc.name + "　模式=" + doc.mode + "　位深=" + doc.bitsPerChannel);
    rep("");
    rep("核心问题：空对象合并后，蒙版【还在不在层上】？");
    rep("  · 若【还在】→ ps 05 的 deleteLeftoverMask=true 会把它删掉，");
    rep("               被遮住的像素整片显现 → 画面相差很大（元凶找到了）");
    rep("  · 若【不在】→ 说明合并确实把蒙版烤进像素了，那要往别处查");
    rep("");

    var T = pickTarget(doc);
    if (!T) {
        rep("★ 这份文档里找不到「带蒙版的普通层」。");
        rep("  请在【还没跑过 05】的原始文件上跑这个诊断。");
        finish("像素差对照：无可测目标");
        return;
    }
    var tid = getId(T);
    rep("=== 实验目标 ===");
    rep("  「" + nameOf(T) + "」(id=" + tid + "，kind=" + kindOf(T) + "，剪贴=" + (isClipped(T) ? "是" : "否") + ")");
    rep("");
    rep("=== ① 原始状态 ===");
    var f0 = fp(doc, tid);
    rep("  " + describe(doc, tid));
    rep("");

    var h = hs(doc);
    var emptyId = -1;

    /* ② 建空层 + 挪到目标下方 */
    rep("=== ② 建空层并挪到目标正下方 ===");
    try {
        if (!selectById(tid)) throw new Error("选不中目标");
        var empty = doc.artLayers.add();
        try { emptyId = getId(doc.activeLayer); } catch (eA) {}
        if (emptyId < 0) { try { emptyId = getId(empty); } catch (eA2) {} }
        var moved = false;
        try { empty.move(byIdIn(doc, tid), ElementPlacement.PLACEAFTER); moved = true; } catch (eM) {}
        rep("  空层 id=" + emptyId + "　move " + (moved ? "未抛错" : "★抛错"));
        rep("  目标：" + describe(doc, tid));
        rep("  （目标像素应该和①一样：建空层+挪位不该改变目标）");
    } catch (e2) { rep("  ★ 抛错：" + clean(e2)); }
    rep("");

    /* ③ Mrg2 */
    rep("=== ③ Mrg2 向下合并（目标 + 空层）===");
    var afterMergeId = -1;
    try {
        if (!selectById(tid)) throw new Error("合并前选不中目标");
        executeAction(cid("Mrg2"), new ActionDescriptor(), DialogModes.NO);
        try { afterMergeId = getId(doc.activeLayer); } catch (eA3) {}
        rep("  Mrg2 未抛错　结果层 id=" + afterMergeId);
    } catch (e3) { rep("  ★ Mrg2 抛错：" + clean(e3)); }
    if (afterMergeId >= 0) {
        var f3 = fp(doc, afterMergeId);
        rep("  结果层：" + describe(doc, afterMergeId));
        rep("  目标旧 id 还在？ " + (byIdIn(doc, tid) ? "★在" : "不在"));
        rep("");
        rep("  ★★ 关键判定 ★★");
        rep("    ①原始  非零=" + f0.px + "　均值=" + f0.avg);
        rep("    ③合并后 非零=" + f3.px + "　均值=" + f3.avg);
        rep("    像素数" + (f3.px === f0.px ? "相同" : ("变化 " + (f3.px - f0.px))) +
            "　均值" + (f3.avg === f0.avg ? "相同" : ("变化 " + (Math.round((f3.avg - f0.avg) * 100) / 100))));
        rep("    合并后蒙版：" + maskInfo(doc, afterMergeId));
        var mk = maskInfo(doc, afterMergeId);
        if (mk.indexOf("图层蒙版") >= 0) {
            rep("    → ★ 蒙版【还在层上】！说明 Mrg2 没把蒙版烤进像素。");
            rep("      而 ps 05 的 deleteLeftoverMask=true 会删掉它 → 被遮住的像素整片显现 → 画面大变。");
            rep("      这就解释了「颜色相差很大」。");
        } else {
            rep("    → 蒙版已经不在了，说明合并确实把蒙版烤进了像素。");
        }
        rep("");

        /* ④ 删蒙版（只在还在的时候） */
        if (mk.indexOf("图层蒙版") >= 0) {
            rep("=== ④ 把残留图层蒙版删掉（= ps 05 的 deleteLeftoverMask）===");
            var f4;
            var okDel = deleteUserMask();
            rep("  删蒙版 " + (okDel ? "成功" : "★失败"));
            f4 = fp(doc, afterMergeId);
            rep("  删后：" + describe(doc, afterMergeId));
            rep("  ★ 对比：③合并后 非零=" + f3.px + " 均值=" + f3.avg +
                "　→ ④删蒙版后 非零=" + f4.px + " 均值=" + f4.avg);
            if (f4.px !== f3.px || f4.avg !== f3.avg) {
                rep("  ★★ 删蒙版确实改变了像素 → 这就是「相差很大」的直接原因！");
            }
            rep("");
        }
    }

    back(doc, h);
    rep("历史回退：" + (back(doc, h) ? "成功" : "失败"));
    rep("");
    rep("== 结论与修法 ==");
    rep("  · 若③显示蒙版还在层上：说明「目标 + 空层」的 Mrg2 合成【没有】把蒙版算进像素。");
    rep("    修法二选一：");
    rep("      (a) 先『应用图层蒙版』（把蒙版烤成像素）再合并 —— 但本机 applyLayerMask 命令不可用，");
    rep("          可以用『把蒙版载入为选区 -> 反选 -> 删除选区内容』来等价实现；");
    rep("      (b) 合并后【不要】删蒙版（deleteLeftoverMask=false），");
    rep("          让 AE 那边靠蒙版继续工作（但这就不是「烘焙」了）。");
    rep("  · 若③显示蒙版已不在、且像素和①不一样：问题在别处，把报告发我。");
    rep("");
    rep("（本诊断只读；所有改动都按历史回退。）");
    finish("像素差对照：已测完");
}

try { main(); } catch (eMain) {
    rep("整体出错：" + clean(eMain));
    try { rep("（行 " + eMain.line + "）"); } catch (e2) {}
    finish("像素差对照：出错");
}