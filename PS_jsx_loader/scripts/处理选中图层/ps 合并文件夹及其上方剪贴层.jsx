#target photoshop
/* ==========================================================================
 * ps 合并文件夹及其上方剪贴层
 * --------------------------------------------------------------------------
 * 【独立工具，不属于批量流程】
 *
 * 做什么：等于"选中【文件夹本身 + 它上方那些剪贴蒙版图层】，然后按 Ctrl+E"，
 *         然后：
 *           · 把结果层的名字还原成文件夹原来的名字
 *           · 检查文件夹【内部】的图层是不是同一个混合模式（★ 排除剪贴层）：
 *               内部模式一致 且 不是"正常"  -> 结果层设成这个模式
 *               内部模式全是"正常"          -> 不修改（按需求）
 *               内部模式不一致              -> 不修改
 *
 * 使用前提（按用户描述）：
 *   · 你已经【选中了一个文件夹图层】（图层组）
 *   · 有可能同时还选中了它上面的剪贴蒙版图层 —— 这两种情况【处理完全一样】：
 *     脚本只认"选中的那个文件夹"，剪贴链由脚本自己在同一父容器里找齐。
 *
 * --------------------------------------------------------------------------
 * 几个关键实现点（都是这个项目里踩过坑的地方）：
 *   ① 读选区用 ActionManager 的 targetLayers（普通 DOM 读不出多选）。
 *   ② 剪贴链：在同一父容器里，从文件夹往【上】（下标更小）走，
 *      只要 grouped === true 就收进来，一遇到不剪贴的就停。
 *   ③ 合并沿用本项目做法：executeAction("Mrg2")（PS 多选时就是"合并图层"= Ctrl+E）。
 *   ④ ★★ 混合模式不靠"按名字查枚举" ★★
 *      —— 直接从【文件夹里那个同模式的图层】身上取 blendMode 值赋给结果层，
 *         这样不可能因为枚举名对不上而失败。（按名字 for..in 遍历 BlendMode 不可靠）
 *   ⑤ ★★ 合并后必须校验 ★★ 用"合并前后的图层 id 差集"确认：
 *        · 新出现的层应该是 0 或 1 个
 *          （合并通常把【下面那层】留下来 = 复用文件夹的 id，所以可能没有新 id；
 *            全新 id 也有可能 —— 两种都要认，不然会误报失败）
 *        · 消失的层数应该正好 = 文件夹全部后代 + 文件夹自己 + 外部剪贴链
 *          多死一个都报警（ps 05 就是栽在"合并把别的层吃掉"这类问题上）
 *   ⑥ ★ 不还原 opacity / fillOpacity：合并已经把不透明度烤进像素了，
 *      再还一次等于乘两遍（50% 会变 25%）。
 *
 * 撤销：整段包在一个 suspendHistory 里，Ctrl+Z 一次全撤。
 * 日志：%TEMP%\psjsx_merge_folder_log.txt（每行即时落盘）
 * ========================================================================== */

(function () {

var OPTIONS = {
    applyUniformBlend: true,     // 内部模式一致(且非"正常")时，套用到结果层
    restoreName: true,           // 把结果层改回文件夹原名
    makeDiffLayer: false,        // 建差值对比层（想验证"画面没变"再打开；大文件会慢）
    diffName: "__对比 合并文件夹前(差值)"
};

var DOC = null;
var R = {
    ok: false,
    folderName: "", folderId: -1, folderBlend: "", folderBlendVal: null,
    folderDescendants: 0,
    clipNames: [], clipIds: [],
    innerTotal: 0, innerSkippedClip: 0, innerModes: [], uniformMode: "",
    sampleLayer: null,                     /* 内部"同模式"里拿一个当样板，用来取 blendMode 值 */
    mergedName: "", mergedId: -1, idReused: false,
    blendApplied: "", blendNote: "",
    warn: [], elapsed: 0, diffMade: false, diffWhy: ""
};

/* ==========================================================================
 * 小工具
 * ========================================================================== */
function cid(k) { try { return charIDToTypeID(k); } catch (e) { return false; } }
function sid(k) { try { return stringIDToTypeID(k); } catch (e) { return false; } }
function cleanMsg(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 300); } catch (e) { return "" + s; } }
function nowMs() { return (new Date()).getTime(); }
function getId(L) { try { return L.id; } catch (e) { return -1; } }
function safeName(L) { try { return L.name; } catch (e) { return "?"; } }
function isGroup(L) { try { return (L.typename === "LayerSet"); } catch (e) { return false; } }
function isVisible(L) { try { return (L.visible !== false); } catch (e) { return true; } }
function isClipped(L) { try { return (L.grouped === true); } catch (e) { return false; } }

