#target photoshop
/* ==========================================================================
 * ps 06 提取文件夹蒙版
 * --------------------------------------------------------------------------
 * 做什么（只提取、不合并、不建对比图层 —— 这一步不改任何像素）
 *   扫描文档里所有【文件夹】，凡是有【图层蒙版 / 矢量蒙版】的：
 *     ① 把文件夹那张蒙版烤成黑白图（白=显示，黑=挡住）
 *     ② 黑白图放到【文档里该文件夹的正上方】（成为它的兄弟图层，不是放进文件夹里！）
 *        ★ 如果该文件夹上方有【剪贴蒙版】图层，就放到那些剪贴层的【最上面】——
 *          这样 mask 脱离剪贴链，07/08 处理剪贴链时不会把它一起复制/合并掉
 *     ③ 图层名 = 文件夹名字 + " mask"（重名就加 2、3…）
 *     ④ 把这个图层【隐藏】（眼睛关掉），文件夹上原来的蒙版【原样保留】
 *   在 AE 里的用法：这个 xxx mask 图层设成【亮度遮罩】，套在该文件夹上。
 *   （AE 导入时会自动丢掉文件夹的图层效果/蒙版/加在文件夹上方的剪贴图层，
 *     所以我们把蒙版信息以黑白图的形式留在文档里，靠它把观感救回来。）
 *
 * ★★ 给 07 / 08 的约定（很重要）★★
 *   名字以「 mask」结尾（更准确地说：文件夹名 + " mask"）的图层是【标记图层】，
 *   07/08 必须【跳过】它：不能合并进别的图层、不能被复制剪贴层覆盖、不能改它的像素。
 *   否则 AE 里设亮度遮罩就会失败。本脚本已经把它放到剪贴层之上，避免被卷进剪贴链。
 *
 * 顺便说明（07/08 的目标）：
 *   本脚本只管"文件夹蒙版"。文件夹【剪贴蒙版】与【图层样式】分别在 07、08 处理。
 *
 * 安全
 *   · 只新建图层 + 填色，不动原图层、不动像素、不删除任何东西
 *   · 文件夹上原来的蒙版保留（可逆）；隐藏的文件夹按约定不碰
 *   · 永不处理 __对比 开头的对比层
 *   · 全程包在一个历史步骤里，Ctrl+Z 可整段撤回
 *
 * 按既有约定：IIFE 隔离 / $.global.PSJSX_HOOK 模式 / 进度条不写 preferredSize /
 * 启动块放文件末尾 / ES3 安全（无 filter/map/forEach/数组 indexOf）/ 批处理钩子。
 * ========================================================================== */

