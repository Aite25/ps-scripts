// ===========================================================================
// ps 测试_多选与选区索引
// ---------------------------------------------------------------------------
// 用途：验证两件事
//   ① 现在的"读选区"用 itemIndex 递归查找，在【有文件夹】的文档里会不会拿错层
//   ② 多选到底能不能成（顶层 vs 文件夹内），三种 slct 写法分别得到几层
//
// 用法：文件 > 脚本 > 浏览 -> 选本文件。跑完弹窗显示结果。
//      会【改变选区】，但不会改动任何图层内容。
// ===========================================================================

(function () {

/* ★ 启动探针 + 顶层 try/catch：
   之前没有顶层保护，任何 API 报错都会被 CEP 的 runScript 吞掉（表现为"点了没反应"）。
   现在：一进脚本就写探针文件；任何异常都会写进探针并弹窗。
   探针：%TEMP%\psjsx_diag_probe.txt */
var __probePath = "";
try { __probePath = Folder.temp.fsName + "/psjsx_diag_probe.txt"; } catch (ePP) { __probePath = ""; }
function __probe(s) {
    if (!__probePath) return;
    try {
        var f = File(__probePath);
        f.encoding = "UTF-8";
        if (f.open("a")) { try { f.write("[" + (new Date()).toString() + "] " + s + "\n"); } finally { try { f.close(); } catch (c0) {} } }
    } catch (e) {}
}
try {
    if (__probePath) {
        var __pf = File(__probePath);
        __pf.encoding = "UTF-8";
        if (__pf.open("w")) { try { __pf.write("===== 开始 =====\n"); } finally { try { __pf.close(); } catch (c1) {} } }
    }
} catch (eP0) {}
__probe("脚本已开始执行");
try {
    __probe("文档数=" + app.documents.length + "，活动文档=" + (app.documents.length ? app.activeDocument.name : "无"));
} catch (ePA) {}

try {

var doc = app.activeDocument;
var OUT = [];
function p(s) { OUT.push(s); }

function cT(k) { try { return charIDToTypeID(k); } catch (e) { return 0; } }
function sT(k) { try { return stringIDToTypeID(k); } catch (e) { return 0; } }

/* ---------------- 读选区（返回 id 和 index 两种） ---------------- */
function readSelection() {
    var out = [];
    try {
        var ref = new ActionReference();
        ref.putProperty(sT("property"), sT("targetLayers"));
        ref.putEnumerated(sT("document"), sT("ordinal"), sT("targetEnum"));
        var d = executeActionGet(ref);
        if (!d.hasKey(sT("targetLayers"))) return out;
        var lst = d.getList(sT("targetLayers"));
        for (var i = 0; i < lst.count; i++) {
            var r = lst.getReference(i);
            var gotId = -1, gotIdx = -1;
            try { gotId = r.getIdentifier(); } catch (e1) { gotId = -1; }
            try { gotIdx = r.getIndex() + 1; } catch (e2) { gotIdx = -1; }
            out.push({ id: gotId, idx: gotIdx });
        }
    } catch (e) {}
    return out;
}

function countSelection() { return readSelection().length; }

/* ---------------- 按 itemIndex 递归找（现有脚本的做法） ---------------- */
function byIndexWalk(root, index) {
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

/* ---------------- 按 id 精确找 ---------------- */
function byIdWalk(root, id) {
    function rec(node) {
        for (var i = 0; i < node.layers.length; i++) {
            var L = node.layers[i];
            try { if (L.id === id) return L; } catch (e2) {}
            if (L.typename === "LayerSet") { var R = rec(L); if (R) return R; }
        }
        return null;
    }
    return rec(root);
}

function pathOf(L) {
    var out = [], a = L, g = 0;
    while (a && g < 32) {
        g++;
        try {
            var pr = a.parent;
            if (!pr || pr === doc) break;
            out.unshift("" + pr.name);
            a = pr;
        } catch (e) { break; }
    }
    return (out.length ? out.join("/") : "（顶层）");
}

function describe(id) {
    var L = byIdWalk(doc, id);
    if (!L) return "id=" + id + "（找不到）";
    return "id=" + id + "  「" + L.name + "」  父级=" + pathOf(L) + "  itemIndex=" + L.itemIndex;
}

/* ---------------- 三种 slct 写法 ---------------- */
function trySelect(ids, form) {
    var desc = new ActionDescriptor();
    var list = new ActionList();
    for (var i = 0; i < ids.length; i++) {
        var r = new ActionReference();
        r.putIdentifier(cT("Lyr "), ids[i]);
        list.putReference(r);
    }
    /* ★ 写法 C（ref.putList）已删除：ActionReference 根本没有 putList 方法，
       调它会抛「refC.putList 不是函数」。三种写法里只有 A / B 是真的。 */
    if (form === "A") {
        /* 目标 = 当前图层（Lyr/Ordn/Trgt） */
        var refA = new ActionReference();
        refA.putEnumerated(cT("Lyr "), cT("Ordn"), cT("Trgt"));
        desc.putReference(cT("null"), refA);
        desc.putList(cT("Lyr "), list);
    } else if (form === "F") {
        /* ★★★ 最可能的正确写法：目标用 putClass("Lyr ") ★★★ */
        var refF = new ActionReference();
        refF.putClass(cT("Lyr "));
        desc.putReference(cT("null"), refF);
        desc.putList(cT("Lyr "), list);
    } else if (form === "D") {
        /* ★ 目标 = 文档（Dcmn/Ordn/Trgt）—— 多选可能应该用这个 */
        var refD = new ActionReference();
        refD.putEnumerated(cT("Dcmn"), cT("Ordn"), cT("Trgt"));
        desc.putReference(cT("null"), refD);
        desc.putList(cT("Lyr "), list);
    } else if (form === "E") {
        /* 目标 = 文档类（putClass） */
        var refE = new ActionReference();
        try { refE.putClass(cT("Dcmn")); } catch (eE1) {}
        desc.putReference(cT("null"), refE);
        desc.putList(cT("Lyr "), list);
    } else { /* B */
        desc.putList(cT("null"), list);
    }
    try {
        executeAction(cT("slct"), desc, DialogModes.NO);
        return countSelection();
    } catch (e) {
        return "异常(" + e + ")";
    }
}

/* ===================== 跑测试 ===================== */
p("===== 多选测试 =====");
p("文档：" + doc.name);
p("");

/* ---- 1) 当前选区：index 查找 vs id 查找 ---- */
var sel = readSelection();
p("【1】当前选区共 " + sel.length + " 个：");
for (var i = 0; i < sel.length; i++) {
    p("   · " + describe(sel[i].id));
    var LbyIdx = byIndexWalk(doc, sel[i].idx);
    var n1 = LbyIdx ? LbyIdx.name : "（null）";
    if (sel[i].id < 0) {
        p("     · getIdentifier() 拿不到 id（返回 -1）—— 这个 API 对 targetLayers 不可用，跳过 id 对比");
        p("     · 用 itemIndex 查找得到：「" + n1 + "」  （itemIndex=" + sel[i].idx + "）");
    } else {
        var LbyId = byIdWalk(doc, sel[i].id);
        var n2 = LbyId ? LbyId.name : "（null）";
        if (n1 !== n2) {
            p("     ★★ 索引查找得到「" + n1 + "」，id 查找得到「" + n2 + "」—— 索引查找拿错层了！");
        } else {
            p("     索引/itemIndex 查找与 id 查找一致 ✔");
        }
    }
}
p("");

/* ---- 2) 顶层前两层：三种写法各能选中几层 ---- */
var rootLayers = [];
for (var k = 0; k < doc.layers.length && rootLayers.length < 2; k++) rootLayers.push(doc.layers[k]);
if (rootLayers.length >= 2) {
    var idsRoot = [rootLayers[0].id, rootLayers[1].id];
    p("【2】顶层前两层：");
    p("   · 「" + rootLayers[0].name + "」 / 「" + rootLayers[1].name + "」");
    /* 写法 C 不存在，跳过 */
    p("   写法 A（目标=当前图层）-> 选中 " + trySelect(idsRoot, "A") + " 层");
    p("   写法 F（putClass Lyr）-> 选中 " + trySelect(idsRoot, "F") + " 层    ← ★");
    p("   写法 D（目标=文档 Dcmn）-> 选中 " + trySelect(idsRoot, "D") + " 层");
    p("   写法 E（目标=文档 putClass）-> 选中 " + trySelect(idsRoot, "E") + " 层");
    p("   写法 B（desc.putList(\"null\")）-> 选中 " + trySelect(idsRoot, "B") + " 层");
} else {
    p("【2】顶层不足 2 层，跳过");
}
p("");

/* ---- 3) 文件夹内的两层：三种写法 ---- */
var folder = null;
for (var f = 0; f < doc.layers.length && !folder; f++) {
    if (doc.layers[f].typename === "LayerSet") folder = doc.layers[f];
}
if (folder && folder.layers.length >= 2) {
    var idsIn = [folder.layers[0].id, folder.layers[1].id];
    p("【3】文件夹「" + folder.name + "」内的前两层：");
    p("   · 「" + folder.layers[0].name + "」 / 「" + folder.layers[1].name + "」");
    /* 写法 C 不存在，跳过 */
    p("   写法 A（目标=当前图层）-> 选中 " + trySelect(idsIn, "A") + " 层");
    p("   写法 F（putClass Lyr）-> 选中 " + trySelect(idsIn, "F") + " 层    ← ★");
    p("   写法 D（目标=文档 Dcmn）-> 选中 " + trySelect(idsIn, "D") + " 层");
    p("   写法 E（目标=文档 putClass）-> 选中 " + trySelect(idsIn, "E") + " 层");
    p("   写法 B  -> 选中 " + trySelect(idsIn, "B") + " 层");
} else {
    p("【3】没有找到含 ≥2 层的文件夹，跳过");
}
p("");

/* ---- 4) 剪贴层 + 它的基底（就是你遇到的情况） ---- */
var clipped = null, itsBase = null;
function findClipped(node) {
    for (var i = 0; i < node.layers.length; i++) {
        var L = node.layers[i];
        try {
            if (L.typename === "ArtLayer" && L.grouped === true) {
                /* 往下找基底 */
                var arr = node.layers;
                for (var j = i + 1; j < arr.length; j++) {
                    if (arr[j].grouped === true) continue;
                    clipped = L; itsBase = arr[j];
                    return true;
                }
            }
        } catch (e) {}
        if (L.typename === "LayerSet") { if (findClipped(L)) return true; }
    }
    return false;
}
if (findClipped(doc)) {
    p("【4】剪贴层 + 基底（你遇到的那一对）：");
    p("   · 剪贴层「" + clipped.name + "」");
    p("   · 基底  「" + itsBase.name + "」");
    p("   父级：剪贴层=" + pathOf(clipped) + "　基底=" + pathOf(itsBase));
    var idsPair = [clipped.id, itsBase.id];
    /* 写法 C 不存在，跳过 */
    p("   写法 A（目标=当前图层）-> 选中 " + trySelect(idsPair, "A") + " 层");
    p("   写法 F（putClass Lyr）-> 选中 " + trySelect(idsPair, "F") + " 层    ← ★");
    p("   写法 D（目标=文档 Dcmn）-> 选中 " + trySelect(idsPair, "D") + " 层");
    p("   写法 E（目标=文档 putClass）-> 选中 " + trySelect(idsPair, "E") + " 层");
    p("   写法 B  -> 选中 " + trySelect(idsPair, "B") + " 层");
} else {
    p("【4】文档里没有剪贴蒙版层，跳过");
}

p("");
p("===== 结束（选区已被改变，图层内容未动）=====");

var txt = OUT.join("\n");
/* 同时写日志，方便复制 */
try {
    var f2 = File(Folder.temp.fsName + "/psjsx_multiselect_test.txt");
    f2.encoding = "UTF-8";
    if (f2.open("w")) { try { f2.write(txt + "\n"); } finally { try { f2.close(); } catch (c) {} } }
} catch (eW) {}

alert(txt + "\n\n日志：%TEMP%\\psjsx_multiselect_test.txt");

} catch (eAll) {
    __probe("★ 出错：" + eAll);
    try { __probe("  行号：" + eAll.line); } catch (eL) {}
    var __m = "诊断脚本出错：\n\n" + eAll;
    try { __m += "\n\n行号：" + eAll.line; } catch (eL2) {}
    __m += "\n\n探针文件：\n" + (__probePath || "（拿不到 TEMP 路径）");
    try { alert(__m); } catch (eA) {}
}
})();
