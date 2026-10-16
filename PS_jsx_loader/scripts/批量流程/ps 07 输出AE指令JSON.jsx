#target photoshop
/* ==========================================================================
 * ps 07 输出 AE 指令 JSON
 * --------------------------------------------------------------------------
 * 这一步【不再烘焙文件夹结构】（那样很慢、破坏性又大）。
 * 它只做"读 + 摆位"：把 AE 导入这份 psd/psb 时需要做的操作写成一份 JSON，
 * 由配套的 AE 脚本读这份 JSON 去执行。
 *
 * ps 里做 4 件事：
 *   ① 找出所有【带蒙版的文件夹】-> 记进 JSON（AE 那边给对应合成设遮罩）
 *   ② 把【文件夹上方的剪贴蒙版图层】复制一份：
 *        · 副本放到【原有剪贴层的最上方】（必须放上方！因为给副本取消剪贴状态时，
 *          会影响它下面紧挨着的那个剪贴层，所以要先离开原来的位置）
 *        · 副本【取消剪贴蒙版状态】（AE 导入时会直接无视文件夹上方的剪贴层，
 *          必须有一个"不剪贴"的版本让 AE 能看见）
 *        · 副本【关闭显示】（保证 PS 内看到的画面完全不变）
 *        · 记进 JSON（AE 那边把它打开，并设 Preserve Underlying Transparency）
 *   ③ 记录文件夹图层的【图层样式完整参数】-> 写进 JSON
 *   ④ 输出 JSON 到【文档同级】：<原名>_ae.json
 *
 * 约定：IIFE 隔离 / 进度条不写 preferredSize / 启动块在文件末尾 /
 *       ES3 安全（不用 filter/map/forEach、数组 indexOf）/ 永不删 __对比 图层 /
 *       批处理钩子 / 支持"停止信号"中止 / 日志每行落盘。
 * ========================================================================== */

(function () {

/* ==========================================================================
 * 一、JSON 序列化（ExtendScript 是 ES3，没有内置 JSON 对象）
 * ========================================================================== */

/* 文档色彩模式 -> RGB / CMYK / GRAY 这样的短名 */
function cleanDocMode(m) {
    var s = "" + m;
    var i = s.lastIndexOf(".");
    if (i >= 0) s = s.substring(i + 1);
    s = s.replace(/^\s+|\s+$/g, "");
    return s;
}
/* 文档位深：优先用 ActionManager 读 depth，读不到再退回 doc.bitsPerChannel */
function readBitsPerChannel() {
    try {
        var d = new ActionDescriptor(), r = new ActionReference();
        r.putProperty(cid("Prpr"), cid("Dpth"));
        r.putEnumerated(cid("Dcmn"), cid("Ordn"), cid("Trgt"));
        d.putReference(cid("null"), r);
        var res = executeAction(cid("getd"), d, DialogModes.NO);
        if (res.hasKey(cid("Dpth"))) {
            var dv = res.getInteger(cid("Dpth"));
            if (dv === 1 || dv === 8) return 8;
            if (dv === 16) return 16;
            if (dv === 32) return 32;
            return dv;
        }
    } catch (e) {}
    try {
        var b = DOC.bitsPerChannel;
        if (b !== null && b !== undefined) {
            var n = Number(b);
            if (!isNaN(n) && n > 0) return n;
        }
    } catch (e2) {}
    return 8;
}

function jsonStr(s) {
    var out = '"';
    var t = "" + s;
    for (var i = 0; i < t.length; i++) {
        var c = t.charAt(i);
        var code = t.charCodeAt(i);
        if (c === '"') out += '\\"';
        else if (c === '\\') out += '\\\\';
        else if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else if (code < 32) {
            var hx = code.toString(16);
            while (hx.length < 4) hx = "0" + hx;
            out += "\\u" + hx;
        } else out += c;
    }
    return out + '"';
}

function jsonNum(n) {
    var v = Number(n);
    if (isNaN(v) || !isFinite(v)) return "null";
    if (Math.round(v) === v) return "" + Math.round(v);
    return "" + v;
}

function jsonObj(o) {
    if (o === null || o === undefined) return "null";
    var ty = typeof o;
    if (ty === "string") return jsonStr(o);
    if (ty === "number") return jsonNum(o);
    if (ty === "boolean") return o ? "true" : "false";
    if (o instanceof Array) {
        var a = [];
        for (var i = 0; i < o.length; i++) a.push(jsonObj(o[i]));
        return "[" + a.join(",") + "]";
    }
    var parts = [];
    for (var k in o) {
        if (!o.hasOwnProperty(k)) continue;
        if (o[k] === undefined) continue;
        parts.push(jsonStr(k) + ":" + jsonObj(o[k]));
    }
    return "{" + parts.join(",") + "}";
}

/* ==========================================================================
 * 二、ActionDescriptor -> 普通对象（图层样式等描述符靠它序列化）
 * ========================================================================== */
function DVT() {
    var d = {};
    function g(name, fallback) {
        try { var v = DescValueType[name]; return (v === undefined || v === null) ? fallback : v; } catch (e) { return fallback; }
    }
    d.INTEGER = g("INTEGERTYPE", 1);
    d.DOUBLE = g("DOUBLETYPE", 2);
    d.UNITDOUBLE = g("UNITDOUBLETYPE", 3);
    d.STRING = g("STRINGTYPE", 4);
    d.BOOLEAN = g("BOOLEANTYPE", 5);
    d.LIST = g("LISTTYPE", 6);
    d.OBJECT = g("OBJECTTYPE", 7);
    d.CLASS = g("CLASSTYPE", 8);
    d.ENUMERATED = g("ENUMERATEDTYPE", 9);
    d.ALIAS = g("ALIASTYPE", 10);
    d.RAW = g("RAWTYPE", 11);
    return d;
}
var T = DVT();

function descValueToObj(desc, key, T) {
    try {
        var ty = desc.getType(key);
        if (ty === T.INTEGER) return desc.getInteger(key);
        if (ty === T.DOUBLE) return desc.getDouble(key);
        if (ty === T.UNITDOUBLE) {
            var u = desc.getUnitDoubleValue(key);
            var ut = "";
            try { ut = typeIDToStringID(desc.getUnitDoubleType(key)); } catch (e0) {}
            return { _unit: ut, value: u };
        }
        if (ty === T.STRING) return desc.getString(key);
        if (ty === T.BOOLEAN) return desc.getBoolean(key);
        if (ty === T.LIST) {
            var lst = desc.getList(key);
            var arr = [];
            for (var i = 0; i < lst.count; i++) arr.push(listItemToObj(lst, i, T));
            return arr;
        }
        if (ty === T.OBJECT) return descToObj(desc.getObjectValue(key), T);
        if (ty === T.CLASS) {
            var cn = ""; try { cn = typeIDToStringID(desc.getClass(key)); } catch (e1) {}
            return { _class: cn };
        }
        if (ty === T.ENUMERATED) {
            var v = "", vt = "";
            try { v = typeIDToStringID(desc.getEnumerationValue(key)); } catch (e2) {}
            try { vt = typeIDToStringID(desc.getEnumerationType(key)); } catch (e3) {}
            return { _enum: v, _enumType: vt };
        }
        if (ty === T.ALIAS) return "" + desc.getPath(key);
        if (ty === T.RAW) return { _raw: "(未序列化)" };
        try { return "" + desc.getString(key); } catch (e9) {}
        return null;
    } catch (e) { return { _err: cleanMsg("" + e) }; }
}

function listItemToObj(lst, i, T) {
    try {
        var ty = lst.getType(i);
        if (ty === T.INTEGER) return lst.getInteger(i);
        if (ty === T.DOUBLE) return lst.getDouble(i);
        if (ty === T.UNITDOUBLE) {
            var u = lst.getUnitDoubleValue(i);
            var ut = "";
            try { ut = typeIDToStringID(lst.getUnitDoubleType(i)); } catch (e0) {}
            return { _unit: ut, value: u };
        }
        if (ty === T.STRING) return lst.getString(i);
        if (ty === T.BOOLEAN) return lst.getBoolean(i);
        if (ty === T.LIST) {
            var sub = lst.getList(i);
            var arr = [];
            for (var k = 0; k < sub.count; k++) arr.push(listItemToObj(sub, k, T));
            return arr;
        }
        if (ty === T.OBJECT) return descToObj(lst.getObjectValue(i), T);
        if (ty === T.CLASS) {
            var cn = ""; try { cn = typeIDToStringID(lst.getClass(i)); } catch (e1) {}
            return { _class: cn };
        }
        if (ty === T.ENUMERATED) {
            var v = "", vt = "";
            try { v = typeIDToStringID(lst.getEnumerationValue(i)); } catch (e2) {}
            try { vt = typeIDToStringID(lst.getEnumerationType(i)); } catch (e3) {}
            return { _enum: v, _enumType: vt };
        }
        if (ty === T.ALIAS) return "" + lst.getPath(i);
        if (ty === T.RAW) return { _raw: "(未序列化)" };
        try { return "" + lst.getString(i); } catch (e9) {}
        return null;
    } catch (e) { return { _err: cleanMsg("" + e) }; }
}

function descToObj(desc, T) {
    var o = {};
    try {
        for (var i = 0; i < desc.count; i++) {
            var key = desc.getKey(i);
            var kn = "";
            try { kn = typeIDToStringID(key); } catch (e0) { kn = "" + key; }
            if (!kn) kn = "key" + i;
            o[kn] = descValueToObj(desc, key, T);
        }
    } catch (e) { o._err = cleanMsg("" + e); }
    return o;
}

/* ==========================================================================
 * 三、工具 / 选项
 * ========================================================================== */
var OPTIONS = {
    askOptions: true,
    rememberOptions: true,
    // 复制"文件夹上方的剪贴蒙版图层"时，副本名加这个前缀（方便 AE 那边和 PS 里辨认）
    copyPrefix: "__AE_",
    // 记录文件夹图层样式（完整参数）
    recordFolderFx: true,
    // 建差值对比层（验证画面没被改动）
    makeDiffLayer: true,
    diffName: "__对比 07-AE指令前(差值)"
};
var PREF_NAME = "ps_07_输出AE指令JSON_选项.txt";

/* ★★ 镜像文件夹结构的根名字（模块级常量）★★
   为什么放模块级：它既要在 doWorkInner() 里用（建镜像结构），
   又要在文件的启动块里用（写 JSON 的 mirrorRootName、写日志/弹窗）。
   之前声明在 doWorkInner() 里，启动块够不到 -> "MIRROR_NAME 未定义"（行 1183）。 */
var MIRROR_NAME = "__AE_结构";
/* 镜像根图层对象（doWorkInner 里赋值，启动块里读它做汇报） */
var MIRROR_ROOT = null;
/* ★ 遮罩源文件夹副本的名字前缀（用户要求"加个标识符"）：
   AE 端按这个前缀就能一眼认出"哪一层是拿来当遮罩的文件夹"。 */
var MIRROR_MASK_PREFIX = "__AE_遮罩_";
/* 镜像构建过程的日志（建了哪些文件夹、关灯成功没有），启动块里要打印出来 */
var mirrorCreatedLog = [];
/* 镜像里被复制的遮罩源文件夹副本，名字沿用原文件夹名（不加前缀） */

var DOC = null;
var PB = { win: null, bar: null, txt: null, n: 0, total: 1, cancel: false };
var LOG = { f: null, path: "" };
var R = {
    folders: 0, foldersWithMask: 0, copies: 0, fx: 0, failed: [],
    notes: [], elapsed: 0, abort: false
};

function cleanMsg(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 200); } catch (e) { return "" + s; } }
function cid(k) { try { return charIDToTypeID(k); } catch (e) { return false; } }
function sid(k) { try { return stringIDToTypeID(k); } catch (e) { return false; } }
function getId(L) { try { return L.id; } catch (e) { return -1; } }
function isGroup(L) { try { return (L.typename === "LayerSet"); } catch (e) { return false; } }
function safeName(L) { try { return L.name; } catch (e) { return "?"; } }
function isVisible(L) { try { return (L.visible !== false); } catch (e) { return true; } }
function isClipped(L) { try { return (L.grouped === true); } catch (e) { return false; } }
function nowMs() { return (new Date()).getTime(); }
/* ★★ 把窗口放到指定屏幕 + 分上下两层（Windows 默认会把弹窗丢到主屏，而且会互相盖住）★★
 * 实现在同目录的「_共享 窗口位置.jsx」里，【不做任何探测】—— 只读手工写的
 *     %TEMP%\psjsx_screen_manual.txt   内容：left,top,width,height
 * 这里只负责按需加载一次并调用。
 *
 * ★ 分两层（解决"ps 00_single 的进度条被子步骤的进度条盖住"）：
 *     外层运行器（ps 00 / ps 00_single）调用时传 isRunner=true -> 放【上 1/3】
 *     批处理里的子步骤（PSJSX_BATCH=true）                    -> 放【下 1/3】
 *     单独跑某个步骤                                          -> 放【上 1/3】
 * ★ 拿不到屏幕设置就返回 false，窗口按系统默认位置显示 —— 绝不影响弹窗本身。 */
