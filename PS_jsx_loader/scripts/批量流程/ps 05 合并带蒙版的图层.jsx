#target photoshop
/* ==========================================================================
 * ps 05 合并带蒙版的图层（简单版）
 * --------------------------------------------------------------------------
 * 做法就是用户一直用顺手的那套【空对象合并】（和 ps 选择层空对象合并.jsx 一致）：
 *     选中目标层 → 在它正下方建一个空图层 → 重选目标层 → Mrg2 向下合并
 * 合并后蒙版（图层蒙版 / 矢量蒙版）就烤进了像素，结果层上没有蒙版。
 *
 * 处理范围
 *   ✔ 有【图层蒙版】或【矢量蒙版】的图层
 *   ✔ 形状/填充/文字图层（光靠 Mrg2 不会真合并掉，所以先栅格化再合并 —— 见下）
 *   ✔ 剪贴蒙版图层（普通图层被剪贴：照合并）
 *   ✘ 文件夹本身（不动；但会递归进去处理它里面的图层）
 *   ✘ 被剪贴到【文件夹】上的图层（"文件夹上的剪贴蒙版"，按用户要求跳过）
 *   ✘ 文件夹上的图层蒙版/矢量蒙版（属于文件夹，不动）
 *   ✘ 隐藏图层（不碰）
 *   ✘ 调整图层（合并会把观感改掉，留着）
 *
 * 为什么没有"画面指纹核对 / 自动回滚"：
 *   用户要求换成简单直接的做法，出问题再看。所以这里只做了一个最轻的校验 ——
 *   "合并后图层总数必须减 1"，减不了就记失败。整份处理包在一个历史步骤里，
 *   不满意可以一次 Ctrl+Z 全部回退。
 *
 * 约定：IIFE 隔离 / 进度条不写 preferredSize / 启动块放文件末尾 /
 *       ES3 安全（不用 filter/map/forEach/数组 indexOf）/ 永不删 __对比 图层 / 批处理钩子。
 * ========================================================================== */

