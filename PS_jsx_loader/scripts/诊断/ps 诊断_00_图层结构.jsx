#target photoshop
/* ==========================================================================
 * ps 诊断_00_图层结构.jsx
 * 对应步骤：00 / 通用——打印图层的完整 ActionManager 描述符
 *
 * 用途：把选中图层（或当前图层 / 全部图层）的**完整 ActionManager 描述符**打出来，
 *       用来定位"结构比较特殊"的图层 —— 比如为什么烘焙后观感变了。
 *
 * 输出：写到文档同目录的 <文档名>_图层结构.txt（每行都即时落盘，PS 崩了也留着）
 *       弹窗只给一句简短提示（详细内容全在文件里）。
 *
 * 说明：本脚本**只读**，不改动文档。
 * ========================================================================== */

var OPTIONS = {
    // 运行前弹一个选项窗，让你直接选"导出范围"（不用改文件）
    askOptions: true,
    // "selected" = 只导出选中的图层；"active" = 当前图层；"all" = 全部图层
    mode: "selected",
    // 描述符递归深度（嵌套太深会很长；一般 6 层够看清结构）
    maxDepth: 6,
    // 每个图层最多写多少行（防止某个图层刷屏）
    maxLinesPerLayer: 400,
    // 顺便把"可疑结构"的判读放在最前面
    summarize: true
};

var OUT = { lines: [], file: null, path: "", doc: null };
var SELINFO = "";
var ACTIVE_ID = -1;

// ⚠ 入口：带初值的全局变量必须定义在这一行之前
main();

var REPORT_FILE = "psjsx_00_layer_dump.txt";

/* ★ 用户要求：诊断不要弹大段表格（占窗口、看不过来）。
 *   完整内容照旧写进报告文件；弹窗只给一句结论 + 报告路径。 */
function finish(headline) {
    try { alert((headline ? (headline + "\n\n") : "") + "报告：\n" +
                 File(Folder.temp.fsName + "/" + REPORT_FILE).fsName); } catch (eA) {}
}

function main() {
    try {
        OUT.doc = app.activeDocument;
    } catch (e0) {
        finish("没有打开的文档");
        return;
    }
    try { ACTIVE_ID = OUT.doc.activeLayer.id; } catch (e9) { ACTIVE_ID = -1; }
    setupFile();
    say("======== 图层结构诊断 ========");
    say("时间：" + (new Date()).toString());
    say("文档：" + safeDocName() + "（只读诊断，不会改动文档）");
    say("");

    if (OPTIONS.askOptions && !askScope()) {
        finish("已取消");
        return;
    }

    var targets = pickLayers();
    if (targets.length === 0) {
        say("没有可导出的图层。");
        finish("没有可导出的图层（请先选中图层，或把 OPTIONS.mode 改成 \"all\"）");
        return;
    }
    if (SELINFO) say("选区解析：" + SELINFO);
    say("本次导出 " + targets.length + " 个图层：");
    say("");

    for (var i = 0; i < targets.length; i++) {
        dumpOne(targets[i], i + 1, targets.length);
    }
    // 还原活动图层（解析选区时逐个选中过）
    try { if (ACTIVE_ID > 0) { var rr = new ActionReference(); rr.putIdentifier(charIDToTypeID("Lyr "), ACTIVE_ID);
        var dd = new ActionDescriptor(); dd.putReference(charIDToTypeID("null"), rr);
        executeAction(charIDToTypeID("slct"), dd, DialogModes.NO); } } catch (e10) {}
    say("");
    say("======== 结束 ========");
    finish("已导出 " + targets.length + " 个图层的描述符");
}