function placeWindowOnHostScreen(w, isRunner) {
    try {
        if (typeof $.global.PSJSX_placeWindow !== "function") {
            var p = null;
            try {
                var raw = "" + $.fileName;
                var here = null;
                try { here = File(raw); } catch (eA) { here = null; }
                if (!here || !here.exists) { try { here = File(decodeURI(raw)); } catch (eB) { here = null; } }
                if (here && here.parent) p = here.parent.fsName + "/_共享 窗口位置.jsx";
            } catch (e0) { p = null; }
            if (p) {
                var f = File(p);
                if (f.exists) { try { $.evalFile(f); } catch (eE) {} }
            }
        }
        if (typeof $.global.PSJSX_placeWindow === "function") return $.global.PSJSX_placeWindow(w, isRunner === true);
    } catch (e) {}
    return false;
}


function batchOn() { try { return ($.global.PSJSX_BATCH === true); } catch (e) { return false; } }

function walk(container, fn) {
    var arr = null; try { arr = container.layers; } catch (e) { return; }
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) { fn(arr[i]); if (isGroup(arr[i])) walk(arr[i], fn); }
}
function byId(id) { var f = null; walk(DOC, function (L) { if (!f && getId(L) === id) f = L; }); return f; }
function pathOf(L) {
    var parts = [], cur = L, guard = 0;
    try {
        while (cur && guard < 60) {
            var nm = safeName(cur);
            if (nm === "") break;
            if (cur.typename === "Document") break;
            parts.unshift(nm);
            cur = cur.parent;
            guard++;
        }
    } catch (e) {}
    return parts.join(" / ");
}

/* 描述符 */
function descOf(L) {
    if (!L) return null;
    try {
        var ref = new ActionReference();
        ref.putProperty(cid("Prpr"), cid("null"));
        ref.putIdentifier(cid("Lyr "), getId(L));
        return executeActionGet(ref);
    } catch (e) {
        try {
            var r2 = new ActionReference();
            r2.putIdentifier(cid("Lyr "), getId(L));
            return executeActionGet(r2);
        } catch (e2) { return null; }
    }
}
function keyTrue(d, k) {
    try { var kk = sid(k); if (kk === false) return false; return d.getBoolean(kk) === true; } catch (e) { return false; }
}
/* ★ 全局规则：调整图层不处理 */
function isAdjustment(L) {
    var d = descOf(L);
    if (!d) return false;
    try { var kt = cid("type"); if (kt !== false && d.hasKey(kt)) return (d.getInteger(kt) === 2); } catch (e1) {}
    try { var kk = sid("layerKind"); if (kk !== false && d.hasKey(kk)) return (d.getInteger(kk) === 2); } catch (e2) {}
    return false;
}
function hasUserMask(L) { var d = descOf(L); if (!d) return false; return keyTrue(d, "hasUserMask"); }
function hasVectorMask(L) { var d = descOf(L); if (!d) return false; return keyTrue(d, "hasVectorMask"); }

function selectById(id) {
    try {
        var d = new ActionDescriptor(), r = new ActionReference();
        r.putIdentifier(cid("Lyr "), id);
        d.putReference(cid("null"), r);
        d.putBoolean(cid("MkVs"), false);
        executeAction(cid("slct"), d, DialogModes.NO);
        return true;
    } catch (e) {
        try { var L = byId(id); if (L) { DOC.activeLayer = L; return true; } } catch (e2) {}
        return false;
    }
}
/* 说明：本脚本【没有】"解除剪贴"的函数 —— 这是故意的。
   实测：Dgrp 在本 PS 版本"当前不可用"，而直接写 grouped 会牵连同一条剪贴链上的
   其它图层（把原始剪贴层也解除剪贴，导致画面损坏）。
   现在改用"副本放进 __AE_jsonCopies 文件夹"来天然获得不剪贴状态，
   全程一个字节的剪贴标志都不写。 */
/* 图层样式描述符（没有样式返回 null） */
function layerEffectsOf(L) {
    var d = descOf(L);
    if (!d) return null;
    try {
        var k = sid("layerEffects");
        if (k === false || !d.hasKey(k)) return null;
        return d.getObjectValue(k);
    } catch (e) { return null; }
}

/* 进度条 */
function pbOpen(title, total) {
    if (batchOn()) return;
    if (typeof Window === "undefined") return;
    try {
        PB.win = new Window("palette", title);
        PB.win.orientation = "column";
        PB.win.alignChildren = "fill";
        PB.txt = PB.win.add("statictext", undefined, "准备中…");
        PB.bar = PB.win.add("progressbar", undefined, 0, (total > 0 ? total : 1));
        try { placeWindowOnHostScreen(PB.win); } catch (ePL) {}
        PB.win.show();
        PB.total = (total > 0 ? total : 1);
        PB.n = 0; PB.cancel = false;
    } catch (e) { PB.win = null; }
}
function pbStep(msg) {
    checkStopFlag();
    if (!PB.win) return;
    PB.n++;
    try { PB.bar.value = (PB.n > PB.total ? PB.total : PB.n); PB.txt.text = msg; PB.win.update(); } catch (e) {}
}
function pbClose() { if (!PB.win) return; try { PB.win.close(); } catch (e) {} PB.win = null; }
function pbCancelled() {
    if (!PB.cancel) return false;
    if (PB.txt) { try { PB.txt.text = "已收到中止请求，正在收尾…"; PB.win.update(); } catch (eT) {} }
    return true;
}

/* 停止信号（外部文件） */
function stopFlagPath() { try { return Folder.temp.fsName + "/psjsx_STOP.txt"; } catch (e) { return ""; } }
function clearStopFlag() { try { var p = stopFlagPath(); if (p) { var f = File(p); if (f.exists) f.remove(); } } catch (e) {} }
function checkStopFlag() {
    try { var p = stopFlagPath(); if (!p) return false; var f = File(p); if (f.exists) { PB.cancel = true; return true; } } catch (e) {}
    return false;
}

/* ==========================================================================
 * 四、核心：扫描 + 复制 + 收集 JSON
 * ========================================================================== */

/* ==========================================================================
 * ★ 给 AE 用的"图层结构定位"信息
 * --------------------------------------------------------------------------
 * 为什么需要：AE 导入 psd/psb 时会【无视剪贴蒙版图层】，
 *   所以 AE 里的图层 index 跟 PS 里的 index 对不上（少了那些剪贴层）。
 *   而且合成可以重名（工程里就有两个「名字」合成），单靠名字定位不可靠。
 *
 * 所以给每一段记录：
 *   folder.containerPath      从文档根到【包含该文件夹的那一层】的文件夹名链
 *   folder.containerChain     同一件事，但记成数组（更好在 AE 里逐步走）
 *   folder.indexInContainer   PS 里"名字"文件夹在它所在容器里的 index（1 = 最上面）
 *   clippedBelowFolder        该容器里，位于"名字"文件夹【下方】的剪贴层数量
 *   targetIndexInAE           换算后的 AE index（用来定副本落点）
 *
 * PS 的 index 规则：数组中【越靠前 = 越上面 = index 越大】。
 *   PS index = container.layers.length - k   （k 是数组下标）
 * AE 的 index 规则：1 = 最上面那一层。
 *   因为 AE 丢了剪贴层，所以 AE index 会比 PS index 小 —— 详见下面注释。
 * ========================================================================== */
function pathArrayOf(folderNames) {
    /* folderNames 是已经有顺序的数组，直接返回副本 */
    var out = [];
    for (var i = 0; i < folderNames.length; i++) out.push(folderNames[i]);
    return out;
}
function pathStringOf(folderNames) {
    var out = [];
    for (var i = 0; i < folderNames.length; i++) out.push(folderNames[i]);
    return out.join(" / ");
}

/* 递归扫描整个文档，收集：
 *   - 带蒙版的文件夹（folders）
 *   - 文件夹上方的剪贴蒙版图层（clipAboveFolder）
 * 判定"文件夹上方的剪贴蒙版图层"：在某一层级里，一个连续的 grouped 序列，
 * 紧跟在它们下面的是 LayerSet（文件夹）。 */
/* ★ 由文件夹的 path 推出【容器链】（= path 去掉最后一段）。
 * path 形如 "标题 / 标题 / CN 烟火邀星河 / 名字"，容器链就是前面那些。 */
function containerChainOf(path) {
    var parts = ("" + path).split(" / ");
    if (parts.length > 0) parts.pop();
    return parts;
}

