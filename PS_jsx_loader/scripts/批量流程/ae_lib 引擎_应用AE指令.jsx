// ===========================================================================
// AE 共用引擎：读 ps 07 生成的 JSON，对 AE 工程做操作
// ===========================================================================
// 【这不是给人直接双击跑的入口】它被 批量流程\ae 08 应用AE指令JSON.jsx 用
// $.evalFile 加载，调用其中的全局入口 AEHandoffRun()。
//
// ===================== 当前方案（v2，按用户要求改的） =====================
//   对每个 clipAboveFolder 段：
//     ① 关掉 __AE_jsonCopies 这个合成的【眼睛】
//        （在父合成里把引用它的那一层 enabled = false）
//     ② 把副本层从 __AE_jsonCopies 里【复制】到目标合成
//        · 目标合成 = JSON 里 folder.containerChain 那条"图层结构路径"所指的合成
//          （★ 不用合成名字定位 —— 合成可以重名，工程里就有两个「名字」合成）
//        · 落点位置用 index 计算（★ 减去被 AE 丢掉的剪贴蒙版图层）
//        · 复制过去后【还原成 PS 里的原名】（去掉 __AE_ 前缀）
//     ③ 给副本设【alpha 遮罩】，遮罩层 = JSON 里写的那个"文件夹合成"
//        （不再使用 Preserve Underlying Transparency）
//
//   ★ 全程包在【一个】AE 撤销组里（app.beginUndoGroup / endUndoGroup），
//     跑完 Ctrl+Z 一次全撤。
//
// ===================== AE 与 PS 的 index 差异（用户指出） =====================
//   AE 导入 psd/psb 时会【无视剪贴蒙版图层】，所以 AE 里的图层 index 跟
//   PS 里的 index 对不上。JSON 里同时给了 psIndexInContainer 和
//   换算后的 aeIndexInContainer，本脚本优先用后者。
// ===========================================================================

/* ===================== 全局入口（入口脚本调用它） ===================== */
/* ===================== 报告即时落盘 ===================== */
/* 踩过的坑（两道）：
 *   ① 报告原来是在 AE_Apply 最后才整体写文件 -> 中途失败就什么都没留下。
 *      改成"边跑边写"。
 *   ② 但 ExtendScript 的 File.write 是【缓冲】的 —— 只有 close() 才真正落盘。
 *      实测：脚本卡在最后的 alert 上时，报告文件是【0 字节且被占用】，
 *      等于还是读不到任何内容。
 *   所以现在改成：每写一行就"打开(追加) -> 写 -> 关闭"，立刻落盘。
 *   文件很小（百来行），这点开销可以忽略。
 */
/* ===================== 报告即时落盘（双路径，防被占用） ===================== */
/* 踩过的坑（两道）：
 *   ① 报告原来是在 AE_Apply 最后才整体写文件 -> 中途失败就什么都没留下。改成"边跑边写"。
 *   ② ExtendScript 的 File.write 是【缓冲】的，只有 close() 才落盘。
 *      实测卡在弹窗上时报告是 0 字节且被占用。改成每行"开-写-关"，立刻落盘。
 *   ③ close() 没放 finally -> write 一抛错句柄泄漏 -> 文件被 AE 一直占用。
 *      实测：某次运行报告只有 2 字节（只写进一个空行），其余全被占用挡住。
 *      close 一律放 finally；并且加【双路径兜底】：
 *        主路径写不进去（被锁/权限/路径异常）就自动切到 %TEMP% 里同名文件继续写，
 *        并在报告里说明切到了哪里。
 */
/* ===================== 报告即时落盘（全新文件名 + 双写，防被占用） ===================== */
/* 踩过的坑（三道）：
 *   ① 报告原来在 AE_Apply 最后才整体写 -> 中途失败就什么都没留下。改成"边跑边写"。
 *   ② ExtendScript 的 File.write 是【缓冲】的，只有 close() 才落盘。改成每行"开-写-关"。
 *   ③ close() 没放 finally -> write 一抛错句柄泄漏 -> 文件被 AE 一直占用。
 *      close 一律放 finally。
 *   ④ ★ 即使这样，实测仍有两次运行的报告只有【2 字节】（只写进一个空行），
 *      而且 %TEMP% 兜底文件也没生成 —— 说明那个文件名已被 AE 里更早的泄漏句柄
 *      "幽灵占用"，新建同名文件时句柄错乱，open 报成功但数据不知去向。
 *   => 所以现在【每次运行都用带时间戳的全新文件名】作为主报告（绝不可能被预先占用），
 *      同时【尽力】再写一份到 JSON 旁边（方便查看）。弹窗里会把两个路径都列出来。
 */
var AE_RPT = { path: "", path2: "", stamp: "" };

function AE_rptStamp() {
    var d = new Date();
    function p2(n) { return (n < 10 ? "0" : "") + n; }
    return "" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "_" +
           p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
}

/* 往指定路径追加一行；成功返回 true */
function AE_rptWriteTo(path, s) {
    if (!path) return false;
    var rf = null;
    try {
        rf = File(path);
        rf.encoding = "UTF-8";
        if (!rf.open("a")) return false;
        var okW = true;
        try { rf.write(s + "\n"); } catch (eW) { okW = false; }
        finally { try { rf.close(); } catch (eC) {} }
        return okW;
    } catch (e) {
        try { if (rf) rf.close(); } catch (e2) {}
        return false;
    }
}

/* 建一个空文件（能建就返回 true） */
function AE_rptTouch(path) {
    var rf = null;
    try {
        rf = File(path);
        rf.encoding = "UTF-8";
        if (!rf.open("w")) { try { rf.close(); } catch (e0) {} return false; }
        try { rf.write(""); } catch (eW) {} finally { try { rf.close(); } catch (eC) {} }
        return true;
    } catch (e) { try { if (rf) rf.close(); } catch (e2) {} return false; }
}

function AE_rptOpen(jsonFile) {
    var base = jsonFile ? ("" + jsonFile.name).replace(/\.json$/i, "") : "ae08";
    AE_RPT.stamp = AE_rptStamp();
    /* ★ 主报告：默认放【桌面】，文件名带时间戳 —— 最好找，且不可能被预先占用。
       桌面拿不到就退回 %TEMP%。
       ★★ 静默模式（$.global.AE_HANDOFF_QUIET = true，批量脚本 ae 09 会设）：
          主报告改放 %TEMP%，避免批量处理几十个文件时把桌面堆满。 */
    var __quiet = false;
    try { __quiet = !!$.global.AE_HANDOFF_QUIET; } catch (eQ) {}
    var __dir = "";
    if (__quiet) {
        try { __dir = Folder.temp.fsName; } catch (eQ2) { __dir = ""; }
    } else {
        try { __dir = Folder.desktop.fsName; } catch (eD) { __dir = ""; }
    }
    if (!__dir) { try { __dir = Folder.temp.fsName; } catch (eT) { __dir = ""; } }
    AE_RPT.path = __dir + "/ae08报告_" + base + "_" + AE_RPT.stamp + ".txt";
    /* 次报告：JSON 旁边（方便查看；被占用也不影响主报告） */
    var __dir2 = (jsonFile && jsonFile.parent) ? jsonFile.parent.fsName : Folder.temp.fsName;
    AE_RPT.path2 = __dir2 + "/" + base + "_ae08报告.txt";

    var ok1 = AE_rptTouch(AE_RPT.path);
    var ok2 = AE_rptTouch(AE_RPT.path2);

    AE_rptWrite("===== ae 08 应用AE指令JSON 报告 =====");
    AE_rptWrite("时间：" + (new Date()).toString());
    AE_rptWrite("JSON：" + (jsonFile ? jsonFile.fsName : "?"));
    AE_rptWrite("主报告：" + AE_RPT.path + (ok1 ? "" : "　★ 建文件失败"));
    AE_rptWrite("次报告：" + AE_RPT.path2 + (ok2 ? "" : "　★ 建文件失败（不影响主报告）"));
    AE_rptWrite("");
}

function AE_rptWrite(s) {
    /* ★ 只写主报告（每行双写两份太慢）。
       次报告（JSON 旁边那份）在收尾时【整体写一次】即可。 */
    AE_rptWriteTo(AE_RPT.path, s);
}

function AE_rptClose() {
    /* 每行都即时落盘且句柄即时释放，这里不留任何打开的句柄。 */
    AE_rptWrite("（报告已即时落盘；文件句柄已释放，不会被 AE 占用）");
    AE_rptWrite("主报告路径：" + AE_RPT.path);
}

function AE_mkReport() {
    var arr = [];
    return {
        push: function (s) { arr.push(s); AE_rptWrite("  " + s); return arr.length; },
        join: function (sep) { return arr.join(sep); },
        toString: function () { return arr.join("\n"); }
    };
}

function AEHandoffRun() {
    var jsonPath = "";
    try { jsonPath = $.global.AE_HANDOFF_JSON || ""; } catch (e0) {}
    var f = null;
    if (jsonPath) f = File(jsonPath);
    else f = File.openDialog("选择 ps 07 生成的 _ae.json", "*.json");

    /* ★ 一拿到 JSON 就建报告文件，后面边跑边写 —— 中途失败也能留下线索 */
    if (f && f.exists) AE_rptOpen(f);
    else AE_rptOpen(null);

    if (!f || !f.exists) {
        AE_rptWrite("★ 没有选择 / 找不到 JSON：" + jsonPath);
        AE_rptClose();
        if (!($.global.AE_HANDOFF_QUIET)) { alert("没有选择/找不到 JSON：" + jsonPath); }
        return;
    }

    var data;
    try { data = AE_ReadJson(f); }
    catch (eR) {
        AE_rptWrite("★ 读 JSON 失败：" + eR);
        AE_rptClose();
        if (!($.global.AE_HANDOFF_QUIET)) { alert("读 JSON 失败：" + eR + "\n\n" + (f ? f.fsName : "")); }
        return;
    }

    AE_rptWrite("JSON 读取成功，开始应用。");
    AE_rptWrite("");
    try { AE_Apply(data, f); }
    catch (eAll) {
        AE_rptWrite("");
        AE_rptWrite("★★ AE_Apply 整体出错：" + eAll);
        try { AE_rptWrite("   （行 " + eAll.line + "）"); } catch (e2) {}
    }
    AE_rptWrite("");
    AE_rptWrite("报告结束。" + (AE_RPT.path ? ("　文件：" + AE_RPT.path) : ""));
    AE_rptClose();
}

/* ===================== 小工具 ===================== */
function AE_has(o, k) { try { return o[k] !== undefined && o[k] !== null; } catch (e) { return false; } }
function AE_S(v, d) { try { return (v === undefined || v === null) ? d : ("" + v); } catch (e) { return d; } }
function AE_N(v, d) { try { var n = Number(v); return isNaN(n) ? d : n; } catch (e) { return d; } }

/* ★★ 按名字找一个工程项（任意类型，【递归】搜索）★★
   踩过的坑：原来只遍历 app.project.rootFolder 的第一层，
   而 AE 导入 psd/psb 时会把所有拆出来的合成/素材放进一个
   「<文档名> Layers」文件夹里 —— 所以 __AE_结构 这类合成
   在根级根本找不到，永远返回 null（引擎报"找不到镜像根（可能没导入）"）。
   现在递归进 FolderItem 里找；优先返回【合成】，其次别的类型。 */
function AE_findItemByName(name, inFolder) {
    var root = inFolder ? inFolder : app.project.rootFolder;
    var anyHit = null;
    var res = null;
    (function rec(folder, depth) {
        if (res || depth > 20) return;
        for (var i = 1; i <= folder.numItems && !res; i++) {
            var it = folder.item(i);
            if (it.name === name) {
                var isComp = false;
                try { isComp = (it instanceof CompItem); } catch (eC) {}
                if (isComp) { res = it; return; }
                if (!anyHit) anyHit = it;   /* 记下第一个同名项，找不到合成时用它 */
            }
            var isFolder = false;
            try { isFolder = (it instanceof FolderItem); } catch (eF) {}
            if (isFolder) { rec(it, depth + 1); if (res) return; }
        }
    })(root, 0);
    return res ? res : anyHit;
}

/* 在合成里按名字找一层 */
function AE_findLayerInComp(comp, name) {
    if (!comp) return null;
    for (var i = 1; i <= comp.numLayers; i++) {
        var L = null; try { L = comp.layer(i); } catch (e) { continue; }
        if (L && L.name === name) return L;
    }
    return null;
}

/* ★★ 按"镜像链"找到【放副本的那个合成】（用户的新方案）★★
 * ps 07 在文档顶层建了一个镜像文件夹（JSON 里的 mirrorRootName，如 __AE_结构），
 * 里面按原文档的文件夹层级逐层建同名文件夹，副本放在最内层。
 * 导入 AE 后这些文件夹都变成【合成(precomp)】。
 * 所以这里：进 mirrorRoot 合成 → 按 mirrorChain 逐段进入同名 precomp → 拿到最内层合成。
 * ★ 好处：完全不用管原文档里那些重名合成 / 剪贴层的干扰。
 * 返回 { comp: CompItem, logs: [...] } 或 { comp: null, logs: [...] } */
/* 走镜像链 stepCount 段，返回到达的那个合成。
   stepCount = chain.length      -> 最内层（放副本的那个合成，镜像是目标文件夹本身）
   stepCount = chain.length - 1  -> 倒数第二层（包含目标文件夹那一层的合成 = 目标合成）
   这样【目标合成】也能从镜像推出来，完全不依赖原文档的 containerChain。
   镜像的最大价值就在这里：AE 端所有定位都在镜像里完成，不受重名/剪贴层干扰。 */
function AE_walkMirror(mirrorRootName, mirrorChain, stepCount, report) {
    var logs = [];
    if (!mirrorRootName) { logs.push("    （JSON 里没有 mirrorRootName，无法用镜像结构）"); return { comp: null, logs: logs }; }
    var root = AE_findItemByName(mirrorRootName);
    if (!root) {
        logs.push("    ★ 找不到镜像根「" + mirrorRootName + "」");
        logs.push("      可能原因：(1) ps 07 之后没保存 PSD  (2) AE 里没重新导入那份 PSD");
        logs.push("                 (3) 导入时该图层组眼睛关着，被 AE 跳过了");
        return { comp: null, logs: logs };
    }
    var cur = null;
    try { if (root instanceof CompItem) cur = root; } catch (e0) {}
    if (!cur) { logs.push("    ★ 「" + mirrorRootName + "」在 AE 里不是合成"); return { comp: null, logs: logs }; }
    logs.push("    镜像根「" + mirrorRootName + "」（" + cur.numLayers + " 层）");

    var chain = mirrorChain || [];
    if (stepCount === undefined || stepCount === null) stepCount = chain.length;
    if (stepCount > chain.length) stepCount = chain.length;
    if (stepCount < 0) stepCount = 0;
    for (var ci = 0; ci < stepCount; ci++) {
        var want = "" + chain[ci];
        var found = null;
        for (var k = 1; k <= cur.numLayers; k++) {
            var L = null; try { L = cur.layer(k); } catch (e1) { continue; }
            var src = null; try { src = L ? L.source : null; } catch (e2) {}
            if (src && (src instanceof CompItem) && src.name === want) { found = src; break; }
        }
        if (!found) {
            logs.push("    ★ 镜像里走到「" + want + "」时找不到同名合成层");
            return { comp: null, logs: logs };
        }
        cur = found;
        logs.push("    → 镜像进入「" + want + "」（" + cur.numLayers + " 层）");
    }
    logs.push("    ✔ 走到「" + cur.name + "」（" + cur.numLayers + " 层，走了 " + stepCount + " 段）");
    return { comp: cur, logs: logs };
}