/* ---------- 运行前选项窗：选导出范围 ---------- */
function askScope() {
    try {
        if (typeof Window === "undefined") return true;
        var selN = 0;
        try { selN = getSelectedLayerIds().length; } catch (e) { selN = 0; }

        var w = new Window("dialog", "图层结构诊断 —— 导出范围");
        w.orientation = "column";
        w.alignChildren = "left";
        var t0 = w.add("statictext", undefined, "文档：" + safeDocName() + "（只读，不会改文档）", { truncate: "middle" });
        t0.preferredSize = [400, 20];

        var rbSel = w.add("radiobutton", undefined, "只导出选中的图层（当前选中 " + selN + " 个）");
        var rbAct = w.add("radiobutton", undefined, "只导出当前图层");
        var rbAll = w.add("radiobutton", undefined, "导出全部图层（最全，文件会比较大）");
        if (OPTIONS.mode === "all") rbAll.value = true;
        else if (OPTIONS.mode === "active") rbAct.value = true;
        else rbSel.value = true;
        if (selN === 0) rbSel.enabled = false;

        var g = w.add("group");
        g.alignment = "right";
        g.add("button", undefined, "开始", { name: "ok" });
        g.add("button", undefined, "取消", { name: "cancel" });
        var res = w.show();
        if (res !== 1) return false;
        if (rbAll.value === true) OPTIONS.mode = "all";
        else if (rbAct.value === true) OPTIONS.mode = "active";
        else OPTIONS.mode = "selected";
        return true;
    } catch (e) {
        return true;   // 弹窗出问题就用文件里的默认值继续
    }
}

/* ---------- 选哪些图层 ---------- */
function pickLayers() {
    var out = [];
    if (OPTIONS.mode === "all") {
        walkAll(OUT.doc, function (l) {
            out.push({ layer: l, path: pathOf(l) });
        });
        return out;
    }
    if (OPTIONS.mode === "active") {
        try { out.push({ layer: OUT.doc.activeLayer, path: pathOf(OUT.doc.activeLayer) }); } catch (e) {}
        return out;
    }
    // selected：用 AM targetLayers 拿选区，再逐个问 PS 要 layerId（不靠索引猜）
    var ids = getSelectedLayerIds();
    for (var i = 0; i < ids.length; i++) {
        var l = byId(ids[i]);
        if (l) out.push({ layer: l, path: pathOf(l) });
    }
    if (out.length === 0) {
        try { out.push({ layer: OUT.doc.activeLayer, path: pathOf(OUT.doc.activeLayer) }); } catch (e2) {}
    }
    return out;
}