/* ★ 找 ps 06 生成的"文件夹蒙版黑白图"图层名。
 * ps 06 的约定（见 ps 06 注释）：图层名 = 文件夹名 + " mask"，重名会加 " 2"、" 3"…
 * 所以这里按 "文件夹名 mask" 精确匹配，以及 "文件夹名 mask N" 前缀匹配。 */
function findMaskLayerNames(folderName) {
    var out = [];
    var prefix = folderName + " mask";
    try {
        walk(DOC, function (L) {
            if (isGroup(L)) return;                 /* 黑白图是普通图层，不是文件夹 */
            var n = safeName(L);
            if (n === prefix) { out.push(n); return; }
            if (n.length > prefix.length && n.substring(0, prefix.length + 1) === prefix + " ") out.push(n);
        });
    } catch (e) {}
    return out;
}

function scanDoc() {
    var res = { folders: [], clipAboveFolder: [] };
    (function rec(container, pathPrefix, depth, folderNames) {
        if (depth > 40) return;
        var arr = null; try { arr = container.layers; } catch (e) { return; }
        if (!arr) return;

        /* 逐层看 */
        for (var i = 0; i < arr.length; i++) {
            var L = arr[i];
            var nm = safeName(L);
            if (nm.length >= 4 && nm.substring(0, 4) === "__对比") continue;
            if (nm.length >= 6 && nm.substring(0, 6) === "__AE_") continue;   // 本脚本自己生成的副本

            if (isGroup(L)) {
                /* ★★ 所有文件夹都记下来（不管有没有蒙版）★★
                   踩过的坑：用户报「概率提升原来黑 拷贝」这个文件夹的图层样式没被设置。
                   原因：老逻辑只记录【带蒙版的文件夹】，没蒙版的文件夹其样式直接被漏掉。
                   而 AE 导入 PSD 时【不会带上图层组的图层样式】，
                   所以每个文件夹的样式都必须靠 JSON 记录、在 AE 里重新加上。
                   这里把每个文件夹的：蒙版情况 + 有没有样式，都记下来；
                   后面只对"有蒙版"或"有样式"的文件夹产出 op。 */
                var hu0 = hasUserMask(L);
                var hv0 = hasVectorMask(L);
                var hasFx0 = false;
                try { hasFx0 = (layerEffectsOf(L) ? true : false); } catch (eFx0) {}
                res.folders.push({
                    id: getId(L),
                    name: nm,
                    path: (pathPrefix ? (pathPrefix + " / ") : "") + nm,
                    hasUserMask: hu0,
                    hasVectorMask: hv0,
                    hasStyles: hasFx0,
                    visible: isVisible(L)
                });
                /* 递归进去 */
                var fn2 = folderNames ? folderNames.slice(0) : [];
                fn2.push(nm);
                rec(L, (pathPrefix ? (pathPrefix + " / ") : "") + nm, depth + 1, fn2);
                continue;
            }

            /* 剪贴层：检查它往下（数组后面）是不是跟着一个文件夹 */
            if (isClipped(L)) {
                /* 收集这一整段连续的剪贴层 */
                var clipIds = [];
                var k = i;
                while (k < arr.length && isClipped(arr[k])) {
                    var cn = safeName(arr[k]);
                    if (!(cn.length >= 4 && cn.substring(0, 4) === "__对比") &&
                        !(cn.length >= 6 && cn.substring(0, 6) === "__AE_")) {
                        clipIds.push(getId(arr[k]));
                    }
                    k++;
                }
                if (k < arr.length && isGroup(arr[k])) {
                    /* ★ 这一整段剪贴层的基底的【文件夹】 -> 就是"文件夹上方的剪贴蒙版图层" */
                    var base = arr[k];
                    var baseIdxArray = k;                       /* 数组下标（0 = 最上面） */
                    var psIndex = arr.length - baseIdxArray;    /* PS 的 index（1 = 最上面） */
                    /* 容器里位于"名字"文件夹【下方】的剪贴层数量；
                       以及容器里所有图层的名字（AE 里 can 用来核对结构） */
                    var clipBelow = 0;
                    var contNames = [];
                    for (var ci = 0; ci < arr.length; ci++) {
                        var cnm = safeName(arr[ci]);
                        contNames.push(cnm);
                    }
                    for (var cj = k + 1; cj < arr.length; cj++) {
                        var isClipCj = false;
                        try { isClipCj = (arr[cj].grouped === true); } catch (eCC2) {}
                        if (isClipCj) clipBelow++;
                    }
                    /* ★ AE 里丢掉的是【剪贴层】，所以 AE index = PS index - 该容器里剪贴层的总数
                       （剪贴层无论在上方还是下方都会被 AE 丢掉，这里用总数最稳） */
                    var clipTotalInCont = 0;
                    for (var ck = 0; ck < arr.length; ck++) {
                        var isClipCk = false;
                        try { isClipCk = (arr[ck].grouped === true); } catch (eCC3) {}
                        if (isClipCk) clipTotalInCont++;
                    }
                    var aeIndexCalc = psIndex - (clipTotalInCont - baseIdxArray);
                    if (aeIndexCalc < 1) aeIndexCalc = 1;

                    res.clipAboveFolder.push({
                        clipIds: clipIds,
                        folderId: getId(base),
                        folderName: safeName(base),
                        folderPath: (pathPrefix ? (pathPrefix + " / ") : "") + safeName(base),
                        parentPath: pathPrefix,
                        depth: depth,
                        firstIndex: i,
                        /* ===== ★ 给 AE 用的结构定位信息 ===== */
                        /* 从文档根到【包含该文件夹的那一层】的文件夹名链
                           （AE 里可以用它一层层走进去，不依赖可能重名的合成名） */
                        containerChain: (folderNames ? folderNames.slice(0) : []),
                        containerPath: pathStringOf(folderNames ? folderNames : []),
                        /* PS 里"名字"文件夹在它所在容器里的 index（1 = 最上面） */
                        psIndexInContainer: psIndex,
                        psIndexArrayPos: baseIdxArray,
                        /* 换算后的 AE index（要减去被 AE 丢掉的剪贴层） */
                        aeIndexInContainer: aeIndexCalc,
                        /* 容器里剪贴层的数量（上+下）与"下方"的数量，便于以后核对 */
                        clipCountInContainer: clipTotalInCont,
                        clipCountBelowFolder: clipBelow,
                        /* 容器的完整图层名清单（从上到下），AE 端可用来核对结构 */
                        containerLayersTopDown: contNames
                    });
                }
                i = k - 1;      /* 跳过这一段（for 循环会 i++） */
                continue;
            }
        }
    })(DOC, "", 0, []);
    return res;
}

/* 复制一段剪贴层里指定的那些图层 */
/* ==========================================================================
 * ★★ 复制一个剪贴层（duplicate 版 + 剪贴自动修复）★★
 * --------------------------------------------------------------------------
 * 为什么最终用 duplicate()（而不是 copy()/paste()）：
 *   探针实测（诊断\ps 诊断_07_复制落点探针 / 复制序列探针 / 复制顺序探针）：
 *     · copy()/paste() 会把副本内容【改小】：
 *         图层 11：源 11846x6015 -> 副本 3840x2160（正好画布）
 *         图层 10：源 2072x993   -> 副本 1889x810
 *       取消选区也没用 -> 这条路本身就会破坏内容，弃用。
 *     · duplicate() 不丢内容：副本 bounds 的 91px 差异只是"容器相关的报告差异"
 *       （搬走 -> 内缩 91px、搬回原容器 -> 完全恢复；而 move() 不可能改像素）。
 *
 * ★ 但 duplicate() 有一个副作用（也是探针实测）：
 *     复制【紧贴文件夹的那一层】（剪贴链最下面那个）会把
 *     【它上面那些剪贴层】的剪贴状态清掉（grouped true -> false）。
 *     原因：链式剪贴（图层11 剪贴到 图层10、图层10 剪贴到 文件夹），
 *           复制时 PS 在链里临时插入副本，重算了上面的剪贴。
 *
 * ★ 而修复办法也被探针验证有效了：
 *     对被清掉的那层写回 grouped = true -> 完美恢复，且不连带坏别的层。
 *     （ActionManager 的 GrpL 也可以，留作兜底。）
 *
 * 所以流程：duplicate 复制 -> 复制完统一 repairClipState() 修回剪贴状态。
 * ========================================================================== */
function copyOneClipViaDuplicate(srcId, destContainer, copyPrefix, propLogOut) {
    var src = byId(srcId);
    if (!src) { R.failed.push("id=" + srcId + "：找不到源层"); return -1; }
    var srcName = safeName(src);

    /* 1) 复制：优先"直接复制进目标容器"，失败退回"原地复制再搬" */
    var cp = null, err1 = "", err2 = "";
    try {
        cp = src.duplicate(destContainer, ElementPlacement.INSIDE);
    } catch (e1) {
        err1 = cleanMsg("" + e1);
        try {
            cp = src.duplicate(src, ElementPlacement.PLACEBEFORE);
            if (cp && destContainer) {
                try { cp.move(destContainer, ElementPlacement.INSIDE); } catch (eM) { err2 = "move:" + cleanMsg("" + eM); }
            }
        } catch (e2) { err2 = cleanMsg("" + e2); }
    }
    if (!cp) {
        R.failed.push(srcName + "：复制失败（" + (err1 || err2 || "无返回") + "）");
        return -1;
    }

    /* 2) ★★ 显式还原图层属性（不透明度/填充不透明度/混合模式）★★
        用户反馈过"图层 11 的不透明度没还原"。逐项写回并回读核对。 */
    var propLog = [];
    function restoreProp(label, getter, setter) {
        var sv = null, cv = null;
        try { sv = getter(src); } catch (eG) { return; }
        if (sv === null || sv === undefined) return;
        try { setter(cp, sv); } catch (eS) { propLog.push(label + " 写回失败：" + cleanMsg("" + eS)); return; }
        try { cv = getter(cp); } catch (eG2) {}
        propLog.push(label + " " + sv + " -> " + cv + (("" + sv) === ("" + cv) ? " ✔" : " ★不一致"));
    }
    restoreProp("不透明度", function (L) { return L.opacity; }, function (L, v) { L.opacity = v; });
    restoreProp("填充不透明度", function (L) { return L.fillOpacity; }, function (L, v) { L.fillOpacity = v; });
    /* 混合模式必须传【原始枚举值】，不能传字符串（否则报"应为枚举值"） */
    restoreProp("混合模式", function (L) { return L.blendMode; }, function (L, v) { L.blendMode = v; });

    /* 3) 像素位置：duplicate 不会改内容，这里只记录一下（不强行 translate） */
    try {
        var sb = src.bounds, cb = cp.bounds;
        propLog.push("像素位置 源=" + sb + " 副本=" + cb + (("" + sb) === ("" + cb) ? " ✔一致" : " （容器相关差异，内容未变）"));
    } catch (eB) { propLog.push("像素位置读不到：" + cleanMsg("" + eB)); }

    /* 4) 改名 + 关灯（保证 PS 内画面完全不变） */
    try { cp.name = copyPrefix + srcName; } catch (eN) {}
    try { cp.visible = false; } catch (eV) {}

    if (propLogOut) {
        try { propLogOut.push("· 复制：" + srcName + " -> " + safeName(cp) + "　【属性核对】" + propLog.join("；")); } catch (eO) {}
    }
    return getId(cp);
}