/* 兼容旧名字：取最内层（放副本的那个合成） */
function AE_findMirrorLeaf(mirrorRootName, mirrorChain, report) {
    return AE_walkMirror(mirrorRootName, mirrorChain, (mirrorChain ? mirrorChain.length : 0), report);
}

/* ★ 按"图层结构路径"定位目标合成（不用名字，避免重名歧义）
   JSON 里的 folder.containerChain 是从文档根开始的【文件夹名链】，
   例如 ["标题","标题","CN 烟火邀星河","名字","名字"]。
   在 AE 导入的工程里，这些"文件夹"对应一层层【合成(precomp)】。
   做法：先找到主合成（引用 __AE_jsonCopies 的那个），再逐段往里走：
     在当前合成里找一层，它的【源】是个合成、且名字 == 链上的下一段名；
     找到就把 current 换成那个源合成，继续下一段。
   返回 { comp: CompItem, logs: [...], chainUsed: [...] } */
/* ★★ 按"图层结构路径"定位【目标合成】（带回溯搜索 + 终点校验）★★
 * JSON 里的 folder.containerChain 是从文档根开始的【文件夹名链】，
 *   例：["标题","标题","CN 烟火邀星河","名字"]
 * 做法：从主合成开始，逐段在当前合成里找"源是合成、且源的名字 == 链上这一段"的图层；
 *   找到就把 current 换成那个源合成，继续下一段。
 *
 * ★★ 为什么要【回溯】★★
 *   工程里有【重名合成】（实测有两个「标题」、两个「名字」），
 *   所以某一段可能有多个候选图层 —— 只取第一个可能走进死路或走错分支。
 *   这里用递归回溯：所有候选都试一遍，返回【能走到最后】的那条路。
 *
 * ★★ 为什么要【终点校验】★★
 *   走完整条链之后，目标合成里必须存在名为 requireLayerName 的那一层
 *   （= 我们要往上放副本的那个文件夹，例如「名字」）。
 *   校验不过的分支直接剪掉，避免误选到镜像树/别的同名分支。
 *
 * 返回 { comp, logs, chainUsed } 或 { comp: null, logs } */
/* 列出合成里的图层名（诊断用） */
function AE_listLayerNames(comp, max) {
    var out = [];
    try {
        for (var i = 1; i <= comp.numLayers && out.length < (max || 20); i++) {
            var L = null; try { L = comp.layer(i); } catch (e) { continue; }
            var nm = ""; try { nm = "" + L.name; } catch (e2) {}
            out.push(i + "." + nm);
        }
    } catch (e0) {}
    return out.join(" | ");
}

/* ==========================================================================
 * ★★ 处理 folderMask：给"代表文件夹的那一层"设【亮度遮罩 LUMA】★★
 * --------------------------------------------------------------------------
 * 前置：ps 06 已经把文件夹的蒙版提取成一张黑/白图层，
 *       命名 = 文件夹名 + " mask"，放在文件夹正上方、隐藏、不是剪贴蒙版。
 * AE 这边要做的：把代表该文件夹的那一层的【亮度遮罩】设成这张黑白图。
 *
 * 注意：蒙版黑白图在 PS 里是【隐藏】的，AE 导入隐藏的普通图层会变成 enabled=false，
 *       这没关系 —— 亮度遮罩用的就是这种"关着灯的供体层"。
 *       所以这里【不强行打开它的眼睛】（否则黑白图会盖在画面上）。
 * ========================================================================== */
/* ★★ 共用：按 containerChain 定位到"包含某文件夹那一层"的合成与那一层 ★★
 * 返回 { comp, layer, logs } 或 { comp: null, layer: null, logs }
 * 供 folderMask / folderStyles 两种 op 共用。 */
function AE_resolveFolderLayer(op, report, nm) {
    var tgt = op.target || op.folder || {};
    var path = AE_S(tgt.path, "");
    var chain = op.containerChain || (op.folder && op.folder.containerChain) || [];
    if (!chain.length && path) {
        var parts = ("" + path).split(" / ");
        if (parts.length > 0) parts.pop();
        chain = parts;
    }
    report.push("  容器链：" + (chain.length ? chain.join(" → ") : "(空)"));
    if (!chain.length) {
        report.push("  · 容器链为空（文件夹在文档根，或 JSON 是旧版），跳过");
        return { comp: null, layer: null };
    }
    report.push("  （正在回溯搜索目标合成，最多访问 4000 个节点）…");
    var r = AE_resolveCompByChain(chain, report, nm);
    report.push("  （搜索返回）");
    for (var i = 0; i < r.logs.length; i++) report.push("    " + r.logs[i]);
    if (!r.comp) { report.push("  ★ 定位目标合成失败"); return { comp: null, layer: null }; }
    report.push("  ✔ 目标合成 = 「" + r.comp.name + "」（" + r.comp.numLayers + " 层）");

    var L = AE_findLayerInComp(r.comp, nm);
    if (!L) {
        report.push("  ★ 在「" + r.comp.name + "」里找不到文件夹层「" + nm + "」");
        report.push("    （该合成里的图层：" + AE_listLayerNames(r.comp, 24) + "）");
        return { comp: r.comp, layer: null };
    }
    report.push("  找到文件夹层「" + nm + "」（index=" + L.index + "，眼睛=" +
                ((function () { try { return L.enabled ? "开" : "关"; } catch (e) { return "?"; } })()) + "）");
    return { comp: r.comp, layer: L };
}

/* ★★ 处理 folderStyles：只有图层样式要还原（没有蒙版）★★
 * 为什么要专门有这个 op：
 *   AE 导入 PSD 时【不会带上图层组(LayerSet)的图层样式】，
 *   所以每个"有样式的文件夹"都必须靠 JSON 记录、在 AE 里重新加上。
 *   踩过的坑：用户报「组 7890」「概率提升原来黑 拷贝」这些嵌套文件夹的样式没被设置，
 *   原因是老逻辑只记录"带蒙版的文件夹"，没蒙版的文件夹样式被整段漏掉。 */
function AE_handleFolderStyles(op, report) {
    var tgt = op.target || op.folder || {};
    var nm = AE_S(tgt.name, "");
    var path = AE_S(tgt.path, "");
    report.push("  目标文件夹：「" + nm + "」" + (path ? ("　路径：" + path) : ""));
    if (!nm) { report.push("  ★ 记录里没有文件夹名，跳过"); return { ok: false, skip: true }; }
    if (!op.layerEffects) { report.push("  · 这条记录里没有图层样式，跳过"); return { ok: false, skip: true }; }

    var fl = AE_resolveFolderLayer(op, report, nm);
    if (!fl.layer) return { ok: false, skip: true };

    report.push("  图层样式：");
    /* ★ 不在这里直接应用 —— 排进队列，等所有图层操作做完再统一加
       （AE 图层样式走异步工作队列，早加容易在关工程时崩） */
    AE_queueStyleTask(nm, op.layerEffects, "文件夹「" + nm + "」（无蒙版）", report);
    return { ok: true, skip: false };
}

function AE_handleFolderMask(op, report) {
    var tgt = op.target || {};
    var nm = AE_S(tgt.name, "");
    var path = AE_S(tgt.path, "");
    report.push("  目标文件夹：「" + nm + "」" + (path ? ("　路径：" + path) : ""));
    if (!nm) { report.push("  ★ 记录里没有文件夹名，跳过"); return { ok: false, skip: true }; }

    /* ①②③ 定位合成与文件夹层（与 folderStyles 共用同一个解析器） */
    var fl = AE_resolveFolderLayer(op, report, nm);
    if (!fl.layer) return { ok: false, skip: true };
    var comp = fl.comp;
    var folderLayer = fl.layer;

    /* ④ 找蒙版黑白图 */
    var cands = op.maskLayerNames || [];
    if (!cands.length) cands = [nm + " mask"];
    report.push("  蒙版图层候选：" + cands.join(" / "));
    var maskLayer = null, maskName = "";
    for (var c = 0; c < cands.length && !maskLayer; c++) {
        maskLayer = AE_findLayerInComp(comp, cands[c]);
        if (maskLayer) maskName = cands[c];
    }
    if (!maskLayer) {
        report.push("  ★ 在「" + comp.name + "」里找不到蒙版黑白图（ps 06 生成的那张）");
        report.push("    （该合成里的图层：" + AE_listLayerNames(comp, 20) + "）");
        report.push("    【请确认】① 跑过 ps 06 了吗　② ps 07 跑完后保存 PSD 并重新导入 AE 了吗");
        return { ok: false, skip: true };
    }
    report.push("  ✔ 找到蒙版黑白图「" + maskName + "」（index=" + maskLayer.index + "，眼睛=" +
                ((function () { try { return maskLayer.enabled ? "开" : "关"; } catch (e) { return "?"; } })()) + "）");

    /* ⑤ 设【亮度遮罩 LUMA】 */
    var ok = false;
    try {
        if (typeof folderLayer.setTrackMatte === "function") {
            folderLayer.setTrackMatte(maskLayer, TrackMatteType.LUMA);
            ok = true;
            report.push("  ✔ 已用 setTrackMatte 把「" + maskName + "」设为「" + nm + "」的【亮度遮罩 LUMA】");
        }
    } catch (eSTM) {
        report.push("    （setTrackMatte 失败：" + eSTM + "，退回旧办法）");
    }
    if (!ok) {
        try {
            maskLayer.moveBefore(folderLayer);
            folderLayer.trackMatteType = TrackMatteType.LUMA;
            ok = true;
            report.push("  ✔ 已用旧办法（把蒙版层移到文件夹层正上方）设好【亮度遮罩 LUMA】");
        } catch (eOld) {
            report.push("  ✗ 设亮度遮罩失败：" + eOld);
        }
    }
    /* ⑥ 确认结果（不强行改眼睛：黑白图要保持关灯，否则会盖在画面上） */
    if (ok) {
        var tm = "";
        try { tm = "" + folderLayer.trackMatteType; } catch (eT) {}
        report.push("    复查：文件夹层 trackMatteType = " + tm);
        report.push("    （蒙版黑白图保持原样不点亮，亮度遮罩用的就是关灯的供体层）");
    }
    return { ok: ok, skip: !ok, comp: comp, folderLayer: folderLayer };
}

function AE_resolveCompByChain(chain, report, requireLayerName) {
    var logs = [];
    if (!chain || chain.length === 0) { logs.push("    （containerChain 为空，无法按结构定位）"); return { comp: null, logs: logs }; }

    /* ---- 找主合成 ---- */
    var boxName = "__AE_jsonCopies";
    var copiesBox = AE_findItemByName(boxName);
    var mainComp = null;
    if (copiesBox) {
        (function rec(folder) {
            for (var i = 1; i <= folder.numItems && !mainComp; i++) {
                var it = folder.item(i);
                if (it instanceof CompItem) {
                    for (var k = 1; k <= it.numLayers; k++) {
                        var L = null; try { L = it.layer(k); } catch (e1) { continue; }
                        try { if (L && L.source === copiesBox) { mainComp = it; return; } } catch (e2) {}
                    }
                } else if (it instanceof FolderItem) { rec(it); if (mainComp) return; }
            }
        })(app.project.rootFolder);
    }
    if (!mainComp) {
        var best = null, bestN = -1;
        (function rec2(folder) {
            for (var i = 1; i <= folder.numItems; i++) {
                var it = folder.item(i);
                if (it instanceof CompItem) {
                    if (it.numLayers > bestN) { bestN = it.numLayers; best = it; }
                } else if (it instanceof FolderItem) rec2(it);
            }
        })(app.project.rootFolder);
        if (best) { mainComp = best; logs.push("    （没找到引用 __AE_jsonCopies 的合成，改用图层最多的合成当主合成）"); }
    }
    if (!mainComp) { logs.push("    ★ 找不到主合成"); return { comp: null, logs: logs }; }
    logs.push("    主合成 = 「" + mainComp.name + "」（" + mainComp.numLayers + " 层）");

    /* ---- 带回溯的搜索 ---- */
    /* ★★ 访问次数上限：防止在"重名合成很多"的工程里回溯组合爆炸 ★★
       踩过的坑：用户那边出现过"没有弹窗、报告文件被锁住、0 字节"——
       表现就是脚本卡死不动。回溯搜索没有上限时，复杂工程可能指数级展开。
       超过上限就放弃搜索（返回 null，走后面的兜底逻辑），绝不把 AE 卡住。 */
    var MAX_VISITS = 4000;
    var visits = 0;
    var overLimit = false;
    var triedPaths = 0;
    function search(cur, idx, used) {
        visits++;
        if (visits > MAX_VISITS) { overLimit = true; return null; }
        if (idx >= chain.length) {
            triedPaths++;
            /* 终点校验：目标合成里必须有 requireLayerName 那一层 */
            if (requireLayerName) {
                var hasIt = (AE_findLayerInComp(cur, requireLayerName) !== null);
                if (!hasIt) return null;
            }
            return cur;
        }
        var want = "" + chain[idx];
        for (var k = 1; k <= cur.numLayers; k++) {
            if (overLimit) return null;
            var L = null; try { L = cur.layer(k); } catch (e1) { continue; }
            var src = null; try { src = L ? L.source : null; } catch (e2) {}
            var isComp = false; try { isComp = (src instanceof CompItem); } catch (e3) {}
            if (!isComp) continue;
            var sname = ""; try { sname = "" + src.name; } catch (e4) { continue; }
            if (sname !== want) continue;
            /* 防止自引用死循环 */
            var seen = false;
            for (var u = 0; u < used.length; u++) { if (used[u] === src) { seen = true; break; } }
            if (seen) continue;
            var used2 = used.slice(0);
            used2.push(src);
            logs.push("      → 进入「" + sname + "」（" + src.numLayers + " 层）" +
                      ((k > 1 || idx > 0) ? "" : ""));
            var got = search(src, idx + 1, used2);
            if (got) return got;
        }
        return null;
    }

    var found = search(mainComp, 0, [mainComp]);
    logs.push("    共试了 " + triedPaths + " 条能走到终点的路径" + (requireLayerName ? ("，要求终点合成里有「" + requireLayerName + "」层") : "") +
              "　（访问 " + visits + " 个节点" + (overLimit ? "，★已触发上限 " + MAX_VISITS + " 提前退出" : "") + "）");
    if (!found) {
        logs.push("    ★ 走不通（可能是重名分支都不满足终点校验，或结构对不上）");
        return { comp: null, logs: logs };
    }
    logs.push("    ✔ 目标合成 = 「" + found.name + "」（" + found.numLayers + " 层）");
    return { comp: found, logs: logs };
}

/* ===================== 读 JSON ===================== */
function AE_ReadJson(f) {
    if (!f || !f.exists) throw new Error("JSON 文件不存在");
    f.encoding = "UTF-8";
    if (!f.open("r")) throw new Error("打不开 JSON：" + f.fsName);
    var txt = f.read();
    f.close();
    try {
        if (typeof JSON !== "undefined" && JSON.parse) return JSON.parse(txt);
    } catch (eJ) {}
    throw new Error("这个 AE 版本的 ExtendScript 没有内置 JSON.parse，无法读取");
}

/* ===================== ① 关掉 __AE_jsonCopies 合成的眼睛 ===================== */
/* __AE_jsonCopies 在 AE 里是个 precomp，它被某个父合成的一层引用着。
   关掉那一层（enabled=false）就等于"关掉这个合成的眼睛"。 */