function getSelectedLayerIds() {
    var ids = [];
    var raw = "";
    try {
        var ref = new ActionReference();
        ref.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("targetLayers"));
        ref.putEnumerated(charIDToTypeID("Dcmn"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        var d = executeActionGet(ref);
        var key = stringIDToTypeID("targetLayers");
        if (d.hasKey(key)) {
            var lst = d.getList(key);
            raw = "targetLayers 共 " + lst.count + " 项";
            for (var i = 0; i < lst.count; i++) {
                var idx = -1;
                try { idx = lst.getReference(i).getIndex(); } catch (e1) { idx = -1; }
                if (idx <= 0) continue;
                var lid = idBySelectingIndex(idx);
                if (lid > 0 && !inIdListD(ids, lid)) ids.push(lid);
            }
        } else {
            raw = "描述符里没有 targetLayers 键（可能 PS 版本行为不同）";
        }
    } catch (e) {
        raw = "读 targetLayers 失败：" + cleanMsg("" + e);
    }
    SELINFO = raw + " → 解析出 " + ids.length + " 个图层";
    if (ids.length === 0) {
        SELINFO += "\r\n  选区自诊断：" + selDebug();
    }
    return ids;
}

// 选区自诊断：把 Photoshop 实际返回的引用结构原样描述出来（解析失败时用）
function selDebug() {
    var out = [];
    try {
        var ref = new ActionReference();
        ref.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("targetLayers"));
        ref.putEnumerated(charIDToTypeID("Dcmn"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        var d = executeActionGet(ref);
        var key = stringIDToTypeID("targetLayers");
        out.push("hasKey(targetLayers)=" + (d.hasKey(key) ? "是" : "否"));
        if (d.hasKey(key)) {
            var lst = d.getList(key);
            out.push("列表长度=" + lst.count);
            for (var i = 0; i < lst.count && i < 5; i++) {
                var one = ["[" + i + "]"];
                try { one.push("getIndex=" + lst.getReference(i).getIndex()); } catch (eA) { one.push("getIndex抛错:" + cleanMsg("" + eA)); }
                try { one.push("getName=" + lst.getReference(i).getName()); } catch (eB) { one.push("getName抛错"); }
                try { one.push("getOffset=" + lst.getReference(i).getOffset()); } catch (eC) { one.push("getOffset抛错"); }
                out.push(one.join("  "));
            }
        }
    } catch (e) {
        out.push("整体读 targetLayers 抛错：" + cleanMsg("" + e));
    }
    try {
        out.push("activeLayer 可读=" + (OUT.doc.activeLayer ? "是" : "否") +
                 "，id=" + OUT.doc.activeLayer.id);
    } catch (e2) { out.push("activeLayer 读取失败：" + cleanMsg("" + e2)); }
    return out.join("\r\n    ");
}

// 让 PS 按 AM 序号选中它，再读"当前图层"的 id
function idBySelectingIndex(idx) {
    try {
        var d = new ActionDescriptor();
        var r = new ActionReference();
        r.putIndex(charIDToTypeID("Lyr "), idx);
        d.putReference(charIDToTypeID("null"), r);
        d.putBoolean(charIDToTypeID("MkVs"), false);
        executeAction(charIDToTypeID("slct"), d, DialogModes.NO);
        return (function () { try { return OUT.doc.activeLayer.id; } catch (e) { return -1; } })();
    } catch (e) { return -1; }
}

// ExtendScript 是 ES3：Array 没有 indexOf，必须自己写
function inIdListD(list, id) {
    for (var i = 0; i < list.length; i++) { if (list[i] === id) return true; }
    return false;
}

function layerIdAtIndex(idx) {
    try {
        var ref = new ActionReference();
        ref.putIndex(charIDToTypeID("Lyr "), idx);
        var d = executeActionGet(ref);
        var key = stringIDToTypeID("layerId");
        if (d.hasKey(key)) return d.getInteger(key);
    } catch (e) {}
    return -1;
}

/* ---------- 导出一个图层 ---------- */
function dumpOne(item, n, total) {
    var layer = item.layer;
    var desc = null;
    try {
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), layer.id);
        desc = executeActionGet(ref);
    } catch (e) {
        say("[" + n + "/" + total + "] " + item.path + "  ← 读不到描述符：" + cleanMsg("" + e));
        say("");
        return;
    }

    var buf = [];
    var count = { n: 0 };
    buf.push("──────────────────────────────────────────────");
    buf.push("[" + n + "/" + total + "] " + item.path);
    buf.push("──────────────────────────────────────────────");

    if (OPTIONS.summarize) {
        var s = summarize(layer, desc);
        buf.push("★ 自动判读（可疑点）：");
        if (s.length === 0) buf.push("  · 没发现常见的可疑结构");
        for (var i = 0; i < s.length; i++) buf.push("  · " + s[i]);
        buf.push("");
    }

    buf.push("--- DOM 信息 ---");
    buf.push("  名称     : " + safeName(layer));
    buf.push("  id       : " + safeId(layer));
    buf.push("  类型     : " + safeTypename(layer));
    buf.push("  混合模式 : " + safeVal(function () { return "" + layer.blendMode; }));
    buf.push("  不透明度 : " + safeVal(function () { return "" + layer.opacity; }));
    buf.push("  填充不透明度: " + safeVal(function () { return "" + layer.fillOpacity; }));
    buf.push("  剪贴蒙版 : " + safeVal(function () { return (layer.grouped === true) ? "是" : "否"; }));
    buf.push("  可见     : " + safeVal(function () { return (layer.visible !== false) ? "是" : "否"; }));
    buf.push("  全锁     : " + safeVal(function () { return (layer.allLocked === true) ? "是" : "否"; }));
    buf.push("  锁透明   : " + safeVal(function () { return (layer.protectTransparency === true) ? "是" : "否"; }));
    buf.push("  锁位置   : " + safeVal(function () { return (layer.protectPosition === true) ? "是" : "否"; }));
    buf.push("  锁合成   : " + safeVal(function () { return (layer.protectComposite === true) ? "是" : "否"; }));
    buf.push("  有图层蒙版: " + safeVal(function () { return (layer.layerMask) ? "是" : "否"; }));
    buf.push("  有矢量蒙版: " + safeVal(function () { return (layer.vectorMask) ? "是" : "否"; }));
    buf.push("  蒙版启用 : " + safeVal(function () { return (layer.layerMask && layer.layerMask.enabled !== false) ? "是" : "否/无"; }));
    buf.push("  链接蒙版 : " + safeVal(function () { return (layer.layerMask && layer.layerMask.link === false) ? "未链接" : "链接/无"; }));
    buf.push("");
    buf.push("--- ActionManager 描述符（这就是【结构】）---");
    dumpDesc(desc, "  ", OPTIONS.maxDepth, buf, count);

    if (count.n >= OPTIONS.maxLinesPerLayer) {
        buf.push("  …（这个图层太长，已截断到 " + OPTIONS.maxLinesPerLayer + " 行）");
    }
    buf.push("");
    for (var k = 0; k < buf.length; k++) say(buf[k]);
}