/* ==========================================================================
 * ★★ 修复被复制动作清掉的剪贴状态 ★★
 * --------------------------------------------------------------------------
 * items: [{ id: 图层id, name: 名字, wasClip: 复制前是不是剪贴状态 }]
 * 对每一项：如果现在的 grouped 和复制前不一样，就写回复制前的值。
 * 探针实测：写回 grouped = true 能完美恢复，且不连带坏别的层。
 * 返回修复说明数组（写日志用）。
 * ========================================================================== */
function repairClipState(items) {
    var log = [];
    if (!items) return log;
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var L = byId(it.id);
        if (!L) { log.push("★「" + it.name + "」找不到了，无法核对剪贴"); continue; }
        var now = false;
        try { now = (L.grouped === true); } catch (eN) {}
        if (now === (it.wasClip === true)) continue;      /* 没被改，跳过 */
        var ok = false, errMsg = "";
        try {
            L.grouped = (it.wasClip === true);
            try { ok = ((L.grouped === true) === (it.wasClip === true)); } catch (eC) {}
        } catch (eW) { errMsg = cleanMsg("" + eW); }
        log.push("· 修复剪贴：「" + it.name + "」" + now + " -> " + (it.wasClip === true) +
                 (ok ? " ✔已修复" : (" ★修复失败" + (errMsg ? ("（" + errMsg + "）") : ""))));
    }
    return log;
}


/* ==========================================================================
 * 四·补、结构安全网（踩过的坑）
 * --------------------------------------------------------------------------
 * 用户反馈：07 跑完"画面损坏"，看起来是取消剪贴时打到了不该动的图层。
 * 所以：
 *   ① 动手【之前】把全文档每个图层的 id -> {剪贴, 显示} 记下来
 *   ② 收尾再记一次，逐条比对
 *   ③ 只要发现【原有图层】的剪贴/显示被改了 -> 报警并列出改动（并提示 Ctrl+Z）
 *   ④ 整批包进【一个】历史步骤，出问题 Ctrl+Z 一次全撤
 * ========================================================================== */
var SAFE_BASE = null;
/* ★★ 必须【全文档递归】遍历：
       踩过的坑 —— 原来的版本只 dump 了 DOC.layers（顶层），
       而"文件夹上方的剪贴层"大多嵌在子文件夹里，
       所以深层图层被改了根本查不出来，安全网形同虚设。 */
function safeWalkAll(container, fn) {
    var arr = null; try { arr = container.layers; } catch (e) { return; }
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
        fn(arr[i]);
        try { if (arr[i].typename === "LayerSet") safeWalkAll(arr[i], fn); } catch (e2) {}
    }
}
function safeSnap() {
    var m = {};
    safeWalkAll(DOC, function (L) {
        var id = getId(L);
        if (id < 0) return;
        var clip = false, vis = true, grp = false;
        try { clip = (L.grouped === true); } catch (e1) {}
        try { vis = (L.visible !== false); } catch (e2) {}
        try { grp = (L.typename === "LayerSet"); } catch (e3) {}
        var pth = "";
        try { pth = pathOf(L); } catch (e4) {}
        m["" + id] = { clip: clip, vis: vis, name: safeName(L), path: pth, grp: grp };
    });
    return m;
}
/* 返回被改动的原有图层列表（新增的 __AE_ 副本不算） */
function safeVerify(base) {
    var bad = [];
    if (!base) return bad;
    safeWalkAll(DOC, function (L) {
        var id = "" + getId(L);
        if (id === "-1") return;
        var b = base[id];
        if (!b) return;
        var clip = false, vis = true;
        try { clip = (L.grouped === true); } catch (e1) {}
        try { vis = (L.visible !== false); } catch (e2) {}
        var where = b.path ? ("  " + b.path) : "";
        if (clip !== b.clip) {
            bad.push("「" + b.name + "」" + where + "（id=" + id + "）：剪贴 " +
                     (b.clip ? "有" : "无") + " -> " + (clip ? "有" : "无"));
        }
        if (vis !== b.vis) {
            bad.push("「" + b.name + "」" + where + "（id=" + id + "）：显示 " +
                     (b.vis ? "开" : "关") + " -> " + (vis ? "开" : "关"));
        }
    });
    return bad;
}

/* ==========================================================================
 * 五、主流程
 * ========================================================================== */
function doWork() {
    /* ★ 出错必须留痕：doWork 是通过 suspendHistory 的字符串调用跑的，
       一旦抛异常会被 PS 静默吞掉（表现：JSON 里字段莫名缺失、但脚本"成功"）。
       所以这里自己 try/catch，把错误写进日志和 JSON。 */
    try { return doWorkInner(); }
    catch (eDW) {
        var __emsg = "" + eDW;
        var __eline = ""; try { __eline = eDW.line; } catch (eL2) {}
        try { plog("★ doWork 出错：" + cleanMsg(__emsg) + "（行 " + __eline + "）"); } catch (eL3) {}
        R.failed.push("doWork 出错：" + cleanMsg(__emsg) + "（行 " + __eline + "）");
        R.abort = true;
        return { ops: [], scan: { folders: [], clipAboveFolder: [] }, error: cleanMsg(__emsg), errorLine: __eline };
    }
}

/* ==========================================================================
 * ★★ 镜像文件夹结构（用户要求）★★
 * --------------------------------------------------------------------------
 * 目的：让 AE 端"按结构定位"变得简单。
 *
 * 做法：在文档【顶层】新建一个文件夹（名字以 __AE 开头），
 *   在里面按【原文档的文件夹层级】逐层建同名文件夹，
 *   结构一直建到"名字"这一层，然后把副本层放进这个最内层里。
 *   例：
 *     __AE_结构
 *       └── 标题
 *             └── 标题
 *                   └── CN 烟火邀星河
 *                         └── 名字
 *                               ├── __AE_图层 11   （副本）
 *                               └── __AE_图层 10   （副本）
 *
 * 导入 AE 后，这些文件夹都会变成【合成(precomp)】，
 *   AE 端只要进 __AE_结构 这个合成，再按同名层一路走进去，
 *   就能拿到副本 —— 完全不用管原文档里那些重名/剪贴层的干扰。
 *
 * ★ 建完后把顶层那个文件夹【关灯】（不影响 PS 内画面）。
 * ========================================================================== */

/* 在 container 里按名字找一个子文件夹（只找第一层） */
function findChildGroup(container, name) {
    var arr = null; try { arr = container.layers; } catch (e) { return null; }
    if (!arr) return null;
    for (var i = 0; i < arr.length; i++) {
        var L = arr[i];
        if (isGroup(L) && safeName(L) === name) return L;
    }
    return null;
}

/* 在 container 里找或建一条 name 子文件夹路径（names 是数组），返回最内层文件夹 */
function ensureGroupPath(container, names, createdLog) {
    var cur = container;
    for (var i = 0; i < names.length; i++) {
        var nm = names[i];
        if (!nm) continue;
        var child = findChildGroup(cur, nm);
        if (!child) {
            try { child = cur.layerSets.add(); } catch (eAdd) {
                try { if (createdLog) createdLog.push("★ 建文件夹「" + nm + "」失败：" + cleanMsg("" + eAdd)); } catch (e3) {}
                return null;
            }
            try { child.name = nm; } catch (eNm) {}
            /* ★ 每个新建的镜像子文件夹都关灯（PS 里给 LayerSet 写 visible 有时不生效，
               所以建的时候就关一次，等于多一层保险）。 */
            try { child.visible = false; } catch (eVc) {}
            var __cv = true; try { __cv = (child.visible !== false); } catch (eVc2) {}
            if (createdLog) createdLog.push("    建文件夹：" + nm + "　眼睛=" + (__cv ? "★仍开着" : "已关"));
        }
        cur = child;
    }
    return cur;
}

/* 把已经做好的副本（按 id 找）搬进镜像结构的对应最内层文件夹 */
function moveCopiesIntoMirror(mirrorRoot, chain, copyItems, createdLog) {
    if (!mirrorRoot) return 0;
    var inner = ensureGroupPath(mirrorRoot, chain, createdLog);
    if (!inner) { if (createdLog) createdLog.push("  ★ 建镜像路径失败"); return 0; }
    var moved = 0;
    for (var i = 0; i < copyItems.length; i++) {
        var it = copyItems[i];
        var L = byId(it.id);
        if (!L) { if (createdLog) createdLog.push("  ★ 副本 id=" + it.id + " 找不到：" + it.name); continue; }
        try {
            L.move(inner, ElementPlacement.INSIDE);
            moved++;
        } catch (eMv) {
            if (createdLog) createdLog.push("  ★ 副本「" + it.name + "」搬进镜像失败：" + cleanMsg("" + eMv));
        }
    }
    return moved;
}

/* ★★ 复制一个文件夹到指定容器（用 copy()/paste()，不用 duplicate）★★
 * 为什么不用 duplicate：探针实测 duplicate 会触发 PS 重算剪贴关系，
 *   把原始剪贴层解除剪贴（"07 跑完画面损坏"的真凶）。
 * copy()/paste() 不触发重算，所以复制文件夹也走这条。
 * 返回新文件夹的 id，失败返回 -1。 */
/* 说明：这里【故意没有】"复制文件夹"的函数。
   探针（诊断\ps 诊断_07_复制文件夹探针）实测了五种办法，全部不可用：
     · Dplc（三种写法）   -> 会把源文件夹上方的剪贴层解除剪贴（画面损坏）
     · move 源文件夹      -> 报"非法参数"（剪贴链的基底不能移走）
     · 建空文件夹+逐个复制 -> 副本自身报"用户取消了操作"（复制不出来）
   所以最终决定：镜像里不放遮罩源文件夹，AE 端直接用原文档那个文件夹合成。 */

/* 把新文件夹放到 container 的最上方 */
function moveGroupToTop(container, group) {
    try {
        var arr = container.layers;
        if (arr && arr.length > 0 && getId(arr[0]) !== getId(group)) {
            group.move(arr[0], ElementPlacement.PLACEBEFORE);
        }
    } catch (e) {}
}