function AE_hideCopiesBox(boxName, report) {
    if (!boxName) { report.push("  · JSON 里没有 copyFolderName，跳过"); return false; }
    var box = AE_findItemByName(boxName);
    if (!box) { report.push("  · 找不到工程项「" + boxName + "」，跳过关眼睛"); return false; }

    var shut = 0;
    (function rec(folder) {
        for (var i = 1; i <= folder.numItems; i++) {
            var it = folder.item(i);
            if (it instanceof CompItem) {
                for (var k = 1; k <= it.numLayers; k++) {
                    var L = null; try { L = it.layer(k); } catch (e1) { continue; }
                    var isRef = false;
                    try { isRef = (L && L.source === box); } catch (e2) {}
                    if (!isRef) continue;
                    try {
                        L.enabled = false;
                        shut++;
                        report.push("  ✔ 已关掉「" + it.name + "」里引用「" + boxName + "」的那一层（第 " + k + " 层）");
                    } catch (e3) { report.push("  ✗ 关「" + it.name + "」第 " + k + " 层失败：" + e3); }
                }
            } else if (it instanceof FolderItem) rec(it);
        }
    })(app.project.rootFolder);

    if (shut === 0) report.push("  · 没有任何合成引用「" + boxName + "」，无需关眼睛");
    return shut > 0;
}

/* ===================== ② 把副本复制进目标合成 ===================== */
/* 复制的是 __AE_jsonCopies 合成【内部】的那一层。
   AE 里跨合成复制层用 Layer.copyToComp()（脚本 API 就这一个）。
   ★ 复制过去后还原成 PS 里的原名。 */
function AE_copyOneIntoComp(srcComp, srcName, origName, targetComp, report) {
    var srcLayer = AE_findLayerInComp(srcComp, srcName);
    if (!srcLayer) { report.push("  ★ 在「" + srcComp.name + "」里找不到副本层「" + srcName + "」，跳过"); return null; }

    /* ★★ 不能依赖 copyToComp() 的返回值 ★★
       实测：这个 AE 版本里 copyToComp() 返回 undefined（虽然复制成功了），
       原来直接判断返回值 -> 误报"复制返回空"，整段跳过。
       改成：记录复制前后的图层数，用"新层总是在最上面（index=1）"来定位新层。 */
    var beforeCount = targetComp.numLayers;
    var retVal = undefined, errMsg = "";
    try { retVal = srcLayer.copyToComp(targetComp); }
    catch (eCp) { errMsg = "" + eCp; }

    if (errMsg) { report.push("  ✗ copyToComp 抛错（" + srcName + "）：" + errMsg); return null; }

    var afterCount = targetComp.numLayers;
    var added = afterCount - beforeCount;

    /* 找新层：优先用返回值（如果这个版本有）；否则用图层数变化 + index=1 */
    var newLayer = null;
    try { if (retVal) newLayer = retVal; } catch (eR) {}
    if (!newLayer && added > 0) {
        /* AE 把 copyToComp 复制出来的层放在最上面 */
        try { newLayer = targetComp.layer(1); } catch (e1) {}
    }

    if (!newLayer) {
        report.push("  ✗ 复制「" + srcName + "」失败：图层数 " + beforeCount + " -> " + afterCount +
                    "（变更 " + added + "），也拿不到新层" + (retVal === undefined ? "；copyToComp 返回值是 undefined" : ""));
        return null;
    }

    /* 改名（还原成 PS 里的原名）+ 移到最上面（保证顺序由调用方统一摆） */
    try { newLayer.name = origName; } catch (eNm) {}
    try { if (newLayer.index !== 1) newLayer.moveToBeginning(); } catch (eMv) {}

    /* ★ 打开眼睛：ps 07 复制出来的副本层在 PS 里是关灯的（保证 PS 画面不变），
       到 AE 里是要用的，所以这里必须 enabled = true（用户反馈过"没打开眼睛"）。 */
    var enOK = false;
    try { newLayer.enabled = true; enOK = (newLayer.enabled === true); } catch (eEn) {}
    if (!enOK) report.push("    （⚠ 「" + origName + "」打开眼睛失败）");

    report.push("  · 「" + origName + "」已复制进「" + targetComp.name + "」（图层数 " +
                beforeCount + " -> " + afterCount + "，index=" + newLayer.index + "）");
    return newLayer;
}

/* ===================== ③ 给副本设 alpha 遮罩 ===================== */
/* 遮罩层 = JSON 里写的那个"文件夹合成"（"名字"那一层的源）。
   AE 的规则：遮罩层必须紧挨在目标层【上面】，目标层 trackMatteType = ALPHA。
   做法：把"名字"文件夹那一层【复制一份】放到副本层上面当遮罩源。
   ★ 注意：AE 会自动把遮罩层（matte）的 enabled 设为 false —— 这是 Track Matte
     的正常行为，不是把合成关掉了。 */
/* ===================== ③ 给副本设 alpha 遮罩 ===================== */
/* 遮罩源 = 目标合成里的文件夹层（folderLayer），也就是原文档那个"名字"合成。
 *
 * ★★ 优先用 AE 的 setTrackMatte()（AE 2021 之后有）★★
 *   它可以把【任意同级图层】直接设成遮罩，不需要"遮罩层紧挨在目标层上面"，
 *   所以【不用再复制一份遮罩源层】—— 直接拿目标合成里那个「名字」层当遮罩即可。
 *   （用户指出：AE 2021 之后可以直接把 alpha 遮罩设成任意同级图层。）
 *
 * 拿不到 setTrackMatte 时（老版本 AE），退回旧办法：
 *   复制一份遮罩源层、放到副本层【上面】，再设 trackMatteType = ALPHA。 */
function AE_applyAlphaMatte(targetComp, folderLayer, copyNames, report, matteSrcLayer) {
    if (!targetComp || !folderLayer) { report.push("  · 缺少目标合成或文件夹层，跳过设遮罩"); return 0; }
    var useLayer = matteSrcLayer ? matteSrcLayer : folderLayer;
    var matteSource = null;
    try { matteSource = useLayer.source; } catch (e0) {}
    if (!matteSource) {
        report.push("  · 「" + useLayer.name + "」没有源合成，无法做 alpha 遮罩源，跳过");
        return 0;
    }

    /* 检测这个 AE 版本有没有 setTrackMatte */
    var hasSetTM = false;
    try {
        if (targetComp.numLayers > 0) {
            hasSetTM = (typeof targetComp.layer(1).setTrackMatte === "function");
        }
    } catch (eT) {}
    report.push("    （这个 AE 版本 " + (hasSetTM ? "支持" : "不支持") + " setTrackMatte，用" +
                (hasSetTM ? "直接指定同级图层当遮罩" : "旧办法：复制遮罩源层放到上面") + "）");

    var done = 0;
    for (var i = 0; i < copyNames.length; i++) {
        var nm = copyNames[i];
        var L = AE_findLayerInComp(targetComp, nm);
        if (!L) { report.push("  ★ 找不到刚复制进来的「" + nm + "」，跳过设遮罩"); continue; }

        /* ---- 首选：setTrackMatte(folderLayer, ALPHA) ---- */
        if (hasSetTM) {
            try {
                L.setTrackMatte(useLayer, TrackMatteType.ALPHA);
                /* ★★ AE 设完 track matte 会把【遮罩层自己】的眼睛关掉 ★★
                   （用户反馈："被设置成遮罩的那个图层的眼睛没有被打开"）。
                   但用 setTrackMatte 这套新机制时，遮罩层是可以同时显示内容的，
                   所以这里【强制把遮罩层的眼睛打开】并回读确认。 */
                var mvOK = false, mvErr = "";
                try {
                    useLayer.enabled = true;
                    mvOK = (useLayer.enabled === true);
                } catch (eMvE) { mvErr = "" + eMvE; }
                /* 有时刚设完 matte 立刻改会被 AE 覆盖，隔一层再确认一次 */
                if (!mvOK) {
                    try { useLayer.enabled = true; mvOK = (useLayer.enabled === true); } catch (eMvE2) { mvErr = "" + eMvE2; }
                }
                done++;
                report.push("  ✔ 「" + nm + "」已用 setTrackMatte 直接把「" + useLayer.name +
                            "」设为 alpha 遮罩（图层数不变，没有多余副本）");
                report.push("     遮罩层「" + useLayer.name + "」眼睛=" + (mvOK ? "已打开" : ("★仍关着" + (mvErr ? ("（" + mvErr + "）") : ""))));
                continue;
            } catch (eSTM) {
                report.push("    （setTrackMatte 失败：" + eSTM + "，退回旧办法）");
            }
        }

        /* ---- 退回：复制遮罩源层放到副本上面 ---- */
        try {
            var beforeN = targetComp.numLayers;
            var retM = undefined;
            try { retM = useLayer.duplicate(); } catch (eDup) { report.push("  ✗ duplicate 抛错：" + eDup); continue; }
            var afterN = targetComp.numLayers;
            var matteLayer = null;
            try { if (retM) matteLayer = retM; } catch (eR) {}
            if (!matteLayer && afterN > beforeN) { try { matteLayer = targetComp.layer(1); } catch (e1) {} }
            if (!matteLayer) {
                report.push("  ✗ 给「" + nm + "」设遮罩失败：复制遮罩源层拿不到新层（图层数 " + beforeN + " -> " + afterN + "）");
                continue;
            }
            try { matteLayer.moveBefore(L); } catch (eMv2) { report.push("    （遮罩层 moveBefore 失败：" + eMv2 + "）"); }
            try { matteLayer.name = "__matte_" + nm; } catch (eNm2) {}
            L.trackMatteType = TrackMatteType.ALPHA;
            done++;
            report.push("  ✔ 「" + nm + "」已设 alpha 遮罩（旧办法），遮罩层 = 复制自「" + matteSource.name +
                        "」的「" + matteLayer.name + "」");
        } catch (eM) {
            report.push("  ✗ 给「" + nm + "」设 alpha 遮罩失败：" + eM);
        }
    }
    /* ★ 收尾再统一确认一次：把遮罩源层的眼睛打开（防止中途被 AE 覆盖回去） */
    if (hasSetTM && useLayer) {
        try {
            if (useLayer.enabled !== true) {
                useLayer.enabled = true;
                report.push("    （收尾复查：遮罩层「" + useLayer.name + "」眼睛已重新打开）");
            }
        } catch (eFix) {}
    }
    return done;
}

/* ★★ 全工程搜"名字相等的图层"（最终兜底）★★
   用途：镜像结构因为各种原因找不到时（比如 AE 导入的是没保存的旧 PSD、
   或者隐藏的图层组被 AE 跳过），直接在全工程的每个合成里按名字找副本层。
   找到就返回 { comp, layer }，找不到返回 null。 */
function AE_findLayerAnywhereDeep(name) {
    if (!name) return null;
    var res = null;
    (function rec(folder, depth) {
        if (res || depth > 20) return;
        for (var i = 1; i <= folder.numItems && !res; i++) {
            var it = folder.item(i);
            if (it instanceof CompItem) {
                for (var k = 1; k <= it.numLayers; k++) {
                    var L = null; try { L = it.layer(k); } catch (e1) { continue; }
                    if (L && L.name === name) { res = { comp: it, layer: L }; return; }
                }
            } else if (it instanceof FolderItem) { rec(it, depth + 1); if (res) return; }
        }
    })(app.project.rootFolder, 0);
    return res;
}

/* 在某个合成里找"遮罩源文件夹副本"那一层。
   ps 07 给这类副本加了标识符前缀（JSON: mirrorMaskPrefix，默认 __AE_遮罩_），
   所以优先按前缀找；找不到再退回"任意一个源是合成的层"。 */
function AE_findCompLayer(comp, namePrefix) {
    if (!comp) return null;
    var firstCompLayer = null;
    for (var i = 1; i <= comp.numLayers; i++) {
        var L = null; try { L = comp.layer(i); } catch (e) { continue; }
        var src = null; try { src = L ? L.source : null; } catch (e2) {}
        if (!src) continue;
        var isComp = false; try { isComp = (src instanceof CompItem); } catch (e3) {}
        if (!isComp) continue;
        if (!firstCompLayer) firstCompLayer = L;
        /* ★ 优先返回名字带标识符前缀的那一层 */
        if (namePrefix) {
            try { if (("" + L.name).indexOf(namePrefix) === 0) return L; } catch (e4) {}
        }
    }
    return firstCompLayer;
}

/* ===================== 操作 3：还原文件夹的图层样式 ===================== */
/* ps 07 把文件夹的 PS layerEffects 描述符序列化进了 JSON（op.layerEffects）。
 * 这里在 AE 里把它还原成效果。
 *
 * ★ 关键：PS 里的【文件夹】在 AE 里是一个【合成(precomp)】，合成本身不能加效果；
 *   真正能加效果的是【父合成里引用这个合成的那一层】。
 *   所以先找到“代表这个文件夹的图层”（源是名为 nm 的合成），再往它上面加效果。 */

/* PS 效果键 -> AE 效果候选名（同名效果在不同 AE 版本里名字可能不同，逐个试） */
var AE_FX_MAP = [
    { ps: "dropShadow",   names: ["Drop Shadow", "ADBE Drop Shadow", "投影"], cn: "投影" },
    { ps: "innerShadow",  names: ["Inner Shadow", "ADBE Inner Shadow", "内阴影"], cn: "内阴影" },
        /* ★ 这台 AE 没有图层样式版的外发光（canAddProperty 全 false），
       所以最后两条用 AE 原生的「投影」来模拟（距离设 0 = 四周均匀发光）。 */
    { ps: "outerGlow",    names: ["Outer Glow", "ADBE Outer Glow", "外发光", "Drop Shadow", "ADBE Drop Shadow"],
      cn: "外发光", asShadow: true },
    { ps: "innerGlow",    names: ["Inner Glow", "ADBE Inner Glow", "内发光"], cn: "内发光" },
    { ps: "bevelEmboss",  names: ["Bevel and Emboss", "Bevel Alpha", "ADBE Bevel Alpha", "斜面和浮雕"], cn: "斜面和浮雕" },
    { ps: "satin",        names: ["Satin", "ADBE Satin", "光泽"], cn: "光泽" },
    { ps: "colorOverlay", names: ["Color Overlay", "颜色叠加"], cn: "颜色叠加" },
    { ps: "solidFill",    names: ["Color Overlay", "ADBE Color Overlay", "颜色叠加"], cn: "颜色叠加" },
    { ps: "gradientFill", names: ["Gradient Overlay", "ADBE Gradient Overlay", "渐变叠加"], cn: "渐变叠加" },
    { ps: "patternFill",  names: ["Pattern Overlay", "ADBE Pattern Overlay", "图案叠加"], cn: "图案叠加" },
    { ps: "stroke",       names: ["Stroke", "描边"],            cn: "描边" },
    /* ★ PS 里"描边"的键其实是 frameFX（frameFXMulti），单独列一条 */
    { ps: "frameFX",      names: ["Stroke", "ADBE Stroke", "描边"], cn: "描边(frameFX)" },
    { ps: "satinMulti",   names: ["Satin", "光泽"],             cn: "光泽" },
    { ps: "bevelEmbossMulti", names: ["Bevel and Emboss", "Bevel Alpha"], cn: "斜面和浮雕" },
    /* scale 不是效果（是图层样式的整体缩放），不映射，会进"已忽略"列表 */
];

/* ★★ 找"主合成"（AE 导入 PSD 后那个总合成）★★
 * 优先：引用 __AE_jsonCopies 的那个合成；否则：图层数最多的合成。
 * 用途：定位文件夹样式时，从主合成往下走，这样【不会误进镜像树】。 */