function walk(container, fn) {
    var arr = null;
    try { arr = container.layers; } catch (e) { return; }
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
        fn(arr[i]);
        if (isGroup(arr[i])) walk(arr[i], fn);
    }
}
function byId(id) {
    var f = null;
    walk(DOC, function (L) { if (!f && getId(L) === id) f = L; });
    return f;
}
function layerIdSet() {
    var map = {};
    walk(DOC, function (L) { var id = getId(L); if (id >= 0) map[id] = safeName(L); });
    return map;
}
function countLayers(container) {
    var n = 0;
    walk(container, function () { n++; });
    return n;
}

/* 混合模式名字（去掉 "BlendMode." 前缀，统一大写），只用于显示与比较 */
function modeName(L) {
    try {
        var s = "" + L.blendMode;
        var i = s.lastIndexOf(".");
        if (i >= 0) s = s.substring(i + 1);
        return s.toUpperCase();
    } catch (e) { return "?"; }
}
function isNormalMode(m) { return (m === "NORMAL"); }

function pathOf(L) {
    var parts = [], cur = L, guard = 0;
    while (cur && guard < 60) {
        guard++;
        try {
            if (cur.parent === DOC) break;
            parts.unshift(safeName(cur));
            cur = cur.parent;
        } catch (e) { break; }
    }
    return parts.join(" / ");
}

/* ==========================================================================
 * 选区（ActionManager：普通 DOM 读不出多选）
 * ========================================================================== */
function getSelectedLayers() {
    var out = [];
    try {
        var ref = new ActionReference();
        ref.putProperty(sid("property"), sid("targetLayers"));
        ref.putEnumerated(sid("document"), sid("ordinal"), sid("targetEnum"));
        var desc = executeActionGet(ref);
        if (!desc.hasKey(sid("targetLayers"))) return out;
        var list = desc.getList(sid("targetLayers"));
        for (var i = 0; i < list.count; i++) {
            var idx = list.getReference(i).getIndex() + 1;      /* Photoshop 索引从 1 开始 */
            var L = layerByIndex(idx);
            if (L) out.push(L);
        }
    } catch (e) {}
    return out;
}
function layerByIndex(index) {
    var found = null;
    (function rec(container) {
        if (found) return;
        var arr = null;
        try { arr = container.layers; } catch (e) { return; }
        if (!arr) return;
        for (var i = 0; i < arr.length; i++) {
            var L = arr[i];
            try { if (L.itemIndex === index) { found = L; return; } } catch (e2) {}
            if (isGroup(L)) { rec(L); if (found) return; }
        }
    })(DOC);
    return found;
}
/* 多选（列表按【从上到下】给） */
function selectLayersByIds(ids) {
    var list = new ActionList();
    for (var i = 0; i < ids.length; i++) {
        var r = new ActionReference();
        r.putIdentifier(cid("Lyr "), ids[i]);
        list.putReference(r);
    }
    var d = new ActionDescriptor();
    d.putList(cid("null"), list);
    executeAction(cid("slct"), d, DialogModes.NO);
}

/* ==========================================================================
 * 找"文件夹上方连续的剪贴链"
 * ========================================================================== */