/* ---------- 自动判读 ---------- */
function summarize(layer, desc) {
    var keySet = {};
    try { collectKeyNames(desc, keySet, 3); } catch (e) {}
    var out = [];

    var fm = safeVal(function () { return layer.fillOpacity; });
    if (fm !== "undefined" && parseFloat(fm) < 99.99) out.push("填充不透明度不是 100%（" + fm + "）：合并进空层可能丢这个属性");

    if (truthyDeep(desc, "blendClipped")) out.push("高级混合：混合裁剪元素为（单独合并会改观感）");
    if (truthyDeep(desc, "blendInterior")) out.push("高级混合：混合内部元素为（单独合并会改观感）");
    if (keySet["knockout"]) out.push("有挖空(knockout)设置（单独合并会改观感）");
    if (truthyDeep(desc, "transparencyShapesLayer")) out.push("透明形状图层（单独合并会改观感）");
    if (truthyDeep(desc, "layerMaskAsGlobalMask")) out.push("蒙版隐藏本图层效果");
    if (truthyDeep(desc, "vectorMaskAsGlobalMask")) out.push("矢量蒙版隐藏本图层效果");
    if (keySet["Lefx"] || keySet["layerEffects"] || keySet["class:layerEffects"]) out.push("带图层样式(layer effects)：合并时会被烤进像素");
    if (keySet["filterFX"] || keySet["filterFXList"] || keySet["class:FilterFX"]) out.push("带智能滤镜(smart filter)：合并时会烤进像素");
    if (keySet["smartObject"] || keySet["class:smartObject"]) out.push("本身是智能对象");
    if (keySet["framedGroup"] || keySet["class:framedGroup"]) out.push("是图框(Frame)相关结构，留意裁切框");
    if (hasTopLevelKey(desc, "adjustment") || hasTopLevelKey(desc, "Adjs")) out.push("是调整层（单独合并会丢调整效果，绝不能这样烤）");

    var maskDis = false;
    try { if (layer.layerMask && layer.layerMask.enabled === false) maskDis = true; } catch (e2) {}
    if (maskDis) out.push("图层蒙版是【禁用】状态（红叉）：合并时可能被当成有效蒙版应用 → 画面被裁");

    var vmask = false;
    try { vmask = (layer.vectorMask) ? true : false; } catch (e3) {}
    if (vmask) out.push("有矢量蒙版（硬边）：烘焙后边缘抗锯齿可能有细微差异");

    return out;
}