function AE_findMainComp() {
    var boxName = "__AE_jsonCopies";
    var box = AE_findItemByName(boxName);
    var main = null;
    if (box) {
        (function rec(folder) {
            for (var i = 1; i <= folder.numItems && !main; i++) {
                var it = folder.item(i);
                if (it instanceof CompItem) {
                    for (var k = 1; k <= it.numLayers; k++) {
                        var L = null; try { L = it.layer(k); } catch (e1) { continue; }
                        try { if (L && L.source === box) { main = it; return; } } catch (e2) {}
                    }
                } else if (it instanceof FolderItem) { rec(it); if (main) return; }
            }
        })(app.project.rootFolder);
    }
    if (!main) {
        var best = null, bestN = -1;
        (function rec2(folder) {
            for (var i = 1; i <= folder.numItems; i++) {
                var it = folder.item(i);
                if (it instanceof CompItem) {
                    if (it.numLayers > bestN) { bestN = it.numLayers; best = it; }
                } else if (it instanceof FolderItem) rec2(it);
            }
        })(app.project.rootFolder);
        main = best;
    }
    return main;
}

/* ★★ 在【主合成往下】的结构里找"代表名为 nm 的文件夹"的那一层 ★★
 * 为什么从主合成走：镜像树里的合成同名（__AE_ 开头的只是根，里面子层也叫「名字」等），
 *   全工程搜会误命中镜像里的层。从主合成 DFS 就不会进镜像（镜像根那一层的源是 __AE_结构，
 *   不是我们要找的文件夹名）。
 * 跳过图层名以 __AE_ 开头的层。 */
function AE_findFxTarget(nm, rootComp) {
    if (!nm) return null;
    var root = rootComp ? rootComp : AE_findMainComp();
    if (!root) return null;

    /* ★★ 也要有访问上限 + 路径去重，否则同样的合成图可能被指数级重复展开 ★★
       （和 AE_resolveCompByChain 一样的原因：用户那边出现过脚本卡死。） */
    var res = null;
    var fxVisits = 0;
    var FX_MAX = 4000;
    (function rec(comp, depth, path) {
        if (res || depth > 20) return;
        fxVisits++;
        if (fxVisits > FX_MAX) return;
        for (var k = 1; k <= comp.numLayers; k++) {
            if (res || fxVisits > FX_MAX) return;
            var L = null; try { L = comp.layer(k); } catch (e1) { continue; }
            var ln = ""; try { ln = "" + L.name; } catch (e2) {}
            if (ln.indexOf("__AE_") === 0) continue;          /* 跳过镜像相关层 */
            var src = null; try { src = L ? L.source : null; } catch (e3) {}
            var isComp = false; try { isComp = (src instanceof CompItem); } catch (e4) {}
            if (!isComp) continue;
            var sn = ""; try { sn = "" + src.name; } catch (e5) {}
            if (sn === nm) { res = { comp: comp, layer: L, how: "主合成结构里，源是这个合成" }; return; }
            /* 同一条路径上不重复进入（防止环） */
            var seen = false;
            for (var p = 0; p < path.length; p++) { if (path[p] === src) { seen = true; break; } }
            if (seen) continue;
            var path2 = path.slice(0);
            path2.push(src);
            rec(src, depth + 1, path2);
            if (res) return;
        }
    })(root, 0, [root]);
    if (res) return res;
    /* 退回：全工程按图层名找（跳过 __AE_ 开头） */
    var hit = AE_findLayerAnywhereDeep(nm);
    if (hit && ("" + hit.layer.name).indexOf("__AE_") !== 0) {
        return { comp: hit.comp, layer: hit.layer, how: "全工程按图层名找到" };
    }
    return null;
}


/* 把 PS 描述符里的参数尽量映射到 AE 效果的属性上（按名字，去空格小写比较） */
function AE_applyFxParams(ef, one, report) {
    if (!one || typeof one !== "object") return;
    for (var i = 1; i <= ef.numProperties; i++) {
        var p = null;
        try { p = ef.property(i); } catch (e) { continue; }
        if (!p) continue;
        var pn = "";
        try { pn = "" + p.name; } catch (e2) { continue; }
        if (!pn) continue;
        var val = undefined;
        if (one[pn] !== undefined) val = one[pn];
        else {
            var flat = pn.replace(/\s+/g, "").toLowerCase();
            for (var k in one) {
                if (!one.hasOwnProperty(k)) continue;
                if (("" + k).replace(/\s+/g, "").toLowerCase() === flat) { val = one[k]; break; }
            }
        }
        if (val === undefined || val === null) continue;
        var num = null;
        if (typeof val === "object" && val.value !== undefined) num = AE_N(val.value, null);
        else if (typeof val === "number") num = val;
        else if (typeof val === "string") { var n0 = parseFloat(val); if (!isNaN(n0)) num = n0; }
        if (num === null) continue;
        try { p.setValue(num); } catch (e3) {}
    }
}

/* 把 PS 的样式键归一化：去掉末尾的 "Multi"（PS 里"多个实例"的格式）
   例：dropShadowMulti -> dropShadow，solidFillMulti -> solidFill */
function AE_normFxKey(k) {
    var s = "" + k;
    if (s.length > 5 && s.substring(s.length - 5) === "Multi") s = s.substring(0, s.length - 5);
    return s;
}
/* 按归一化后的键在 AE_FX_MAP 里查 */
function AE_fxMapLookup(normKey) {
    for (var i = 0; i < AE_FX_MAP.length; i++) {
        if (AE_FX_MAP[i].ps === normKey) return AE_FX_MAP[i];
    }
    return null;
}
/* multi 形式的值是数组；取第一个 enabled 的（没有就取第一个对象） */
/* ==========================================================================
 * 读一个样式实例的"眼睛"状态（跟 ps 07 那边的 fxEyeOf 是对应关系）
 * --------------------------------------------------------------------------
 * PS 图层样式里每个效果都有自己的勾选框（= 眼睛）。没勾的效果，PS 也会写一整块
 * 默认值进描述符（present=false / enabled=false），所以：
 *   · 光看"键存不存在"判断不出来它到底加没加；
 *   · 必须看 enabled / present 这两个字段。
 * JSON 里这两项 ps 07 已经导出了（见 06 明河卡池图_ae.json：
 *   outerGlow 是 {"enabled":true,"present":true}（加了），
 *   dropShadowMulti 等是 [{"enabled":false,"present":false}]（没加））。
 *
 * 返回：
 *   on         —— 有没有 enabled=true（= PS 里勾上了）
 *   sawEnabled —— 有没有真的读到 enabled 字段（读不到就别据此跳过，免得误杀）
 *   present    —— true / false / null（字段没有）
 * ========================================================================== */
function AE_fxEyeOf(v) {
    var res = { on: false, sawEnabled: false, present: null };
    try {
        if (v === null || v === undefined) return res;
        if (v instanceof Array) {
            for (var q = 0; q < v.length; q++) {
                var e = v[q];
                if (!e || typeof e !== "object") continue;
                if (typeof e.enabled === "boolean") {
                    res.sawEnabled = true;
                    if (e.enabled === true) res.on = true;
                }
                if (typeof e.present === "boolean") res.present = e.present;
                if (res.on) break;
            }
            return res;
        }
        if (typeof v === "object") {
            if (typeof v.enabled === "boolean") { res.sawEnabled = true; res.on = (v.enabled === true); }
            if (typeof v.present === "boolean") res.present = v.present;
        }
    } catch (e) {}
    return res;
}

function AE_pickFxInstance(one) {
    var v = one;
    try { if (v instanceof Array) {
        var pick = null;
        for (var q = 0; q < v.length; q++) {
            if (!v[q] || typeof v[q] !== "object") continue;
            if (pick === null) pick = v[q];
            if (v[q].enabled === true) { pick = v[q]; break; }
        }
        v = pick;
    } } catch (eA) {}
    return v;
}

/* 列出目标图层【已有】的效果名（用于判断 AE 是否已经从 PSD 导入了样式） */
function AE_listEffects(L) {
    var names = [];
    try {
        var grp = L.Effects;
        for (var i = 1; i <= grp.numProperties; i++) {
            var e = null;
            try { e = grp.property(i); } catch (e1) { continue; }
            var n = ""; try { n = "" + e.name; } catch (e2) {}
            if (n) names.push(n);
        }
    } catch (e0) {}
    return names;
}

/* ★★ 开关：是否尝试还原图层样式 ★★
 * 踩过的坑：这台 AE 上 layer.Effects.addProperty("Outer Glow") 会【卡死】
 *   （不抛错、不返回、无弹窗，报告停在那一行）。为免它拖死整轮流程，
 *   这里留一个开关；如果你只想先把"复制 + 遮罩"跑完，把 AE_TRY_FX 改成 false。
 */
var AE_TRY_FX = true;

/* ★★ 是否尝试「用菜单命令加真正的图层样式」★★
 * 默认【关】。原因（用户目视确认 + 报告）：
 *   executeCommand(9000~9008)（图层 > 图层样式）在这台 AE 上执行了但完全不生效，
 *   图层上既没有外发光、也没有「图层样式」这一组。
 *   同样的代码只在 13:50 偶然生效过一次，无法稳定复现（AE 菜单状态问题）。
 *   所以默认跳过这条没用的路（也省时间），直接走原生效果替代。
 * 想再试试就改成 true。 */
var AE_TRY_LAYER_STYLES = true;   /* ★ 用图层样式（能成功的那版逻辑），功能优先 */

/* ★★ 是否允许"用 AE 原生投影 + 距离 0 模拟外发光"的替代方案 ★★
 * 默认【关】。理由（13:44 / 13:45 两次报告踩过）：
 *   真正的图层样式命令 executeCommand(9002) 其实一直是有效的
 *   （13:2x 那次用户确认过参数：不透明度 94、杂色 2、扩展 6、大小 90、范围 49、抖动 0），
 *   但 "canSetEnabled" 这个信号读出来总是 false —— 于是被判"没生效"，
 *   又多做了一遍替代的"投影"，结果画面上看到的反而是错的那个效果。
 * 所以：默认不做替代；只有确认 AE 根本加不了图层样式时，才手动打开这个开关。 */
/* ★★ 是否用 AE 原生效果替代 PS 的图层样式 ★★
 * 默认【开】：真正的图层样式加不上（见 AE_TRY_LAYER_STYLES 的说明），
 * 所以用原生「投影 + 距离 0」近似外发光。用户已同意这个替代。 */
var AE_ALLOW_SHADOW_FALLBACK = false;  /* ★ 不做原生替代，避免叠出错误效果 */

/* ★★ 是否打印"ADBE Layer Styles 属性树"（诊断用）★★
 * 默认【关】。理由（13:50:28 报告踩过）：
 *   dump 会逐项读子属性的 .value，读到第 5 项（outerGlow/color，颜色属性）之后
 *   报告文件就断了 —— 同时之后【样式 2/2 完全没执行】。
 *   AE 的图层样式属性里有些值不能随便读（颜色等），拿它当调试输出有崩溃风险。
 *   而且这个 dump 的使命已经完成：真实属性名都拿到了
 *   （outerGlow/blur、outerGlow/chokeMatte、outerGlow/inputRange、outerGlow/shadingNoise）。
 * 需要时再手动改成 true。 */
var AE_DUMP_LS_TREE = false;

/* 安全地"探测能不能加这个效果" —— 只用 canAddProperty，不直接 addProperty
 * （addProperty 对不认识的名字可能弹模态框/卡死，canAddProperty 只返回布尔） */
function AE_canAddFx(grp, name, report) {
    var can = null;
    report.push("      [探测] canAddProperty(\"" + name + "\") …");
    try {
        if (typeof grp.canAddProperty === "function") {
            can = grp.canAddProperty(name);
        } else {
            can = null;
            report.push("      [探测]   （这个 AE 版本没有 canAddProperty，无法预判）");
        }
    } catch (eCan) {
        report.push("      [探测]   抛错：" + eCan);
        can = false;
    }
    if (can !== null) report.push("      [探测]   = " + can);
    return can;
}

/* ★★ 把"外发光"用 AE 原生的「投影」效果模拟 ★★
 * 背景（探针实测）：
 *   这台 AE 上 canAddProperty("Outer Glow") / ("ADBE Outer Glow") / ("外发光")
 *   全部返回 false —— 没有"图层样式版"的效果可加（之前 addProperty 直接卡死就是这个原因）。
 *   所以改用 AE 老牌原生效果「投影 Drop Shadow」：
 *     距离 = 0  ->  阴影不再偏移，而是从图层四周均匀扩散 = 外发光
 *     柔和度 = PS 的 blur，不透明度 = PS 的 opacity，颜色 = PS 的 color
 *   用户已确认：替代即可，不要求效果完全一样。
 */

/* 把 JSON 里的值转成数字（PS 描述符里数值常是字符串，例如 "94"） */
function AE_numOf(v, d) {
    if (v === undefined || v === null) return d;
    if (typeof v === "object" && v.value !== undefined) return AE_N(v.value, d);
    if (typeof v === "number") return v;
    var n = parseFloat("" + v);
    return isNaN(n) ? d : n;
}

/* 在效果上按候选属性名设值 */
function AE_setFxProp(ef, names, val, label, report) {
    for (var i = 0; i < names.length; i++) {
        try {
            var p = ef.property(names[i]);
            if (p) {
                p.setValue(val);
                report.push("        " + label + " = " + val + "（属性名：" + names[i] + "）");
                return true;
            }
        } catch (e) { /* 换下一个名字 */ }
    }
    report.push("        ⚠ " + label + " 设不上（试过 " + names.join(" / ") + "）");
    return false;
}

/* 把 PS 的 outerGlow 参数套到 AE 的「投影」上（距离固定 0） */
function AE_setGlowAsShadow(ef, one, report) {
    var blur = AE_numOf(one.blur, 20);
    var op = AE_numOf(one.opacity, 75);
    AE_setFxProp(ef, ["Distance", "距离"], 0, "距离(0=当外发光用)", report);
    AE_setFxProp(ef, ["Softness", "柔和度"], blur, "柔和度(PS blur)", report);
    AE_setFxProp(ef, ["Opacity", "不透明度"], op, "不透明度(PS opacity)", report);
    var col = one.color;
    if (col && typeof col === "object") {
        /* PS 的颜色键是 red / grain(其实是绿) / blue，0-255 -> AE 要 0-1 的数组 */
        var rgb = [AE_N(col.red, 255) / 255, AE_N(col.grain, 255) / 255, AE_N(col.blue, 255) / 255];
        AE_setFxProp(ef, ["Shadow Color", "阴影颜色"], rgb, "颜色(PS color)", report);
    }
}

/* ==========================================================================
 * ★★ 图层样式：用【菜单命令 ID】应用（AE 不能用 addProperty 添加）★★
 * --------------------------------------------------------------------------
 * 权威依据：https://qiita.com/TimeToEdit/items/0f4aa8dbc0b70abc9b8f
 *   1. 每个图层其实已经有图层样式组：layer.property("ADBE Layer Styles")
 *      但默认是"隐藏且未启用"，canSetEnabled 返回 false。
 *   2. property("ADBE Layer Styles").addProperty("frameFX/enabled") 会直接报错 —— 加不了。
 *      （这也解释了为什么 canAddProperty("Outer Glow") 全是 false）
 *   3. ★ 正解：用菜单命令
 *        layer.selected = true;
 *        app.executeCommand(app.findMenuCommandId("外发光"));
 *   4. 参数用 matchName 设（官方文档 Layer Styles Match Names）：
 *        layer.property("ADBE Layer Styles").property("outerGlow/blur").setValue(90)
 * ========================================================================== */