function clipChainAbove(folder) {
    var out = [];
    try {
        var parent = folder.parent;
        var arr = parent.layers;
        var myIdx = -1;
        for (var i = 0; i < arr.length; i++) { if (getId(arr[i]) === getId(folder)) { myIdx = i; break; } }
        if (myIdx < 0) return out;
        for (var j = myIdx - 1; j >= 0; j--) {
            var L = arr[j];
            if (!isClipped(L)) break;
            out.push(L);
        }
    } catch (e) {}
    return out;      /* 紧贴着文件夹、自下而上 */
}

/* ==========================================================================
 * 统计文件夹【内部】各图层的混合模式（★ 排除剪贴层与子文件夹本身）
 *   同时留一个"样板图层"，后面直接拿它的 blendMode 值去赋给结果层
 * ========================================================================== */
function scanInnerModes(folder) {
    var modes = [], total = 0, skippedClip = 0, sample = null;
    (function rec(container) {
        var arr = null;
        try { arr = container.layers; } catch (e) { return; }
        if (!arr) return;
        for (var i = 0; i < arr.length; i++) {
            var L = arr[i];
            if (isGroup(L)) { rec(L); continue; }        /* 子文件夹本身不算，进去看里面 */
            if (isClipped(L)) { skippedClip++; continue; }   /* ★ 剪贴层不计入 */
            var m = modeName(L);
            total++;
            if (sample === null) sample = L;
            var dup = false;
            for (var q = 0; q < modes.length; q++) { if (modes[q] === m) { dup = true; break; } }
            if (!dup) modes.push(m);
        }
    })(folder);
    R.innerTotal = total;
    R.innerSkippedClip = skippedClip;
    R.innerModes = modes;
    R.uniformMode = (modes.length === 1) ? modes[0] : "";
    R.sampleLayer = sample;
    return modes;
}

/* ==========================================================================
 * 差值对比层（可选，默认关）
 * ========================================================================== */
function makeDiff() {
    try {
        var prev = null;
        walk(DOC, function (L) { if (safeName(L) === OPTIONS.diffName) prev = L; });
        if (prev) { try { prev.remove(); } catch (e0) {} }

        /* 先选中"最上面那个可见图层"，否则"合并可见图层"会拒绝执行 */
        var top = null;
        try {
            var arr = DOC.layers;
            for (var i = 0; i < arr.length; i++) { if (isVisible(arr[i])) { top = arr[i]; break; } }
            if (!top && arr.length) top = arr[0];
        } catch (e1) {}
        if (top) selectLayersByIds([getId(top)]);

        var d = new ActionDescriptor();
        d.putBoolean(cid("Dplc"), true);
        executeAction(cid("MrgV"), d, DialogModes.NO);

        var made = DOC.activeLayer;
        try { made.name = OPTIONS.diffName; } catch (eN) {}
        try {
            var t2 = DOC.layers[0];
            if (getId(t2) !== getId(made)) made.move(t2, ElementPlacement.PLACEBEFORE);
        } catch (eM) {}
        try { made.blendMode = BlendMode.DIFFERENCE; }
        catch (eB) { try { made.remove(); } catch (eB2) {} throw new Error("设差值失败"); }
        try { made.visible = false; } catch (eV) {}
        R.diffMade = true;
    } catch (e) { R.diffWhy = cleanMsg("" + e); }
}

/* ==========================================================================
 * 日志（每行即时落盘：攒到最后一并写，中途崩了就全丢）
 * ========================================================================== */
var LOG = { path: "" };
function logPath() { return LOG.path; }
function logOpen() {
    try {
        LOG.path = Folder.temp.fsName + "/psjsx_merge_folder_log.txt";
        var f = File(LOG.path);
        f.encoding = "UTF-8";
        if (f.open("w")) { try { f.write(""); } catch (e0) {} try { f.close(); } catch (e1) {} }
    } catch (e) { LOG.path = ""; }
}
function plog(s) {
    var line = "[" + (new Date()).toTimeString().substring(0, 8) + "] " + s;
    if (!LOG.path) return;
    var f = null;
    try {
        f = File(LOG.path);
        f.encoding = "UTF-8";
        if (!f.open("a")) return;
        try { f.write(line + "\r\n"); } catch (eW) {} finally { try { f.close(); } catch (eC) {} }
    } catch (e) { try { if (f) f.close(); } catch (e2) {} }
}