/* ---------- 描述符递归导出 ---------- */
function dumpDesc(desc, indent, depth, buf, count) {
    if (!desc) return;
    var n = 0;
    try { n = desc.count; } catch (e) { return; }
    for (var i = 0; i < n; i++) {
        if (count.n++ > OPTIONS.maxLinesPerLayer) return;
        var k = null, ks = "", t = null;
        try { k = desc.getKey(i); } catch (e2) { continue; }
        try { ks = typeIDToStringID(k); } catch (e3) { ks = ""; }
        try { t = desc.getType(k); } catch (e4) { continue; }

        if (t == DescValueType.OBJECTTYPE) {
            var cls = null;
            try { cls = typeIDToStringID(desc.getObjectType(k)); } catch (e5) { cls = "?"; }
            buf.push(indent + ks + "  {对象:" + cls + "}");
            if (depth > 0) {
                try { dumpDesc(desc.getObjectValue(k), indent + "    ", depth - 1, buf, count); } catch (e6) {}
            } else {
                buf.push(indent + "    …（深度到顶，未展开）");
            }
        } else if (t == DescValueType.LISTTYPE) {
            var lst = null, ln = 0;
            try { lst = desc.getList(k); ln = lst.count; } catch (e7) { lst = null; }
            buf.push(indent + ks + "  [列表 " + ln + " 项]");
            if (lst && depth > 0) {
                for (var j = 0; j < ln; j++) {
                    if (count.n++ > OPTIONS.maxLinesPerLayer) return;
                    var lt = null;
                    try { lt = lst.getType(j); } catch (e8) { continue; }
                    if (lt == DescValueType.OBJECTTYPE) {
                        var lcls = null;
                        try { lcls = typeIDToStringID(lst.getObjectValue(j).getObjectValue ? "" : ""); } catch (e9) {}
                        var o = null;
                        try { o = lst.getObjectValue(j); } catch (eA) { o = null; }
                        buf.push(indent + "  [" + j + "] {对象}");
                        try { dumpDesc(o, indent + "      ", depth - 1, buf, count); } catch (eB) {}
                    } else {
                        buf.push(indent + "  [" + j + "] = " + listScalar(lst, j, lt));
                    }
                }
            }
        } else {
            buf.push(indent + ks + " = " + scalar(desc, k, t));
        }
    }
}

function scalar(desc, k, t) {
    try {
        if (t == DescValueType.INTEGERTYPE) return "" + desc.getInteger(k);
        if (t == DescValueType.STRINGTYPE) return "\"" + desc.getString(k) + "\"";
        if (t == DescValueType.DOUBLETYPE) return "" + desc.getDouble(k);
        if (t == DescValueType.UNITDOUBLE) {
            return "" + desc.getUnitDoubleValue(k) + " " + typeIDToStringID(desc.getUnitDoubleType(k));
        }
        if (t == DescValueType.BOOLEANTYPE) return (desc.getBoolean(k) === true) ? "true" : "false";
        if (t == DescValueType.ENUMERATEDTYPE) {
            return typeIDToStringID(desc.getEnumerationType(k)) + "." + typeIDToStringID(desc.getEnumerationValue(k));
        }
        if (t == DescValueType.CLASSTYPE) return "<类 " + typeIDToStringID(desc.getClass(k)) + ">";
        if (t == DescValueType.ALIASTYPE) return "<路径 " + desc.getPath(k) + ">";
        if (t == DescValueType.RAWTYPE) return "<原始数据>";
    } catch (e) {
        return "<读值失败:" + cleanMsg("" + e) + ">";
    }
    return "<类型 " + t + ">";
}