/* PS 样式键 -> { AE 图层样式的本地化菜单名候选, 参数 matchName 前缀 } */
var AE_LS_MAP = [
    /* ★ cmdId：实测拿到的菜单命令 ID（findMenuCommandId 不可靠，优先用写死的） */
    { ps: "outerGlow",    prefix: "outerGlow",    cn: "外发光", cmdId: 9002,
      menu: ["外发光", "Outer Glow", "光彩 (外側)", "光彩(外側)"] },
    { ps: "dropShadow",   prefix: "dropShadow",   cn: "投影", cmdId: 9000,
      menu: ["投影", "Drop Shadow", "ドロップシャドウ"] },
    { ps: "innerShadow",  prefix: "innerShadow",  cn: "内阴影", cmdId: 9001,
      menu: ["内阴影", "Inner Shadow"] },
    { ps: "innerGlow",    prefix: "innerGlow",    cn: "内发光", cmdId: 9003,
      menu: ["内发光", "Inner Glow"] },
    { ps: "bevelEmboss",  prefix: "bevelEmboss",  cn: "斜面和浮雕", cmdId: 9004,
      menu: ["斜面和浮雕", "Bevel and Emboss"] },
    { ps: "satin",        prefix: "chromeFX",     cn: "光泽", cmdId: 9005,
      menu: ["光泽", "Satin"] },
    { ps: "solidFill",    prefix: "solidFill",    cn: "颜色叠加", cmdId: 9006,
      menu: ["颜色叠加", "Color Overlay"] },
    { ps: "gradientFill", prefix: "gradientFill", cn: "渐变叠加", cmdId: 9007,
      menu: ["渐变叠加", "Gradient Overlay"] },
    { ps: "patternFill",  prefix: "patternFill",  cn: "图案叠加", cmdId: 0,
      menu: ["图案叠加", "Pattern Overlay"] },
    { ps: "frameFX",      prefix: "frameFX",      cn: "描边", cmdId: 9008,
      menu: ["描边", "Stroke"] }
];
function AE_lsLookup(normKey) {
    for (var i = 0; i < AE_LS_MAP.length; i++) { if (AE_LS_MAP[i].ps === normKey) return AE_LS_MAP[i]; }
    return null;
}

/* 查某个本地化菜单名的命令 ID；找不到返回 -1 */
function AE_menuCmdId(name, report) {
    try {
        if (typeof app.findMenuCommandId !== "function") {
            report.push("      （此 AE 版本没有 findMenuCommandId，无法按名字找菜单命令）");
            return -1;
        }
        var id = app.findMenuCommandId(name);
        if (id === undefined || id === null) return -1;
        id = parseInt(id, 10);
        if (isNaN(id) || id <= 0) return -1;
        return id;
    } catch (e) { return -1; }
}

/* 只选中目标层（先清掉同合成里其它层的选择） */
function AE_selectOnly(comp, layer, report) {
    var cleared = 0;
    try {
        for (var i = 1; i <= comp.numLayers; i++) {
            try {
                var L = comp.layer(i);
                if (L.selected) { L.selected = false; cleared++; }
            } catch (e0) {}
        }
    } catch (e1) {}
    try { layer.selected = true; } catch (e2) { report.push("      ⚠ 选不中目标层：" + e2); return false; }
    var ok = false;
    try { ok = (layer.selected === true); } catch (e3) {}
    if (!ok) report.push("      ⚠ 目标层选中状态没生效");
    return ok;
}

/* ★ 应用一个图层样式：按本地化菜单名找命令 ID 并执行 ★ */
/* ==========================================================================
 * ★★ 判断某个图层样式当前是否"已应用/已启用" ★★
 * --------------------------------------------------------------------------
 * 踩过的坑（13:44:05 报告）：
 *   上一版用 g.value === true 判断，结果【永远判为没生效】——
 *   因为 "xxx/enabled" 这个组的 .value 实测是 undefined（属性树 dump 里就是 undefined），
 *   于是明明 executeCommand(9002) 成功了（13:23 那次真加上了外发光、参数也对），
 *   却被判为失败 -> 又多做了一遍"投影 + 距离 0"的替代效果。
 *
 * 可靠判据：canSetEnabled（见教程 https://qiita.com/TimeToEdit/items/0f4aa8dbc0b70abc9b8f
 *   「属性が有効に出来るかは canSetEnabled で確認出来ます」—— 未启用时返回 false）。
 *   这里把三个信号都读出来写进报告，判断优先级：
 *     canSetEnabled === true      -> 已应用
 *     value === true / "1"        -> 已应用
 *     canSetEnabled === false     -> 没应用
 *     其它（读不到）              -> 未知（按"已应用"处理，避免重复叠加替代效果）
 * ========================================================================== */
function AE_styleState(layer, prefix, report) {
    var g = null;
    try { g = AE_findLsGroup(layer, prefix); } catch (e0) {}
    if (!g) {
        if (report) report.push("        样式状态：★ 找不到样式组「" + prefix + "」");
        return "unknown";
    }
    var v = "n/a", can = "n/a", n = "n/a";
    try { v = "" + g.g.value; } catch (e1) {}
    try { can = "" + g.g.canSetEnabled; } catch (e2) {}
    try { n = "" + g.g.numProperties; } catch (e3) {}
    if (report) {
        report.push("        样式状态：value=" + v + "　canSetEnabled=" + can + "　numProperties=" + n +
                    "　（组：" + g.how + "）");
    }
    if (can === "true") return "on";
    if (v === "true" || v === "1") return "on";
    if (can === "false") return "off";
    return "unknown";
}

/* 兼容旧调用：只要不是明确"没应用"，都当作成功（避免重复叠加替代效果） */
function AE_isStyleOn(layer, prefix) {
    var st = AE_styleState(layer, prefix, null);
    return (st === "on" || st === "unknown");
}


/* ★ 应用一个图层样式：按本地化菜单名找命令 ID 并执行
 * ★★ 故意【先不开查看器】★★
 *   踩过的坑：脚本跑过之后，AE 在 File > New > New Project（关闭工程）时崩溃，
 *   日志是 <BEE_WorkQueue> PreCloseProject end —— 属于"关工程时还有没结算的 UI/渲染任务"。
 *   而 openInViewer() 会【打开一个查看器】，工程关闭时查看器拆卸正好走这个队列。
 *   参考教程的示例也只是 `layer.selected = true; app.executeCommand(id);`，并没有开查看器。
 *   所以：先不开查看器试一次；只有确实没生效，才开查看器再试一次。 */

/* ★★ AE 界面预热 ★★
 * 实测（13:58:39 报告）：AE 里【一个合成都没打开】时（activeItem=null），
 *   即使 openInViewer 把目标合成变成了 activeItem，
 *   图层样式菜单命令 executeCommand(9002) 也不生效（canSetEnabled 一直 false），
 *   而且之后对未启用的样式套参数会把 AE 搞崩。
 *   而 13:50:28 那次成功，正是因为一开始就有合成开着（activeItem=「06 明河卡池图」）。 */

function AE_warmUpViewer(report) {
    var act = null;
    try { act = app.project.activeItem; } catch (e0) {}
    if (act) {
        report.push("  （界面预热：已有活动合成「" + act.name + "」，不用预热）");
        return true;
    }
    report.push("  （界面预热：当前【没有任何合成打开】—— 先打开主合成，否则图层样式菜单命令不生效）");
    var main = null;
    try { main = AE_findMainComp(); } catch (e1) {}
    if (!main) { report.push("    ★ 找不到主合成，无法预热"); return false; }
    report.push("    打开主合成「" + main.name + "」…");
    try { main.openInViewer(); } catch (eV) { report.push("    openInViewer 抛错：" + eV); }
    try { $.sleep(700); } catch (eS) {}
    var act2 = null;
    try { act2 = app.project.activeItem; } catch (e2) {}
    report.push("    预热后 activeItem = " + (act2 ? ("「" + act2.name + "」") : "(null)"));
    return !!act2;
}

/* 执行一次"应用图层样式"的菜单命令。
 * ★★ 不拿 canSetEnabled 判成败 ★★
 *   回到 13:50 那次【成功】的行为：命令执行了就往下走，成败由后面
 *   "套参数 + 回读"来验证（参数能设上、回读对得上 => 样式确实应用了）。
 *   踩过的坑：拿 canSetEnabled 判定，会在某些 AE 状态下误判成"没生效"
 *   （用户目视确认过：既没外发光也没图层样式组），于是又叠一层替代效果，
 *   画面上看到的反而是错的那个。 */
function AE_tryStyleCmd(comp, layer, prefix, id, how, report) {
    report.push("      [菜单]   正在 executeCommand(" + id + ")（" + how + "）…");
    try {
        app.executeCommand(id);
    } catch (eC) {
        report.push("      [菜单]   抛错：" + eC);
        return false;
    }
    report.push("      [菜单]   执行完毕");
    try { AE_styleState(layer, prefix, report); } catch (eSt) {}
    report.push("      [菜单]   命令已执行（成败由后面的『参数回读』判定）");
    return true;
}

function AE_applyLayerStyle(comp, layer, m, report) {
    /* ---- 收集候选命令 ID（去重）：实测写死的优先，再 findMenuCommandId 查到的 ---- */
    var ids = [];
    function addId(id, how) {
        if (!id || id <= 0) return;
        for (var q = 0; q < ids.length; q++) { if (ids[q].id === id) return; }
        ids.push({ id: id, how: how });
    }
    addId(m.cmdId, "实测 " + m.cn);
    if (m.cmdId && m.cmdId > 0) report.push("      [菜单] 实测命令 ID：" + m.cmdId);
    for (var i = 0; i < m.menu.length; i++) {
        var nm = m.menu[i];
        report.push("      [菜单] findMenuCommandId(\"" + nm + "\") …");
        var id = AE_menuCmdId(nm, report);
        if (id <= 0) { report.push("      [菜单]   没找到这个菜单命令"); continue; }
        report.push("      [菜单]   ID = " + id);
        addId(id, "名字查到 " + nm);
    }
    if (ids.length === 0) { report.push("      [菜单] ★ 没有任何可用的命令 ID，放弃"); return false; }

    /* 确认活动合成 + 选中目标层，然后依次试候选 ID（第一个执行成功的就返回 true） */
    var a = AE_makeActive(comp, layer, report);
    if (!a.selected) return false;
    for (var k = 0; k < ids.length; k++) {
        if (AE_tryStyleCmd(comp, layer, m.prefix, ids[k].id, ids[k].how, report)) return true;
    }
    report.push("      [菜单] ★ 所有候选 ID 都没能执行成功");
    return false;
}




/* ★ 把"图层样式菜单名 -> 命令 ID"的探测结果全部列出来。
 * 好处：即使应用失败，报告里也能看到【你这台 AE 里这些图层样式到底叫什么名字】，
 * 方便我按实际名字修正（中文版 / 英文版 / 日文版菜单名都不一样）。 */
var AE_MENU_DUMPED = false;   /* 菜单名探测只做一次（很慢） */
function AE_dumpLsMenuIds(report) {
    if (AE_MENU_DUMPED) { report.push("    （菜单名探测已做过，跳过）"); return; }
    AE_MENU_DUMPED = true;
    report.push("    【图层样式菜单名探测】（看 ID 是否 > 0）");
    for (var i = 0; i < AE_LS_MAP.length; i++) {
        var m = AE_LS_MAP[i];
        var out = [];
        for (var j = 0; j < m.menu.length; j++) {
            var id = AE_menuCmdId(m.menu[j], { push: function () {} });
            out.push(m.menu[j] + "=" + (id > 0 ? id : "找不到"));
        out.push("【实测ID=" + (m.cmdId ? m.cmdId : "无") + "】");
        }
        report.push("      " + m.cn + "： " + out.join("　"));
    }
}

/* ★ 最后手段：用 AE 原生「投影」+ 距离 0 模拟外发光（用户已同意这个替代） */
function AE_glowViaShadowFallback(layer, one, report) {
    /* ★ 先用实测命令 ID（Drop Shadow = 9000），findMenuCommandId 只当兜底 ——
       理由同 AE_applyLayerStyle：findMenuCommandId 不可靠，实测 ID 才稳。 */
    var ids = [9000];
    var nm2 = AE_menuCmdId("Drop Shadow", report);
    if (nm2 > 0 && nm2 !== 9000) ids.push(nm2);
    var nm3 = AE_menuCmdId("投影", report);
    if (nm3 > 0 && nm3 !== 9000 && nm3 !== nm2) ids.push(nm3);
    for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        report.push("      [回退] 用「投影」(ID=" + id + ") + 距离 0 模拟外发光");
        try { app.executeCommand(id); } catch (eC) { report.push("      [回退] 执行失败：" + eC); continue; }
        try { AE_setGlowAsShadowLite(layer, one, report); } catch (eP) {}
        return true;
    }
    report.push("      [回退] 所有候选 ID 都执行失败");
    return false;
}

/* 把"外发光"的参数套到「投影」上：AE 图层样式的 matchName 是 dropShadow/xxx */
function AE_setGlowAsShadowLite(layer, one, report) {
    var ls = null;
    try { ls = layer.property("ADBE Layer Styles"); } catch (eL) {}
    if (!ls) { report.push("        ⚠ 拿不到 ADBE Layer Styles 组"); return; }
    function set(suffix, val, label) {
        var aeNames = [];
        for (var q = 0; q < AE_LS_PARAMS.length; q++) { if (AE_LS_PARAMS[q].suffix === suffix) aeNames = AE_LS_PARAMS[q].ae; }
        var f = AE_findLsProp(layer, "dropShadow", suffix, aeNames, report, label);
        if (!f) { report.push("        · " + label + " 属性不存在"); return; }
        try { f.p.setValue(val); report.push("        ✔ " + label + " = " + val + "　(" + f.how + ")"); }
        catch (e) { report.push("        ⚠ " + label + " 设不上：" + e); }
    }
    var blur = AE_numOf(one.blur, 20);
    var op = AE_numOf(one.opacity, 75);
    set("distance", 0, "距离(0=当外发光用)");
    set("blur", blur, "大小(PS blur)");
    set("opacity", op, "不透明度(PS opacity)");
    var col = one.color;
    if (col && typeof col === "object") {
        var rgb = [AE_N(col.red, 255) / 255, AE_N(col.grain, 255) / 255, AE_N(col.blue, 255) / 255];
        set("color", rgb, "颜色(PS color)");
    }
}

/* ==========================================================================
 * ★★ 图层样式参数：映射表 + 健壮设值 ★★
 * --------------------------------------------------------------------------
 * 探针事实（13:18:21 报告）：
 *   · 用菜单命令添加图层样式【成功】（Outer Glow -> ID 9002）
 *   · 但 ls.property("outerGlow/blur") 全部"属性不存在" -> 参数设不上
 *     （AE 里这些属性的实际 matchName / 存取路径和官方文档表里写的形式不完全一致）
 * 用户要求：只改 AE 和 PS【同名】的参数；名字相似的就映射一下。
 *
 * 做法：
 *   1. 先把 layer.property("ADBE Layer Styles") 的【属性树】整个打进报告
 *      （每项的 index / name / matchName / value）—— 这样一眼能看出真实名字
 *   2. 设值时按三重顺序找目标属性：
 *        ① matchName 直接取：ls.property("outerGlow/blur")
 *        ② 嵌套取：          ls.property("outerGlow").property("blur")
 *        ③ 遍历属性树，按 matchName 或【显示名】匹配（英文名 + 中文名都给）
 *   3. 参数映射表（PS 键 -> matchName 后缀 + AE 显示名候选）
 * ========================================================================== */