/* ==========================================================================
 * 主流程
 * ========================================================================== */
function doWork() {
    var t0 = nowMs();

    /* ---- ① 读选区，找目标文件夹 ---- */
    var sel = getSelectedLayers();
    var selDesc = [];
    for (var sd = 0; sd < sel.length; sd++) selDesc.push(safeName(sel[sd]) + (isGroup(sel[sd]) ? "(文件夹)" : ""));
    plog("选中的图层 " + sel.length + " 个：" + (selDesc.length ? selDesc.join(" / ") : "（空）"));

    var folder = null;
    for (var i = 0; i < sel.length; i++) {
        if (isGroup(sel[i]) && !folder) folder = sel[i];
    }
    if (!folder) throw new Error("选区里没有【文件夹】。请先选中一个图层组（可以连它上面的剪贴蒙版图层一起选）。");

    R.folderName = safeName(folder);
    R.folderId = getId(folder);
    R.folderBlend = modeName(folder);
    try { R.folderBlendVal = folder.blendMode; } catch (eFB) { R.folderBlendVal = null; }
    R.folderDescendants = countLayers(folder);
    plog("目标文件夹：「" + R.folderName + "」　路径：" + pathOf(folder));
    plog("  它自己的混合模式=" + R.folderBlend + "　内部图层总数（含子文件夹）=" + R.folderDescendants);

    /* ---- ② 找它上方连续的剪贴链 ---- */
    var chain = clipChainAbove(folder);
    for (var c = 0; c < chain.length; c++) {
        R.clipIds.push(getId(chain[c]));
        R.clipNames.push(safeName(chain[c]));
    }
    plog("文件夹上方连续的剪贴层 " + chain.length + " 个：" +
         (R.clipNames.length ? R.clipNames.join(" / ") : "（没有）"));
    for (var c2 = 0; c2 < chain.length; c2++) {
        plog("    · 「" + safeName(chain[c2]) + "」　混合模式=" + modeName(chain[c2]));
    }

    /* ---- ③ 统计文件夹内部（排除剪贴层）的混合模式 ---- */
    scanInnerModes(folder);
    plog("文件夹内部：参与统计 " + R.innerTotal + " 个普通图层（另跳过剪贴层 " + R.innerSkippedClip + " 个，" +
         "子文件夹本身不计）");
    plog("  出现的混合模式：" + (R.innerModes.length ? R.innerModes.join(" / ") : "（内部没有普通图层）"));
    plog("  -> " + (R.uniformMode ? ("模式一致：" + R.uniformMode) : ("模式不一致（" + R.innerModes.length + " 种）")));

    /* ---- ④ 记下合并前状态（用来校验有没有多死图层） ---- */
    var idsBefore = layerIdSet();

    /* ---- ⑤ 选中：剪贴链（上）+ 文件夹（下），然后 Ctrl+E ---- */
    var ids = [];
    for (var q = chain.length - 1; q >= 0; q--) ids.push(getId(chain[q]));   /* 从上到下 */
    ids.push(R.folderId);                                                    /* 文件夹在最下 */
    plog("准备合并 " + ids.length + " 个图层（从上到下）：" +
         (function () { var ns = []; for (var z = 0; z < ids.length; z++) ns.push(ids[z]); return ns.join(", "); })());
    selectLayersByIds(ids);

    plog("执行合并（相当于 Ctrl+E：Mrg2）…");
    executeAction(cid("Mrg2"), new ActionDescriptor(), DialogModes.NO);

    /* ---- ⑥ 找结果层 ----
       合并通常把【下面那层】留下来 = 复用文件夹的 id；也可能生成全新 id。
       两种都认，不然会误报"合并结果不对"。 */
    var idsAfter = layerIdSet();
    var newIds = [];
    for (var idk in idsAfter) { if (!idsBefore[idk]) newIds.push(parseInt(idk, 10)); }
    var goneCount = 0;
    for (var idk2 in idsBefore) { if (!idsAfter[idk2]) goneCount++; }

    plog("合并后：新出现 " + newIds.length + " 个图层；消失 " + goneCount + " 个");

    var res = null;
    if (newIds.length === 1) {
        res = byId(newIds[0]);
    } else if (newIds.length === 0 && idsAfter[R.folderId]) {
        R.idReused = true;
        res = byId(R.folderId);
        plog("  （结果层复用了文件夹原来的 id=" + R.folderId + " —— 这是合并的常见行为，正常）");
    }
    if (!res) {
        throw new Error("找不到合并结果层（新出现 " + newIds.length + " 个图层）。" +
                        "请 Ctrl+Z 撤销后检查选区，并把日志发我。");
    }
    R.mergedId = getId(res);
    R.mergedName = safeName(res);
    plog("结果层：「" + R.mergedName + "」　id=" + R.mergedId + "　还是文件夹吗=" + (isGroup(res) ? "是(★异常)" : "否"));

    /* ---- ⑦ 校验：消失的层数应该正好 ---- */
    var expectGone = R.folderDescendants + 1 /* 文件夹自己 */ + chain.length;
    plog("  [校验] 预期消失 " + expectGone + " 个（文件夹后代 " + R.folderDescendants +
         " + 文件夹自己 1 + 上方剪贴链 " + chain.length + "），实际消失 " + goneCount + " 个");
    if (goneCount !== expectGone) {
        R.warn.push("★ 消失的图层数(" + goneCount + ")和预期(" + expectGone +
                    ")对不上 —— 有可能多合掉了别的图层，请检查画面（或 Ctrl+Z 撤销）");
    }
    if (isGroup(res)) {
        R.warn.push("★ 合并后还是个图层组（不是普通图层）—— 说明合并没真正生效，请检查");
    }

    /* ---- ⑧ 还原名字 ---- */
    if (OPTIONS.restoreName) {
        try { res.name = R.folderName; } catch (eRN) {}
    }
    R.mergedName = safeName(res);
    plog("结果层名字：" + R.mergedName + (OPTIONS.restoreName ? ("（还原成文件夹原名「" + R.folderName + "」）") : ""));

    /* ---- ⑨ 混合模式 ----
       ★ 不按名字查 BlendMode 枚举（不可靠），直接拿"内部同模式样板层"的 blendMode 值赋过去 */
    var before = modeName(res);
    var note = "";
    var doSet = false, goalVal = null, goalName = "";

    if (OPTIONS.applyUniformBlend && R.uniformMode && !isNormalMode(R.uniformMode) && R.sampleLayer) {
        doSet = true;
        goalVal = (function () { try { return R.sampleLayer.blendMode; } catch (e) { return null; } })();
        goalName = R.uniformMode;
        note = "内部图层（排除剪贴层）模式一致 = " + R.uniformMode + " -> 套用到结果层";
    } else if (R.uniformMode && isNormalMode(R.uniformMode)) {
        doSet = true;
        goalVal = R.folderBlendVal;
        goalName = R.folderBlend;
        note = "内部图层（排除剪贴层）全是【正常】-> 按需求不修改" +
               "（保持文件夹原本的模式：" + R.folderBlend + "）";
    } else if (R.innerModes.length > 1) {
        doSet = true;
        goalVal = R.folderBlendVal;
        goalName = R.folderBlend;
        note = "内部图层模式不一致（" + R.innerModes.join(" / ") + "）-> 不套用" +
               "（保持文件夹原本的模式：" + R.folderBlend + "）";
    } else {
        note = "内部没有可统计的普通图层 -> 保持原样（" + before + "）";
    }

    if (doSet && goalVal !== null && goalVal !== undefined) {
        var goalNameReal = "";
        try {
            goalNameReal = "" + goalVal;
            var dot = goalNameReal.lastIndexOf(".");
            if (dot >= 0) goalNameReal = goalNameReal.substring(dot + 1);
        } catch (eGN) {}
        if (goalNameReal.toUpperCase() === before) {
            note += "　（本来就已经是这个模式，没动）";
        } else {
            try {
                res.blendMode = goalVal;
                note += "　-> 已设为 " + modeName(res);
            } catch (eBM) {
                note += "　★ 设置失败：" + cleanMsg("" + eBM);
                R.warn.push("设置混合模式失败：" + cleanMsg("" + eBM));
            }
        }
    } else if (doSet) {
        note += "　★ 没拿到可用的混合模式值（枚举值取不到），没有改";
        R.warn.push("拿不到目标混合模式的枚举值（" + goalName + "），结果层模式保持原样");
    }

    R.blendApplied = modeName(res);
    R.blendNote = note;
    plog("混合模式：合并后本来是 " + before + " -> 现在是 " + R.blendApplied);
    plog("  判定：" + note);

    R.elapsed = Math.round((nowMs() - t0) / 100) / 10;
    R.ok = true;
    plog("耗时 " + R.elapsed + " 秒");
}