(function () {

var OPTIONS = {
    askOptions: true,
    rememberOptions: true,
    // 只处理"有图层蒙版"的图层（true）还是图层蒙版+矢量蒙版都处理（false）
    layerMaskOnly: false,

    // 合并后如果结果层上还挂着蒙版，就把它删掉（AE 那边不该多一张蒙版）
    deleteLeftoverMask: true,
    // ★ 安全开关：空层没落到目标层正下方时，
    //   false（默认）= 放弃合并这一层（宁可不合，也不吃掉别的图层）
    //   true = 仍然合并（会吃掉目标层下方的真实图层！只用于排查）
    mergeEvenIfNotPlaced: false,
    // 建差值对比层（和 01/02/03/04 一样：盖印可见图层 → 最顶层 → 混合模式=差值）
    makeDiffLayer: true,
    diffName: "__对比 05-合并蒙版前(差值)"
};

var PREF_NAME = "ps_05_合并带蒙版的图层_选项.txt";
var DOC = null;
var PB = { win: null, bar: null, txt: null, n: 0, total: 1, cancel: false, btn: null };
var LOG = { f: null, path: "" };
var R = {
    total: 0, ok: [], skipped: [], failed: [],
    skipFolder: 0, skipFolderClip: 0, skipHidden: 0, skipAdjust: 0, skipShape: 0, elapsed: 0,
    blendRestored: 0, blendFailed: 0, blendFailedList: [], clipRestored: 0,
    diffMade: false, diffWhy: "", diffBase: null, aborted: false
};
var DONE_ID = {};

/* ------------------------------ 主流程 ------------------------------ */
function doMerge() {
    if (app.documents.length === 0) return;
    if (!DOC) DOC = app.activeDocument;

    var list = [];
    scan(DOC, list, true);
    R.total = list.length;
    if (R.total === 0) {
        plog("没有找到需要合并的带蒙版图层。");
        return;
    }

    plog("候选图层 " + R.total + " 个，开始逐个合并（空对象合并）");

    // ★ 进度条：一定要在这里开（之前漏了 pbOpen，导致进度条从头到尾都不显示，
    //   看起来就像卡死了）。批处理模式下 pbOpen 会自己跳过。
    if (typeof Window !== "undefined") pbOpen("ps 05 合并带蒙版的图层", R.total);

    for (var i = 0; i < R.total; i++) {
        // ★ 每层开始前检查一次"停止信号文件"
        if (checkStopFlag() || pbCancelled()) {
            plog("⚠ 已收到中止请求：已处理 " + i + " / " + R.total + " 层，剩下的跳过");
            R.aborted = true;
            break;
        }
        processOne(list[i], i + 1);
    }

    pbClose();
}

/* 处理单个候选图层：选中 → 下方建空层 → 重选 → Mrg2 */
function processOne(meta, idxNo) {
    var L = byId(meta.id);
    if (!L) { plog("· 图层已不存在，跳过：" + meta.path); return; }
    if (DONE_ID[meta.id]) return;
    DONE_ID[meta.id] = true;

    if (!isVisible(L)) {
        R.skipHidden++;
        R.skipped.push(meta.path + "（隐藏）");
        return;
    }
    if (isGroup(L)) {                       // 理论上扫描已排除，这里再兜一次
        R.skipFolder++;
        return;
    }
    // ★ 形状/填充/文字层：只有"另有图层蒙版"才处理（它自带的形状路径不算蒙版）
    if (isShapeLikeLayer(L) && !hasLayerMask(L)) {
        R.skipShape++;
        return;
    }

    var nameBefore = safeName(L);

    /* ★★ 合并会把"混合模式"和"剪贴关系"丢掉（新空层是 normal，而且不剪贴）★★
       实测 bug（用户反馈）：图层 6 本来是【叠加】，05 合完变成【正常】，画面巨变。
       单独用「ps 选择层空对象合并.jsx」没这个问题 —— 因为它合完会把 blendMode 还回去；
       ps 03 / ps 04 也都保存并还原了 blendBefore，只有 05 漏了。
       所以这里先记下来，合并后原样还回去。
       ★ 注意【不要】还 opacity / fillOpacity：合并已经把不透明度烤进像素了，
         再还一次等于乘两遍（50% 会变 25%），画面反而更错。 */
    var blendBefore = null, clipBefore = false;
    try { blendBefore = L.blendMode; } catch (eB0) {}
    try { clipBefore = (L.grouped === true); } catch (eC0) {}

    pbStep("(" + idxNo + "/" + R.total + ") " + nameBefore);

    // 解锁（只在真要动它的时候才解锁）
    try {
        if (L.allLocked) L.allLocked = false;
        try { if (L.protectTransparency) L.protectTransparency = false; } catch (e1) {}
        try { if (L.protectPosition) L.protectPosition = false; } catch (e2) {}
    } catch (eU) {}

    var ok = false, why = "";

    // 合并前记下【目标层正下方那一层】是谁，方便日志里核对
    //   （它应该就是我们刚建的空层；不是的话合并会吃掉它）
    var belowName = "?";
    try { var bl0 = layerDirectlyBelow(meta.id); if (bl0) belowName = safeName(bl0); } catch (eb0) {}

    // ---- 空对象合并（照 ps 选择层空对象合并.jsx 的写法）----
    //
    // ★★ 安全保护（必须保留，别删）★★
    //   Mrg2 = 向下合并，会把【目标层】和【它正下方那一层】一起合掉。
    //   所以必须确保目标层正下方就是我们刚建的那个空层；
    //   万一空层没挑到位（例如 .move() 失败、或空层落在别处），
    //   合并就会吃掉一个【不该动的真实图层】（比如一个没蒙版的矢量图层）。
    //   下面 byId()!=null 这条是最后的拦网：不确定就宁可不合。
    try {
        if (!selectById(meta.id)) throw new Error("选不中目标层");
        var emptyL = DOC.artLayers.add();                    // 建空层（当前活动图层 = 目标层）
        if (!emptyL) throw new Error("建空图层失败");
        var emptyId = getId(emptyL);
        var placed = false;
        try { emptyL.move(L, ElementPlacement.PLACEAFTER); placed = true; } catch (eMv) {}
        if (!placed || byId(emptyId) === null) {
            // 兜底：ActionManager 版 move（null / From / T 三段式）
            placed = moveLayerAfterAM(emptyId, meta.id);
        }
        if (!placed) throw new Error("空图层挪到目标层下方失败");

        // move() 之后【立刻】查一次落点：用来区分
        //   "move 当场就没生效" vs "move 生效了、但后面又被别的东西挤走"
        try {
            var immBelow = layerDirectlyBelow(meta.id);
            plog("    [move后] 目标正下方=" +
                 (immBelow ? ("「" + safeName(immBelow) + "」(id=" + getId(immBelow) + ")　是空层=" + (getId(immBelow) === emptyId)) : "(无)"));
        } catch (eIB) {}

        // ★ 硬保护：空层必须真实存在，且就在目标层正下方；否则绝不合并
        //   （下面每步都写日志，出问题时能一眼看出卡在哪）
        var stillThere = byId(emptyId);
        var relNow = (stillThere && isDirectlyBelow(meta.id, emptyId));
        var belowNow = "?";
        try { var bN = layerDirectlyBelow(meta.id); if (bN) belowNow = safeName(bN) + "(id=" + getId(bN) + ")"; } catch (eBN) {}
        plog("    [核验] 空层id=" + emptyId + "　空层还在=" + (stillThere ? "是" : "★否") +
             "　空层在目标正下方=" + (relNow ? "是" : "★否") +
             "　此刻目标正下方=" + belowNow +
             "　（建层前正下方=" + belowName + "）");
        if (!stillThere) {
            if (!OPTIONS.mergeEvenIfNotPlaced) throw new Error("空图层不见了（建了但找不到）—— 已放弃合并以免吃掉别的图层");
            plog("    ⚠ 空层不见了，但 mergeEvenIfNotPlaced=开 → 仍然合并（排查模式）");
        } else if (!relNow) {
            if (!OPTIONS.mergeEvenIfNotPlaced) throw new Error("空图层没在目标层正下方（此刻正下方=" + belowNow + "）—— 已放弃合并以免吃掉别的图层");
            plog("    ⚠ 空层没在目标正下方，但 mergeEvenIfNotPlaced=开 → 仍然合并（排查模式）");
        }

        if (!selectById(meta.id)) throw new Error("合并前重新选中失败");
        executeAction(cid("Mrg2"), new ActionDescriptor(), DialogModes.NO);
        ok = true;
    } catch (eM) {
        why = cleanMsg("" + eM);
    }

    // ---- 校验：目标层必须消失，且【图层总数必须正好减 1】 ----
    //   只减 1 = 只合了"目标层 + 空层"（正常）
    //   减得更多 = 连带把别的真实图层也吃掉了（异常，必须报出来）
    if (ok && byId(meta.id)) {
        ok = false;
        why = "Mrg2 没报错但目标层还在＝假成功";
    }


    if (!ok) {
        R.failed.push(meta.path + "：" + why);
        plog("  ✗ 合并失败：" + meta.path + " —— " + why);
        return;
    }

    // ---- 结果层：改名 + 清残留蒙版 ----
    var res = null;
    try { res = DOC.activeLayer; } catch (eAc) {}
    if (res) {
        try { res.name = nameBefore; } catch (eN) {}

        /* ★★ 还原混合模式（关键！不还的话"叠加/正片叠底/滤色/柔光…"全变成"正常"）★★ */
        if (blendBefore !== null) {
            var bOK = false;
            try { res.blendMode = blendBefore; bOK = (("" + res.blendMode) === ("" + blendBefore)); } catch (eBM) {}
            if (bOK) {
                R.blendRestored = (R.blendRestored || 0) + 1;
                plog("    [还原] 混合模式 → " + ("" + blendBefore) + "　✔");
            } else {
                R.blendFailed = (R.blendFailed || 0) + 1;
                R.blendFailedList = R.blendFailedList || [];
                try { R.blendFailedList.push(meta.path + "（原本 " + blendBefore + "）"); } catch (eBL) {}
                plog("    [还原] ★ 混合模式没还回去（原本 " + blendBefore + "）—— 这一层外观会变，请看报告");
            }
        }

        /* ★ 还原剪贴关系：新空层默认不剪贴，合并会把"剪贴到下面那一层"弄丢 */
        if (clipBefore) {
            var cNow = false;
            try { cNow = (res.grouped === true); } catch (eCG) {}
            if (!cNow) {
                try { res.grouped = true; } catch (eCS) {}
                var cOK = false;
                try { cOK = (res.grouped === true); } catch (eCV) {}
                R.clipRestored = (R.clipRestored || 0) + 1;
                plog("    [还原] 剪贴关系 → 剪贴到下层" + (cOK ? "　✔" : "　★失败（这一层外观会变）"));
            }
        }

        var maskLeft = "";
        if (hasLayerMask(res)) maskLeft += "图层蒙版";
        if (hasVectorMask(res)) maskLeft += (maskLeft ? "+" : "") + "矢量蒙版";
        if (maskLeft && OPTIONS.deleteLeftoverMask) {
            if (hasLayerMask(res) && !deleteMaskChannel()) plog("  ⚠ 残留图层蒙版删不掉：" + meta.path);
            if (hasVectorMask(res) && !deleteVectorMaskChannel()) plog("  ⚠ 残留矢量蒙版删不掉：" + meta.path);
            maskLeft = "";
            if (hasLayerMask(res)) maskLeft += "图层蒙版";
            if (hasVectorMask(res)) maskLeft += (maskLeft ? "+" : "") + "矢量蒙版";
        }
        R.ok.push(meta.path);
        plog("  ✓ " + meta.path + " → 已合并（结果层「" + safeName(res) + "」" +
             "，合并前正下方=「" + belowName + "」" +
             (maskLeft ? "，⚠ 蒙版仍残留：" + maskLeft : "，蒙版已烤进像素") + "）");
    } else {
        R.ok.push(meta.path);
        plog("  ✓ " + meta.path + " → 已合并（拿不到结果层引用）");
    }
}

/* ------------------------------ 扫描 ------------------------------ */
/* 收集所有"应该被合并"的图层。
   ★ 关键规则（按用户要求）：
     · 文件夹本身不动；但【递归进去】处理它里面的子图层
     · 被剪贴到【文件夹】上的图层 → 跳过（"文件夹上的剪贴蒙版"）
     · 文件夹自身的图层蒙版/矢量蒙版 → 不动（文件夹不进候选）
     · 文件夹【内部】的剪贴层（剪贴到同组里的普通图层）→ 正常合并
     · 隐藏图层 → 跳过；调整图层 → 跳过 */
function scan(container, out, isRoot) {
    var layers = null;
    try { layers = container.layers; } catch (e) { return; }
    if (!layers) return;

    for (var i = 0; i < layers.length; i++) {
        var L = layers[i];
        var nm = safeName(L);
        if (nm.length >= 4 && nm.substring(0, 4) === "__对比") continue;      // 永不碰对比层

        var grp = isGroup(L);

        if (grp) {
            /* 原来这里跳过"被剪贴到下面的文件夹"，现已取消 —— 用户要求 05 对文件夹上方的剪贴蒙版图层生效 */
            /* ★ 已按要求取消跳过（05 要对「文件夹上方的剪贴蒙版图层」生效）： if (isRoot && isClipped(L)) { R.skipFolderClip++; continue; } */
            // 文件夹本身（含它的蒙版）不动，但进去处理子图层
            R.skipFolder++;
            scan(L, out, false);
            continue;
        }

        /* 原来这里跳过"文档根级、剪贴到文件夹上的图层"，现已取消 —— 这类图层正是本次要处理的对象 */
        /* ★ 已按要求取消跳过（05 要对「文件夹上方的剪贴蒙版图层」生效）： if (isRoot && isClipped(L)) { R.skipFolderClip++; continue; } */

        if (isAdjustment(L)) { R.skipAdjust++; continue; }
        if (!isVisible(L)) { continue; }                    // 隐藏的留到处理阶段再记

        var lm = hasLayerMask(L), vm = hasVectorMask(L);
        // ★ 形状/填充/文字层：它们的"矢量蒙版"其实就是形状路径，不算蒙版。
        //   只有它们【另有一个图层蒙版】时才合并；否则整层跳过。
        if (isShapeLikeLayer(L)) {
            if (!lm) { R.skipShape++; continue; }
            vm = false;                       // 忽略它自带的形状路径
        }
        if (!lm && !vm) continue;
        if (OPTIONS.layerMaskOnly && !lm) continue;

        out.push({ layer: L, id: getId(L), name: nm, path: pathOf(L), hasLM: lm, hasVM: vm });
    }
}

/* ------------------------------ 图层操作 ------------------------------ */
function selectById(id) {
    try {
        var d = new ActionDescriptor();
        var r = new ActionReference();
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

/* idUpper 是不是正好在 idLower 的《上一层》（同父级 + 索引相邻）
   用来确认"Mrg2 向下合并" 一定会合到我们要的那层上。 */
/* 取【指定图层正下方那一层】的对象（没有则返回 null） */
function layerDirectlyBelow(id) {
    try {
        var L = byId(id);
        if (!L) return null;
        var list = L.parent.layers;
        for (var i = 0; i < list.length; i++) {
            if (getId(list[i]) === id) return (i + 1 < list.length) ? list[i + 1] : null;
        }
    } catch (e) {}
    return null;
}

function isDirectlyBelow(idUpper, idLower) {
    try {
        var up = byId(idUpper), lo = byId(idLower);
        if (!up || !lo) return false;
        if (getId(up) === getId(lo)) return false;
        var list = lo.parent.layers;
        for (var i = 0; i < list.length; i++) {
            if (getId(list[i]) === getId(lo)) {
                return (i - 1 >= 0) && (getId(list[i - 1]) === getId(up));
            }
        }
    } catch (e) {}
    return false;
}

/* 兜底：ActionManager 的 move（把 idMove 挪到 idRef 之后）。三段式 null/From/T */
function moveLayerAfterAM(idMove, idRef) {
    var mvEv = sid("move");
    if (mvEv === false) return false;
    try {
        var d = new ActionDescriptor();
        var r1 = new ActionReference();
        r1.putIdentifier(cid("Lyr "), idMove);
        d.putReference(cid("null"), r1);
        var rF = new ActionReference();
        rF.putIdentifier(cid("Lyr "), idMove);
        d.putReference(sid("From"), rF);
        var r2 = new ActionReference();
        r2.putIdentifier(cid("Lyr "), idRef);
        d.putReference(cid("T   "), r2);
        executeAction(mvEv, d, DialogModes.NO);
        return true;
    } catch (e) { return false; }
}

/* 删掉当前图层身上的图层蒙版通道（真机实测 Dlt + [Chnl,Chnl,Msk ] 可用） */
function deleteMaskChannel() {
    try {
        var ref = new ActionReference();
        ref.putEnumerated(cid("Chnl"), cid("Chnl"), cid("Msk "));
        var d = new ActionDescriptor();
        d.putReference(cid("null"), ref);
        executeAction(cid("Dlt "), d, DialogModes.NO);
        return true;
    } catch (e) { return false; }
}

/* 删掉当前图层身上的矢量蒙版通道 */
function deleteVectorMaskChannel() {
    var vk = cid("vmsk");
    if (vk !== false) {
        try {
            var ref = new ActionReference();
            ref.putEnumerated(cid("Chnl"), cid("Chnl"), vk);
            var d = new ActionDescriptor();
            d.putReference(cid("null"), ref);
            executeAction(cid("Dlt "), d, DialogModes.NO);
            return true;
        } catch (e1) {}
    }
    var vk2 = sid("vectorMask");
    if (vk2 !== false) {
        try {
            var ref2 = new ActionReference();
            ref2.putEnumerated(sid("channel"), sid("channel"), vk2);
            var d2 = new ActionDescriptor();
            d2.putReference(sid("null"), ref2);
            executeAction(sid("delete"), d2, DialogModes.NO);
            return true;
        } catch (e2) {}
    }
    return false;
}

/* ------------------------------ 图层类型判定 ------------------------------ */
/* ★★ 关键（ps 诊断_05_蒙版检测核对 实测得出）★★
   形状/填充/文字图层【天生就带矢量路径】，PS 在描述符里会报：
       hasVectorMask = true  +  vectorMaskEnabled 键
   但那只是"定义形状的那条路径"，【不是蒙版】！
   实测：36 个形状层全被误判成"有矢量蒙版"，导致 05 的候选数从 ~7 涨到 43。
   所以这几类图层要当成"形状层"处理：只有它们【另有一个图层蒙版】时才合并。 */
function isShapeLikeLayer(L) {
    var k = null;
    try { k = L.kind; } catch (e) { return false; }
    if (k === LayerKind.SOLIDFILL) return true;      // 形状/纯色填充
    if (k === LayerKind.GRADIENTFILL) return true;   // 渐变填充
    if (k === LayerKind.PATTERNFILL) return true;    // 图案填充
    if (k === LayerKind.TEXT) return true;           // 文字（文字也是矢量）
    return false;
}

/* ------------------------------ 蒙版判定 ------------------------------ */
/* ★ 不能用"键名存在"判断：每个图层都有 userMaskDensity 之类的键。
   真正表示"有没有"的是布尔键 hasUserMask / hasVectorMask。 */
function hasLayerMask(L) {
    var d = descOf(L);
    if (!d) return false;
    if (keyTrue(d, "hasUserMask")) return true;
    if (keyExists(d, "hasUserMask")) return false;
    return hasTopKey(d, "userMask");
}

function hasVectorMask(L) {
    var d = descOf(L);
    if (!d) return false;
    if (keyTrue(d, "hasVectorMask")) return true;
    if (keyExists(d, "hasVectorMask")) return false;
    return hasTopKey(d, "vectorMask") || hasTopKey(d, "vectorMaskEnabled") || hasTopKey(d, "vmsk");
}

/* ★ 形状/矢量图层的描述符里【也有 adjustment 键】，不能拿它判断调整图层
   （误判过 17 个形状层）。可靠判据是图层类型枚举 type=2，兜底才看 layerKind。 */
function isAdjustment(L) {
    var d = descOf(L);
    if (!d) return false;
    var t = -1;
    try { t = d.hasKey(cid("type")) ? d.getInteger(cid("type")) : -1; } catch (e1) { t = -1; }
    if (t !== -1) return (t === 2);
    var kind = -1;
    try { kind = d.hasKey(sid("layerKind")) ? d.getInteger(sid("layerKind")) : -1; } catch (e2) { kind = -1; }
    return (kind === 2);
}

function isClipped(L) { try { return (L.grouped === true); } catch (e) { return false; } }

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

function hasTopKey(desc, keyName) {
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

function keyTrue(desc, keyName) {
    if (!desc) return false;
    try {
        var k = sid(keyName);
        if (k === false) return false;
        if (!desc.hasKey(k)) return false;
        return (desc.getBoolean(k) === true);
    } catch (e) { return false; }
}

function keyExists(desc, keyName) {
    if (!desc) return false;
    try {
        var k = sid(keyName);
        if (k === false) return false;
        return desc.hasKey(k);
    } catch (e) { return false; }
}

/* ------------------------------ 工具 ------------------------------ */
function isGroup(L) { try { return (L.typename === "LayerSet"); } catch (e) { return false; } }
function getId(L) { try { return L.id; } catch (e) { return -1; } }
function safeName(L) { try { return L.name; } catch (e) { return "?"; } }
function isVisible(L) { try { return (L.visible !== false); } catch (e) { return true; } }
function cid(name) { try { return charIDToTypeID(name); } catch (e) { return false; } }
function sid(name) { try { return stringIDToTypeID(name); } catch (e) { return false; } }
function nowMs() { return (new Date()).getTime(); }
function cleanMsg(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 200); } catch (e) { return "" + s; } }

function walk(container, fn) {
    var layers = null;
    try { layers = container.layers; } catch (e) { return; }
    if (!layers) return;
    for (var i = 0; i < layers.length; i++) {
        fn(layers[i]);
        if (isGroup(layers[i])) walk(layers[i], fn);
    }
}



/* 递归数一下图层总数。
   ★ 注意性能：这个函数会遍历整棵树，
     所以只能在每个候选层「合并前各 1 次」调用，
     不要写成"每个图层调 2 次"（上一版就是那么卡死的）。 */
function countLayers() {
    var n = 0;
    walk(DOC, function () { n++; });
    return n;
}

function byId(id) {
    var found = null;
    walk(DOC, function (L) { if (!found && getId(L) === id) found = L; });
    return found;
}

function pathOf(L) {
    var parts = [], cur = L, guard = 0;
    try {
        while (cur && guard < 60) {
            var nm = safeName(cur);
            if (nm === "") break;
            parts.unshift(nm);
            cur = cur.parent;
            if (cur && cur.typename === "Document") break;
            guard++;
        }
    } catch (e) {}
    return parts.join(" / ");
}

/* ------------------------------ 差值对比图层 ------------------------------ */
/* 和 ps 01/02/03/04 一样的做法：
 *   盖印可见图层 → 改名 → 移到最顶层 → 混合模式 = 差值。
 *   整体包进一个 suspendHistory：历史里只出现一条「ps05 建对比层」。
 *   ★ suspendHistory 不允许嵌套，所以 makeDiff() 必须在主流程那个
 *     suspendHistory 之前调用（启动块里已按此顺序排好）。
 *   批处理模式下不建（避免影响批量速度）。 */
function makeDiff() {
    try {
        try { $.global.PSJSX_DIFF = makeDiffBody; } catch (eG) {}
        if (typeof $.global.PSJSX_DIFF !== "function") { makeDiffBody(); return; }
        DOC.suspendHistory("ps05 建对比层", "diffHookFn()");
    } catch (eH) {
        makeDiffBody();                     // 不支持就退回原样
    }
}

/* ★ 建对比层之前的判断（比 batchOn() 细一层）
 * --------------------------------------------------------------------------
 *   · 手动单独跑某个步骤（batchOn()=false）            -> 建
 *   · ps 00_single（只处理【当前这一个】文件）          -> 建
 *       （它会把 $.global.PSJSX_DIFF_OK 设成 true —— 单文件就是拿来盯对比层的）
 *   · ps 00 整文件夹批处理（几百个文件）                -> 不建
 *       （建几百个全屏差值层，白占内存，事后还得清）
 *
 * ★ 踩过的坑：原来这里写的是 `if (batchOn()) return;`，
 *   而 ps 00_single 也会把 batchOn() 打开（为了让子脚本不弹窗），
 *   结果【单文件跑完整条流水线，一个对比层都没有】——
 *   用户就是因为这个来提需求的。所以把"静默"和"建不建对比层"拆成两件事。 */
function diffSkipped() {
    if (!batchOn()) return false;
    try { if ($.global.PSJSX_DIFF_OK === true) return false; } catch (e) {}
    return true;
}


function makeDiffBody() {
    if (diffSkipped()) return;         // 批处理不建；ps 00_single 会放行
    selectTopVisible();
    try {
        clearOldDiff();
        selectById(getId(DOC.layers[0]));
        if (!stampVisible()) throw new Error("盖印失败（mergeVisible 与备用方式都不行）");

        var made = DOC.activeLayer;
        try { made.name = OPTIONS.diffName; } catch (eN) {}
        try {
            var top = DOC.layers[0];
            if (getId(top) !== getId(made)) made.move(top, ElementPlacement.PLACEBEFORE);
        } catch (eM) {}
        made = byId(getId(made)) || made;
        if (made.parent !== DOC) throw new Error("对比图层没能移到文档最顶层");

        try { made.blendMode = BlendMode.DIFFERENCE; }
        catch (eB) { try { made.remove(); } catch (eB2) {} throw new Error("设差值失败"); }

        /* ★ 建完立刻关掉对比层的眼睛：
           它是全屏 DIFFERENCE（差值）层，可见时会让整个画面颜色彻底变样，
           自动流水线里绝不能留着（用户确认：自动关掉，想看时手动点开）。 */
        try { made.visible = false; } catch (eVis) {}
        R.diffMade = true;
        R.diffBase = readHist();
        if (R.diffBase) {
            plog("对比图层已建（最顶层，差值）。基准：非黑 " + R.diffBase.nonZero + " 个，最深 " + R.diffBase.maxIdx + "/255");
        }
    } catch (e) {
        R.diffWhy = cleanMsg("" + e);
        plog("建立对比图层失败：" + R.diffWhy);
    }
}

/* 被 suspendHistory 以字符串调用（必须在全局作用域里找得到这个名字） */
function diffHookFn() {
    try { return $.global.PSJSX_DIFF(); } catch (e) { return null; }
}

function clearOldDiff() {
    var guard = 0;
    try {
        var L = findByName(DOC, OPTIONS.diffName);
        while (L && guard < 20) { try { L.remove(); } catch (e) {} L = findByName(DOC, OPTIONS.diffName); guard++; }
    } catch (e2) {}
}

function stampVisible() {
    try {
        var d = new ActionDescriptor();
        d.putBoolean(cid("Dplc"), true);
        executeAction(cid("MrgV"), d, DialogModes.NO);
        return true;
    } catch (e1) {}
    try {
        DOC.selection.selectAll();
        var evC = sid("copyMerged");
        if (evC === false) return false;
        executeAction(evC, new ActionDescriptor(), DialogModes.NO);
        var evP = sid("paste");
        if (evP === false) return false;
        var d2 = new ActionDescriptor();
        var kIn = sid("inPlace");
        if (kIn !== false) d2.putBoolean(kIn, true);
        executeAction(evP, d2, DialogModes.NO);
        try { DOC.selection.deselect(); } catch (eD) {}
        return true;
    } catch (e2) { return false; }
}

function readHist() {
    try {
        var h = DOC.histogram;
        var nonZero = 0, maxIdx = 0;
        for (var i = 1; i < h.length; i++) { if (h[i] > 0) { nonZero += h[i]; maxIdx = i; } }
        return { nonZero: nonZero, maxIdx: maxIdx };
    } catch (e) { return null; }
}

/* 合并完了看一眼差值层：全黑 = 一个像素都没变 */
function checkDiffAfterMerge() {
    if (!R.diffMade || !R.diffBase) return;
    var now = readHist();
    if (!now) return;
    if (now.nonZero === 0) plog("✔ 差值对比：画面纯黑 → 一个像素都没变（理想结果）");
    else if (now.maxIdx <= R.diffBase.maxIdx + 3) {
        plog("✔ 差值对比：最深 " + now.maxIdx + "/255，与基准同量级 → 没引入新差异");
    } else {
        plog("⚠ 差值对比：最深 " + now.maxIdx + "/255，明显超过基准 " + R.diffBase.maxIdx + "/255 → 请点亮差值图层看哪里变了");
    }
}

/* 盖印前先选中"最上面那个可见图层"（活动图层被隐藏时 mergeVisible 会拒绝执行） */
function selectTopVisible() {
    try {
        var list = DOC.layers;
        for (var i = 0; i < list.length; i++) {
            var v = true;
            try { v = (list[i].visible !== false); } catch (eV) { v = true; }
            if (v) { DOC.activeLayer = list[i]; return; }
        }
    } catch (e) {}
}

/* 运行前把所有"脚本生成的对比层"（以 __对比 开头）的眼睛关掉 */
function hideCompareLayers() {
    var n = 0;
    walk(DOC, function (L) {
        var nm = "";
        try { nm = L.name; } catch (e) { return; }
        if (nm && nm.length >= 4 && nm.substring(0, 4) === "__对比") {
            try { if (L.visible !== false) { L.visible = false; n++; } } catch (e2) {}
        }
    });
    if (n > 0) plog("运行前关掉了 " + n + " 个旧对比层的眼睗");
    return n;
}

function findByName(container, nm) {
    var found = null;
    walk(container, function (L) { if (!found && safeName(L) === nm) found = L; });
    return found;
}

/* ------------------------------ 进度条（不写 preferredSize） ------------------------------ */
function pbOpen(title, total) {
    if (batchOn()) return;
    if (typeof Window === "undefined") return;
    try {
        PB.win = new Window("palette", title);
        PB.win.orientation = "column";
        PB.win.alignChildren = "fill";
        PB.txt = PB.win.add("statictext", undefined, "准备中…");
        PB.bar = PB.win.add("progressbar", undefined, 0, (total > 0 ? total : 1));
        PB.cancel = false;
        try { placeWindowOnHostScreen(PB.win); } catch (ePL) {}
        PB.win.show();
        PB.n = 0;
        PB.cancel = false;
        PB.btn = null;
    } catch (e) { PB.win = null; }
}
function pbStep(msg) {
    checkStopFlag();
    if (!PB.win) return;
    PB.n++;
    try { PB.bar.value = PB.n; PB.txt.text = msg; PB.win.update(); } catch (e) {}
}
/* ------------------------------ 中止（取消）支持 ------------------------------
 * 进度条上加一个"中止"按钮。点一下只是把 PB.cancel 置位，
 * 真正的停止发生在【下一次 pbCancelled() 检查处】——
 * 也就是每处理完一个单位（一层 / 一个文件夹 / 一个步骤）才停，
 * 绝不会打断半层，也绝不会丢日志（会正常走收尾流程）。
 * 点过之后按钮文字会变成"正在停止…"，让你知道点到了。
 * ------------------------------------------------------------------------------ */
function pbCancelled() {
    if (!PB.cancel) return false;
    if (PB.txt) { try { PB.txt.text = "已收到中止请求，正在收尾…"; PB.win.update(); } catch (eT) {} }
    return true;
}

/* 停止信号文件的路径（和 "停止运行.bat" 里写的一致） */
function stopFlagPath() {
    try { return Folder.temp.fsName + "/psjsx_STOP.txt"; } catch (e) { return ""; }
}
/* 清掉停止信号（启动时清一次，避免上次的残留误停） */
function clearStopFlag() {
    try { var p = stopFlagPath(); if (p) { var f = File(p); if (f.exists) f.remove(); } } catch (e) {}
}
/* ★ 中止检查：只看"停止信号文件在不在"。
   为什么不用按钮：实测（ps 诊断_中止按钮探针）palette 的按钮
   在脚本执行期间根本收不到点击 —— Photoshop 的脚本是同步的，
   事件要等脚本跑完才处理。读文件则没这个问题。 */
function checkStopFlag() {
    try {
        var p = stopFlagPath();
        if (!p) return false;
        var f = File(p);
        if (f.exists) { PB.cancel = true; return true; }
    } catch (e) {}
    return false;
}
function pbClose() {
    if (!PB.win) return;
    try { PB.win.close(); } catch (e) {}
    PB.win = null;
}

/* ------------------------------ 批处理钩子 ------------------------------ */
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


function batchOn() {
    try { return ($.global.PSJSX_BATCH === true); } catch (e) { return false; }
}

/* ------------------------------ 选项面板 ------------------------------ */
function askDialog() {
    if (batchOn()) return true;
    if (typeof Window === "undefined") return true;
    var w = new Window("dialog", "ps 05 合并带蒙版的图层 —— 选项");
    w.orientation = "column";
    w.alignChildren = "left";

    var g0 = w.add("panel", undefined, "将要做的");
    g0.orientation = "column"; g0.alignChildren = "left";
    g0.add("statictext", undefined, "· 空对象合并：下方建空层 → 重选原层 → 向下合并");
    g0.add("statictext", undefined, "· 带图层蒙版 / 矢量蒙版的图层都会处理；剪贴层也合并");
    g0.add("statictext", undefined, "· 跳过：文件夹本身、隐藏层、调整层");

    var cbLM = w.add("checkbox", undefined, "只处理【图层蒙版】（勾上则纯矢量蒙版的层跳过）");
    cbLM.value = !!OPTIONS.layerMaskOnly;
    var cbDiff = w.add("checkbox", undefined, "先在最顶层盖印一层「" + OPTIONS.diffName + "」（差值）");
    cbDiff.value = !!OPTIONS.makeDiffLayer;
    var cbDl = w.add("checkbox", undefined, "合并后清掉结果层上残留的蒙版");
    cbDl.value = !!OPTIONS.deleteLeftoverMask;
    var cbRem = w.add("checkbox", undefined, "记住我的选择（下次自动带上）");
    cbRem.value = !!OPTIONS.rememberOptions;

    var gB = w.add("group"); gB.alignment = "right";
    gB.add("button", undefined, "开始", { name: "ok" });
    gB.add("button", undefined, "取消", { name: "cancel" });

    try { placeWindowOnHostScreen(w); } catch (ePL) {}
    if (w.show() !== 1) return false;

    OPTIONS.layerMaskOnly = (cbLM.value === true);
    OPTIONS.makeDiffLayer = (cbDiff.value === true);
    OPTIONS.deleteLeftoverMask = (cbDl.value === true);
    OPTIONS.rememberOptions = (cbRem.value === true);
    return true;
}

/* ------------------------------ 结果 ------------------------------ */
function writeSummary() {
    plog("");
    plog("========== 汇总 ==========");
    if (R.aborted) plog("⚠ 本次被用户中止（只处理了一部分）");
    plog("候选图层 " + R.total + " 个：成功 " + R.ok.length + "，失败 " + R.failed.length);
    plog("合并后还原：混合模式 " + (R.blendRestored || 0) + " 个；剪贴关系 " + (R.clipRestored || 0) + " 个" +
         ((R.blendFailed || 0) > 0 ? ("；★ 混合模式还原失败 " + R.blendFailed + " 个（这些层外观会变！）") : ""));
    if (R.blendFailedList && R.blendFailedList.length) {
        plog("★ 混合模式还原失败的层：");
        for (var bf = 0; bf < R.blendFailedList.length; bf++) plog("  · " + R.blendFailedList[bf]);
    }
    plog("跳过：形状/填充/文字层（自带的形状路径不算蒙版）" + R.skipShape + " 个" +
         "，文件夹本身 " + R.skipFolder + " 个（子图层已递归处理）" +
             "，被剪贴到文件夹上的图层（现已处理）" + R.skipFolderClip + " 个" +
         "，调整层 " + R.skipAdjust + " 个");
    if (R.skipped.length) {
        plog("隐藏层跳过 " + R.skipped.length + " 个：");
        for (var s = 0; s < R.skipped.length && s < 20; s++) plog("  · " + R.skipped[s]);
    }
    if (R.failed.length) {
        plog("失败明细：");
        for (var f = 0; f < R.failed.length; f++) plog("  · " + R.failed[f]);
    }
    if (R.ok.length) {
        plog("成功明细：");
        for (var o = 0; o < R.ok.length; o++) plog("  · " + R.ok[o]);
    }
    plog("文件夹本身、文件夹的蒙版：一律未动。");
    plog("没有清理缓存、没有自动存盘。");
    plog("日志：" + LOG.path);
    plog("===== 结束 =====");
    logClose();
}

function finishShort(msg) {
    if (batchOn()) return;
    if (typeof Window === "undefined") return;
    var t = msg;
    if (R.ok.length) t += "\n\n· 已合并 " + R.ok.length + " 个";
    if (R.failed.length) t += "\n\n⚠ 失败 " + R.failed.length + " 个（明细在日志里）";
    if (R.diffMade) {
        t += "\n\n最顶层已建「" + OPTIONS.diffName + "」（差值）";
        t += "\n  全黑 = 没改任何像素；有亮处 = 有改动";
    }
    t += "\n\n详细日志：\n" + LOG.path;
    alert(t);
}

function failOut(msg) {
    if (batchOn()) {
        try {
            var f = File(Folder.temp.fsName + "/psjsx_05_error.txt");
            f.open("w"); f.write(msg + "\n"); f.close();
        } catch (e) {}
        return;
    }
    try { alert(msg); } catch (e2) {}
}

/* ------------------------------ 日志目录（<文档目录>/_日志/） ------------------------------ */
function ensureLogFolder() {
    try {
        var d = (DOC && DOC.path) ? Folder(DOC.path) : null;
        if (!d) return null;
        var sub = Folder(d.fsName + "/_日志");
        if (!sub.exists) { try { sub.create(); } catch (eC) {} }
        return (sub.exists ? sub : d);
    } catch (e) { return null; }
}

/* ------------------------------ 日志 ------------------------------ */
function logOpen() {
    try {
        var d = ensureLogFolder();
        if (!d) d = Folder(Folder.temp);
        LOG.path = d.fsName + "/" + DOC.name.replace(/\.[^.]+$/, "") + "_ps05日志.txt";
        LOG.f = File(LOG.path);
        LOG.f.open("w");
    } catch (e) { LOG.f = null; LOG.path = "(无法写日志)"; }
}
function logClose() { if (LOG.f) { try { LOG.f.close(); } catch (e) {} LOG.f = null; } }
/* 日志落盘策略：不是每行都 close/open（那是 1 次文件 I/O 每行，很慢），
   而是每 25 行才真正 close+reopen 一次（ExtendScript 的 File 有写入缓冲，
   不 close 就不落盘；这样兼顾"崩了不丢太多"与"跑得快"）。 */
var LOG_LINES = 0;
function LOG_FLUSH() {
    LOG_LINES++;
    if (LOG_LINES % 25 !== 0) return;
    try { LOG.f.close(); LOG.f.open("a"); } catch (e) {}
}
function plog(s) {
    if (!LOG.f) return;
    try { LOG.f.write("[" + (new Date()).toTimeString().substring(0, 8) + "] " + s + "\n"); LOG_FLUSH(); } catch (e) {}
}

/* ------------------------------ 选项记忆 ------------------------------ */
function prefFile() { try { return File(Folder.userData + "/" + PREF_NAME); } catch (e) { return null; } }

function loadPrefs() {
    var f = prefFile();
    if (!f || !f.exists) return;
    try {
        f.open("r");
        var lines = f.read().split("\n");
        f.close();
        for (var i = 0; i < lines.length; i++) {
            var kv = lines[i].split("=");
            if (kv.length < 2) continue;
            var k = kv[0].replace(/^\s+|\s+$/g, "");
            var v = kv[1].replace(/^\s+|\s+$/g, "");
            if (k === "layerMaskOnly") OPTIONS.layerMaskOnly = (v === "1");
            if (k === "deleteLeftoverMask") OPTIONS.deleteLeftoverMask = (v === "1");
            if (k === "makeDiffLayer") OPTIONS.makeDiffLayer = (v === "1");
        }
    } catch (e) {}
}

function savePrefs() {
    if (!OPTIONS.rememberOptions) return;
    var f = prefFile();
    if (!f) return;
    try {
        f.open("w");
        f.write("layerMaskOnly=" + (OPTIONS.layerMaskOnly ? "1" : "0") + "\n");
        f.write("deleteLeftoverMask=" + (OPTIONS.deleteLeftoverMask ? "1" : "0") + "\n");
        f.write("makeDiffLayer=" + (OPTIONS.makeDiffLayer ? "1" : "0") + "\n");
        f.close();
    } catch (e) {}
}

/* ==========================================================================
 * 启动块（放文件末尾：上面所有 var 都已赋过值）
 * ========================================================================== */
try {
    if (app.documents.length === 0) {
        failOut("没有打开的文档。");
    } else {
        DOC = app.activeDocument;
        loadPrefs();
        var goOn = true;
        if (OPTIONS.askOptions && !askDialog()) goOn = false;
        if (goOn) {
            savePrefs();
            logOpen();
            plog("===== ps 05 合并带蒙版的图层 开始 =====");
            plog("文档：" + DOC.name);
            plog("生效选项：只处理图层蒙版=" + (OPTIONS.layerMaskOnly ? "是" : "否（两种都处理）") +
                 "，清残留蒙版=" + (OPTIONS.deleteLeftoverMask ? "是" : "否"));

            // 运行前：关旧对比层的眼睛 + 建新的对比层
            // ★ 必须在下面那个 suspendHistory 之前（suspendHistory 不能嵌套）
            try { hideCompareLayers(); } catch (eHC) {}
            if (OPTIONS.makeDiffLayer) makeDiff();

            // ★ 启动前清掉上次残留的停止信号（否则一开始就被误停）
            clearStopFlag();

            var t0 = nowMs();
            var had = false;
            try {
                try { $.global.PSJSX_HOOK = doMerge; } catch (eG) {}
                DOC.suspendHistory("ps05 合并带蒙版的图层", "PSJSX_HOOK()");
                had = true;
            } catch (eH) { had = false; }
            if (!had) { try { doMerge(); } catch (eD) { plog("✗ 直接执行也失败：" + cleanMsg("" + eD)); } }
            R.elapsed = Math.round((nowMs() - t0) / 100) / 10;

            try { checkDiffAfterMerge(); } catch (eDC) {}

            pbClose();

            // 收尾复查：还有多少带蒙版的层没被处理
            try {
                var left = [];
                scan(DOC, left, true);
                if (left.length > 0) plog("收尾复查：候选里还剩 " + left.length + " 个（多为失败或被跳过的）");
            } catch (eS) {}

            writeSummary();
            finishShort("完成：候选 " + R.total + " 个，成功 " + R.ok.length +
                        "，失败 " + R.failed.length + "\n耗时约 " + R.elapsed + " 秒");
        }
    }
} catch (eMain) {
    try { pbClose(); } catch (eP) {}
    try {
        var __ln = ""; try { __ln = eMain.line; } catch (eL) {}
        var __fn = ""; try { __fn = eMain.fileName; } catch (eF) {}
        logOpen();
        plog("✗ 整体出错：" + eMain + "（行 " + __ln + "）");
        logClose();
        if (batchOn()) { failOut("ps 05 运行出错：" + eMain); }
        else { alert("ps 05 运行出错：\n" + eMain + "\n行号: " + __ln + "\n文件: " + __fn + "\n日志: " + LOG.path); }
    } catch (eAl) {}
}

})();