var AE_LS_PARAMS = [
    { ps: "blur",              suffix: "blur",              ae: ["Size", "大小"],                      cn: "大小" },
    { ps: "opacity",           suffix: "opacity",           ae: ["Opacity", "不透明度"],                cn: "不透明度" },
    { ps: "noise",             suffix: "noise",             ae: ["Noise", "杂色"],                     cn: "杂色" },
    { ps: "chokeMatte",        suffix: "chokeMatte",        ae: ["Spread", "Choke", "扩展", "收缩"],    cn: "扩展/收缩" },
    { ps: "distance",          suffix: "distance",          ae: ["Distance", "距离"],                  cn: "距离" },
    { ps: "size",              suffix: "size",              ae: ["Size", "大小"],                      cn: "大小" },
    { ps: "localLightingAngle",suffix: "localLightingAngle",ae: ["Angle", "角度"],                     cn: "角度" },
    { ps: "strengthRatio",     suffix: "strengthRatio",     ae: ["Depth", "深度"],                     cn: "深度" },
    { ps: "softness",          suffix: "softness",          ae: ["Soften", "柔化"],                    cn: "柔化" },
    { ps: "inputRange",        suffix: "inputRange",        ae: ["Range", "范围"],                     cn: "范围" },
    { ps: "shadingNoise",      suffix: "shadingNoise",      ae: ["Jitter", "抖动"],                    cn: "抖动" },
    { ps: "angle",             suffix: "angle",             ae: ["Angle", "角度"],                     cn: "角度" },
    { ps: "gradientSmoothness",suffix: "gradientSmoothness",ae: ["Gradient Smoothness", "渐变平滑度"],   cn: "渐变平滑度" },
    { ps: "scale",             suffix: "scale",             ae: ["Scale", "缩放"],                     cn: "缩放" },
    { ps: "reverse",           suffix: "reverse",           ae: ["Reverse", "反向"],                   cn: "反向" }
];



/* 拿到某个图层样式的【组】（例如 Outer Glow）。
 * 关键事实（13:23:06 报告）：layer.property("ADBE Layer Styles") 下面只有 11 项，
 * 每一项都是 "xxx/enabled" 这个【组】；真正的参数（Opacity/Size/Spread...）
 * 是这些组的【子属性】。所以必须先拿到组，再在组里找参数。 */
function AE_findLsGroup(layer, prefix) {
    var ls = null;
    try { ls = layer.property("ADBE Layer Styles"); } catch (e0) {}
    if (!ls) return null;
    /* ① matchName 形式 prefix/enabled */
    try { var g1 = ls.property(prefix + "/enabled"); if (g1) return { g: g1, how: prefix + "/enabled" }; } catch (e1) {}
    /* ② 直接 prefix */
    try { var g2 = ls.property(prefix); if (g2) return { g: g2, how: prefix }; } catch (e2) {}
    /* ③ 遍历 11 项，按 matchName 前缀匹配 */
    var n = 0; try { n = ls.numProperties; } catch (e3) {}
    for (var i = 1; i <= n; i++) {
        var p = null; try { p = ls.property(i); } catch (e4) { continue; }
        var mn = ""; try { mn = "" + p.matchName; } catch (e5) {}
        if (mn === prefix + "/enabled" || mn === prefix || mn.indexOf(prefix + "/") === 0) {
            return { g: p, how: "遍历 matchName=" + mn };
        }
    }
    return null;
}

/* 打印 ADBE Layer Styles 的属性树。
 * ★★ 安全约束（13:26:41 报告踩过）★★
 *   不能展开【未启用】的样式组的子属性 —— 那些样式是"隐藏且未启用"状态
 *   （canSetEnabled=false），读它的子属性会让 AE 崩溃/卡死。
 *   实测：展开 [2] Drop Shadow 的子属性到第二个就断了，整轮脚本没了下文，
 *         结果参数一条都没设上、AE 里全变默认值。
 * 所以：
 *   · 顶层 11 项的名字/matchName 总是可以打印（安全）
 *   · 子属性【只展开 onlyPrefix 指定的那一个样式组】
 *     （也就是我们刚用菜单命令应用过、确认已启用的那个）
 */
function AE_dumpLsTree(layer, report, onlyPrefix) {
    var ls = null;
    try { ls = layer.property("ADBE Layer Styles"); } catch (e0) {}
    if (!ls) { report.push("      【属性树】拿不到 ADBE Layer Styles 组"); return; }
    var n = -1;
    try { n = ls.numProperties; } catch (e1) {}
    report.push("      【ADBE Layer Styles 属性树】共 " + n + " 项" +
                (onlyPrefix ? ("（只展开 " + onlyPrefix + " 组的子属性，其它组不碰）") : "（只列名字，不展开子属性）"));
    for (var i = 1; i <= n; i++) {
        var p = null;
        try { p = ls.property(i); } catch (e2) { continue; }
        var nm = "", mn = "";
        try { nm = "" + p.name; } catch (e3) {}
        try { mn = "" + p.matchName; } catch (e4) {}
        report.push("        [" + i + "] " + nm + "　matchName=" + mn);

        /* ★ 只展开我们关心的那个样式组（已确认启用，读子属性安全） */
        if (!onlyPrefix) continue;
        if (mn.indexOf(onlyPrefix + "/") !== 0 && mn !== onlyPrefix) continue;
        var n2 = 0;
        try { n2 = p.numProperties; } catch (e6) { continue; }
        for (var j = 1; j <= n2; j++) {
            var c = null;
            try { c = p.property(j); } catch (e7) { continue; }
            var cn2 = "", cmn = "", cv = "";
            try { cn2 = "" + c.name; } catch (e8) {}
            try { cmn = "" + c.matchName; } catch (e9) {}
            try { cv = "" + c.value; } catch (e10) { cv = "(组)"; }
            report.push("             · " + cn2 + "　matchName=" + cmn + "　value=" + cv);
        }
    }
}


/* 在某个图层样式【组】里找目标参数：
 *   ① 组内直接按 suffix 取        grp.property("blur")
 *   ② 组内按 prefix/suffix 取     grp.property("outerGlow/blur")
 *   ③ 遍历组内子属性，按 matchName 或【显示名】匹配（英文名 + 中文名都给）
 */
function AE_findLsProp(layer, prefix, suffix, aeNames, report, label) {
    var gi = AE_findLsGroup(layer, prefix);
    if (!gi) return null;
    var grp = gi.g;

    try { var p1 = grp.property(suffix); if (p1) return { p: p1, how: gi.how + " -> " + suffix }; } catch (e1) {}
    try { var p2 = grp.property(prefix + "/" + suffix); if (p2) return { p: p2, how: gi.how + " -> " + prefix + "/" + suffix }; } catch (e2) {}

    var n = 0; try { n = grp.numProperties; } catch (e3) {}
    var seen = [];
    for (var i = 1; i <= n; i++) {
        var p = null; try { p = grp.property(i); } catch (e4) { continue; }
        var mn = "", nm = "";
        try { mn = "" + p.matchName; } catch (e5) {}
        try { nm = "" + p.name; } catch (e6) {}
        seen.push(nm + "/" + mn);
        /* matchName 命中：等于 suffix、等于 prefix/suffix、或以 /suffix 结尾 */
        if (mn === suffix || mn === prefix + "/" + suffix ||
            (mn.length > suffix.length && mn.substring(mn.length - suffix.length - 1) === "/" + suffix)) {
            return { p: p, how: gi.how + " -> 遍历 matchName=" + mn };
        }
        for (var d = 0; d < aeNames.length; d++) {
            if (nm === aeNames[d]) return { p: p, how: gi.how + " -> 遍历 名字=" + nm };
        }
    }
    /* 把组里到底有哪些子属性写出来，方便下一轮精确映射 */
    if (report) report.push("        · 「" + label + "」在组「" + prefix + "」里没找到；组内子属性有：" + seen.join(" | "));
    return null;
}

/* 设图层样式的参数：只设 PS 和 AE 都有的（名字同名或近似映射） */
function AE_setLsParams(layer, prefix, one, report) {
    var ls = null;
    try { ls = layer.property("ADBE Layer Styles"); } catch (eL) {}
    if (!ls) { report.push("        ⚠ 拿不到「ADBE Layer Styles」组，参数没法设"); return 0; }

    var ok = 0, tried = 0, miss = [];
    for (var i = 0; i < AE_LS_PARAMS.length; i++) {
        var it = AE_LS_PARAMS[i];
        if (!AE_has(one, it.ps)) continue;              /* PS 里没有这个参数的就不动 */
        var v = AE_numOf(one[it.ps], null);
        if (v === null) continue;
        tried++;
        var found = AE_findLsProp(layer, prefix, it.suffix, it.ae, report, it.cn);
        if (!found) { miss.push(it.cn + "(" + it.ps + ")"); continue; }
        try {
            found.p.setValue(v);
            /* ★ 立刻回读 —— 这才是"样式真的应用上了"的可靠证据 */
            var back = "?";
            try { back = "" + found.p.value; } catch (eBk) {}
            var match = (Math.abs(parseFloat(back) - v) < 0.01);
            ok++;
            report.push("        " + (match ? "✔" : "⚠") + " " + it.cn + " 设置 " + v + "　回读 " + back +
                        (match ? "　✔对得上" : "　★对不上") + "（" + found.how + "）");
            if (!match) miss.push(it.cn + "(回读不一致)");
        } catch (eS) {
            report.push("        ⚠ " + it.cn + " 设不上：" + eS);
            miss.push(it.cn + "(" + it.ps + ")");
        }
    }
    /* 颜色单独处理（AE 要 0-1 的三元数组） */
    if (AE_has(one, "color") && one.color && typeof one.color === "object") {
        tried++;
        var col = one.color;
        var rgb = [AE_N(col.red, 255) / 255, AE_N(col.grain, 255) / 255, AE_N(col.blue, 255) / 255];
        var ci = AE_findLsProp(layer, prefix, "color", ["Color", "颜色"], report, "颜色");
        if (ci) {
            try { ci.p.setValue(rgb); ok++; report.push("        ✔ 颜色 = " + rgb.join(",") + "（" + ci.how + "）"); }
            catch (eC2) { report.push("        ⚠ 颜色设不上：" + eC2); miss.push("颜色"); }
        } else {
            miss.push("颜色");
        }
    }
    report.push("        参数小结：PS 有 " + tried + " 项 -> 设成功 " + ok + " 项" +
                (miss.length ? ("；没设上的：" + miss.join("、")) : ""));
    return ok;
}

/* ==========================================================================
 * ★★ 图层样式统一【最后】应用 ★★
 * --------------------------------------------------------------------------
 * 为什么不能一边做图层操作一边加样式：
 *   AE 2021+ 的图层样式是走 AE 自己的【异步工作队列】(BEE_WorkQueue) 的。
 *   用户实测：脚本跑过之后，在 AE 里执行 File > New > New Project（= 关闭工程）时
 *   AE 崩溃，日志最后一条是：
 *       <...> <BEE_WorkQueue> <5> BEE_WorkQueue_PreCloseProject end
 *   这就是"工程关闭时工作队列里还有没结算的图层样式任务"的典型表现。
 *   所以：加样式的动作要【排在所有图层操作之后】，并且尽量少、尽量晚。
 *
 * 做法：各分支只把任务排进队列（记文件夹名 + 样式描述符），
 *       等所有 op 处理完，再由 AE_flushStyleTasks() 统一应用。
 * ========================================================================== */
var AE_STYLE_TASKS = [];
/* ★ 本次运行里"PS 里眼睛关着、按需求跳过"的效果总数（队列开始时清零） */
var AE_FX_EYE_OFF = 0;

function AE_queueStyleTask(name, effects, label, report) {
    if (!effects) return;
    AE_STYLE_TASKS.push({ name: name, effects: effects, label: label });
    report.push("  （图层样式已排入队列，稍后统一应用：" + label + "）");
}

function AE_flushStyleTasks(report) {
    var n = AE_STYLE_TASKS.length;
    report.push("");
    if (n === 0) { report.push("===== 图层样式：没有需要应用的 =====\n"); return 0; }
    report.push("===== 统一应用图层样式（" + n + " 项；放在所有图层操作之后，降低 AE 崩溃风险）=====");
    /* ★ 先做界面预热（没有活动合成时先打开主合成），否则图层样式菜单命令不生效 */
    try { AE_warmUpViewer(report); } catch (eWU) { report.push("  （预热出错：" + eWU + "）"); }
    var ok = 0;
    AE_FX_EYE_OFF = 0;         /* 队列开始，重新计数 */
    for (var i = 0; i < n; i++) {
        var t = AE_STYLE_TASKS[i];
        report.push("【样式 " + (i + 1) + "/" + n + "】" + t.label);
        try {
            if (AE_restoreLayerEffects({ layerEffects: t.effects, folder: { name: t.name } }, report)) ok++;
        } catch (e) {
            report.push("  ⚠ 这一项出错：" + e);
        }
        report.push("");
    }
    report.push("  图层样式小结：队列 " + n + " 项，成功 " + ok + " 项" +
                 (AE_FX_EYE_OFF > 0 ? ("；PS 里眼睛关着、按需求跳过的效果 " + AE_FX_EYE_OFF + " 个") : ""));
    report.push("");
    return ok;
}

/* ==========================================================================
 * ★★ 把某个合成弄成"活动合成"，并选中目标层 ★★
 * --------------------------------------------------------------------------
 * 为什么必须确认 app.project.activeItem：
 *   AE 的「图层 > 图层样式」菜单命令（app.executeCommand(9002) 等）
 *   只作用于【活动合成(activeItem) 里选中的图层】。
 *
 * 踩过的坑（13:45:57 报告 + 用户目视）：
 *   · AE_restoreLayerEffects 里调了 comp.openInViewer() 并报告"✔ 已 openInViewer"，
 *     但用户看到【目标合成的 timeline 页签根本没打开】；
 *   · 结果 executeCommand(9002) 执行完之后读状态是 canSetEnabled=false（= 没生效），
 *     两个文件夹的图层样式一个都没设上（只有后面的替代方案加了投影）。
 *   · 而 13:23:06 那次真能设置成功，是因为用户当时【手动打开着那个合成】。
 *   => 所以：openInViewer 返回不代表 activeItem 变了，必须【读 activeItem 确认】。
 *
 * 做法：openInViewer -> 反复读 app.project.activeItem 直到它等于目标合成（最多 8 次）
 *       -> 再只选中目标层 -> 把每一步的实际结果写进报告。
 * ========================================================================== */
function AE_makeActive(comp, layer, report) {
    var act = null;
    try { act = app.project.activeItem; } catch (e0) {}
    report.push("      [激活] 当前 activeItem = " + (act ? ("「" + act.name + "」") : "(null)"));

    if (act !== comp) {
        try { comp.openInViewer(); } catch (eV) { report.push("      [激活] openInViewer 抛错：" + eV); }
    }

    var tries = 0;
    while (tries < 8) {
        try { act = app.project.activeItem; } catch (e1) {}
        if (act === comp) break;
        try { comp.openInViewer(); } catch (eV2) {}
        tries++;
    }
    var isTarget = false;
    try { isTarget = (act === comp); } catch (e2) {}
    report.push("      [激活] 重试 " + tries + " 次后 activeItem = " + (act ? ("「" + act.name + "」") : "(null)") +
                (isTarget ? "　✔ 已是目标合成" : "　★★ 仍不是目标合成（图层样式菜单命令会作用不到！）"));

    AE_selectOnly(comp, layer, report);
    var selOK = false;
    try { selOK = (layer.selected === true); } catch (e3) {}
    report.push("      [激活] 目标层「" + (function () { try { return layer.name; } catch (e) { return "?"; } })() +
                "」选中=" + (selOK ? "是" : "★否"));
    return { active: isTarget, selected: selOK };
}

/* ★★ 用 AE 原生效果替代 PS 的图层样式 ★★
 * --------------------------------------------------------------------------
 * 为什么必须走这条路（用户目视确认 + 报告）：
 *   · executeCommand(9000~9008)（图层 > 图层样式 的菜单命令）在这台 AE 上
 *     执行了但【完全不生效】：用户检查发现图层上既没有外发光、也没有"图层样式"这一组。
 *   · canSetEnabled 读出 false 是【正确的】，不是误判。
 *   · 同样的代码在 13:50 那次偶然生效过一次，但无法稳定复现（AE 菜单状态问题）。
 *   => 所以改用【真正的 AE 原生效果】来近似：
 *        PS 外发光 -> AE 原生「投影 Drop Shadow」，【距离 = 0】
 *        （距离 0 时阴影不偏移，从四周均匀扩散 = 外发光）
 *
 * ★ 必须用 matchName "ADBE Drop Shadow"，不能用显示名 "Drop Shadow"：
 *   显示名会和"图层样式里的投影"撞名（那个 canAddProperty 返回 false）。
 */