(function () {

var OPTIONS = {
    // 运行前弹"选项面板"（和 01~05 一样的行为）。批处理模式（PSJSX_BATCH）下自动不弹。
    askOptions: true,
    // 和 askOptions 配合的开关：false 时 askDialog() 会直接返回（彻底不弹，排查用）。
    showOptionsDialog: true,
    rememberOptions: true,
    suffix: " mask",              // 黑白图的名字 = 文件夹名 + 这个后缀
    hideMaskLayer: true,          // 建完把这张黑白图隐藏（AE 里设亮度遮罩用）
    skipHiddenFolders: true,      // 隐藏的文件夹不碰
    // 后缀统一由 normSuffix() 保证"带前导空格"，所以名字会是「文件夹名 mask」而不是「文件夹名mask」
    // ★ 排查探针：把每个细步骤的毫秒级时间写进日志（定位"哪个操作触发外部弹窗"）。
    //   排查完可改成 false（只影响日志，不影响处理结果）。
    probeTiming: true
};

var PREF_NAME = "ps_06_提取文件夹蒙版_选项.txt";
var DOC = null;
var PB = { win: null, bar: null, txt: null, n: 0, total: 1, cancel: false, btn: null };
var LOG = { f: null, path: "" };
var R = {
    total: 0, made: [], skipNoMask: 0, skipHidden: [], failed: [],
    eyesFixed: [], elapsed: 0, aborted: false
};
var DONE_ID = {};               // 本次已处理过的文件夹 id
var SNAP = null;                // 运行前的可见性快照

/* ------------------------------ 主流程 ------------------------------ */
function doExtract() {
    if (!DOC) DOC = app.activeDocument;

    var list = [];
    scanFolders(DOC, list);
    R.total = list.length;
    if (R.total === 0) return;

    pbOpen("提取文件夹蒙版：" + R.total + " 个", R.total + 1);
    var t0 = nowMs();
    for (var i = 0; i < R.total; i++) {
        // ★ 每个文件夹开始前检查一次"停止信号文件"
        //   （实测 palette 的中止按钮在脚本执行期间收不到点击，只能靠外部文件）
        if (checkStopFlag() || pbCancelled()) {
            plog("⚠ 已收到中止请求：已处理 " + i + " / " + R.total + " 个文件夹，剩下的跳过");
            R.aborted = true;
            break;
        }
        pbStep("(" + (i + 1) + "/" + R.total + ") " + list[i].path);
        try { processOne(list[i]); } catch (eOne) {
            R.failed.push(list[i].path + "：处理时出错 " + cleanMsg("" + eOne));
            plog("✗ 处理出错（跳过这个文件夹）：" + list[i].path + " —— " + cleanMsg("" + eOne));
        }
    }
    R.elapsed = Math.round((nowMs() - t0) / 100) / 10;
    pbClose();
}

function processOne(meta) {
    var G = byId(meta.id);
    if (!G) { R.failed.push(meta.path + "（文件夹已不存在）"); return; }
    if (DONE_ID[meta.id]) { plog("· 已处理过，跳过：" + meta.path); return; }
    DONE_ID[meta.id] = true;

    var hasLM = hasLayerMask(G), hasVM = hasVectorMask(G);
    if (!hasLM && !hasVM) { R.skipNoMask++; return; }

    if (OPTIONS.skipHiddenFolders && !isVisible(G)) {
        R.skipHidden.push(meta.path + "（文件夹是隐藏的）");
        plog("· 跳过（隐藏的文件夹）：" + meta.path);
        return;
    }

    // 选中文件夹（新建的图层才会落在它上方）
    if (!selectById(meta.id)) {
        R.failed.push(meta.path + "：选不中这个文件夹");
        plog("✗ 选不中：" + meta.path);
        return;
    }

    // 双击保护：万一这层已经被 06 处理过（同名黑白图已在它正上方），就跳过
    if (alreadyHasMaskLayer(meta.id, meta.name)) {
        plog("· 跳过（正上方已经有「" + meta.name + OPTIONS.suffix + "」）：" + meta.path);
        return;
    }

    var madeCount = 0;
    if (hasLM) madeCount += extractOne(G, meta, false);
    if (hasVM) madeCount += extractOne(G, meta, true);

    if (madeCount > 0) {
        R.made.push(meta.path + "（" + madeCount + " 张黑白图）");
        plog("✓ 已提取 " + madeCount + " 张：" + meta.path);
    } else {
        R.failed.push(meta.path + "：黑白图没建成");
        plog("✗ 黑白图没建成：" + meta.path);
    }
}

/* 提取一张蒙版成黑白图。useVector=true 时取矢量蒙版，否则取图层蒙版。
   返回 1=成功，0=失败 */
function extractOne(G, meta, useVector) {
    var kindName = useVector ? "矢量蒙版" : "图层蒙版";

    probe("--- 开始处理：" + meta.path + " ---");

    // ① 让文件夹成为活动图层
    probe("A 选中文件夹 之前");
    if (!selectById(meta.id)) return 0;
    probe("A 选中文件夹 之后（返回）");

    // ② 把那张蒙版载入成选区（真机实测：setd + fsel + [Chnl,Chnl,Msk ] 可用）
    probe("B 载入蒙版为选区 之前");
    if (!loadMaskAsSelection(meta.id, useVector)) {
        plog("  ✗ " + kindName + "载入选区失败：" + meta.path);
        return 0;
    }
    probe("B 载入蒙版为选区 之后");
    var selOK = hasSelection();
    if (!selOK) {
        plog("  ✗ " + kindName + "载入后没有选区（可能整张全白/全黑）：" + meta.path);
        deselectQuiet();
        return 0;
    }

    // ③ 新建一张空图层 —— 手法对齐 ps 选择层空对象合并.jsx：
    //    选中参考层 → artLayers.add() → 【立刻对刚拿到的这个对象调用 .move()】。
    //    不要"用 id 回头查对象再移动"，那正是之前慢/弹窗的写法。
    //    新层天生就是文件夹的兄弟层、就在它正上方；只有上方有剪贴链时才需要一次移动。
    var idsBefore = idSet();
    var tmpName = "__mask_tmp_" + nowMs();
    probe("C 新建图层 之前");
    var built = makeMaskLayerAbove(tmpName, meta.id);
    probe("C 新建图层 之后");
    deselectQuiet();                                   // 让选区回到干净状态（活动图层后面再选）
    probe("C2 取消选区 之后");
    if (!built) {
        plog("  ✗ 在文件夹上方建图层失败：" + meta.path);
        return 0;
    }

    // 拿到新层的 id/对象（DOM 路线直接就有对象；AM 路线用 id 差集找回来）
    var newL = built;
    var newId = getId(built);
    if (newId < 0) {
        newId = findNewIdId(idsBefore);
        newL = (newId >= 0) ? byId(newId) : null;
    }
    if (!newL || newId < 0) {
        plog("  ✗ 新建图层后拿不到它（可能建层没生效）：" + meta.path);
        deselectQuiet();
        return 0;
    }

    // ③b 位置：新层已经在文件夹正上方了；若它上方还有【剪贴蒙版】图层，
    //     再把新层挪到那些剪贴层的最上面（最多一次移动，避免 mask 被卷进剪贴链）。
    probe("D 位置修正（可能含一次移动） 之前");
    if (!placeMaskLayerSafely(newL, meta.id)) {
        plog("  ✗ 黑白图位置不对（既不在文件夹上方，也不是剪贴层上方）：" + meta.path);
        try { newL.remove(); } catch (eR2) {}
        deselectQuiet();
        return 0;
    }
    probe("D 位置修正 之后");
    // 移动后按 id 重新取一次引用（稳妥；对象引用在跨父级移动后可能失效）
    newId = getId(newL);
    newL = (newId >= 0) ? byId(newId) : newL;
    if (!newL) { deselectQuiet(); return 0; }
    newId = getId(newL);

    // ③c ★ 关键：万一它还是"剪贴蒙版"状态，mask 会被 07 当剪贴层一起烤掉。
    //    这里强制取消并核验。
    probe("E 取消剪贴状态 之前");
    if (!clearClipping(newL)) {
        plog("  ⚠ 取消 mask 的剪贴蒙版设置失败（可能影响 07）：" + meta.path);
    }

    probe("E 取消剪贴状态 之后");

    // 保险：接下来要往新建的空图层里填色，必须选中它（不能误填到文件夹或别的层）
    probe("F 选中新层（准备填色） 之前");
    if (!selectById(newId)) {
        plog("  ✗ 选不中刚建的黑白图： " + meta.path);
        deselectQuiet();
        return 0;
    }

    // ★★ 关键一步：必须在这里【重新载入一次蒙版选区】★★
    //    诊断实测：新建图层会把选区清掉（ps 诊断_蒙版保真度 方法 A）。
    //    之前是"先载入选区、再建图层"，结果 fill 变成"填满整层"→ 生成的 mask 永远是纯黑。
    //    ★ 必须把【文件夹的 id】传进去：此刻活动图层是刚建的空层，它没有蒙版，
    //      "载入活动图层的蒙版"会失败（踩过）。
    probe("F2 重新载入蒙版为选区 之前");
    deselectQuiet();
    var maskSelOK = loadMaskAsSelection(meta.id, useVector);
    if (!maskSelOK) {
        plog("  ✗ 重新载入蒙版为选区失败（已指定文件夹 id=" + meta.id + "）：" + meta.path);
        try { newL.remove(); } catch (eRL) {}
        deselectQuiet();
        return 0;
    }
    probe("F2 重新载入蒙版为选区 之后");
    if (!hasSelection()) {
        plog("  ✗ 重新载入后没有选区：" + meta.path);
        try { newL.remove(); } catch (eRL2) {}
        deselectQuiet();
        return 0;
    }
    // 载入蒙版会把活动图层切到文件夹上，这里再选回新层
    if (!selectById(newId)) {
        plog("  ✗ 载入选区后选不回新层： " + meta.path);
        deselectQuiet();
        return 0;
    }
    probe("F3 选回新层 之后");

    // ④ 生成黑白图：选区【内】填白、选区【外】填黑（产物是普通像素图层，【没有图层蒙版】）
    //    诊断实测（ps 诊断_蒙版保真度，在真实文档上）：
    //      · selection.fill() 【认选区】：无选区时填满整层（min=0 max=0 全黑），
    //        有选区时只填选区内部（填白后 min=128 max=255，出现 46 万个中间灰像素）
    //      · 而且能表达灰阶：羽化/半透明蒙版填出来的不是二值的
    //      · 新建图层会把选区清掉 → 所以前面必须【建完图层再重新载入一次蒙版选区】
    //    产物形态：完全透明的底 → 选区内白、选区外黑，整层不透明，无蒙版、无 alpha 依赖
    probe("G 选区内填白 之前");
    if (!fillByColor(255, 255, 255)) {
        plog("  ✗ 选区内填白失败：" + meta.path);
        try { newL.remove(); } catch (eR1) {}
        deselectQuiet();
        return 0;
    }
    probe("G 选区内填白 之后");

    probe("H 反选 之前");
    try { DOC.selection.invert(); } catch (eInv) { plog("  ⚠ 反选失败（选区外会留透明）"); }
    probe("H 反选 之后");

    probe("I 选区外填黑 之前");
    fillByColor(0, 0, 0);
    probe("I 选区外填黑 之后");
    deselectQuiet();
    probe("J 取消选区 之后");

    // 保险：万一还挂着图层蒙版（产物不该有），清掉它
    if (hasLayerMask(newL)) {
        if (removeLayerMaskQuiet(newL)) plog("  · 已清掉 mask 图层上多余的图层蒙版");
        else plog("  ⚠ mask 图层上有个图层蒙版没清掉（你可能会看到蒙版缩略图）");
    }

    // ⑤ 命名：直接用"文件夹名 + 后缀"，不做无谓的去重（避免莫名多出 " 2"）
    //    只有在【真的】已经有同名图层时才加序号
    var wantName = meta.name + OPTIONS.suffix;
    var finalName = wantName;
    if (nameInUse(wantName, newId)) {
        finalName = uniqueLayerName(wantName, newId);
        plog("  · 已存在同名图层，改为「" + finalName + "」");
    }
    probe("K 改名 之前");
    try { newL.name = finalName; } catch (eN) {}
    // 核验名字：PS 有时会自动唯一化，这里确保落成我们想要的名字
    if (safeName(newL) !== finalName) {
        try { newL.name = finalName; } catch (eN2) {}
    }

    probe("K 改名 之后");

    // ⑥ 隐藏
    probe("L 隐藏新层 之前");
    if (OPTIONS.hideMaskLayer) {
        try { newL.visible = false; } catch (eV) {}
    }

    probe("L 隐藏新层 之后");

    // ⑦ 核验位置 + 剪贴状态
    probe("M 位置核验 之前");
    var posInfo = describeMaskPos(newId, meta.id);
    probe("M 位置核验 之后");
    var clipped = isClipped(newL);
    if (clipped) {   // 再兜一次：还是被设成剪贴层就再取消
        clearClipping(newL);
        clipped = isClipped(newL);
    }
    plog("  · 已建「" + safeName(newL) + "」（" + kindName + "，" + posInfo +
         "，剪贴蒙版=" + (clipped ? "⚠ 仍是" : "否 ✔") + "，" +
         (OPTIONS.hideMaskLayer ? "已隐藏" : "保持显示") + "）");
    return 1;
}

/* 取消图层的"剪贴蒙版"设置（DOM 的 grouped 属性），并核验真的取消了 */
function clearClipping(L) {
    if (!L) return false;
    var ok = false;
    for (var i = 0; i < 3; i++) {                 // 最多试 3 次
        var g = false;
        try { g = (L.grouped === true); } catch (e) { g = false; }
        if (!g) { ok = true; break; }
        try { L.grouped = false; } catch (e2) {}
    }
    if (!ok) {
        try { ok = (L.grouped !== true); } catch (e3) { ok = false; }
    }
    return ok;
}

function isClipped(L) {
    try { return (L.grouped === true); } catch (e) { return false; }
}

/* 文档里是否已经存在这个名字（排除自己） */
function nameInUse(nm, exceptId) {
    var found = false;
    walk(DOC, function (L) {
        if (found) return;
        if (getId(L) === exceptId) return;
        if (safeName(L) === nm) found = true;
    });
    return found;
}

function uniqueLayerName(base, exceptId) {
    for (var i = 2; i < 100; i++) {
        if (!nameInUse(base + " " + i, exceptId)) return base + " " + i;
    }
    return base + " " + nowMs();
}

/* 描述黑白图被放到哪了（核验用）：在文件夹正上方 / 在剪贴层最上面 / 还在文件夹内部 */
function describeMaskPos(maskId, folderId) {
    var mask = byId(maskId), folder = byId(folderId);
    if (!mask || !folder) return "位置核验不到";
    var mp = null, fp = null;
    try { mp = mask.parent; } catch (e) { return "位置核验不到"; }
    try { fp = folder.parent; } catch (e2) { return "位置核验不到"; }
    if (mp === folder) return "⚠ 还在文件夹内部（不对）";
    if (mp !== fp) return "⚠ 不在同一层级（不对）";
    var list = null;
    try { list = fp.layers; } catch (e3) { return "在文件夹正上方"; }
    var mIdx = -1, fIdx = -1, clips = 0, i;
    for (i = 0; i < list.length; i++) {
        if (getId(list[i]) === maskId) mIdx = i;
        if (getId(list[i]) === folderId) fIdx = i;
    }
    if (mIdx < 0 || fIdx < 0) return "在文件夹正上方";
    if (mIdx > fIdx) return "⚠ 跑到文件夹下面了（不对）";
    for (i = mIdx + 1; i < fIdx; i++) {
        var g = false;
        try { g = (list[i].grouped === true); } catch (e4) { g = false; }
        if (g) clips++;
    }
    if (clips > 0) return "在 " + clips + " 个剪贴层的最上面";
    return "紧贴文件夹正上方";
}

/* ------------------------------ 扫描 ------------------------------ */
/* 只找【文件夹】，且它自己有图层蒙版或矢量蒙版 */
/* ---- 调整图层判定 ----
 *   一般情况调整图层不归本脚本管（它本来就不会被当成"文件夹"）。
 *   这里留一道保险：万一有同名/异常的层被误判成文件夹，也不会去动调整图层。 */
function isAdjustment(L) {
    if (!L) return false;
    var d = descOf(L);
    if (!d) return false;
    try { var kt = cid("type"); if (kt !== false && d.hasKey(kt)) return (d.getInteger(kt) === 2); } catch (e1) {}
    try { var kk = sid("layerKind"); if (kk !== false && d.hasKey(kk)) return (d.getInteger(kk) === 2); } catch (e2) {}
    return false;
}
function scanFolders(container, out) {
    var layers = null;
    try { layers = container.layers; } catch (e) { return; }
    if (!layers) return;
    for (var i = 0; i < layers.length; i++) {
        var L = layers[i];
        if (isAdjustment(L)) continue;          // ★ 全局规则：调整图层一律不处理
        if (!isGroup(L)) continue;
        var nm = safeName(L);
        if (nm.length >= 4 && nm.substring(0, 4) === "__对比") continue;   // 对比层不碰
        // 已经是 mask 标记图层的话（文件夹名恰好如此）也跳过
        if (nm.length >= OPTIONS.suffix.length && nm.substring(nm.length - OPTIONS.suffix.length) === OPTIONS.suffix) continue;
        var lm = hasLayerMask(L), vm = hasVectorMask(L);
        if (lm || vm) {
            out.push({ layer: L, id: getId(L), name: nm, path: pathOf(L), hasLM: lm, hasVM: vm });
        }
        scanFolders(L, out);          // 子文件夹也进去找
    }
}

/* 该文件夹【正上方】的兄弟图层里，是否已经有「文件夹名 + 后缀」这张黑白图（防重复跑） */
function alreadyHasMaskLayer(folderId, folderName) {
    var folder = byId(folderId);
    if (!folder) return false;
    var parent = null, list = null;
    try { parent = folder.parent; } catch (e) { return false; }
    if (!parent) return false;
    try { list = parent.layers; } catch (e2) { return false; }
    if (!list) return false;
    // PS 里 layers[0] 是最上层：index 比文件夹小的都在它上方
    var want = folderName + OPTIONS.suffix;
    for (var i = 0; i < list.length; i++) {
        if (getId(list[i]) === folderId) return false;     // 到这里说明上方还没有
        if (safeName(list[i]) === want) return true;
    }
    return false;
}

/* ------------------------------ 图层操作 ------------------------------ */
/* ===== 在文件夹【正上方】建一张黑白图 —— 尽量不做"搬图层"的动作 =====
 *
 * 旧做法（怀疑会触发 Adobe 登录弹窗）：
 *     选中文件夹 → Mk+above 建层（结果建在【文件夹内部】）→ move 搬到文件夹外面 → 再 move 往上搬
 *     —— 两次"图层重排"，而且要把图层从一个组里挪到组外。
 *
 * 新做法（结构上就不需要搬）：
 *     选中文件夹 → DOM 的 artLayers.add() 建层。
 *     Photoshop 会把新层建在【活动图层所在的那一层容器】里、紧贴活动图层上方，
 *     所以新层天生就是文件夹的兄弟层、就在它正上方 —— 零次移动。
 *     只有当文件夹上方还有"剪贴蒙版"图层时，才做一次向上的移动（把 mask 脱出剪贴链）。
 *
 * mkLayerAboveMode 作为兜底开关保留：
 *     "dom"（默认）= 上面这套；"action" = 旧的 Mk+above 路线（DOM 建层不可用时手动切回）
 */
var mkLayerAboveMode = "dom";

/* 兼容保留：placeMaskLayerMode = "simple" 时禁止"挪到剪贴层之上"那一步（排查用） */
var placeMaskLayerMode = "clipping";

/* 在 idRef 这个图层（=文件夹）【正上方】新建一个空图层。
   ★ 返回【新建出来的图层对象】（不是 id）—— 后面所有移动/填色都用这个对象直接操作，
     和 ps 选择层空对象合并.jsx 的写法一致（它也是 artLayers.add() 之后直接 .move()）。
     失败返回 null。 */
function makeMaskLayerAbove(name, idRef) {
    var L = null;
    if (mkLayerAboveMode !== "action") L = makeMaskLayerAboveDom(name, idRef);
    if (!L) L = makeMaskLayerAboveAction(name);     // DOM 路线不可用时退回旧路线
    return L;
}

/* DOM 路线：先选中文件夹，再 artLayers.add() —— 新层成为文件夹的兄弟层、位于其正上方 */
function makeMaskLayerAboveDom(name, idRef) {
    try {
        var folder = byId(idRef);
        if (!folder) return null;
        if (!selectById(idRef)) return null;                   // 让文件夹成为活动图层
        var L = DOC.artLayers.add();                           // 建在"活动图层那一层容器"里、紧贴其上方
        try { L.name = name; } catch (eN) {}
        var parId = parentIdOfLayer(L);
        if (parId > 0 && parId === parentIdOfLayer(folder)) return L;
        try { L.remove(); } catch (eR) {}                      // 建到了别处：删掉，交给旧路线
        return null;
    } catch (e) { return null; }
}

/* ActionManager 路线（旧做法）：Mk + above:true —— 文件夹是活动图层时会建在【文件夹内部】 */
function makeMaskLayerAboveAction(name) {
    var aboveKey = sid("above");
    if (aboveKey === false) aboveKey = sid("Abov");
    if (aboveKey === false) return null;
    try {
        var d = new ActionDescriptor();
        var r = new ActionReference();
        r.putClass(cid("Lyr "));
        d.putReference(cid("null"), r);
        d.putBoolean(aboveKey, true);
        var u = new ActionDescriptor();
        u.putString(cid("Nm  "), name);
        d.putObject(cid("Usng"), cid("Lyr "), u);
        executeAction(cid("Mk  "), d, DialogModes.NO);
        // AM 路线建完不知道新层是哪个：交给调用方用 id 差集去找
        return DOC.activeLayer;
    } catch (e) { return null; }
}

/* 取图层父级的 id（父级是文档时返回 -1，取不到返回 -2） */
function parentIdOfLayer(L) {
    try {
        var p = L.parent;
        if (!p) return -2;
        try { return p.id; } catch (e1) { return -1; }
    } catch (e) { return -2; }
}

/* 图层是否正好在 idRef 的正上方（同一父级、且在它上面一层） */
function isRightAbove(idUpper, idRef) {
    try {
        var up = byId(idUpper), rf = byId(idRef);
        if (!up || !rf) return false;
        if (parentIdOfLayer(up) !== parentIdOfLayer(rf)) return false;
        var list = rf.parent.layers;
        for (var i = 0; i < list.length; i++) {
            if (getId(list[i]) === idRef) return (i - 1 >= 0) && (getId(list[i - 1]) === idUpper);
        }
    } catch (e) {}
    return false;
}


/* 文档里所有图层的 id（建完新图层后用"哪个 id 是新的"来精确找回它，不靠活动图层） */
function idSet() {
    var set = {};
    walk(DOC, function (L) {
        var id = getId(L);
        if (id >= 0) set[id] = true;
    });
    return set;
}

function findNewIdId(before) {
    var all = [];
    walk(DOC, function (L) { all.push(getId(L)); });
    for (var i = 0; i < all.length; i++) {
        if (!before[all[i]]) return all[i];
    }
    return -1;
}

/* 把 idMove 挪到 idRef 正上方。
   ★ move 动作必须【同时】给两样东西，少一样 PS 就拒（"非法参数"）：
       null = [Lyr, idMove]   ← 要移动谁
       From = [Lyr, idMove]   ← 它现在在哪（少了这个就失败，实测踩过）
       T    = [Lyr, idRef]    ← 移到谁的上面
   ---- 这是"移动图层"的标准三段式，别删 From ---- */
/* 把图层对象 mvL 移到图层对象 refL 的上方。
   ★ 手法对齐 ps 选择层空对象合并.jsx：直接对图层对象调 .move()。
   ★ 实测：这台 PS 上 executeAction("move") 报"命令"移动"当前不可用"，
     所以【只用 DOM 的 move】，不再尝试 ActionManager（省掉每次抛错）。 */
function moveBefore(mvL, refL) {
    if (!mvL || !refL) return false;
    try {
        mvL.move(refL, ElementPlacement.PLACEBEFORE);
        return true;
    } catch (e) { return false; }
}

/* 位置核验 / 修正：
 *   新层（DOM 路线）本来就该在文件夹正上方。
 *     ① 已在正上方，且它上方没有剪贴层 → 什么都不做（零移动）
 *     ② 已在正上方，但上方有连续的剪贴层 → 做【一次】上移，把 mask 放到剪贴链最上面
 *     ③ 不在正上方（例如走了旧路线、建在文件夹内部）→ 先做一次移动把它挪到文件夹正上方，再按 ② 处理
 *   返回 false = 位置实在弄不对（调用方会把这张图层删掉） */
function placeMaskLayerSafely(maskLayer, folderId) {
    if (!maskLayer || folderId < 0) return false;

    var folder = byId(folderId);
    if (!folder) return false;
    var maskId = getId(maskLayer);

    // ③ 不在正上方 → 先挪到文件夹正上方（旧路线兜底）
    if (maskId < 0 || !isRightAbove(maskId, folderId)) {
        if (!moveBefore(maskLayer, folder)) return false;
        var maskId2 = getId(maskLayer);
        if (maskId2 < 0 || !isRightAbove(maskId2, folderId)) return false;   // 挪了还是不对 → 判失败
    }

    if (placeMaskLayerMode !== "clipping") return true;          // 排查用：不碰剪贴链

    // 找文件夹上方【连续】的剪贴层里最靠上的那个
    var list = null;
    try { list = folder.parent.layers; } catch (e) { return true; }
    if (!list) return true;

    var idx = -1, i;
    for (i = 0; i < list.length; i++) { if (getId(list[i]) === folderId) { idx = i; break; } }
    if (idx < 0) return true;

    var highestClipL = null;
    for (i = idx - 1; i >= 0; i--) {                             // 越靠上 index 越小
        var g = false;
        try { g = (list[i].grouped === true); } catch (e2) { g = false; }
        if (!g) break;                                           // 剪贴链是连续的，断了就停
        highestClipL = list[i];
    }
    if (highestClipL) {
        // 只有这一步才是"把 mask 挪到剪贴链之上"的移动；文件夹上方没有剪贴层时【零移动】
        moveBefore(maskLayer, highestClipL);
    }
    return true;
}


/* ------------------------------ 蒙版载入 ------------------------------ */
/* 把【指定图层】的图层蒙版（或矢量蒙版）载入为选区。
   参数：
       layerId  —— 要载入谁的蒙版。★ 必须给：不要把"载入谁的蒙版"交给活动图层去猜。
                   踩过的坑：为了填色先把活动图层切到新建的空层，再调这个函数
                   → 空层没有蒙版 → 载入直接失败（整轮没生成任何 mask）。
       useVector —— true = 载入矢量蒙版（vmsk）；false = 载入图层蒙版（Msk ）
   做法：先把活动图层切到目标图层，同时用【明确指向该图层的通道引用】双保险。 */
function loadMaskAsSelection(layerId, useVector) {
    if (layerId === undefined || layerId === null || layerId < 0) return false;
    var vec = (useVector === true);

    // 1) 把活动图层切到目标图层（PS 载入蒙版时会参考活动图层）
    if (!selectById(layerId)) return false;

    // 2) 明确指向"该图层的那个通道"，再载入为选区
    try {
        var d = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putProperty(cid("Chnl"), cid("fsel"));
        d.putReference(cid("null"), ref);

        var to = new ActionReference();
        if (vec) {
            var vk = cid("vmsk");
            if (vk === false) return false;
            to.putEnumerated(cid("Chnl"), cid("Chnl"), vk);
        } else {
            to.putEnumerated(cid("Chnl"), cid("Chnl"), cid("Msk "));
        }
        try { to.putIdentifier(cid("Lyr "), layerId); } catch (ePI) {}   // 双保险
        d.putReference(cid("T   "), to);

        executeAction(cid("setd"), d, DialogModes.NO);
        return true;
    } catch (e) {
        // 3) 兜底：去掉"图层指向"再试一次（有些版本不接受带图层的通道引用）
        try {
            var d2 = new ActionDescriptor();
            var r2 = new ActionReference();
            r2.putProperty(cid("Chnl"), cid("fsel"));
            d2.putReference(cid("null"), r2);
            var t2 = new ActionReference();
            t2.putEnumerated(cid("Chnl"), cid("Chnl"), vec ? cid("vmsk") : cid("Msk "));
            d2.putReference(cid("T   "), t2);
            executeAction(cid("setd"), d2, DialogModes.NO);
            return true;
        } catch (e2) { return false; }
    }
}

function deselectQuiet() {
    try { DOC.selection.deselect(); } catch (e) {}
}

function hasSelection() {
    try { var b = DOC.selection.bounds; return (b ? true : false); } catch (e) { return false; }
}

/* 用 SolidColor 填充选区（诊断实测这条可用）
   ★ 注意：DOM 的 selection.fill(SolidColor) 会【无视选区边界、填满整层】。
     所以它只适合"整层填白"这种用法；不要指望它只填选区内部。 */
function fillWhite() {
    try {
        var c = new SolidColor();
        c.rgb.red = 255; c.rgb.green = 255; c.rgb.blue = 255;
        DOC.selection.fill(c);
        return true;
    } catch (e) {
        // 退回 ActionManager 的 fill
        return tryFillByAction(255, 255, 255);
    }
}

function fillBlack() {
    try {
        var c = new SolidColor();
        c.rgb.red = 0; c.rgb.green = 0; c.rgb.blue = 0;
        DOC.selection.fill(c);
        return true;
    } catch (e) {
        return tryFillByAction(0, 0, 0);
    }
}

/* 删掉图层 L 的图层蒙版（产物不该带蒙版；万一有残留就清掉） */
function removeLayerMaskQuiet(L) {
    if (!L) return false;
    try {
        var ref = new ActionReference();
        ref.putEnumerated(cid("Chnl"), cid("Chnl"), cid("Msk "));
        ref.putIdentifier(cid("Lyr "), getId(L));
        var d = new ActionDescriptor();
        d.putReference(cid("null"), ref);
        executeAction(cid("Dlt "), d, DialogModes.NO);
        return !hasLayerMask(L);
    } catch (e) { return !hasLayerMask(L); }
}
/* 给图层 L 建一个【全白】图层蒙版。
   ★ 实测：Usng:UsrM,RvlS（按选区建蒙版）在这台 PS 上抛错；
            只有 RvlA（全部显示）可用，所以先建全白蒙版，内容稍后再填。 */
function addWhiteLayerMask(L) {
    if (!L) return false;
    try {
        if (!selectById(getId(L))) return false;
        var desc = new ActionDescriptor();
        desc.putClass(cid("Nw  "), cid("Chnl"));
        var rAt = new ActionReference();
        rAt.putEnumerated(cid("Chnl"), cid("Chnl"), cid("Msk "));
        desc.putReference(cid("At  "), rAt);
        desc.putEnumerated(cid("Usng"), cid("UsrM"), cid("RvlA"));      // RvlA = 全部显示
        executeAction(cid("Mk  "), desc, DialogModes.NO);
        return hasLayerMask(L);
    } catch (e) { return false; }
}

/* 把图层 L 的【蒙版通道】选成当前的编辑目标（之后填色就填进蒙版，而不是填进像素） */
function selectMaskChannel(L) {
    if (!L) return false;
    try {
        var d = new ActionDescriptor();
        var r = new ActionReference();
        r.putEnumerated(cid("Chnl"), cid("Chnl"), cid("Msk "));
        r.putIdentifier(cid("Lyr "), getId(L));
        d.putReference(cid("null"), r);
        d.putBoolean(cid("MkVs"), false);
        executeAction(cid("slct"), d, DialogModes.NO);
        return true;
    } catch (e) { return false; }
}

/* 用指定颜色填充（失败时退回 ActionManager 的 fill） */
function fillByColor(r, g, b) {
    try {
        var c = new SolidColor();
        c.rgb.red = r; c.rgb.green = g; c.rgb.blue = b;
        DOC.selection.fill(c);
        return true;
    } catch (e) {
        return tryFillByAction(r, g, b);
    }
}

/* 备用：把前景色设成指定值然后 fill（不依赖 DOM 的 selection.fill） */
function tryFillByAction(r, g, b) {
    try {
        var col = new ActionDescriptor();
        col.putDouble(cid("Rd  "), r);
        col.putDouble(cid("Grn "), g);
        col.putDouble(cid("Bl  "), b);
        var fg = new ActionDescriptor();
        fg.putObject(cid("Clr "), cid("RGBColor"), col);
        var d1 = new ActionDescriptor();
        d1.putObject(cid("null"), cid("Clr "), fg);
        executeAction(cid("setd"), d1, DialogModes.NO);

        var d2 = new ActionDescriptor();
        d2.putEnumerated(cid("Usng"), cid("FlCn"), cid("FrgC"));
        d2.putUnitDouble(cid("Opct"), cid("#Prc"), 100);
        d2.putEnumerated(cid("Md  "), cid("BlnM"), cid("Nrml"));
        executeAction(cid("fill"), d2, DialogModes.NO);
        return true;
    } catch (e2) { return false; }
}

/* （命名去重用的是上面那对 nameInUse / uniqueLayerName(base, exceptId)） */

/* ------------------------------ 蒙版判定 ------------------------------ */
/* ★★ 不能用"键名存在"判断 ★★
   实测：每个图层都有 userMaskDensity / vectorMaskDensity 这些键；
   真正表示"有没有"的是布尔键 hasUserMask / hasVectorMask。 */
function hasLayerMask(L) {
    var d = descOf(L);
    if (!d) return false;
    if (keyTrue(d, "hasUserMask")) return true;
    if (keyExists(d, "hasUserMask")) return false;
    if (hasTopKey(d, "userMask")) return true;
    if (hasTopKey(d, "userMaskEnabled")) return true;
    return false;
}

function hasVectorMask(L) {
    var d = descOf(L);
    if (!d) return false;
    if (keyTrue(d, "hasVectorMask")) return true;
    if (keyExists(d, "hasVectorMask")) return false;
    if (hasTopKey(d, "vectorMask")) return true;
    if (hasTopKey(d, "vectorMaskEnabled")) return true;
    if (hasTopKey(d, "vmsk")) return true;
    return false;
}

function descOf(L) { return descOfId(getId(L)); }

function descOfId(id) {
    try {
        var ref = new ActionReference();
        ref.putProperty(cid("Prpr"), cid("null"));
        ref.putIdentifier(cid("Lyr "), id);
        return executeActionGet(ref);
    } catch (e) {
        try {
            var r2 = new ActionReference();
            r2.putIdentifier(cid("Lyr "), id);
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
    var n = 0;
    try { n = desc.count; } catch (e) { return false; }
    for (var i = 0; i < n; i++) {
        var k = null, ks = "";
        try { k = desc.getKey(i); ks = typeIDToStringID(k); } catch (e2) { continue; }
        if (ks !== keyName) continue;
        try { return (desc.getBoolean(k) === true); } catch (e3) { return true; }
    }
    return false;
}

function keyExists(desc, keyName) {
    if (!desc) return false;
    var n = 0;
    try { n = desc.count; } catch (e) { return false; }
    for (var i = 0; i < n; i++) {
        var ks = "";
        try { ks = typeIDToStringID(desc.getKey(i)); } catch (e2) { continue; }
        if (ks === keyName) return true;
    }
    return false;
}

/* ------------------------------ 可见性校验 ------------------------------ */
function snapshotEyes() {
    var map = {};
    walk(DOC, function (L) {
        var id = getId(L);
        if (id >= 0) { try { map[id] = (L.visible !== false); } catch (e) {} }
    });
    return map;
}

/* 只校验"处理之前就存在"的图层；本次新建的黑白图不在快照里，天然跳过 */
function verifyEyes() {
    var fixed = [];
    if (!SNAP) return fixed;
    walk(DOC, function (L) {
        var id = getId(L);
        if (id < 0 || SNAP[id] === undefined) return;
        var cur = true;
        try { cur = (L.visible !== false); } catch (e) { return; }
        if (cur !== SNAP[id]) {
            try { L.visible = SNAP[id]; fixed.push(safeName(L)); } catch (e2) {}
        }
    });
    if (fixed.length) plog("⚠ 有 " + fixed.length + " 个图层的显示状态被改动，已还原：" + fixed.join(" / "));
    else plog("✔ 可见性校验：原有图层与开始前一致（新建的黑白图不参与比对）");
    return fixed;
}

/* ------------------------------ 工具 ------------------------------ */
function isGroup(L) { try { return (L.typename === "LayerSet"); } catch (e) { return false; } }
function getId(L) { try { return L.id; } catch (e) { return -1; } }
function safeName(L) { try { return L.name; } catch (e) { return "?"; } }
function isVisible(L) { try { return (L.visible !== false); } catch (e) { return true; } }
function cid(name) { try { return charIDToTypeID(name); } catch (e) { return false; } }
function sid(name) { try { return stringIDToTypeID(name); } catch (e) { return false; } }
function nowMs() { return (new Date()).getTime(); }
function cleanMsg(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 180); } catch (e) { return "" + s; } }

function walk(container, fn) {
    try {
        var list = container.layers;
        for (var i = 0; i < list.length; i++) {
            var L = list[i];
            fn(L);
            if (isGroup(L)) walk(L, fn);
        }
    } catch (e) {}
}

function byId(id) {
    var found = null;
    if (id < 0) return null;
    walk(DOC, function (L) { if (found === null && getId(L) === id) found = L; });
    return found;
}

function findByName(container, nm) {
    var found = null;
    try {
        for (var i = 0; i < container.layers.length; i++) {
            var L = container.layers[i];
            if (safeName(L) === nm) { found = L; break; }
            if (isGroup(L)) { var inner = findByName(L, nm); if (inner) { found = inner; break; } }
        }
    } catch (e) {}
    return found;
}

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
        try {
            var L = byId(id);
            if (L) { DOC.activeLayer = L; return true; }
        } catch (e2) {}
        return false;
    }
}

