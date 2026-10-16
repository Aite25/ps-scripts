// ===========================================================================
// 诊断_AE_工程结构
// ---------------------------------------------------------------------------
// 用途：把 AE 工程里的真实结构打印出来，确认：
//   · __AE_jsonCopies 在 AE 里是【合成】（precomp）还是【文件夹】（FolderItem）
//   · 副本层（__AE_图层 11 / __AE_图层 10）到底在哪一层合成里
//   · JSON 里提到的文件夹（如"名字"）在 AE 里对应什么（合成？图层？）
//   · 每个合成的顶层图层清单（名字 / 类型 / index / enabled / preserveTransparency）
//
// 为什么需要：ps 07 建的 __AE_jsonCopies 是个文件夹，
//   AE 导入 PSD 时【每个 LayerSet 都会生成 precomp】，
//   所以副本层很可能在 __AE_jsonCopies 这个【合成】内部，
//   而引擎原来只在各合成顶层按名字找 → 找不到。
//
// 只读，不改工程。报告写 %TEMP%，并弹窗显示。
// ===========================================================================

(function () {

var OUT = [];
function p(s) { OUT.push(s); }

function yes(b) { return b ? "是" : "否"; }

function layerInfo(comp, L) {
    var s = "      [" + L.index + "] ";
    var ty = "?";
    try {
        if (L instanceof AVLayer) ty = "AVLayer";
        else if (L instanceof TextLayer) ty = "TextLayer";
        else if (L instanceof ShapeLayer) ty = "ShapeLayer";
        else if (L instanceof CameraLayer) ty = "CameraLayer";
        else if (L instanceof LightLayer) ty = "LightLayer";
        else ty = "其他";
    } catch (e0) {}
    s += ty + "  「" + L.name + "」";
    try { s += "  enabled=" + L.enabled; } catch (e1) {}
    try { s += "  preserveTransparency=" + L.preserveTransparency; } catch (e2) {}
    try { if (L.source) s += "  源=「" + L.source.name + "」(" + (L.source instanceof CompItem ? "合成" : "素材") + ")"; } catch (e3) {}
    try { if (L.parent) s += "  父级=「" + L.parent.name + "」"; } catch (e4) {}
    return s;
}

function dumpComp(comp) {
    p("  ● 合成「" + comp.name + "」  " + comp.width + "x" + comp.height +
      "  时长 " + (Math.round(comp.duration * 100) / 100) + "s  图层数 " + comp.numLayers);
    for (var i = 1; i <= comp.numLayers; i++) {
        var L = null; try { L = comp.layer(i); } catch (e) { continue; }
        if (L) p(layerInfo(comp, L));
    }
    p("");
}

function main() {
    p("诊断_AE_工程结构 —— " + (new Date()).toString());
    p("AE 版本：" + app.version);
    if (!app.project) { p("没有打开的工程"); return; }
    p("工程文件：" + (app.project.file ? app.project.file.fsName : "(未保存)"));
    p("");

    /* ---- 1) 全工程递归列出所有项 ---- */
    p("== 工程项总览（递归）==");
    (function rec(folder, indent) {
        for (var i = 1; i <= folder.numItems; i++) {
            var it = folder.item(i);
            var kind = "?";
            try {
                if (it instanceof CompItem) kind = "合成";
                else if (it instanceof FolderItem) kind = "文件夾(FolderItem)";
                else if (it instanceof FootageItem) {
                    var fk = "素材"; try { if (it.mainSource && it.mainSource instanceof SolidSource) fk = "纯色"; } catch (eS) {}
                    kind = fk;
                }
            } catch (e) {}
            p("  " + indent + kind + "  「" + it.name + "」" +
              (it instanceof CompItem ? ("  " + it.width + "x" + it.height + "  图层 " + it.numLayers) : ""));
            if (it instanceof FolderItem) rec(it, indent + "    ");
        }
    })(app.project.rootFolder, "");
    p("");

    /* ---- 2) 重点看：__AE_jsonCopies 是什么 ---- */
    p("== ★ 重点排查 ==");
    var names = ["__AE_jsonCopies"];
    for (var n = 0; n < names.length; n++) {
        var nm = names[n];
        var found = null, foundKind = "";
        (function rec2(folder) {
            for (var i = 1; i <= folder.numItems && !found; i++) {
                var it = folder.item(i);
                if (it.name === nm) {
                    found = it;
                    foundKind = (it instanceof CompItem) ? "合成(precomp)" :
                                ((it instanceof FolderItem) ? "文件夾(FolderItem)" : "素材");
                    return;
                }
                if (it instanceof FolderItem) { rec2(it); if (found) return; }
            }
        })(app.project.rootFolder);
        if (found) {
            p("  「" + nm + "」在 AE 里是：" + foundKind);
            if (found instanceof CompItem) {
                p("    ★★ 是合成！副本层很可能在这个合成【内部】——");
                p("       而引擎原来只在各合成顶层按名字找，所以会【找不到副本层】。");
                p("       这个合成里的图层：");
                for (var k = 1; k <= found.numLayers; k++) {
                    var LL = null; try { LL = found.layer(k); } catch (e) {}
                    if (LL) p(layerInfo(found, LL));
                }
                p("    ★ 父级合成（谁引用了它）：");
                var usedBy = [];
                (function rec3(folder) {
                    for (var i = 1; i <= folder.numItems; i++) {
                        var it = folder.item(i);
                        if (it instanceof CompItem) {
                            for (var k2 = 1; k2 <= it.numLayers; k2++) {
                                var L2 = null; try { L2 = it.layer(k2); } catch (e) { continue; }
                                try { if (L2 && L2.source === found) usedBy.push("「" + it.name + "」的第 " + k2 + " 层「" + L2.name + "」"); } catch (e2) {}
                            }
                        } else if (it instanceof FolderItem) rec3(it);
                    }
                })(app.project.rootFolder);
                if (usedBy.length === 0) p("      （没有任何合成引用它）");
                for (var u = 0; u < usedBy.length; u++) p("      " + usedBy[u]);
            } else if (found instanceof FolderItem) {
                p("    （是 FolderItem，那副本层应该在某个合成顶层 —— 引擎的查找方式没问题）");
            }
        } else {
            p("  「" + nm + "」：工程里【找不到】");
        }
    }
    p("");

    /* ---- 3) 找副本层（__AE_ 开头）到底在哪 ---- */
    p("== 找所有 __AE_ 开头的图层（副本层）==");
    var any = false;
    (function rec4(folder) {
        for (var i = 1; i <= folder.numItems; i++) {
            var it = folder.item(i);
            if (it instanceof CompItem) {
                for (var k = 1; k <= it.numLayers; k++) {
                    var L = null; try { L = it.layer(k); } catch (e) { continue; }
                    if (L && ("" + L.name).indexOf("__AE_") === 0) {
                        any = true;
                        p("  合成「" + it.name + "」 " + layerInfo(it, L));
                    }
                }
            } else if (it instanceof FolderItem) rec4(it);
        }
    })(app.project.rootFolder);
    if (!any) p("  ★ 一个都没找到！说明 AE 导入时把副本层改名了，或者根本没导入。");
    p("");

    /* ---- 4) 找 JSON 里提到的文件夹名（"名字"）---- */
    p("== 找 JSON 里的文件夹「名字」==");
    var target = "名字", hitAny = false;
    (function rec5(folder) {
        for (var i = 1; i <= folder.numItems; i++) {
            var it = folder.item(i);
            if (it.name === target) {
                hitAny = true;
                p("  「" + target + "」是 " + ((it instanceof CompItem) ? "合成(precomp)" :
                  ((it instanceof FolderItem) ? "文件夾(FolderItem)" : "素材")));
            }
            if (it instanceof FolderItem) rec5(it);
        }
    })(app.project.rootFolder);
    if (!hitAny) p("  ★ 找不到「" + target + "」");
    p("");

    /* ---- 5) 所有合成的顶层图层清单（看引擎按名字找能不能找到）---- */
    p("== 所有合成的顶层图层清单 ==");
    (function rec6(folder) {
        for (var i = 1; i <= folder.numItems; i++) {
            var it = folder.item(i);
            if (it instanceof CompItem) dumpComp(it);
            else if (it instanceof FolderItem) rec6(it);
        }
    })(app.project.rootFolder);
}

try { main(); } catch (eM) {
    p("整体出错：" + eM);
    try { p("（行 " + eM.line + "）"); } catch (e2) {}
}

/* ---- 6) 脚本目录自检：查清 getFiles 为什么枚举不到引擎 ---- */
p("== 脚本目录自检 ==");
try {
    var self = File($.fileName);
    p("  $.fileName（原始）= " + $.fileName);
    p("  File($.fileName).fsName = " + (self ? self.fsName : "?"));
    var d = self ? self.parent : null;
    p("  所在目录 = " + (d ? d.fsName : "?"));
    if (d) {
        p("  ★ 目录里 getFiles(\"*.jsx\") 的结果：");
        var g1 = d.getFiles("*.jsx");
        p("     数量 = " + (g1 ? g1.length : "null"));
        if (g1) for (var gi = 0; gi < g1.length; gi++) p("       - " + g1[gi].name);
        p("  ★ 目录里 getFiles()（不带通配）的结果：");
        var g2 = d.getFiles();
        p("     数量 = " + (g2 ? g2.length : "null"));
        if (g2) for (var gj = 0; gj < Math.min(g2.length, 40); gj++) p("       - " + g2[gj].name);
        /* 直接按完整文件名试（绕开枚举） */
        p("  ★ 直接按完整文件名试 File()：");
        var tryNames = ["ae_lib 引擎_应用AE指令.jsx", "ae 08 应用AE指令JSON.jsx", "ae 诊断_工程结构.jsx"];
        for (var ti = 0; ti < tryNames.length; ti++) {
            var tf = File(d.fsName + "/" + tryNames[ti]);
            p("      " + tryNames[ti] + " -> exists=" + (tf ? tf.exists : "?"));
        }
    }
} catch (eSelf) { p("  自检出错：" + eSelf); }
p("");
var txt = OUT.join("\n");
var path = "";
try {
    var f = File(Folder.temp.fsName + "/psjsx_ae_structure.txt");
    f.encoding = "UTF-8"; f.open("w"); f.write(txt + "\n"); f.close();
    path = f.fsName;
} catch (eW) { path = "(写报告失败 " + eW + ")"; }
try { alert(txt.substring(0, 1500) + "\n\n……（完整报告）\n" + path); } catch (eA) {}

})();