function AE_nativeGlowFallback(layer, one, report) {
    var can = null;
    try { can = layer.Effects.canAddProperty("ADBE Drop Shadow"); } catch (eC) {}
    report.push("      [替代] canAddProperty(\"ADBE Drop Shadow\") = " + can);

    var ef = null;
    try { ef = layer.Effects.addProperty("ADBE Drop Shadow"); }
    catch (eA) { report.push("      [替代] ✗ 添加失败：" + eA); return false; }
    if (!ef) {
        /* 退一步：试显示名 */
        try { ef = layer.Effects.addProperty("Drop Shadow"); } catch (eA2) {}
        if (!ef) { report.push("      [替代] ✗ 添加返回空"); return false; }
    }
    report.push("      [替代] ✔ 已给「" + (function () { try { return layer.name; } catch (e) { return "?"; } })() +
                "」添加 AE 原生「投影」效果");

    /* 按"外发光"的语义套参数：距离 0 是关键 */
    AE_setFxProp(ef, ["Distance", "距离"], 0, "距离(0=当外发光用)", report);
    AE_setFxProp(ef, ["Softness", "柔和度"], AE_numOf(one.blur, 20), "柔和度(PS blur)", report);
    AE_setFxProp(ef, ["Opacity", "不透明度"], AE_numOf(one.opacity, 75), "不透明度(PS opacity)", report);
    var col = one.color;
    if (col && typeof col === "object") {
        var rgb = [AE_N(col.red, 255) / 255, AE_N(col.grain, 255) / 255, AE_N(col.blue, 255) / 255];
        AE_setFxProp(ef, ["Shadow Color", "阴影颜色"], rgb, "颜色(PS color)", report);
    }
    /* 回读验证 —— 这才是"效果真的加上了"的可靠证据 */
    try {
        var dv = ef.property("Distance").value;
        var sv = ef.property("Softness").value;
        var ov = ef.property("Opacity").value;
        report.push("      [替代] 回读：距离=" + dv + "　柔和度=" + sv + "　不透明度=" + ov +
                    (Math.abs(parseFloat("" + dv)) < 0.01 ? "　✔ 距离确实是 0" : "　★ 距离不是 0"));
    } catch (eR) { report.push("      [替代] 回读失败：" + eR); }
    report.push("      [替代] 说明：这不是 PS 的图层样式，是 AE 原生效果近似（视觉接近外发光）");
    return true;
}

function AE_restoreLayerEffects(op, report) {
    if (!AE_TRY_FX) { report.push("  · 已用开关关闭图层样式还原（AE_TRY_FX=false），跳过"); return false; }
    if (!AE_has(op, "layerEffects") || !op.layerEffects) { report.push("  · 没有图层样式记录，跳过"); return false; }
    var nm = AE_S((op.target && op.target.name) ? op.target.name : ((op.folder && op.folder.name) ? op.folder.name : ""), "");
    if (!nm) { report.push("  · 样式记录里没有目标名字，跳过"); return false; }

    report.push("    正在查找代表文件夹「" + nm + "」的图层（主合成往下搜索，有访问上限）…");
    var hit = AE_findFxTarget(nm);
    report.push("    查找结束。");
    if (!hit) { report.push("  ★ 找不到代表文件夹「" + nm + "」的图层，无法还原样式"); return false; }
    report.push("    样式目标：合成「" + hit.comp.name + "」里的图层「" + hit.layer.name + "」（" + hit.how + "）");

    var existing = AE_listEffects(hit.layer);
    report.push("    该图层已有 " + existing.length + " 个效果" + (existing.length ? ("：" + existing.join(" | ")) : ""));

    /* ★★ 硬性前提：先把合成打开成【活动合成】并选中目标层 ★★
       踩过的坑（13:38:26 报告）：全新启动的 AE 里没有合成在查看器中打开时，
       app.findMenuCommandId() 对【所有】图层样式名字都返回"找不到"
       （连之前明明能拿到的 "Outer Glow"=9002 都找不到）。
       原因：AE 的"图层 > 图层样式"这些菜单命令只对【活动合成里选中的图层】可用，
             没有活动合成时它们是禁用状态，findMenuCommandId 就查不到。
       所以：先 openInViewer()，再只选中目标层，然后才做菜单名探测与执行。 */
    report.push("    正在把合成「" + hit.comp.name + "」弄成活动合成并选中目标层…");
    var act2 = AE_makeActive(hit.comp, hit.layer, report);
    if (!act2.active) {
        report.push("    ★★ 目标合成没能成为活动合成 —— 图层样式菜单命令会作用不到，");
        report.push("       请检查 AE 里是否把查看器【锁定】到别的合成了（查看器下方的锁图标），");
        report.push("       或者先手动点开一次「" + hit.comp.name + "」的 timeline 页签再跑。");
    }

    try { AE_dumpLsMenuIds(report); } catch (eDump) { report.push("    （菜单名探测出错：" + eDump + "）"); }

    var fx = op.layerEffects;
    var keys = [];
    for (var kk in fx) { if (fx.hasOwnProperty(kk)) keys.push(kk); }
    /* ★ 把每个样式键的"眼睛"状态记下来（用户要求：把 PS 里的显示状态记录下来）。
       开 = PS 里勾上了，会在 AE 里还原；关 = PS 里眼睛是关的，跳过；
       无 = 样式里根本没有这个效果（PS 也会写一整块默认值，别被键名骗了）。 */
    var eyeLine = [];
    for (var e1 = 0; e1 < keys.length; e1++) {
        var eo = AE_fxEyeOf(fx[keys[e1]]);
        eyeLine.push(keys[e1] + "=" + (eo.on ? "开" : ((eo.present === false) ? "无" : (eo.sawEnabled ? "关" : "?"))));
    }
    report.push("    JSON 里的样式键（眼睛状态）：" + eyeLine.join("　"));
    report.push("      （开 = PS 里勾上了，会还原；关 = PS 里眼睛是关的，跳过；无 = 样式里没这个效果）");

    var okCnt = 0, tried = 0, unmatched = [];
    for (var i = 0; i < keys.length; i++) {
        var raw = keys[i];
        var norm = AE_normFxKey(raw);
        var m = AE_lsLookup(norm);
        if (!m) { unmatched.push(raw); continue; }
        tried++;

        var one = AE_pickFxInstance(fx[raw]);
        if (!one || typeof one !== "object") { report.push("    · " + m.cn + "（" + raw + "）：没有可用实例，跳过"); continue; }

        /* ★★ 只还原 PS 里【眼睛是开的】效果 ★★
           用户明确要求：有的 PS 效果眼睛是关掉的，08 不用添加这个图层样式。
           判断依据是描述符里的 enabled（= 图层样式对话框里的勾选框）；
           present === false 表示"样式里根本没这个效果"，同样跳过。
           ★ 读不到 enabled 字段时【不跳过】（sawEnabled=false）—— 宁可多还原，
             也不能因为字段缺失就把用户的样式悄悄丢掉。 */
        var eye = AE_fxEyeOf(fx[raw]);
        if (eye.sawEnabled && !eye.on) {
            report.push("    · " + m.cn + "（" + raw + "）：★ PS 里眼睛是关的（没勾上），跳过 —— 不在 AE 里加这个样式");
            AE_FX_EYE_OFF++;
            continue;
        }
        if (eye.present === false && !eye.on) {
            report.push("    · " + m.cn + "（" + raw + "）：样式里没有这个效果（present=false），跳过");
            AE_FX_EYE_OFF++;
            continue;
        }

        report.push("    ── " + m.cn + "（" + raw + "）");
        var applied = false;
        if (AE_TRY_LAYER_STYLES) {
            applied = AE_applyLayerStyle(hit.comp, hit.layer, m, report);
        } else {
            report.push("      （已跳过【用菜单命令加图层样式】这条路：AE_TRY_LAYER_STYLES=false，");
            report.push("        实测这台 AE 的图层样式菜单命令执行了但不生效）");
        }
        if (!applied && AE_ALLOW_SHADOW_FALLBACK) {
            if (m.ps === "outerGlow") {
                report.push("      ↪ 改用替代方案：AE 原生「投影」+ 距离 0 近似外发光");
                try {
                    if (AE_nativeGlowFallback(hit.layer, one, report)) {
                        report.push("    ✔ " + m.cn + " 已用【替代方案】完成（原生投影，视觉接近）");
                        okCnt++;
                        report.push("");
                        continue;
                    }
                } catch (eFb) { report.push("      [替代] 出错：" + eFb); }
                report.push("    ✗ " + m.cn + "：替代方案也没成功");
            } else {
                report.push("    · " + m.cn + "：暂时没有对应的原生效果替代（目前只实现了外发光）");
            }
            report.push("");
            continue;
        }
        if (!applied) {
            report.push("    ✗ " + m.cn + "：菜单命令方式没成功（找不到该图层样式的菜单命令）");
            /* ★ 替代方案默认【不做】—— 见文件顶部 AE_ALLOW_SHADOW_FALLBACK 的说明。
               踩过的坑：拿 canSetEnabled 误判成"没生效"，于是又叠了一层投影，
               结果 AE 里看到的是错的那个效果，而真正的图层样式其实应该已经加上了。 */
            if (!AE_ALLOW_SHADOW_FALLBACK) {
                report.push("    · 已跳过替代方案（AE_ALLOW_SHADOW_FALLBACK=false，避免叠加错误效果）");
                report.push("      真正的图层样式命令已经执行过，成败请看上面『参数回读』那几行。");
                continue;
            }
            if (m.ps === "outerGlow") {
                report.push("    ↪ 改用替代方案：AE 原生「投影」+ 距离 0 模拟外发光");
                try {
                    if (AE_glowViaShadowFallback(hit.layer, one, report)) {
                        report.push("    ✔ " + m.cn + " 已用替代方案完成（视觉接近，不是真正的图层样式版）");
                        okCnt++;
                    } else {
                        report.push("    ✗ 替代方案也没成功");
                    }
                } catch (eFb) { report.push("    ✗ 替代方案出错：" + eFb); }
            }
            continue;
        }
        report.push("    ✔ " + m.cn + " 的图层样式已应用");
        /* ★ 顺序很关键：先设参数，再打印属性树。
           因为打印属性树有可能让 AE 崩（碰未启用的样式组），
           先设参数能保证即使打印崩了，参数也已经生效。 */
        /* ★★ 套参数之前先确认样式真的应用上了 ★★
           踩过的坑（13:58:39 报告）：样式没应用上（canSetEnabled=false）时还去 setValue，
           报告正好断在"正在套参数"这一行 —— 对未启用的图层样式设参数会让 AE 崩。 */
        /* ★ 不再用 canSetEnabled 拦着 —— 直接套参数。
           理由：13:50 那次【成功】就是"命令执行完直接套参数 + 回读"验证的；
           而 canSetEnabled 在某些 AE 状态下会误判，导致明明能设的参数被跳过。
           真正的验证在下面：回读参数值，对得上就说明样式确实应用了。 */
        report.push("      正在套参数（先拿到 " + m.prefix + " 样式组，再在组里找参数）…");
        try { AE_setLsParams(hit.layer, m.prefix, one, report); } catch (eP) { report.push("        ⚠ 套参数出错：" + eP); }
        if (AE_DUMP_LS_TREE) {
            report.push("      正在读 " + m.prefix + " 组的属性树（只展开这一组）…");
            try { AE_dumpLsTree(hit.layer, report, m.prefix); } catch (eT) { report.push("      （属性树打印失败：" + eT + "）"); }
        } else {
            report.push("      （属性树 dump 已关闭：它有崩溃风险，且真实属性名已经拿到）");
        }
        okCnt++;
    }
    if (unmatched.length > 0) report.push("    （这些键没有对应效果，已忽略：" + unmatched.join(", ") + "）");
    report.push("  " + (okCnt > 0 ? "✔" : "⚠") + " 文件夹「" + nm + "」样式：试了 " + tried + " 个样式，应用了 " + okCnt + " 个");
    return okCnt > 0;
}