/* ==========================================================================
 * ★★ 收集"文件夹链上所有文件夹"的图层样式 ★★
 * --------------------------------------------------------------------------
 * 用户反馈：ae08 没有设置成功图层样式。
 * 查日志发现：ps07 只记录了【目标文件夹】（「名字」）的样式，
 *   而日志明确写着"目标文件夹「名字」没有图层样式" -> JSON 里没有样式 -> AE 无样可设。
 *
 * 其实样式可能挂在链路【任意一层】文件夹上（标题 / CN 烟火邀星河 / 名字 …），
 * 所以这里把 containerChain 上每一层 + 目标文件夹自己，全都查一遍，
 * 有的就收集进 JSON（segOp.folderStyles），AE 端逐条还原。
 *
 * 返回 [{ name, path, layerEffects }]，并往 logOut 里写"哪一层有/没有样式"。
 * ========================================================================== */
/* ==========================================================================
 * 图层样式的"眼睛"（勾选）状态
 * --------------------------------------------------------------------------
 * PS 的图层样式里，每个效果都有自己的勾选框（= 眼睛）。用户可能把其中几个关掉，
 * 例如：外发光开着、投影关着、颜色叠加关着。
 *
 * 描述符里对应的字段（实测，见 06 明河卡池图_ae.json）：
 *   · enabled  = 这个效果【勾了没有】   —— 这就是"眼睛"
 *   · present  = 这个效果【在不在样式列表里】
 *   没勾的效果，PS 也会写一整块默认值（present:false / enabled:false），
 *   所以光看"键存不存在"完全判断不出来。
 *
 * 输出规则：只有 enabled=true（且 present 不是 false）的效果，AE 那边才该还原。
 * 这里把这些状态写进日志，方便核对"到底哪些会进 AE"。
 * ========================================================================== */
var FX_CN = {
    scale: "（比例，不是效果）",
    dropShadow: "投影",
    innerShadow: "内阴影",
    outerGlow: "外发光",
    innerGlow: "内发光",
    bevelEmboss: "斜面和浮雕",
    satin: "光泽",
    solidFill: "颜色叠加",
    gradientFill: "渐变叠加",
    patternFill: "图案叠加",
    frameFX: "描边"
};

/* 取一个效果键的"眼睛"状态：返回 { on:true/false, present:true/false } */
function fxEyeOf(fx, key) {
    var res = { on: false, present: false };
    try {
        var v = fx[key];
        if (v === null || v === undefined) return res;
        if (v instanceof Array) {
            for (var q = 0; q < v.length; q++) {
                var e = v[q];
                if (!e || typeof e !== "object") continue;
                if (e.present === true) res.present = true;
                if (e.enabled === true) { res.on = true; res.present = true; break; }
            }
            return res;
        }
        if (typeof v === "object") {
            res.present = (v.present === true);
            res.on = (v.enabled === true);
        }
    } catch (e) {}
    return res;
}

/* 把所有效果的眼睛状态拼成一行：外发光=开 / 投影=关 / … */
function fxEyeLine(fx) {
    var parts = [], onCnt = 0, offCnt = 0;
    try {
        for (var k in fx) {
            if (!fx.hasOwnProperty(k)) continue;
            var norm = ("" + k);
            if (norm.length > 5 && norm.substring(norm.length - 5) === "Multi") norm = norm.substring(0, norm.length - 5);
            var cn = FX_CN[norm] ? FX_CN[norm] : norm;
            if (norm === "scale") continue;                 /* 比例不是效果，不列 */
            var eye = fxEyeOf(fx, k);
            if (eye.on) { parts.push(cn + "=开"); onCnt++; }
            else if (eye.present) { parts.push(cn + "=关"); offCnt++; }
            /* present=false 的连"在样式里"都不算，不列出来，免得刷屏 */
        }
    } catch (e) {}
    if (parts.length === 0) return "（这个样式里没有任何效果是勾上的）";
    return parts.join(" / ") + "　→ 会进 AE 的 " + onCnt + " 个，眼睛关着不进的 " + offCnt + " 个";
}

/* 兼容旧名字（原来只列键名，现在带眼睛状态） */
function keysOfFx(fx) {
    return fxEyeLine(fx);
}
function collectFolderStyles(chain, targetId, targetName, logOut) {
    var out = [];
    var cur = DOC;
    var names = chain ? chain.slice(0) : [];
    for (var i = 0; i < names.length; i++) {
        var nm = names[i];
        var g = findChildGroup(cur, nm);
        if (!g) { logOut.push("  （链路第 " + (i + 1) + " 段「" + nm + "」找不到，跳过）"); break; }
        var fx = layerEffectsOf(g);
        if (fx) {
            var o = descToObj(fx, T);
            out.push({ name: nm, path: names.slice(0, i + 1).join(" / "), layerEffects: o });
            logOut.push("  ✔ 链路第 " + (i + 1) + " 段「" + nm + "」有样式：" + keysOfFx(o));
        } else {
            logOut.push("  · 链路第 " + (i + 1) + " 段「" + nm + "」没有样式");
        }
        cur = g;
    }
    var tgt = byId(targetId);
    if (tgt) {
        var tfx = layerEffectsOf(tgt);
        if (tfx) {
            var to = descToObj(tfx, T);
            out.push({ name: targetName, path: (names.join(" / ") + " / " + targetName), layerEffects: to });
            logOut.push("  ✔ 目标文件夹「" + targetName + "」有样式：" + keysOfFx(to));
        } else {
            logOut.push("  · 目标文件夹「" + targetName + "」没有样式");
        }
    } else {
        logOut.push("  （找不到目标文件夹 id=" + targetId + "）");
    }
    return out;
}