function listScalar(lst, i, t) {
    try {
        if (t == DescValueType.INTEGERTYPE) return "" + lst.getInteger(i);
        if (t == DescValueType.STRINGTYPE) return "\"" + lst.getString(i) + "\"";
        if (t == DescValueType.DOUBLETYPE) return "" + lst.getDouble(i);
        if (t == DescValueType.UNITDOUBLE) {
            return "" + lst.getUnitDoubleValue(i) + " " + typeIDToStringID(lst.getUnitDoubleType(i));
        }
        if (t == DescValueType.BOOLEANTYPE) return (lst.getBoolean(i) === true) ? "true" : "false";
        if (t == DescValueType.ENUMERATEDTYPE) {
            return typeIDToStringID(lst.getEnumerationType(i)) + "." + typeIDToStringID(lst.getEnumerationValue(i));
        }
    } catch (e) {
        return "<读值失败:" + cleanMsg("" + e) + ">";
    }
    return "<类型 " + t + ">";
}

/* ---------- 工具 ---------- */
function truthyDeep(o, keyName, depth) {
    var d = (depth === undefined) ? 4 : depth;
    var n = 0;
    try { n = o.count; } catch (e) { return false; }
    for (var i = 0; i < n; i++) {
        var k = null, ks = "";
        try { k = o.getKey(i); } catch (e2) { continue; }
        try { ks = typeIDToStringID(k); } catch (e3) { ks = ""; }
        if (ks === keyName) {
            try { if (o.getBoolean(k) === true) return true; } catch (e4) {}
            try { if (o.getInteger(k) === 1) return true; } catch (e5) {}
            return false;
        }
    }
    if (d <= 0) return false;
    for (var j = 0; j < n; j++) {
        var k2 = null, t = null;
        try { k2 = o.getKey(j); t = o.getType(k2); } catch (e6) { continue; }
        if (t == DescValueType.OBJECTTYPE) {
            try { if (truthyDeep(o.getObjectValue(k2), keyName, d - 1)) return true; } catch (e7) {}
        } else if (t == DescValueType.LISTTYPE) {
            try {
                var lst = o.getList(k2);
                for (var m = 0; m < lst.count; m++) {
                    if (lst.getType(m) == DescValueType.OBJECTTYPE) {
                        if (truthyDeep(lst.getObjectValue(m), keyName, d - 1)) return true;
                    }
                }
            } catch (e8) {}
        }
    }
    return false;
}

// 只看"顶层键"（不再递归）—— 智能滤镜参数里也有个叫 adjustment 的键，递归会误判成调整层
function hasTopLevelKey(desc, keyName) {
    if (!desc) return false;
    var n = 0;
    try { n = desc.count; } catch (e) { return false; }
    for (var i = 0; i < n; i++) {
        var ks = "";
        try { ks = typeIDToStringID(desc.getKey(i)); } catch (e2) { ks = ""; }
        if (ks === keyName) return true;
    }
    return false;
}

function collectKeyNames(desc, out, depth) {
    if (!desc) return out;
    var n = 0;
    try { n = desc.count; } catch (e) { return out; }
    for (var i = 0; i < n; i++) {
        var k = null, ks = "";
        try { k = desc.getKey(i); } catch (e2) { continue; }
        try { ks = typeIDToStringID(k); } catch (e3) { ks = ""; }
        if (ks) out[ks] = true;
        var cls = null;
        try { cls = desc.getObjectType(k); } catch (e4) { cls = null; }
        if (cls !== null && cls !== undefined) {
            var cs = "";
            try { cs = typeIDToStringID(cls); } catch (e5) { cs = ""; }
            if (cs) out["class:" + cs] = true;
        }
        if (depth <= 0) continue;
        var t = null;
        try { t = desc.getType(k); } catch (e6) { continue; }
        if (t == DescValueType.OBJECTTYPE) {
            try { collectKeyNames(desc.getObjectValue(k), out, depth - 1); } catch (e7) {}
        } else if (t == DescValueType.LISTTYPE) {
            try {
                var lst = desc.getList(k);
                for (var j = 0; j < lst.count; j++) {
                    if (lst.getType(j) == DescValueType.OBJECTTYPE) {
                        collectKeyNames(lst.getObjectValue(j), out, depth - 1);
                    }
                }
            } catch (e8) {}
        }
    }
    return out;
}