/* ===================== 主流程：应用 JSON ===================== */
/* ===================== 主流程：应用 JSON ===================== */
function AE_Apply(data, f) {
    var report = AE_mkReport();   /* push 的同时即时写进报告文件 */
    var log = [];
    function L2(s) { log.push(s); }

    L2("===== AE 应用 ps 07 指令（v2）=====");
    try { if (AE_RPT.path) L2("★ 本次报告会写到：" + AE_RPT.path); } catch (eP0) {}
    L2("JSON：" + (f ? f.fsName : "?"));
    /* ★ 明确报出"读的是哪个 JSON、内容对不对" —— 避免"AE 读了旧 JSON"这类排查困难 */
    try {
        if (f) {
            var __mod = "";
            try { __mod = "" + f.modified; } catch (eM) {}
            L2("  修改时间：" + __mod);
        }
    } catch (eM2) {}
    try {
        L2("  JSON 关键字段检查：");
        L2("    mirrorRootName = " + (data.mirrorRootName ? ("「" + data.mirrorRootName + "」") : "★ 没有（可能是旧版 JSON）"));
        L2("    ops = " + ((data.ops && data.ops.length) ? data.ops.length : 0) + " 个");
        if (data.ops && data.ops.length > 0) {
            for (var __oi = 0; __oi < data.ops.length; __oi++) {
                var __op = data.ops[__oi];
                L2("      op" + (__oi + 1) + " kind=" + AE_S(__op.kind, "?") +
                   "　mirrorChain=" + (__op.mirrorChain && __op.mirrorChain.length ? ("[" + __op.mirrorChain.join(" / ") + "]") : "★ 没有") +
                   "　folder.containerChain=" + (__op.folder && __op.folder.containerChain && __op.folder.containerChain.length
                                                   ? ("[" + __op.folder.containerChain.join(" / ") + "]") : "★ 没有"));
            }
        }
    } catch (eChk) { L2("    （字段检查出错：" + eChk + "）"); }
    var doc = data.doc || {};
    L2("文档：" + AE_S(doc.name, "?") + "　" + AE_S(doc.width, "?") + "x" + AE_S(doc.height, "?"));

    /* ★ 整个操作包进【一个】撤销组 */
    var undoOpened = false;
    try { app.beginUndoGroup("应用 ps 07 指令 JSON（ae 08）"); undoOpened = true; }
    catch (eU) { L2("⚠ beginUndoGroup 失败（仍然继续）：" + eU); }

    var boxName = AE_S(data.copyFolderName, "__AE_jsonCopies");
    var ops = data.ops || [];
    var nHide = 0, nCopy = 0, nMatte = 0, nFx = 0, nSkip = 0;

    try {
        /* ---------- ① 先关掉 __AE_jsonCopies 的眼睛 ---------- */
        report.push("【① 关闭副本容器 __AE_jsonCopies 的眼睛】");
        /* ★ 现在要关的是【镜像根】那个合成（ps 07 已经把 __AE_jsonCopies 清掉了）。
           用 mirrorRootName；没有才退回 copyFolderName。 */
        var hideTarget = AE_S(data.mirrorRootName, "") || boxName;
        report.push("  （要关的容器：" + hideTarget + "）");
        report.push("  （正在全工程找引用它的图层）…");
        if (AE_hideCopiesBox(hideTarget, report)) nHide++;
        report.push("  （找完了）");
        report.push("");

        /* ---------- 逐段处理 ---------- */
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            var kind = AE_S(op.kind, "");
            report.push("【" + (i + 1) + "/" + ops.length + "】" + kind);

            /* ---------- kind = folderStyles：只还原文件夹的图层样式（没有蒙版） ---------- */
            /* ---------- kind = folderStyles：只还原文件夹的图层样式（没有蒙版） ---------- */
            if (kind === "folderStyles") {
                var fs2 = null;
                try { fs2 = AE_handleFolderStyles(op, report); } catch (eFS) { report.push("  ★ folderStyles 处理出错：" + eFS); }
                if (fs2 && fs2.ok) nSkip++; else nSkip++;   /* 样式在最后统一应用，这里只排队列 */
                report.push("");
                continue;
            }

            /* ---------- kind = folderMask：给文件夹层设亮度遮罩 ---------- */
            if (kind === "folderMask") {
                var fm = null;
                try { fm = AE_handleFolderMask(op, report); } catch (eFM) { report.push("  ★ folderMask 处理出错：" + eFM); }
                if (fm && fm.ok) nMatte++; else nSkip++;
                /* 文件夹自己的图层样式 -> 排进队列（最后统一应用） */
                if (op.layerEffects && fm && fm.ok) {
                    AE_queueStyleTask(AE_S((op.target || {}).name, ""), op.layerEffects,
                                      "文件夹「" + AE_S((op.target || {}).name, "") + "」（带蒙版）", report);
                }
                report.push("");
                continue;
            }

            if (kind !== "clipAboveFolder") {
                report.push("  · 暂不支持的操作类型，跳过");
                nSkip++;
                report.push("");
                continue;
            }

            var folder = op.folder || {};
            var chain = folder.containerChain || [];
            report.push("  目标结构路径：" + (chain.length ? chain.join(" → ") : "(空)"));
            report.push("  PS index=" + AE_S(folder.psIndexInContainer, "?") +
                        "　换算后 AE index=" + AE_S(folder.aeIndexInContainer, "?") +
                        "　（容器里剪贴层 " + AE_S(folder.clipCountInContainer, "?") + " 个，" +
                        "文件夹下方的 " + AE_S(folder.clipCountBelowFolder, "?") + " 个）");
            if (folder.containerLayersTopDown && folder.containerLayersTopDown.length) {
                report.push("  PS 容器图层（从上到下）：" + folder.containerLayersTopDown.join(" | "));
            }

            /* ★★ 定位【目标合成】★★
               ★ 必须走【原文档的 containerChain】（从主合成一层层进去），
                 因为镜像树里的合成本身也是同名的 —— 用镜像链会走到
                 【镜像自己的合成】里，把副本放进那个隐藏的镜像树里（踩过的坑）。
               镜像只负责【提供副本】，不负责"目标在哪"。 */
            var targetComp = null;
            var fallbackSrcComp = null;   /* 兜底命中的合成（既是目标合成、也是副本来源） */
            if (chain && chain.length > 0) {
                report.push("  【目标合成】按原文档 containerChain 走 " + chain.length + " 段：");
                report.push("    （正在回溯搜索目标合成，最多访问 4000 个节点）…");
                var r = AE_resolveCompByChain(chain, report, AE_S(folder.name, ""));
                report.push("    （搜索返回）");
                for (var lr = 0; lr < r.logs.length; lr++) report.push("    " + r.logs[lr]);
                targetComp = r.comp;
            } else {
                report.push("  · JSON 里没有 folder.containerChain，无法定位目标合成");
            }
            /* ★★ 最终兜底：镜像和 containerChain 都推不出来时，
               直接全工程搜副本层（JSON 里 copies[].name），用它们所在的合成当来源。 */
            if (!targetComp) {
                report.push("  · 镜像与原结构都推不出目标合成，改用【全工程搜副本层】兜底…");
                var __c0 = (op.copies && op.copies.length) ? AE_S(op.copies[0].name, "") : "";
                var __hit0 = AE_findLayerAnywhereDeep(__c0);
                if (__hit0) {
                    report.push("    ✔ 在全工程里找到了「" + __c0 + "」，它在合成「" + __hit0.comp.name + "」（" + __hit0.comp.numLayers + " 层）");
                    /* 那个合成就是"放副本的合成"；目标合成 = 它，副本来源也是它 */
                    targetComp = __hit0.comp;
                    fallbackSrcComp = __hit0.comp;
                }
            }
            if (!targetComp) {
                report.push("  ★ 定位目标合成失败，跳过这一段");
                report.push("    【请检查这三件事】");
                report.push("      (1) ps 07 跑完之后，PS 里【保存过 PSD】了吗？");
                report.push("          （没保存的话，AE 导入的还是旧文件，里面没有镜像树）");
                report.push("      (2) 在 AE 里【重新导入】过那份 PSD 了吗？");
                report.push("          （用旧的导入项也不会有镜像树）");
                report.push("      (3) AE 项目里有没有名为「" + (AE_S(data.mirrorRootName, "") || "?") + "」的合成？");
                report.push("          （在项目面板的「<文档名> Layers」文件夹里找找；");
                report.push("            如果没有，可能是导入时这个图层组眼睛关着、被 AE 跳过了）");
                nSkip++; report.push(""); continue;
            }

            /* 在目标合成里找"名字"文件夹对应的那一层 */
            var folderName = AE_S(folder.name, "");
            var folderLayer = AE_findLayerInComp(targetComp, folderName);
            if (!folderLayer) {
                report.push("  ★ 在「" + targetComp.name + "」里找不到「" + folderName + "」层，跳过");
                nSkip++; report.push(""); continue;
            }
            report.push("  找到文件夹层「" + folderName + "」（index=" + folderLayer.index + "）");

            /* ★★ 副本来源（用户的新方案：优先用镜像结构）★★
               镜像结构 = ps 07 在文档顶层建的文件夹（JSON: mirrorRootName），
               结构跟原 PS 文档的文件夹层级一样，副本放在最内层。
               导入 AE 后每层都是 precomp，所以按 mirrorChain 走进去即可。 */
            var mirrorRootName = AE_S(data.mirrorRootName, "");
            var mirrorChain = op.mirrorChain || [];
            var srcComp = fallbackSrcComp;      /* ★ 兜底已经找到就用它 */
            if (srcComp) report.push("  · 副本来源用兜底命中的合成「" + srcComp.name + "」");
            if (!srcComp && mirrorRootName) {
                var mres = AE_findMirrorLeaf(mirrorRootName, mirrorChain, report);
                for (var mrl = 0; mrl < mres.logs.length; mrl++) report.push(mres.logs[mrl]);
                srcComp = mres.comp;
            }
            if (!srcComp) {
                /* 退回旧方案：平铺的 __AE_jsonCopies 合成 */
                report.push("  · 镜像结构不可用，退回用「" + boxName + "」");
                var box = AE_findItemByName(boxName);
                try { if (box instanceof CompItem) srcComp = box; } catch (eB) {}
            }
            if (!srcComp) { report.push("  ★ 找不到任何副本来源（镜像和 " + boxName + " 都没有）"); nSkip++; report.push(""); continue; }
            report.push("  副本来源合成 = 「" + srcComp.name + "」（" + srcComp.numLayers + " 层）");

            /* ★ ② 把副本复制进去（按 orderTopDown 的顺序，从上到下依次复制） */
            var copies = op.copies || [];
            var madeNames = [];
            var madeLayers = [];
            /* ★ 先全部复制进来（copyToComp 会把新层放到最上面） */
            for (var c = 0; c < copies.length; c++) {
                var one = copies[c];
                var srcName = AE_S(one.name, "");
                var origName = AE_S(one.originalName, AE_S(one.sourceName, srcName));
                var nl = AE_copyOneIntoComp(srcComp, srcName, origName, targetComp, report);
                if (nl) { nCopy++; madeNames.push(origName); madeLayers.push(nl); } else nSkip++;
            }
            /* ★ 再按 orderTopDown【倒序】逐个移到最上面：
                 这样 orderTopDown=0 的那一层最终会在最上面，顺序和 PS/JSON 一致。
                 （先移最下面那个 → 最后移最上面那个） */
            try {
                var order = [];
                for (var oc = 0; oc < copies.length; oc++) {
                    var oi = AE_N(copies[oc].orderTopDown, oc);
                    order.push({ i: oc, o: oi });
                }
                /* 按 orderTopDown 从大到小排（= 从最下面到最上面） */
                for (var oa = 0; oa < order.length; oa++) {
                    for (var ob = oa + 1; ob < order.length; ob++) {
                        if (order[ob].o > order[oa].o) { var tmpO = order[oa]; order[oa] = order[ob]; order[ob] = tmpO; }
                    }
                }
                for (var ok = 0; ok < order.length; ok++) {
                    var ly = madeLayers[order[ok].i];
                    if (ly && ly.index !== 1) ly.moveToBeginning();
                }
                for (var om = 0; om < madeLayers.length; om++) {
                    if (madeLayers[om]) report.push("  ✔ 「" + madeLayers[om].name + "」最终 index=" + madeLayers[om].index);
                }
            } catch (eOrd) { report.push("  ⚠ 摆放顺序时出错：" + eOrd); }

            /* 关于 index 的说明：JSON 里给的 aeIndexInContainer 已经减掉了
               被 AE 丢掉的剪贴层；这里因为要保证多层顺序，统一用"移到最上面"
               的方式摆放，效果等同于让副本都位于目标层之上。 */
            if (madeNames.length > 0) {
                /* ★ 遮罩源 = 【目标合成里的文件夹层】（= 原文档那个 名字 合成）。
                   镜像里没有遮罩源文件夹副本（PS 侧做不到，探针已证明），
                   所以这里传 null，让 AE_applyAlphaMatte 用 folderLayer 自己那份源。 */
                nMatte += AE_applyAlphaMatte(targetComp, folderLayer, madeNames, report, null);
            }

            /* ★★ 文件夹的图层样式 ★★
               ps 07 现在给的是 folderStyles 数组（文件夹链上每一层 + 目标文件夹，
               谁有样式就收谁），这里逐条还原。 */
            if (op.folderStyles && op.folderStyles.length > 0) {
                report.push("  图层样式：" + op.folderStyles.length + " 个文件夹有样式（排入队列）");
                for (var fs = 0; fs < op.folderStyles.length; fs++) {
                    var ent = op.folderStyles[fs];
                    AE_queueStyleTask(AE_S(ent.name, ""), ent.layerEffects,
                                      "文件夹「" + AE_S(ent.name, "") + "」（" + AE_S(ent.path, "") + "）", report);
                }
            } else if (AE_has(op, "layerEffects") && op.layerEffects) {
                /* 兼容旧 JSON（单个 layerEffects） */
                AE_queueStyleTask(AE_S(folder.name, ""), op.layerEffects,
                                  "文件夹「" + AE_S(folder.name, "") + "」（旧格式）", report);
            } else {
                report.push("  （JSON 里没有文件夹样式记录）");
            }

            report.push("");
        }
        /* ★★ 所有图层操作做完之后，再统一应用图层样式 ★★
           原因：AE 的图层样式走异步工作队列（BEE_WorkQueue），
           如果在做其它图层操作的中途加样式、或者没结算就关工程，
           AE 会在 BEE_WorkQueue_PreCloseProject 处崩溃（用户实测）。 */
        try { nFx += AE_flushStyleTasks(report); } catch (eFl) { report.push("  ⚠ 样式统一应用出错：" + eFl); }

        /* ★ 收尾：取消所有图层选择，让 AE 回到干净状态（降低关工程崩溃风险） */
        try {
            var __deselected = 0;
            for (var __ci = 0; __ci < ops.length; __ci++) {
                var __tc = null;
                try { __tc = app.project.activeItem; } catch (eA2) {}
                if (!__tc || !(__tc instanceof CompItem)) break;
                for (var __li = 1; __li <= __tc.numLayers; __li++) {
                    try { if (__tc.layer(__li).selected) { __tc.layer(__li).selected = false; __deselected++; } } catch (eD2) {}
                }
                break;
            }
            report.push("  （收尾：取消了 " + __deselected + " 个图层的选择）");
        } catch (eDe) {}
    } catch (eAll) {
        report.push("★ 处理过程中出错：" + eAll);
        try { if (eAll.line) report.push("  （行 " + eAll.line + "）"); } catch (eL) {}
    } finally {
        /* ★★ 无论如何都要关掉撤销组 ★★
           踩过的坑：脚本中途崩溃时如果没关，AE 会一直停在一个"打开的撤销组"里，
           之后连 File > New > New Project 都会崩（用户实测崩了好几次）。 */
        if (undoOpened) {
            try { app.endUndoGroup(); report.push("✔ 已结束撤销组 —— 按 Ctrl+Z 一次可全撤"); }
            catch (eE) { report.push("⚠ endUndoGroup 失败：" + eE); }
        }
    }

    report.push("");
    report.push("===== 汇总 =====");
    report.push("  关副本容器眼睛 " + (nHide ? "成功" : "未成功") +
                "；复制进目标合成 " + nCopy + " 个；设 alpha 遮罩 " + nMatte + " 个" +
                "；还原图层样式 " + nFx + " 个；跳过 " + nSkip + " 个");
    report.push("");
    report.push("===== ⚠ 防崩溃提醒（重要）=====");
    report.push("  AE 的图层样式属于它自己的【异步工作队列】(BEE_WorkQueue)。");
    report.push("  实测过：脚本跑过之后，直接做 File > New > New Project（关闭工程）");
    report.push("  会让 AE 崩在 <BEE_WorkQueue> PreCloseProject —— 队列里还有没结算的任务。");
    report.push("  规避办法：");
    report.push("    1) 跑完 ae 08 之后，先 Ctrl+S 保存工程，再做别的事；");
    report.push("    2) 如果要新建工程，【先关掉 AE 再重开】，不要直接 New Project；");
    report.push("    3) 如果本次运行中途失败/崩溃过，工程状态可能已经不对，");
    report.push("       请【强制退出 AE 再重开】（别试图正常关闭那个工程）。");
    report.push("    4) 如果这样还是崩，把引擎顶部的 AE_TRY_FX 改成 false（不做图层样式），");
    report.push("       先保证复制+遮罩那部分能稳定用。");
    /* 报告已经在每一步即时写进文件了（AE_rptWrite / AE_mkReport），
       这里只把开头的关键字段区补进文件，然后弹窗给用户看。 */
    /* ★★ 收尾：把完整报告【整体重写】一次 ★★
       踩过的坑（13:50:28）：逐行写入中途失效了，报告文件缺了【样式 2/2】、小结、汇总
       这一大段尾巴（但内存里的数组是全的，所以弹窗是完整的）。
       这里在最后整体重写一遍，保证"正常跑完"的情况下文件是完整的。 */
    try {
        var __full = head + "\n\n" + report.join("\n") + "\n";
        var __paths = [AE_RPT.path, AE_RPT.path2];
        for (var __pi = 0; __pi < __paths.length; __pi++) {
            if (!__paths[__pi]) continue;
            var __all = null;
            try {
                __all = File(__paths[__pi]);
                __all.encoding = "UTF-8";
                if (__all.open("w")) {
                    try { __all.write(__full); } catch (eW3) {} finally { try { __all.close(); } catch (eC3) {} }
                } else { try { __all.close(); } catch (eC5) {} }
            } catch (eA3) { try { if (__all) __all.close(); } catch (eC4) {} }
        }
    } catch (eRW) {}

    var msg = head + "\n\n" + report.join("\n");
    msg += "\n\n报告文件（主，一定可读）：\n" + AE_RPT.path;
    if (AE_RPT.path2) msg += "\n\n报告文件（次，JSON 旁边）：\n" + AE_RPT.path2;
    /* ★ 静默模式（批量 ae 09）不弹窗，靠报告文件汇总 */
    if (!($.global.AE_HANDOFF_QUIET)) { try { alert(msg); } catch (eA) {} }

}