function doWorkInner() {
    if (!DOC) DOC = app.activeDocument;
    /* ★ 这两个是模块级变量（启动块也要读），每次跑都要清一次，
       否则同一进程里跑第二遍会累积上一次的记录。 */
    MIRROR_ROOT = null;
    mirrorCreatedLog = [];
    var t0 = nowMs();

    /* ★★ 开头：清掉上一次跑 07 留下的东西（重复跑不会累积垃圾）★★
       要清理的（都只删【空的】或【名字明确是本脚本产物】的）：
         · __AE_结构        （镜像根，上次留下的）
         · __AE_jsonCopies  （中转文件夹，上次留下的）
         · __probe_*        （诊断探针留下的测试文件夹）
       安全规则：
         · 只处理【文档根级】的（不深入文件夹，免得误删用户的东西）
         · __AE_结构 / __AE_jsonCopies 只在【空的】时候删（万一有内容就保留并关灯）
         · __probe_* 一律删（名字就是探针专用）
         · 顺序：从后往前删，避免数组下标错位 */
    try {
        var rootArr0 = DOC.layers;
        var cleaned = [];
        for (var ci0 = rootArr0.length - 1; ci0 >= 0; ci0--) {
            var L0 = rootArr0[ci0];
            var n0 = safeName(L0);
            if (!isGroup(L0)) continue;
            var isProbe = (n0.length >= 8 && n0.substring(0, 8) === "__probe_");
            var isMine = (n0 === MIRROR_NAME || n0 === "__AE_jsonCopies");
            if (!isProbe && !isMine) continue;
            var cnt0 = -1;
            try { cnt0 = L0.layers.length; } catch (eC0) { cnt0 = -1; }
            if (isProbe || cnt0 === 0) {
                try { L0.remove(); cleaned.push(n0); } catch (eR0) {
                    try { L0.visible = false; } catch (eV0) {}
                    cleaned.push(n0 + "（删不掉，已关灯）");
                }
            } else {
                try { L0.visible = false; } catch (eV1) {}
                cleaned.push(n0 + "（里面有 " + cnt0 + " 层，保留并关灯）");
            }
        }
        if (cleaned.length > 0) R.notes.push("开头清理上次遗留：" + cleaned.join("；"));
    } catch (eClean0) { R.notes.push("开头清理出错：" + cleanMsg("" + eClean0)); }

    var scan = scanDoc();
    var scan = scanDoc();
    R.folders = scan.folders.length;
    /* ★ foldersWithMask 只统计【真的带蒙版】的文件夹（scan.folders 现在包含所有文件夹） */
    var __maskedN = 0, __styleN = 0;
    for (var __fi = 0; __fi < scan.folders.length; __fi++) {
        if (scan.folders[__fi].hasUserMask === true || scan.folders[__fi].hasVectorMask === true) __maskedN++;
        if (scan.folders[__fi].hasStyles === true) __styleN++;
    }
    R.foldersWithMask = __maskedN;
    R.foldersTotal = scan.folders.length;
    R.foldersWithStyles = __styleN;

    R.notes.push("带蒙版的文件夹 " + scan.folders.length + " 个");
    R.notes.push("文件夹上方的剪贴蒙版段 " + scan.clipAboveFolder.length + " 段");

    var totalWork = scan.clipAboveFolder.length + scan.folders.length + 1;
    pbOpen("ps 07 输出 AE 指令 JSON", totalWork);

    var ops = [];

    /* ★ 先建一个 __AE_jsonCopies 文件夹（所有副本都收在这里）。
       作用：① 副本集中、好看好管 ② 文件夹里只有一层 → 天然不剪贴，
       全程不写 grouped（Dgrp 在本 PS 版本不可用）。 */
    var COPY_BOX = null;
    if (scan.clipAboveFolder.length > 0) {
        try {
            COPY_BOX = DOC.layerSets.add();
            COPY_BOX.name = "__AE_jsonCopies";
            /* 放到文档根级最上方 */
            try {
                var rootArr = DOC.layers;
                if (rootArr && rootArr.length > 0 && getId(rootArr[0]) !== getId(COPY_BOX)) {
                    COPY_BOX.move(rootArr[0], ElementPlacement.PLACEBEFORE);
                }
            } catch (eMvBox) {}
            R.notes.push("已建 __AE_jsonCopies 文件夹（id=" + getId(COPY_BOX) + "）放所有副本");
        } catch (eBox) {
            R.failed.push("★ 建 __AE_jsonCopies 文件夹失败：" + cleanMsg("" + eBox));
            COPY_BOX = null;
        }
    }

    /* ==========================================================================
     * ★★ 镜像文件夹结构（用户要求）★★
     * --------------------------------------------------------------------------
     * 顶层建一个文件夹（名字带 __AE 前缀），里面按【原文档的文件夹层级】逐层建同名文件夹，
     * 一直建到要处理的"名字"那一层；然后把
     *   · 标记出来的剪贴蒙版图层的【副本】放在最上面
     *   · 要当遮罩源的【文件夹副本】放在它们【下面】
     * 整个镜像树【全部关灯】（不影响 PS 内画面）。
     *
     * 导入 AE 后这些文件夹都变成合成，AE 端进镜像根合成、按同名层走进去即可。
     * ========================================================================== */
    if (scan.clipAboveFolder.length > 0) {
        try {
            MIRROR_ROOT = DOC.layerSets.add();
            /* ★ 名字必须带 __AE 前缀（AE 端按镜像根名找它） */
            try { MIRROR_ROOT.name = MIRROR_NAME; } catch (eMn) {}
            /* 放到文档最上方 */
            moveGroupToTop(DOC, MIRROR_ROOT);
            /* ★ 关灯（用户要求：镜像树的眼镜要关掉，不影响 PS 内画面）。
               注意：PS 里给 LayerSet 写 visible=false 有时不生效，
               所以下面每个新建的子文件夹也都会各自关一次灯。 */
            try { MIRROR_ROOT.visible = false; } catch (eMv1) {}
            var __rootVis = true;
            try { __rootVis = (MIRROR_ROOT.visible !== false); } catch (eRv) {}
            mirrorCreatedLog.push("镜像根「" + MIRROR_NAME + "」id=" + getId(MIRROR_ROOT) +
                                  "　眼睛=" + (__rootVis ? "★仍开着" : "已关"));
            R.notes.push("已建镜像根文件夹「" + MIRROR_NAME + "」（id=" + getId(MIRROR_ROOT) + "）");
        } catch (eMir) {
            R.failed.push("★ 建镜像根文件夹失败：" + cleanMsg("" + eMir));
            MIRROR_ROOT = null;
        }
    }

    /* ---- ① 文件夹 -> JSON
        · 有蒙版  -> kind="folderMask"（AE 给对应合成设【亮度遮罩】）
        · 没蒙版但有图层样式 -> kind="folderStyles"（AE 只还原样式）
        · 都没有  -> 不产出 op ---- */
    for (var i = 0; i < scan.folders.length; i++) {
        if (checkStopFlag() || pbCancelled()) { R.abort = true; break; }
        var f = scan.folders[i];
        var masked = (f.hasUserMask === true) || (f.hasVectorMask === true);
        if (!masked && !f.hasStyles) continue;          /* 没什么可做的，跳过 */
        pbStep("文件夹 " + (i + 1) + "/" + scan.folders.length + "：" + f.name);

        var op = {
            kind: (masked ? "folderMask" : "folderStyles"),
            target: { name: f.name, id: f.id, path: f.path },
            /* ★ 容器链：AE 用它从主合成一层层走进【包含这个文件夹的合成】 */
            containerChain: containerChainOf(f.path),
            /* ★ ps 06 生成的蒙版黑白图图层名（AE 用它当【亮度遮罩】的源） */
            maskLayerNames: findMaskLayerNames(f.name),
            mask: { user: f.hasUserMask, vector: f.hasVectorMask },
            visible: f.visible
        };
        if (masked) {
            if (op.maskLayerNames.length === 0) {
                R.notes.push("· ★ 文件夹「" + f.name + "」有蒙版，但没找到 ps 06 生成的黑白图（名字应为「" + f.name + " mask」）——" +
                             "AE 端会设不上亮度遮罩，请确认跑过 ps 06");
            } else {
                R.notes.push("· 文件夹「" + f.name + "」的蒙版黑白图：" + op.maskLayerNames.join(" / ") +
                             "　容器链：" + (op.containerChain.length ? op.containerChain.join(" / ") : "(文档根)"));
            }
        } else {
            R.notes.push("· 文件夹「" + f.name + "」（无蒙版，只还原图层样式）　容器链：" +
                         (op.containerChain.length ? op.containerChain.join(" / ") : "(文档根)"));
        }

        /* ---- ③ 顺便记录这个文件夹的图层样式 ---- */
        if (OPTIONS.recordFolderFx) {
            var L = byId(f.id);
            var fx = layerEffectsOf(L);
            if (fx) {
                op.layerEffects = descToObj(fx, T);
                R.fx++;
            }
        }
        ops.push(op);
    }
    if (R.abort) return { ops: ops, scan: scan };

    /* ---- ② 复制"文件夹上方的剪贴蒙版图层"---- */
    for (var c = 0; c < scan.clipAboveFolder.length; c++) {
        if (checkStopFlag() || pbCancelled()) { R.abort = true; break; }
        var seg = scan.clipAboveFolder[c];
        pbStep("复制剪贴层 " + (c + 1) + "/" + scan.clipAboveFolder.length + "：" + seg.folderName);

        /* ★ 段内副本清单（循环后要搬进镜像结构） */
        var segCopyItems = [];

        /* ★★ 复制前先记下这一段【所有剪贴层】的 grouped 状态 ★★
           探针实测：复制【紧贴文件夹的那一层】会把上面那些剪贴层的剪贴状态清掉
           （grouped true -> false）。所以复制完要按这份快照修回来。 */
        var clipSnap = [];
        for (var sq = 0; sq < seg.clipIds.length; sq++) {
            var sqL = byId(seg.clipIds[sq]);
            if (!sqL) continue;
            var sqClip = false;
            try { sqClip = (sqL.grouped === true); } catch (eSq) {}
            clipSnap.push({ id: seg.clipIds[sq], name: safeName(sqL), wasClip: sqClip });
        }
        /* 记录这一段的原始信息（AE 那边要"打开副本"，
           所以 JSON 里要写清：副本名、对应哪个文件夹、原来顺序是什么） */
        var segOp = {
            kind: "clipAboveFolder",
            /* ★★ 这里必须带上【定位目标合成】要用的结构字段 ★★
               踩过的坑：AE 引擎用 folder.containerChain 一步步进入目标合成
               （"名字"文件夹所在的那个合成）。原来 clipAboveFolder 的 folder 里
               只有 name/id/path，没有 containerChain -> AE 端 chain 是空数组 ->
               AE_resolveCompByChain 直接失败 -> 整段被跳过（"图层没有复制过去"）。
               这些数据在 seg（scanDoc 的结果）里本来就有，补上即可。 */
            folder: {
                name: seg.folderName,
                id: seg.folderId,
                path: seg.folderPath,
                containerChain: (seg.containerChain ? seg.containerChain.slice(0) : []),
                containerPath: seg.containerPath || "",
                psIndexInContainer: seg.psIndexInContainer,
                aeIndexInContainer: seg.aeIndexInContainer,
                clipCountInContainer: seg.clipCountInContainer,
                clipCountBelowFolder: seg.clipCountBelowFolder,
                containerLayersTopDown: (seg.containerLayersTopDown ? seg.containerLayersTopDown.slice(0) : [])
            },
            originals: [],
            copies: []
        };

        /* 从【最下面那个剪贴层】开始复制（这样每次插到最上方时顺序不会乱），
           但 JSON 里按原顺序（从上到下）记录 */
        for (var q = 0; q < seg.clipIds.length; q++) {
            var srcId = seg.clipIds[q];
            var srcL = byId(srcId);
            if (!srcL) continue;
            var sName = safeName(srcL);
            var sVis = isVisible(srcL);
            segOp.originals.push({ name: sName, id: srcId, visible: sVis });

            /* ★ 用 copy()/paste() 复制（duplicate 会重算剪贴关系、把原始剪贴层解除剪贴） */
            var copyId = copyOneClipViaDuplicate(srcId, COPY_BOX, OPTIONS.copyPrefix, R.notes);
            if (copyId >= 0) {
                R.copies++;
                var cpL = byId(copyId);
                var cpClip = false;
                try { cpClip = (cpL.grouped === true); } catch (eCC) {}
                /* 源的属性（写进 JSON：AE 端需要时也能校正一遍） */
                var srcOpacity = null, srcFill = null, srcBlend = "";
                try { srcOpacity = srcL.opacity; } catch (eSo) {}
                try { srcFill = srcL.fillOpacity; } catch (eSf) {}
                try { srcBlend = "" + srcL.blendMode; } catch (eSb) {}
                segOp.copies.push({
                    /* PS 里给副本起的临时名（带 __AE_ 前缀） */
                    name: safeName(cpL),
                    /* ★ 源图层的属性（AE 端可用来核对/校正） */
                    sourceOpacity: srcOpacity,
                    sourceFillOpacity: srcFill,
                    sourceBlendMode: srcBlend,
                    id: copyId,
                    /* ★ 原名：AE 那边复制过去后要把名字还原成这个 */
                    originalName: sName,
                    sourceName: sName,
                    sourceId: srcId,
                    /* 副本实际落在哪个文件夹里（AE 那边按名字找） */
                    inFolder: "__AE_jsonCopies",
                    visible: false,
                    clipped: cpClip,
                    /* 这一层在"从上到下"的顺序里排第几个（0 = 最上面）；
                       AE 那边按这个顺序把副本摆进目标合成 */
                    orderTopDown: segOp.copies.length,
                    /* 旧字段：现在改成用 alpha 遮罩，不再用 Preserve Underlying Transparency。
                       保留着只是不让旧 JSON 解析出错。 */
                    aePreserveUnderlyingTransparency: false,
                    /* ★ 新方案：给副本设 alpha 遮罩，遮罩层 = 那段对应的文件夹合成 */
                    aeTrackMatte: "alpha",
                    aeTrackMatteSource: "folderComp"
                });
                segCopyItems.push({ id: copyId, name: safeName(cpL) });
            }
        }
        /* ★★ 收集【文件夹链上所有文件夹】的图层样式 ★★
           用户反馈：ae08 没有设置成功图层样式。
           查日志发现：原来只记【目标文件夹】的样式，而它恰好没有样式
           （日志："目标文件夹「名字」没有图层样式"）-> JSON 里没样式 -> AE 无样可设。
           其实样式可能挂在链路【任意一层】上，所以这里整条链都查一遍。 */
        /* ★ 这里【不再】收集"文件夹链上的样式"了 ——
           因为现在 scanDoc 会记录【所有文件夹】（带不带蒙版都记），
           每个有样式的文件夹都会各自产出 kind="folderStyles" 的 op，
           在这里再收一遍会导致同一个样式被应用两次。
           所以 clipAboveFolder 的 op 不再带 folderStyles 字段。 */

        if (segOp.copies.length > 0) ops.push(segOp);

        /* ★★ 复制完立刻修复被清掉的剪贴状态 ★★
           探针实测：写回 grouped = true 能完美恢复，且不连带坏别的层。
           放在"搬进镜像"之前做，保证后续按 id 找层时结构是对的。 */
        try {
            var fixLog = repairClipState(clipSnap);
            for (var fl = 0; fl < fixLog.length; fl++) R.notes.push(fixLog[fl]);
            if (fixLog.length === 0) R.notes.push("· 剪贴状态核对：这一段原始剪贴层都没被改动 ✔");
        } catch (eFix) { R.notes.push("★ 修复剪贴状态出错：" + cleanMsg("" + eFix)); }

        /* ★★ 把这一段做好的东西搬进镜像结构（用户要求）★★
           镜像里的层级（在"名字"这一层里面，从上到下）：
             ① 标记出来的剪贴蒙版图层的【副本】（带 __AE_ 前缀）
             ② 要当遮罩源的【文件夹副本】（放在副本【下面】）
           两个都关灯。 */
        if (MIRROR_ROOT && segCopyItems.length > 0) {
            var chainForMirror = seg.containerChain ? seg.containerChain.slice(0) : [];
            /* containerChain 的最后一段就是"名字"（目标文件夹本身），
               镜像里要建到它，所以整条链都要建。 */
            if (chainForMirror.length === 0) chainForMirror = [seg.folderName];

            /* ==========================================================================
             * ★★ 为什么【不】把遮罩源文件夹复制进镜像 ★★
             * --------------------------------------------------------------------------
             * 用户要求过"把遮罩源文件夹也复制进镜像树，放在剪贴层副本下面"。
             * 但探针（诊断\ps 诊断_07_复制文件夹探针）把五种办法全测了一遍，结论是
             * 【在这个 PS 版本上做不到】，而且都会留下后患：
             *
             *   A. Dplc（from 只给名字）        -> ★ 把源文件夹上方的剪贴层解除了剪贴
             *   B. Dplc（from 完整描述符）      -> ★ 一样坏
             *   F. Dplc（不带 from）            -> ★ 一样坏
             *   G. move 源文件夹进别的文件夹     -> ★ 报"非法参数"（剪贴链基底不能移走）
             *   C/E/H. 建空文件夹+逐个复制子层   -> 源和剪贴层都安全，但副本自身
             *                                     报"用户取消了操作"（复制不出来）
             *
             * 每一次 A/B/F 都会把「图层 11」「图层 10」的剪贴状态从 true 改成 false
             *   —— 这正是用户反馈的"07 动了源文件夹以及其上方的剪贴蒙版图层"。
             *
             * ★ 所以最终方案：镜像里【不放】遮罩源文件夹副本。
             *   AE 端改用【原文档里那个文件夹合成】当遮罩源 ——
             *   反正 AE 导入 psd/psb 时，每个文件夹本来就会生成一个合成，
             *   再复制一份进镜像其实是冗余的。
             *   （引擎里 matteSrcLayer 拿不到时会自动退回用目标合成里的文件夹层，见 ae_lib）
             * ========================================================================== */
            var maskFolderCopyId = -1;   /* 恒为 -1：镜像里没有遮罩源文件夹副本 */
            var maskFolderCopyName = "";

            /* ---- ② 再把剪贴层副本放进去（放在遮罩源文件夹【上面】） ---- */
            var moved = moveCopiesIntoMirror(MIRROR_ROOT, chainForMirror, segCopyItems, mirrorCreatedLog);

            /* ★★ 显式排序 ★★
               用户反馈："图层 11 跟图层 10 的顺序错了"。
               move(container, INSIDE) 的落点（插到最上面还是最下面）在不同情况下不一样，
               所以不能靠"按顺序搬"来保证顺序 —— 这里搬完之后【显式重排一次】：
               目标是从上到下 copy[0]、copy[1]、…（和 PS 里原顺序一致）。
               做法：从最后一个开始，把它移到文件夹的【第一个子层之前】。 */
            try {
                var innerFolder = ensureGroupPath(MIRROR_ROOT, chainForMirror, mirrorCreatedLog);
                if (innerFolder) {
                    var orderLog = [];
                    for (var ri = segCopyItems.length - 1; ri >= 0; ri--) {
                        var rL = byId(segCopyItems[ri].id);
                        if (!rL) continue;
                        var topL = null;
                        try { topL = innerFolder.layers[0]; } catch (eTL) {}
                        if (!topL) continue;
                        if (getId(topL) === getId(rL)) continue;
                        try { rL.move(topL, ElementPlacement.PLACEBEFORE); } catch (eRo) {
                            mirrorCreatedLog.push("    ★ 排序时移动「" + safeName(rL) + "」失败：" + cleanMsg("" + eRo));
                        }
                    }
                    /* 记下最终顺序，方便核对 */
                    try {
                        var fl = innerFolder.layers;
                        for (var fi = 0; fi < fl.length; fi++) {
                            orderLog.push(safeName(fl[fi]) + (fi === 0 ? "（最上面）" : ""));
                        }
                    } catch (eFl) {}
                    mirrorCreatedLog.push("    镜像内层最终顺序（从上到下）：" + orderLog.join(" | "));
                }
            } catch (eOrder) {
                mirrorCreatedLog.push("    ★ 镜像内层排序出错：" + cleanMsg("" + eOrder));
            }
            R.notes.push("· 搬进镜像「" + MIRROR_NAME + " / " + chainForMirror.join(" / ") + "」：" + moved + " 个副本" +
                         (maskFolderCopyId >= 0 ? "，遮罩源文件夹副本 id=" + maskFolderCopyId : "，遮罩源文件夹未复制"));
            /* ★ 把"遮罩源文件夹副本"挪到最下面，
               让它位于剪贴层副本【下面】而不是包住它们。
               （刚才它是先建的，所以先占了最内层；现在并排放到末尾。） */
            if (maskFolderCopyId >= 0) {
                try {
                    var maskCp = byId(maskFolderCopyId);
                    if (maskCp) {
                        maskCp.move(ElementPlacement.PLACEATEND);
                        try { maskCp.visible = false; } catch (eVm2) {}
                        try { if (maskFolderCopyName) maskCp.name = maskFolderCopyName; } catch (eNm2) {}
                        mirrorCreatedLog.push("    遮罩源文件夹副本已挪到最下面（并关灯）");
                    }
                } catch (eEnd) { mirrorCreatedLog.push("    ★ 挪遮罩源文件夹副本失败：" + cleanMsg("" + eEnd)); }
            }
            segOp.mirrorChain = chainForMirror;
            segOp.mirrorRootName = MIRROR_NAME;
            segOp.mirrorMaskFolderCopyId = maskFolderCopyId;
            segOp.mirrorMaskFolderCopyName = maskFolderCopyName;
            /* 副本改记录它在镜像里的位置 */
            for (var mi = 0; mi < segOp.copies.length; mi++) {
                segOp.copies[mi].inFolder = MIRROR_NAME + " / " + chainForMirror.join(" / ");
            }
        } else if (segCopyItems.length > 0) {
            R.notes.push("⚠ 镜像结构没建成，副本留在 __AE_jsonCopies 里");
        }

        /* copy/paste 不会改动原来的剪贴链，所以理论上不需要重扫；
           但为了让"多段"情况下的 id 更稳，还是刷新一下后续段落的 id。 */
        if (c + 1 < scan.clipAboveFolder.length) {
            var rs = scanDoc();
            /* 只更新还没处理的那几段的 id */
            for (var z = c + 1; z < scan.clipAboveFolder.length; z++) {
                if (rs.clipAboveFolder[z]) {
                    scan.clipAboveFolder[z].clipIds = rs.clipAboveFolder[z].clipIds;
                    scan.clipAboveFolder[z].folderId = rs.clipAboveFolder[z].folderId;
                }
            }
        }
    }

    /* ★ 收尾：__AE_jsonCopies 只是个中转文件夹 —— 副本都搬进镜像之后它就空了。
       留着会在文档里多一个空文件夹（用户会以为是垃圾），所以这里把它删掉。
       注意：只删【它自己】且【确认它已经空了】，绝不动别的。 */
    if (COPY_BOX) {
        try {
            var leftInside = 0;
            try { leftInside = COPY_BOX.layers.length; } catch (eLn) { leftInside = -1; }
            if (leftInside === 0) {
                try { COPY_BOX.remove(); R.notes.push("已删掉中转文件夹 __AE_jsonCopies（已空）"); }
                catch (eRm) {
                    /* 删不掉就关灯，至少不碍眼 */
                    try { COPY_BOX.visible = false; } catch (eV2) {}
                    R.notes.push("中转文件夹删不掉，已关灯：" + cleanMsg("" + eRm));
                }
            } else {
                R.notes.push("中转文件夹里还有 " + leftInside + " 层，保留并关灯");
                try { COPY_BOX.visible = false; } catch (eV3) {}
            }
        } catch (eClean) { R.notes.push("收尾清理中转文件夹出错：" + cleanMsg("" + eClean)); }
    }

    var __final = { ops: ops, scan: scan };
    var __final = { ops: ops, scan: scan };
    try { $.global.PSJSX_07_RESULT = __final; } catch (eF) {}
    return __final;
}