function walkAll(container, cb) {
    var arr = container.layers;
    for (var i = 0; i < arr.length; i++) {
        cb(arr[i]);
        var isGroup = false;
        try { isGroup = (arr[i].typename == "LayerSet"); } catch (e) {}
        if (isGroup) walkAll(arr[i], cb);
    }
}

function byId(id) {
    var found = null;
    walkAll(OUT.doc, function (l) {
        if (found) return;
        try { if (l.id === id) found = l; } catch (e) {}
    });
    return found;
}

function pathOf(layer) {
    var parts = [];
    var l = layer;
    var guard = 0;
    while (l && guard++ < 60) {
        var nm = "";
        try { nm = l.name; } catch (e) {}
        if (nm) parts.unshift(nm);
        var p = null;
        try { p = l.parent; } catch (e2) { p = null; }
        if (!p || p == OUT.doc) break;
        l = p;
    }
    return parts.join(" / ");
}

function safeName(l) { try { return l.name; } catch (e) { return "?"; } }
function safeId(l) { try { return "" + l.id; } catch (e) { return "?"; } }
function safeTypename(l) { try { return l.typename; } catch (e) { return "?"; } }

function safeVal(fn) {
    try { return "" + fn(); } catch (e) { return "读不到"; }
}

function safeDocName() {
    try { return OUT.doc.name; } catch (e) { return "?"; }
}

function cleanMsg(s) {
    if (!s) return "";
    s = ("" + s).replace(/[\r\n\t]+/g, " ");
    if (s.length > 160) s = s.substring(0, 160) + "…";
    return s;
}

/* ---------- 输出 ---------- */
function setupFile() {
    var name = docBase() + "_图层结构.txt";
    var f = null;
    try { if (OUT.doc.path) f = new File(OUT.doc.path.fsName + "/" + name); } catch (e) {}
    if (!f) { try { f = new File(Folder.desktop.fsName + "/" + name); } catch (e2) {} }
    if (!f) return;
    try { if (f.exists) f.remove(); } catch (e3) {}
    OUT.file = f;
    OUT.path = f.fsName;
}

function docBase() {
    var s = safeDocName();
    var i = s.lastIndexOf(".");
    return (i > 0) ? s.substring(0, i) : s;
}

function say(line) {
    OUT.lines.push(line);
    if (!OUT.file) return;
    try {
        OUT.file.encoding = "UTF-8";
        if (OUT.file.open("a")) { OUT.file.write(line + "\r\n"); OUT.file.close(); }
    } catch (e) {}
}

/* ------------------------------ 收尾：弹窗只给一行 + 报告路径 ------------------------------ */
/* ★ 用户要求：诊断不要弹大段表格（占窗口、看不过来）。
 *   完整内容照旧写进报告文件；弹窗只给一句结论 + 报告在哪。
 *   （这里不用 preferredSize，避免旧版 ScriptUI 上出问题） */
function finish(headline) {
    try {
        var msg = (headline ? (headline + "\n\n") : "") + "报告：\n" + (OUT.path || "(写文件失败)");
        if (typeof Window === "undefined") return;
        var w = new Window("dialog", "图层结构诊断");
        w.orientation = "column";
        w.alignChildren = "left";
        w.add("statictext", undefined, msg);
        var g = w.add("group");
        g.alignment = "right";
        g.add("button", undefined, "关闭", { name: "ok" });
        w.show();
    } catch (e) {}
}