function pathOf(L) {
    var parts = [];
    var cur = L;
    var guard = 0;
    while (cur && guard < 40) {
        guard++;
        try {
            parts.unshift(safeName(cur));
            var parent = cur.parent;
            if (!parent || parent === DOC) break;
            cur = parent;
        } catch (e) { break; }
    }
    return parts.join(" / ");
}

/* ------------------------------ 进度条（不写 preferredSize） ------------------------------ */
function pbOpen(title, total) {
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
        PB.total = (total > 0 ? total : 1);
        PB.n = 0;
        PB.cancel = false;
        PB.btn = null;
    } catch (e) { PB.win = null; }
}

function pbStep(msg) {
    checkStopFlag();
    if (!PB.win) return;
    PB.n++;
    try {
        PB.bar.value = (PB.n > PB.total ? PB.total : PB.n);
        PB.txt.text = msg;
        PB.win.update();
    } catch (e) {}
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

/* ★★ 步骤结果标记（供 ps 00 批处理判断这一步成功还是失败）★★
   为什么需要：$.evalFile 只会在"抛出异常"时报错；但步骤脚本多半自己把异常
   捕获了（不让批处理中断），于是 ps 00 无法知道这一步到底成没成。
   做法：启动成功先写 "OK"，之后若出错再覆盖成 "FAIL|原因"。
   ps 00 在每步前后读这个文件，就能判断并把失败步骤记进汇总。
   只在批处理模式写（单跑时不产生垃圾文件）。 */
function stepMarkPath() {
    try { return Folder.temp.fsName + "/psjsx_step_result.txt"; } catch (e) { return ""; }
}
function stepMark(text) {
    if (!batchOn()) return;
    try {
        var p = stepMarkPath();
        if (!p) return;
        var f = File(p);
        f.open("w");
        f.write(text + "\n");
        f.close();
    } catch (e) {}
}


/* ------------------------------ 选项面板 ------------------------------ */
/* ★ 默认不建这个窗口（OPTIONS.showOptionsDialog = false）。
   它只在"你想改选项"时才需要；平时点脚本应该直接开跑，不该弹任何东西。
   想打开：把 OPTIONS.showOptionsDialog 改成 true（或 askOptions = true）。 */
function askDialog() {
    if (!OPTIONS.showOptionsDialog) return true;     // ★ 不弹：直接用默认值
    if (batchOn()) return true;
    if (typeof Window === "undefined") return true;
    var w = new Window("dialog", "ps 06 提取文件夹蒙版 —— 选项");
    w.orientation = "column";
    w.alignChildren = "left";

    var g0 = w.add("panel", undefined, "将要做的");
    g0.orientation = "column"; g0.alignChildren = "left";
    g0.add("statictext", undefined, "· 找出所有【带图层蒙版 / 矢量蒙版】的文件夹");
    g0.add("statictext", undefined, "· 在文件夹【正上方】建一张黑白图（白=显示，黑=挡住）");
    g0.add("statictext", undefined, "· 名字 = 文件夹名 +「" + OPTIONS.suffix + "」，建完隐藏");
    g0.add("statictext", undefined, "· AE 里把它设成该文件夹的【亮度遮罩】");
    g0.add("statictext", undefined, "★ 只新建图层、不合并、不改像素；文件夹上原来的蒙版保留不动");

    var gSuf = w.add("group");
    gSuf.add("statictext", undefined, "黑白图名字后缀：");
    var etSuf = gSuf.add("edittext", undefined, OPTIONS.suffix);
    etSuf.characters = 10;
    gSuf.add("statictext", undefined, "（最终名字 = 文件夹名 + 这个后缀）");

    var cbHide = w.add("checkbox", undefined, "建完把黑白图隐藏（AE 里设亮度遮罩用）");
    cbHide.value = !!OPTIONS.hideMaskLayer;

    var cbSkipHidden = w.add("checkbox", undefined, "跳过隐藏的文件夹");
    cbSkipHidden.value = !!OPTIONS.skipHiddenFolders;

    var g2 = w.add("panel", undefined, "给 07 / 08 的约定");
    g2.orientation = "column"; g2.alignChildren = "left";
    g2.add("statictext", undefined, "· 名字以「" + OPTIONS.suffix + "」结尾的图层是【标记图层】");
    g2.add("statictext", undefined, "  07/08 会跳过它们（不合并、不改像素），否则 AE 亮度遮罩会失效");
    g2.add("statictext", undefined, "· 本步不建对比图层（它不改画面）");

    var cbRem = w.add("checkbox", undefined, "记住我的选择（下次自动带上）");
    cbRem.value = !!OPTIONS.rememberOptions;

    var gB = w.add("group"); gB.alignment = "right";
    gB.add("button", undefined, "开始", { name: "ok" });
    gB.add("button", undefined, "取消", { name: "cancel" });

    try { placeWindowOnHostScreen(w); } catch (ePL) {}
    if (w.show() !== 1) return false;

    // 后缀统一规范化：保证带前导空格（否则名字会变成「文件夹名mask」）
    OPTIONS.suffix = normSuffix(etSuf.text);
    OPTIONS.hideMaskLayer = (cbHide.value === true);
    OPTIONS.skipHiddenFolders = (cbSkipHidden.value === true);
    OPTIONS.rememberOptions = (cbRem.value === true);
    return true;
}

/* ------------------------------ 结果 ------------------------------ */
function writeSummary() {
    plog("");
    plog("========== 汇总 ==========");
    if (R.aborted) plog("⚠ 本次被用户中止（只处理了一部分文件夹）");
    plog("带蒙版的文件夹 " + R.total + " 个：已提取 " + R.made.length + " 个，失败 " + R.failed.length + " 个");
    if (R.skipNoMask) plog("（另有 " + R.skipNoMask + " 个文件夹在扫描后已没有蒙版，跳过）");
    if (R.skipHidden.length) {
        plog("跳过（隐藏的文件夹）：");
        for (var i = 0; i < R.skipHidden.length; i++) plog("  · " + R.skipHidden[i]);
    }
    if (R.failed.length) {
        plog("失败明细：");
        for (var j = 0; j < R.failed.length; j++) plog("  · " + R.failed[j]);
    }
    plog("原图层、原蒙版、像素：一律未动；没有删除任何东西。");
    plog("下一步：07 烘焙文件夹的剪贴蒙版（务必跳过「" + OPTIONS.suffix + "」图层）。");
    plog("日志：" + LOG.path);
    plog("===== 结束 =====");
    logClose();
}

/* 收尾：写一份结果文件（不建任何窗口）
   ★ 2026-10-15 实验：原来这里弹 alert 汇总窗，弹窗关闭前后会冒出 Adobe 的
     登录/开发者控制台网页（developer.adobe.com/console/plugins + auth.services.adobe.com）。
     现在改成【完全不建 Window】，结果写到 <文档名>_ps06结果.txt，便于对比验证。
     要恢复弹窗：把下面 finishShort() 里那句 alert 的注释去掉即可。 */
function finishShort(msg) {
    var t = msg;
    if (R.made.length) t += "\r\n\r\n· 已提取 " + R.made.length + " 张黑白图（都在各自文件夹正上方，已隐藏）";
    if (R.skipHidden.length) t += "\r\n· 跳过隐藏文件夹 " + R.skipHidden.length + " 个";
    if (R.failed.length) t += "\r\n\r\n⚠ 失败 " + R.failed.length + " 个（明细在日志里）";
    t += "\r\n\r\n下一步：07 烘焙文件夹剪贴蒙版（会跳过「" + OPTIONS.suffix + "」图层）";
    t += "\r\n\r\n详细日志：" + LOG.path;
    writeResultFile(t);

    // 需要弹窗时把下面这行取消注释（批处理模式仍然不弹）
    // if (!batchOn() && typeof Window !== "undefined") { try { alert(t); } catch (eA) {} }
}

/* 把汇总写到 <文档名>_ps06结果.txt（和日志同目录）—— 不开任何窗口 */
function writeResultFile(txt) {
    try {
        var d = ensureLogFolder();
        if (!d) d = Folder(Folder.temp);
        var p = d.fsName + "/" + DOC.name.replace(/\.[^.]+$/, "") + "_ps06结果.txt";
        var f = File(p);
        f.open("w");
        f.write("ps 06 提取文件夹蒙版 —— 结果\r\n");
        f.write(txt + "\r\n");
        f.close();
    } catch (e) {}
}

function failOut(msg) {
    writeResultFile(msg);
    if (batchOn()) {
        try {
            var f = File(Folder.temp.fsName + "/psjsx_06_error.txt");
            f.open("w"); f.write(msg + "\n"); f.close();
        } catch (e) {}
        return;
    }
    // 出错也不弹窗（同样为了排除"弹窗触发外部网页"的可能）；需要时再打开下面这行
    // try { alert(msg); } catch (e2) {}
}


/* ------------------------------ 日志目录（统一放 <文档目录>/_日志/） ------------------------------
 * 说明：以前日志直接写在文档旁边，文档一多就糊成一片。
 * 现在统一放进文档同级的 "_日志" 子文件夹里（例如 F:\Fwork\zmd1.6运营\process\_日志）。
 * 该文件夹不存在就新建；建不出来（只读盘等）就退回文档目录，再不行退回临时目录。 */
function logDirName() { return "_日志"; }

function ensureLogFolder() {
    try {
        var d = (DOC && DOC.path) ? Folder(DOC.path) : null;
        if (!d) return null;
        var sub = Folder(d.fsName + "/" + logDirName());
        if (!sub.exists) {
            try { sub.create(); } catch (eC) {}
        }
        if (sub.exists) return sub;
        return d;                       // 建不出来就退回文档目录
    } catch (e) { return null; }
}

/* ------------------------------ 日志 ------------------------------ */
function logOpen() {
    try {
        var d = ensureLogFolder();
        if (!d) d = Folder(Folder.temp);
        LOG.path = d.fsName + "/" + DOC.name.replace(/\.[^.]+$/, "") + "_ps06日志.txt";
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

/* ===== 排查探针：带毫秒的时间戳 =====
   用途：跑完把日志时间与"浏览器历史里弹窗的时间"对照，就能定位
        到底是哪个【具体操作】触发了 Adobe 的登录/开发者页面。
   排查完可以整段删掉（只影响日志，不影响处理结果）。 */
function probe(s) {
    if (!OPTIONS.probeTiming) return;
    if (!LOG.f) return;
    try {
        var d = new Date();
        var ms = "" + d.getMilliseconds();
        while (ms.length < 3) ms = "0" + ms;
        LOG.f.write("[探针 " + d.toTimeString().substring(0, 8) + "." + ms + "] " + s + "\n");
    } catch (e) {}
}

/* 后缀规范化：保证以空格开头，这样图层名是「文件夹名 mask」。
   （老偏好文件里存的是不带空格的 "mask"，会被这里纠正） */
function normSuffix(s) {
    var v = ("" + s).replace(/^\s+|\s+$/g, "");      // 去掉两端空白
    if (!v) v = "mask";
    return " " + v;
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
            if (k === "suffix") OPTIONS.suffix = normSuffix(v);
            if (k === "hideMaskLayer") OPTIONS.hideMaskLayer = (v === "1");
            if (k === "skipHiddenFolders") OPTIONS.skipHiddenFolders = (v === "1");
            // 记住"要不要弹选项面板"（临时打开过之后不会一直弹）
            if (k === "showOptionsDialog") {
                OPTIONS.showOptionsDialog = (v === "1");
                OPTIONS.askOptions = OPTIONS.showOptionsDialog;
            }
        }
    } catch (e) {}
}

function savePrefs() {
    if (!OPTIONS.rememberOptions) return;
    var f = prefFile();
    if (!f) return;
    try {
        f.open("w");
        f.write("suffix=" + OPTIONS.suffix + "\n");
        f.write("hideMaskLayer=" + (OPTIONS.hideMaskLayer ? "1" : "0") + "\n");
        f.write("skipHiddenFolders=" + (OPTIONS.skipHiddenFolders ? "1" : "0") + "\n");
        f.close();
    } catch (e) {}
}

/* ==========================================================================
 * 启动块（必须放在文件最末尾：用到的所有 var 都已经赋过值）
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
            plog("===== ps 06 提取文件夹蒙版 开始 =====");
            plog("文档：" + DOC.name);
            plog("生效选项：后缀=「" + OPTIONS.suffix + "」，建完隐藏=" + (OPTIONS.hideMaskLayer ? "是" : "否") +
                 "，跳过隐藏文件夹=" + (OPTIONS.skipHiddenFolders ? "是" : "否"));
            plog("建层方式=" + mkLayerAboveMode + "，放置方式=" + placeMaskLayerMode);

            clearStopFlag();   // ★ 启动前清掉上次残留的停止信号
            stepMark("OK");   // ★ 先记成功，出错时会被覆盖成 FAIL
            SNAP = snapshotEyes();

            var had = false;
            try {
                try { $.global.PSJSX_HOOK = doExtract; } catch (eG) {}
                DOC.suspendHistory("ps06 提取文件夹蒙版", "PSJSX_HOOK()");
                had = true;
            } catch (eH) { had = false; }
            if (!had) { try { doExtract(); } catch (eD) { plog("✗ 直接执行也失败：" + cleanMsg("" + eD)); } }

            try { R.eyesFixed = verifyEyes(); } catch (eV) {}

            writeSummary();
            finishShort("完成：带蒙版的文件夹 " + R.total + " 个，已提取 " + R.made.length +
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
        stepMark("FAIL|整体出错：" + cleanMsg("" + eMain));
        logClose();
        // 出错也统一走"写结果文件"，不弹窗（实验：把 Windows 弹窗全部去掉）
        failOut("ps 06 运行出错：" + eMain + "\r\n行号: " + __ln + "\r\n文件: " + __fn +
                "\r\n日志: " + LOG.path);
    } catch (eAl) {}
}

})();