/* ==========================================================================
 * 六、日志（<文档目录>/_日志/，每 25 行落盘一次）
 * ========================================================================== */
function ensureLogFolder() {
    try {
        var d = (DOC && DOC.path) ? Folder(DOC.path) : null;
        if (!d) return null;
        var sub = Folder(d.fsName + "/_日志");
        if (!sub.exists) { try { sub.create(); } catch (eC) {} }
        return (sub.exists ? sub : d);
    } catch (e) { return null; }
}
function logOpen() {
    try {
        var d = ensureLogFolder();
        if (!d) d = Folder(Folder.temp);
        LOG.path = d.fsName + "/" + DOC.name.replace(/\.[^.]+$/, "") + "_ps07日志.txt";
        LOG.f = File(LOG.path);
        LOG.f.open("w");
    } catch (e) { LOG.f = null; LOG.path = "(无法写日志)"; }
}
function logClose() { if (LOG.f) { try { LOG.f.write("[" + ts() + "] ===== 结束 =====\n"); } catch (e) {} try { LOG.f.close(); } catch (e2) {} LOG.f = null; } }
var LOG_LINES = 0;
function ts() { var d = new Date(); function p(n) { return (n < 10 ? "0" : "") + n; } return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()); }
function plog(s) {
    if (!LOG.f) return;
    try {
        LOG.f.write("[" + ts() + "] " + s + "\n");
        LOG_LINES++;
        if (LOG_LINES % 25 === 0) { LOG.f.close(); LOG.f.open("a"); }
    } catch (e) {}
}

/* ==========================================================================
 * 七、结果 / 选项面板
 * ========================================================================== */
