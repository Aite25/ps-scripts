// ===========================================================================
// ps 工具_打印对象属性.jsx
// ---------------------------------------------------------------------------
// 用途：调试 ExtendScript 对象 / ActionDescriptor / ActionReference 时，
//       把它的所有属性、属性链、匹配名（matchName）全部 dump 出来。
//
// 来源：用户笔记 `PS Script.md` 里的 prt 打印机，改成输出到 %TEMP%、
//       并额外支持 ActionDescriptor 的键枚举。
//
// 用法：
//   ① 直接改下面 CONFIG 里的 target 再跑（最常用）
//   ② 或者在任何脚本里 $.evalFile 本文件，然后调用
//        PSJSX_prt.op(对象)            写到 %TEMP%\psjsx_objprint.txt
//        PSJSX_prt.op(对象, 1)         弹窗显示
//        PSJSX_prt.pp(属性)            打印单个 property
//        PSJSX_prt.desc(actionDescriptor)   专门打印 ActionDescriptor 的所有键
//        PSJSX_prt.ref(actionReference)     打印 ActionReference 的类型
//
// 输出：%TEMP%\psjsx_objprint.txt
// ===========================================================================

(function () {

/* =========================================================================
 * 配置：想打印什么，改这里
 * ========================================================================= */
var CONFIG = {
    target: "activeLayer",     // "activeLayer" | "activeDocument" | "selection" | "layerDescriptor"
    show: false                // true = 弹窗，false = 写文件
};

/* =========================================================================
 * prt：对象 / 属性 / 描述符 打印机
 * ========================================================================= */
var PSJSX_prt = {

    _outPath: "",
    _buf: [],

    outPath: function () {
        if (!this._outPath) {
            try { this._outPath = Folder.temp.fsName + "/psjsx_objprint.txt"; }
            catch (e) { this._outPath = ""; }
        }
        return this._outPath;
    },

    clear: function () { this._buf = []; },

    saveFile: function (str) {
        this._buf.push(str);
        var p = this.outPath();
        if (!p) return;
        try {
            var f = File(p);
            f.encoding = "UTF-8";
            if (f.open("w")) { try { f.write(this._buf.join("")); } finally { try { f.close(); } catch (c) {} } }
            else { try { f.close(); } catch (c2) {} }
        } catch (e) {}
    },

    /* 属性链：从当前属性一路往上到根 */
    propGrChain_arr: function (prop) {
        var arr = [];
        try {
            arr.push(prop);
            var depth = 0;
            try { depth = prop.propertyDepth; } catch (e0) { depth = 0; }
            for (var i = 1; i <= depth; i++) {
                try { arr.push(prop.propertyGroup(i)); } catch (e1) { break; }
            }
            arr.reverse();
        } catch (e) {}
        return arr;
    },

    printPropChain: function (chainArr) {
        var s = "";
        for (var i = 0; i < chainArr.length; i++) {
            try { s += chainArr[i].name; } catch (e) { s += "?"; }
            if (i !== chainArr.length - 1) s += " -> ";
        }
        s += "\n";
        for (var j = 0; j < chainArr.length; j++) {
            try { s += chainArr[j].matchName; } catch (e2) { s += "?"; }
            if (j !== chainArr.length - 1) s += " -> ";
        }
        s += "\n";
        return s;
    },

    _valueStr: function (v) {
        try {
            if (v instanceof Array) return "[" + v.toString() + "]";
            if (v instanceof Number) return v.toString();
            return "\"" + v.toString() + "\"";
        } catch (e) { return "?"; }
    },

    /* 打印一个普通对象的所有属性 */
    op: function (obj, show) {
        var s = "";
        try { s += (obj.name || "（无 name）") + "\n"; } catch (e0) { s += "（无 name）\n"; }
        try { s += this.printPropChain(this.propGrChain_arr(obj)) + "\n"; } catch (e1) {}

        var n = 0;
        for (var k in obj) {
            s += n + " " + k + "\t";
            var ok = false;
            try { s += obj[k] + ";\n"; ok = true; } catch (e2) { ok = false; }
            if (!ok) {
                try {
                    var v = obj[k];
                    if (v instanceof Array) s += "[" + v.toString() + "];\n";
                    else {
                        s += "*" + typeof v + "*";
                        try { s += "\t.value:\t" + this._valueStr(v.value); } catch (e3) {}
                        s += ";\n";
                    }
                } catch (e4) { s += ";\n"; }
            }
            n++;
        }
        if (show) { try { alert(s); } catch (e5) {} }
        else this.saveFile(s);
        return s;
    },

    /* 打印单个 property（含 matchName、value） */
    pp: function (prop, show) {
        var arr = [];
        try {
            var num = 0;
            try { num = prop.numProperties; } catch (e0) { num = 0; }
            for (var i = 1; i <= num; i++) {
                try { arr.push(prop.property(i)); } catch (e1) { break; }
            }
        } catch (e2) {}

        var s = "";
        try { s += prop.name + "\n"; } catch (e3) {}
        try { s += this.printPropChain(this.propGrChain_arr(prop)) + "\n"; } catch (e4) {}

        for (var j = 0; j < arr.length; j++) {
            s += j + " ";
            try { s += arr[j].name; } catch (e5) { s += "?"; }
            s += ":\t\n";
            try { s += arr[j].matchName; } catch (e6) { s += "?"; }
            s += "\n";
            try { s += "value:\t" + arr[j].value + "\n"; }
            catch (e7) {
                try {
                    var v = arr[j].value;
                    if (v instanceof Array) s += "value:\t[" + v.toString() + "]\n";
                    else s += "*" + typeof arr[j] + "*\n";
                } catch (e8) {}
            }
            s += "\n";
        }

        if (show) { try { alert(s); } catch (e9) {} }
        else this.saveFile(s);
        return s;
    },

    /* ★ 专门打印 ActionDescriptor 的所有键（调试 ActionManager 用） */
    desc: function (d, show) {
        var s = "===== ActionDescriptor =====\n";
        try {
            var n = d.count;
            s += "count = " + n + "\n\n";
            for (var i = 0; i < n; i++) {
                var key = "?";
                try { key = typeIDToStringID(d.getKey(i)); } catch (e0) {
                    try { key = typeIDToCharID(d.getKey(i)); } catch (e1) { key = "?"; }
                }
                var typ = "?";
                try { typ = d.getType(d.getKey(i)); } catch (e2) { typ = "?"; }
                s += i + "  " + key + "  (type=" + typ + ")\n";

                /* 尝试按类型取值 */
                try {
                    s += "    value = " + d.getInteger(d.getKey(i)) + "\n";
                } catch (e3) {
                    try { s += "    value = " + d.getDouble(d.getKey(i)) + "\n"; }
                    catch (e4) {
                        try { s += "    value = " + d.getBoolean(d.getKey(i)) + "\n"; }
                        catch (e5) {
                            try { s += "    value = \"" + d.getString(d.getKey(i)) + "\"\n"; }
                            catch (e6) {
                                try { s += "    list.count = " + d.getList(d.getKey(i)).count + "\n"; }
                                catch (e7) {
                                    try { s += "    obj.keys = " + d.getObjectValue(d.getKey(i)).count + "\n"; }
                                    catch (e8) {
                                        try { s += "    reference.type = " + d.getReference(d.getKey(i)).getType() + "\n"; }
                                        catch (e9) { s += "    (无法取值)\n"; }
                                    }
                                }
                            }
                        }
                    }
                }
                s += "\n";
            }
        } catch (eAll) {
            s += "★ 读描述符失败：" + eAll + "\n";
        }

        if (show) { try { alert(s); } catch (eA) {} }
        else this.saveFile(s);
        return s;
    },

    /* 打印 ActionReference 的类型 */
    ref: function (r, show) {
        var s = "===== ActionReference =====\n";
        try { s += "type = " + r.getType() + "  (" + typeIDToStringID(r.getType()) + ")\n"; }
        catch (e0) { try { s += "type = " + r.getType() + "\n"; } catch (e1) { s += "type = ?\n"; } }
        try { s += "name = " + r.getName() + "\n"; } catch (e2) {}
        try { s += "index = " + r.getIndex() + "\n"; } catch (e3) {}
        try { s += "identifier = " + r.getIdentifier() + "\n"; } catch (e4) {}
        try { s += "property = " + typeIDToStringID(r.getProperty()) + "\n"; } catch (e5) {}

        if (show) { try { alert(s); } catch (e6) {} }
        else this.saveFile(s);
        return s;
    }
};

/* 挂到全局，方便别的脚本 $.evalFile 后直接调用 */
try { $.global.PSJSX_prt = PSJSX_prt; } catch (eG) {}

/* =========================================================================
 * 直接运行时：按 CONFIG 打印
 * ========================================================================= */
function runDemo() {
    var doc = null;
    try { doc = app.activeDocument; } catch (e0) { doc = null; }
    if (!doc) { alert("没有打开的文档。"); return; }

    PSJSX_prt.clear();

    var head = [];
    head.push("===== ps 工具_打印对象属性 =====");
    head.push("时间：" + (new Date()).toString());
    head.push("文档：" + doc.name);
    head.push("");

    try { head.push("--- 文档对象（部分）---"); } catch (e1) {}
    PSJSX_prt.saveFile(head.join("\n") + "\n");

    try {
        if (CONFIG.target === "activeDocument") {
            PSJSX_prt.op(doc, CONFIG.show);
        } else if (CONFIG.target === "selection") {
            PSJSX_prt.op(doc.selection, CONFIG.show);
        } else if (CONFIG.target === "layerDescriptor") {
            /* ★ 最常用：dump 当前图层的完整描述符（能看清所有键，不用猜 ✗） */
            var ref = new ActionReference();
            ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            var d = executeActionGet(ref);
            PSJSX_prt.desc(d, CONFIG.show);
        } else {
            /* activeLayer */
            var L = doc.activeLayer;
            PSJSX_prt.op(L, CONFIG.show);
        }
    } catch (e2) {
        PSJSX_prt.saveFile("★ 打印失败：" + e2 + "\n");
    }

    var tail = "\n\n输出：%TEMP%\\psjsx_objprint.txt\n";
    try { alert("已打印。\n\n目标：" + CONFIG.target + "\n输出：%TEMP%\\psjsx_objprint.txt"); } catch (e3) {}
}

try { runDemo(); } catch (eAll) {
    try { alert("出错：" + eAll); } catch (e2) {}
}

})();