/* ==========================================================================
 * 入口
 * ========================================================================== */
function main() {
    if (app.documents.length === 0) { alert("没有打开的文档。"); return; }
    DOC = app.activeDocument;
    logOpen();
    plog("===== ps 合并文件夹及其上方剪贴层 开始 =====");
    plog("文档：" + DOC.name);

    var ran = false, errMsg = "";
    try {
        try { $.global.PSJSX_HOOK = doWork; } catch (eG) {}
        if (typeof $.global.PSJSX_HOOK === "function") {
            DOC.suspendHistory("合并文件夹及其上方剪贴层", "PSJSX_HOOK()");
            ran = true;
        }
    } catch (eS) {
        plog("（suspendHistory 不可用，改为直接跑：" + cleanMsg("" + eS) + "）");
    }
    if (!ran) {
        try { doWork(); } catch (eD) { errMsg = cleanMsg("" + eD); plog("★ 出错：" + errMsg); }
    }

    /* 可选的对比层（必须在主 suspendHistory 之外 —— suspendHistory 不能嵌套） */
    if (OPTIONS.makeDiffLayer && !errMsg) {
        try { makeDiff(); } catch (eDF) { R.diffWhy = cleanMsg("" + eDF); }
    }

    plog("===== 结束 =====");
    showResult(errMsg);
}