function showResult(msg) {
    if (batchOn()) return;
    try { alert(msg); } catch (e) {}
}
function askDialog() {
    if (batchOn()) return true;
    if (typeof Window === "undefined") return true;
    var w = new Window("dialog", "ps 07 输出 AE 指令 JSON —— 选项");
    w.orientation = "column"; w.alignChildren = "left";
    var g0 = w.add("panel", undefined, "将要做的（只读 + 摆位，不改画面）");
    g0.orientation = "column"; g0.alignChildren = "left";
    g0.add("statictext", undefined, "· 找出带蒙版的文件夹，记进 JSON（AE 那边设遮罩）");
    g0.add("statictext", undefined, "· 复制文件夹上方的剪贴蒙版图层到【最上方】，取消剪贴 + 关灯");
    g0.add("statictext", undefined, "· 记录文件夹的图层样式完整参数");
    g0.add("statictext", undefined, "· 输出 <原名>_ae.json 到文档同级（AE 脚本读它执行）");
    var cbFx = w.add("checkbox", undefined, "记录文件夹图层样式（完整参数）");
    cbFx.value = !!OPTIONS.recordFolderFx;
    var cbDiff = w.add("checkbox", undefined, "先盖印一层「" + OPTIONS.diffName + "」（差值，用来验证画面没变）");
    cbDiff.value = !!OPTIONS.makeDiffLayer;
    var cbRem = w.add("checkbox", undefined, "记住我的选择");
    cbRem.value = !!OPTIONS.rememberOptions;
    var gB = w.add("group"); gB.alignment = "right";
    gB.add("button", undefined, "开始", { name: "ok" });
    gB.add("button", undefined, "取消", { name: "cancel" });
    try { placeWindowOnHostScreen(w); } catch (ePL) {}
    if (w.show() !== 1) return false;
    OPTIONS.recordFolderFx = (cbFx.value === true);
    OPTIONS.makeDiffLayer = (cbDiff.value === true);
    OPTIONS.rememberOptions = (cbRem.value === true);
    return true;
}
function prefFile() { try { return File(Folder.userData + "/" + PREF_NAME); } catch (e) { return null; } }
function loadPrefs() {
    var f = prefFile(); if (!f || !f.exists) return;
    try {
        f.open("r"); var t = f.read(); f.close();
        var ls = t.split("\n");
        for (var i = 0; i < ls.length; i++) {
            var kv = ls[i].split("=");
            if (kv.length < 2) continue;
            var k = kv[0].replace(/^\s+|\s+$/g, ""), v = kv[1].replace(/^\s+|\s+$/g, "");
            if (k === "recordFolderFx") OPTIONS.recordFolderFx = (v === "1");
            if (k === "makeDiffLayer") OPTIONS.makeDiffLayer = (v === "1");
        }
    } catch (e) {}
}
function savePrefs() {
    if (!OPTIONS.rememberOptions) return;
    var f = prefFile(); if (!f) return;
    try {
        f.open("w");
        f.write("recordFolderFx=" + (OPTIONS.recordFolderFx ? "1" : "0") + "\n");
        f.write("makeDiffLayer=" + (OPTIONS.makeDiffLayer ? "1" : "0") + "\n");
        f.close();
    } catch (e) {}
}

/* ==========================================================================
 * 八、启动块（放文件末尾）
 * ========================================================================== */
try {
    if (app.documents.length === 0) {
        if (!batchOn()) alert("没有打开的文档。");
    } else {
        DOC = app.activeDocument;
        loadPrefs();
        var goOn = true;
        if (OPTIONS.askOptions && !batchOn() && !askDialog()) goOn = false;
        if (goOn) {
            savePrefs();
            logOpen();
            clearStopFlag();
            plog("===== ps 07 输出 AE 指令 JSON 开始 =====");
            plog("文档：" + DOC.name);
            plog("生效选项：记录图层样式=" + (OPTIONS.recordFolderFx ? "开" : "关") +
                 "，建对比层=" + (OPTIONS.makeDiffLayer ? "开" : "关"));

            /* 说明：本脚本【故意不建差值对比层】。
               因为它只做"读 + 复制并关灯的副本"，PS 里看到的画面本来就不该变；
               留着对比层只会污染画面、还要额外处理。想验证画面没变，
               可以跑前后各存一份、或者用 AE 那边核对。 */

            /* ★ 动手前记结构基线 */
            var baseSnap = safeSnap();
            var tStart = nowMs();
            /* ★★ 整批包进【一个】历史步骤：出问题 Ctrl+Z 一次全撤 */
            var res = null;
            var histOK = false;
            try {
                try { $.global.PSJSX_HOOK = doWork; } catch (eG) {}
                DOC.suspendHistory("ps07 输出AE指令JSON", "PSJSX_HOOK()");
                histOK = true;
            } catch (eH) {
                plog("⚠ suspendHistory 不可用，改为直接执行：" + cleanMsg("" + eH));
                try { res = doWork(); } catch (eD) { plog("★ doWork 抛错：" + cleanMsg("" + eD)); }
            }
            /* suspendHistory 是字符串调用，返回值拿不到，所以走全局变量传回来 */
            try { if (histOK && $.global.PSJSX_07_RESULT) res = $.global.PSJSX_07_RESULT; } catch (eR) {}
            if (!res) res = { ops: [], scan: { folders: [], clipAboveFolder: [] } };
            if (!res.scan) res.scan = { folders: [], clipAboveFolder: [] };
            if (!res.ops) res.ops = [];
            R.elapsed = Math.round((nowMs() - tStart) / 100) / 10;
            pbClose();

            /* ★ 收尾校验：有没有原有图层被误改 */
            var brokeList = [];
            try { brokeList = safeVerify(baseSnap); } catch (eV0) {}
            if (brokeList.length > 0) {
                R.failed.push("★ 有 " + brokeList.length + " 个【原有图层】的剪贴/显示被改动了：");
                for (var bi = 0; bi < brokeList.length; bi++) R.failed.push("    · " + brokeList[bi]);
                R.failed.push("    → 按 Ctrl+Z 一次即可全部撤回（整批是一个历史步骤）");
            }

            /* ---- 组装 JSON ---- */
            var out = {
                format: "ps-ae-handoff",
                version: 1,
                generatedAt: (new Date()).toString(),
                psVersion: "" + app.version,
                doc: {
                    name: "" + DOC.name,
                    path: (DOC.path ? DOC.path.fsName : ""),
                    width: Number(DOC.width),
                    height: Number(DOC.height),
                    /* ★ doc.mode 字符串化是 DocumentMode.RGB 这种，去掉前缀只留 RGB / CMYK / GRAY / LAB / BITMAP / INDEXED */
                    mode: cleanDocMode(DOC.mode),
                    /* ★ doc.bitsPerChannel 在中文版 PS 上直接取值可能是 null，用 ActionManager 读 depth 才靠得住 */
                    bitsPerChannel: readBitsPerChannel()
                },
                /* ★ AE 脚本按这个名字找"副本文件夹"（所有 __AE_ 副本都收在这里） */
                copyFolderName: "__AE_jsonCopies",
                /* ★★ 镜像文件夹结构的根名字（用户要求）：
                   它在 PS 里是个文件夹（已关灯），导入 AE 后变成合成。
                   结构 = 原文档的文件夹层级，副本放在最内层。
                   AE 端只要进这个合成，按同名层一路走进去就能拿到副本。 */
                mirrorRootName: MIRROR_NAME,
                /* ★ 遮罩源文件夹副本的名字前缀（AE 端按它认出"哪一层是遮罩源"） */
                mirrorMaskPrefix: MIRROR_MASK_PREFIX,
                /* 兼容：旧的平铺副本文件夹也记着（没建成镜像时副本还在这儿） */
                mirrorCreated: (MIRROR_ROOT ? true : false),
                summary: {
                    /* ★ foldersWithMask 只算【真的带蒙版】的文件夹 */
                    foldersWithMask: R.foldersWithMask,
                    /* ★ 新增：文件夹总数 / 有图层样式的文件夹数 */
                    foldersTotal: R.foldersTotal,
                    foldersWithStyles: R.foldersWithStyles,
                    clipAboveFolderSegments: res.scan.clipAboveFolder.length,
                    copiesMade: R.copies,
                    folderEffectsRecorded: R.fx,
                    aborted: R.abort
                },
                ops: res.ops
            };

            var json = jsonObj(out);
            var dest = null, destPath = "(未写出)";
            try {
                var baseDir = (DOC.path ? DOC.path.fsName : Folder.temp.fsName);
                dest = File(baseDir + "/" + DOC.name.replace(/\.[^.]+$/, "") + "_ae.json");
                dest.encoding = "UTF-8";
                dest.open("w");
                dest.write(json);
                dest.close();
                destPath = dest.fsName;
                plog("JSON 已写出：" + destPath + "（" + json.length + " 字符）");
            } catch (eW) {
                plog("★ 写 JSON 失败：" + cleanMsg("" + eW));
                destPath = "(写失败：" + cleanMsg("" + eW) + ")";
            }

            plog("");
            plog("========== 汇总 ==========");
            if (R.abort) plog("⚠ 被中止（只处理了一部分）");
            plog("文件夹共 " + R.foldersTotal + " 个（带蒙版 " + R.foldersWithMask + " 个；有图层样式 " + R.foldersWithStyles + " 个）；" +
         "文件夹上方的剪贴段 " + res.scan.clipAboveFolder.length + " 段");
            plog("复制的剪贴层 " + R.copies + " 个；记录到图层样式的数量 " + R.fx + " 个");
            plog("镜像结构：" + (MIRROR_ROOT ? ("已建「" + MIRROR_NAME + "」（关灯）") : "未建"));
            for (var ml = 0; ml < mirrorCreatedLog.length; ml++) plog("  " + mirrorCreatedLog[ml]);
            for (var n = 0; n < R.notes.length; n++) plog("  " + R.notes[n]);
            if (R.failed.length > 0) {
                plog("失败 " + R.failed.length + " 个：");
                for (var m = 0; m < R.failed.length; m++) plog("  · " + R.failed[m]);
            }
            plog("JSON：" + destPath);
            plog("（没有清理缓存、没有自动存盘）");
            logClose();

            var msg = "ps 07 完成（耗时约 " + R.elapsed + " 秒）\n\n" +
                      "· 文件夹 " + R.foldersTotal + " 个（带蒙版 " + R.foldersWithMask + " 个，有样式 " + R.foldersWithStyles + " 个）\n" +
                      "· 文件夹上方的剪贴段 " + res.scan.clipAboveFolder.length + " 段\n" +
                      "· 复制的剪贴层 " + R.copies + " 个（已取消剪贴 + 关灯）\n" +
                      "· 记录图层样式 " + R.fx + " 个\n" +
                      (R.failed.length ? ("\n⚠ 失败 " + R.failed.length + " 个（见日志）") : "") +
                      "\n\nJSON：\n" + destPath + "\n日志：\n" + LOG.path;
            showResult(msg);
        }
    }
} catch (eMain) {
    try { pbClose(); } catch (eP) {}
    try {
        var __ln = ""; try { __ln = eMain.line; } catch (eL) {}
        logOpen();
        plog("✗ 整体出错：" + eMain + "（行 " + __ln + "）");
        logClose();
        if (!batchOn()) alert("ps 07 运行出错：\n" + eMain + "\n行号: " + __ln + "\n日志: " + LOG.path);
    } catch (eAl) {}
}

})();