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
/* 读回"当前真实选中了几层" —— 用来验证选区，别再靠假设 */
function countSelected() {
    try {
        var ref = new ActionReference();
        ref.putProperty(sid("property"), sid("targetLayers"));
        ref.putEnumerated(sid("document"), sid("ordinal"), sid("targetEnum"));
        var d = executeActionGet(ref);
        if (!d.hasKey(sid("targetLayers"))) return 0;
        return d.getList(sid("targetLayers")).count;
    } catch (e) { return -1; }
}

/* 多选（列表按【从上到下】给）
 * --------------------------------------------------------------------------
 * ★★★ 两个键千万别搞混（踩过的坑）★★★
 *   "null"  -> 放【目标引用】(ActionReference)。slct 需要一个"当前目标"作为容器；
 *   "Lyr "  -> 放【图层列表】(ActionList)。要选中的那些层的 id 放这里。
 *   之前把列表写到了 "null" 上 -> PS 报「命令"选择"当前不可用」
 *   （"发生了常规 Photoshop 错误…… 该功能可能无法在这个版本的 Photoshop 中使用"）。
 *   实际上跟 PS 版本毫无关系，就是键名错了。
 * ========================================================================== */
function selectLayersByIds(ids) {
    var list = new ActionList();
    for (var i = 0; i < ids.length; i++) {
        var r = new ActionReference();
        r.putIdentifier(cid("Lyr "), ids[i]);
        list.putReference(r);
    }
    var d = new ActionDescriptor();
    var targetRef = new ActionReference();
    targetRef.putEnumerated(cid("Lyr "), cid("Ordn"), cid("Trgt"));
    d.putReference(cid("null"), targetRef);       /* ★ 目标引用放 "null" */
    d.putList(cid("Lyr "), list);                 /* ★ 图层列表放 "Lyr " */
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

    /* ---- ⑤ 分两步合并 ----
     * ★★★ 为什么不能一次多选（实测结论）★★★
     *   如果一次多选「文件夹 + 它上方的剪贴层」再执行 Mrg2，
     *   PS 只会执行【合并组】（把文件夹拍平），完全忽略其它被选中的图层 ——
     *   结果就是"只合并了文件夹内容，上方的剪贴层一个都没动"。
     *   所以必须分两步：
     *     ① 只选文件夹                 -> Mrg2（合并组）-> 文件夹变成普通图层
     *     ② 选「上方剪贴链 + 那个图层」-> Mrg2        -> 真正合成一层
     * ---------------------------------------------------------------------- */

    /* ★ 合并前预处理：剪辑链上每层都解锁 / 取消背景层 / 栅格化智能对象。
       「命令"合并图层"当前不可用」最常见的真凶就是这三样。 */
    for (var __pk = 0; __pk < chain.length; __pk++) {
        var __Lk = chain[__pk];
        var __nk = [];
        try { if (__Lk.isBackgroundLayer) { __Lk.isBackgroundLayer = false; __nk.push("取消背景层"); } } catch (eK1) {}
        try { if (__Lk.allLocked) { __Lk.allLocked = false; __nk.push("解除全部锁定"); } } catch (eK2) {}
        try { if (__Lk.positionLocked) { __Lk.positionLocked = false; __nk.push("解除位置锁定"); } } catch (eK3) {}
        try { if (__Lk.kind === LayerKind.SMARTOBJECT) { __Lk.rasterize(RasterizeType.ENTIRELAYER); __nk.push("栅格化智能对象"); } } catch (eK4) { __nk.push("栅格化失败：" + cleanMsg("" + eK4)); }
        if (__nk.length) plog("  预处理「" + safeName(__Lk) + "」：" + __nk.join(" / "));
    }

    /* ★ 合并期间关掉 PS 的确认框：矢量智能对象合并时要栅格化，
       脚本里没人点确认 -> 会报「用户取消了操作」。
       （app.displayDialogs 才能影响 layer.merge() 这类 ExtendScript 方法） */
    var __prevDialogs = null;
    try { __prevDialogs = app.displayDialogs; } catch (ePD) { __prevDialogs = null; }
    try { app.displayDialogs = DialogModes.NO; } catch (ePD2) {}

    /* ① 拍平文件夹：用 LayerSet.merge()（= PS 的 Ctrl+E 合并组）
     * ★★★ 别再对"单个组"用 Mrg2 ★★★
     *   MRg2 的命令名是【合并图层】，要求至少两层；对单个组执行会报
     *   「命令"合并图层"当前不可用」。LayerSet.merge() 才是合并组。
     * ---------------------------------------------------------------------- */
    plog("第 1 步：拍平文件夹（LayerSet.merge()）…");

    var flatId = -1;
    try {
        var mergedL = folder.merge();
        if (mergedL) flatId = getId(mergedL);
        if (flatId >= 0) plog("  merge() 成功，结果图层 id=" + flatId);
    } catch (eM1) {
        plog("  merge() 失败：" + cleanMsg("" + eM1) + "　改用 Mrg2 退路");
    }

    if (flatId < 0) {
        try {
            selectLayersByIds([R.folderId]);
            executeAction(cid("Mrg2"), new ActionDescriptor(), DialogModes.NO);
            var flatL = DOC.activeLayer; if (flatL) flatId = getId(flatL);
        } catch (eM2) {
            plog("  退路 Mrg2 也失败：" + cleanMsg("" + eM2));
        }
    }
    if (flatId < 0) throw new Error("拍平文件夹失败（merge() 与 Mrg2 都没成）");
    plog("  已拍平，结果图层 id=" + flatId + "　名字=「" + safeName(DOC.activeLayer) + "」");

    /* ② 上方剪贴链：从最下面那层开始，逐层 ArtLayer.merge()（合并向下）
     * ★ 不用 Mrg2 多选：PS 对"多选 + 合并图层"经常报
     *   「命令"合并图层"当前不可用」，而且含组时还会只做合并组。
     *   merge() 是"与下面那层合并"，一层层并下去，语义最确定。
     *   （合并向下保留【下面那层】的 id，所以拍平后的图层一直有效。）
     * ------------------------------------------------------------------ */
    if (chain.length > 0) {
        /* ★ 第 2 步：先走【Mrg2 多选】—— 这条路在真实文档上验证过可用
         *   （日志实测：3 层多选 -> 消失 4 个 -> 合成 1 层，结果正确）。
         *   万一失败，再退回逐层 ArtLayer.merge()。
         * -------------------------------------------------------------- */
        var ids2 = [];
        for (var q2 = chain.length - 1; q2 >= 0; q2--) ids2.push(getId(chain[q2]));   /* 从上到下 */
        ids2.push(flatId);                                                            /* 拍平后的层在最下 */
        plog("第 2 步：连同上方 " + chain.length + " 个剪贴层合并（共 " + ids2.length + " 层）：" + ids2.join(", "));

        /* ★ 先验证选区真的选中了 N 层 ——「命令"合并图层"当前不可用」
           最常见的原因就是实际只选中了 1 层（合并图层至少要 2 层）。 */
        var step2ok = false;
        try {
            selectLayersByIds(ids2);
            var cnt2 = countSelected();
            plog("  选区自检：想选 " + ids2.length + " 层，实际选中 " + cnt2 + " 层");
            if (cnt2 === ids2.length) {
                executeAction(cid("Mrg2"), new ActionDescriptor(), DialogModes.NO);
                step2ok = true;
                plog("  ✔ Mrg2 多选合并成功");
            } else {
                plog("  ★ 选区数量不对，跳过 Mrg2，改用逐层合并向下");
            }
        } catch (eS2) {
            plog("  Mrg2 多选失败（" + cleanMsg("" + eS2) + "），改用逐层合并向下");
        }

        if (!step2ok) {
            var flatLayer = null;
            try { flatLayer = DOC.activeLayer; } catch (eFL) { flatLayer = null; }
            if (!flatLayer) throw new Error("第 2 步：拿不到活动图层");
            for (var q = chain.length - 1; q >= 0; q--) {
                try {
                    chain[q].merge();
                    plog("  ✔ 已并入「" + safeName(chain[q]) + "」（逐层）");
                } catch (eM3) {
                    throw new Error("合并「" + safeName(chain[q]) + "」失败：" + cleanMsg("" + eM3));
                }
            }
        }
    } else {
        plog("第 2 步：上方没有剪贴层，跳过（只需拍平）");
    }

    /* 合并做完了，还原对话框设置 */
    try { if (__prevDialogs !== null) app.displayDialogs = __prevDialogs; } catch (ePD3) {}

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

    /* ---- ⑦ 校验：消失的层数应该正好 ----
     * ★ 公式修正：
     *   拍平文件夹时，"文件夹自己 + 它的 N 个后代" 会变成 1 个图层，
     *   所以消失的是 N 个（后代数），【文件夹自己不算额外消失】。
     *   第二步把 M 个剪贴层并进这 1 个，消失 M 个。
     *   合计 = 后代数 + 剪贴层数。
     *   （以前多算了"+1 文件夹自己"，所以总是报"预期 5、实际 4"的假警报。） */
    var expectGone = R.folderDescendants + chain.length;
    plog("  [校验] 预期消失 " + expectGone + " 个（文件夹后代 " + R.folderDescendants +
         " + 上方剪贴链 " + chain.length + "；文件夹自己并入首层、不额外算），实际消失 " + goneCount + " 个");
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
        /* ★★ 两种子情况要分开 ★★
           ① 文件夹原本是【穿透】(PassThrough)：
              合并结果是【普通图层】，而"穿透"只能用于图层组 ——
              PS 会报「"穿透"混合模式只可用于图层组」。
              这是必然的，不是失败：结果保持【正常】正是要的效果，
              所以【不要去设置、也不要记警告】。
           ② 其它模式：保持文件夹原本的模式即可（内部全是正常 -> 不改）。 */
        if (String(R.folderBlend).toUpperCase() === "PASSTHROUGH") {
            doSet = false;
            note = "内部图层全是【正常】；文件夹原为【穿透】—— 结果层是普通图层，" +
                   "保持【正常】（符合预期，不视为失败）";
        } else {
            doSet = true;
            goalVal = R.folderBlendVal;
            goalName = R.folderBlend;
            note = "内部图层（排除剪贴层）全是【正常】-> 按需求不修改" +
                   "（保持文件夹原本的模式：" + R.folderBlend + "）";
        }
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
        /* ★★ 这里必须区分两种错误来源 ★★
           suspendHistory 抛错有两种可能：
             ① 它自己在这个 PS 上不可用；
             ② 里面执行的 doWork() 抛了异常。
           以前一律当 ① 处理，于是【又跑一遍 doWork】—— 日志里出现重复的剪贴链、
           图层也会被操作两次。现在只有错误信息里明确带 "suspendHistory" 才重试。 */
        var m0 = cleanMsg("" + eS);
        if (/suspendHistory/i.test(m0)) {
            plog("（suspendHistory 不可用，改为直接跑：" + m0 + "）");
        } else {
            ran = true;                     /* 视为"跑过了，但失败了"：不再重跑 */
            errMsg = m0;
            plog("★ 出错：" + errMsg);
        }
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
    /* ★★ 成功一律不弹窗（按用户要求）★★
       只有【失败】才弹。
       成功时的细节（含 ⚠ 警告，比如混合模式没能完全还原、文件夹是穿透所以结果用了正常）
       全都写进日志文件，不再打断操作。
       日志：%TEMP%\psjsx_merge_folder_log.txt */
    if (!errMsg) {
        return;                 /* 成功：静默 */
    }
    try { alert(t); } catch (e) {}
}

try { main(); } catch (eM) {
    try { plog("★ 整体出错：" + cleanMsg("" + eM)); } catch (e2) {}
    try { showResult(cleanMsg("" + eM)); } catch (e3) {}
}

})();