function showResult(errMsg) {
    if (typeof Window === "undefined") return;
    try { if ($.global && $.global.PSJSX_BATCH === true) return; } catch (eB) {}   /* 批处理下不弹窗 */
    var t = "";
    if (errMsg) {
        t = "合并文件夹及其上方剪贴层 —— 失败\n\n" + errMsg + "\n\n日志：\n" + logPath();
    } else {
        t = "合并文件夹及其上方剪贴层 —— 完成\n\n";
        t += "文件夹：「" + R.folderName + "」\n";
        t += "上方剪贴层：" + (R.clipNames.length ? (R.clipNames.join(" / ") + "（" + R.clipNames.length + " 个）") : "无") + "\n";
        t += "结果层：「" + R.mergedName + "」" + (R.idReused ? "（复用了文件夹的 id）" : "") + "\n\n";
        t += "内部图层混合模式：" + (R.innerModes.length ? R.innerModes.join(" / ") : "（无）") + "\n";
        t += "  参与统计 " + R.innerTotal + " 个，跳过剪贴层 " + R.innerSkippedClip + " 个\n\n";
        t += "结果层混合模式：" + R.blendApplied + "\n";
        t += R.blendNote + "\n";
        if (R.warn.length) {
            t += "\n⚠ 注意：\n";
            for (var i = 0; i < R.warn.length; i++) t += "· " + R.warn[i] + "\n";
        }
        t += "\n（一次 Ctrl+Z 可以整体撤销）";
        t += "\n\n日志：\n" + logPath();
    }
    try { alert(t); } catch (e) {}
}

try { main(); } catch (eM) {
    try { plog("★ 整体出错：" + cleanMsg("" + eM)); } catch (e2) {}
    try { showResult(cleanMsg("" + eM)); } catch (e3) {}
}

})();
