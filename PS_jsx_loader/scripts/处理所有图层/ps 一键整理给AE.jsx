#target photoshop
/* ==========================================================================
 * ps 一键整理给AE.jsx
 * 把当前的 PSD / PSB 整理成 After Effects 能直接导入、并且尽量不丢效果的状态。
 *
 * ---------------------------------------------------------------------------
 * 【这个脚本做什么】
 *   1. 预检：颜色模式 / 位深 / 尺寸 / 图层复合（AE 对 CMYK、Lab、索引、位图、
 *      多通道的 PSD 支持很差，会把颜色弄歪甚至导不进去；默认自动转成 RGB）。
 *   2. 剪贴蒙版(clipping mask)整理：
 *      · 基底是「文件夹」的剪贴蒙版（例：杂色 拷贝 12 盖在「3 拷贝」文件夹上）——
 *        AE 会直接无视这个图层。处理办法：把它复制到该文件夹里每个叶子图层上、
 *        设为剪切蒙版并合并进那个叶子（子文件夹递归进去，只和叶子合并），
 *        最后删掉原来那个跨文件夹的剪贴图层。
 *      · 基底是「普通图层」的剪贴链：自下而上合并进基底图层。
 *      · 链里只要有一个隐藏图层就整条跳过（AE 本来就看不见）。
 *   3. 图层样式(fx) → 真实图层：调用 PS 官方命令「图层 > 图层样式 > 创建图层」
 *      (createLayersFromLayerFX)，把每个 fx 拆成普通图层。
 *      AE 只能"部分"支持 PS 的图层样式；拆成真实图层后 AE 一律按普通图层导入，
 *      观感一致，而且不依赖 AE 导入对话框里选哪个「图层选项」。
 *   4. 检测 AE 表达不了的东西（填充不透明度、混合剪贴图层/内部效果、挖空、
 *      透明形状图层、蒙版隐藏效果、通道限制、颜色查找调整层、溶解混合模式、
 *      被禁用的蒙版、基底被隐藏的剪贴蒙版、缺失字体……）写进报告。
 *      默认只报告、绝不动你的图层；需要时可以打开开关让它自动烘焙。
 *   5. 结束时校验：除了本次新生成的图层，所有图层的"眼睛"开关必须和整理前
 *      完全一致；发现被副作用改掉的，自动还原并写进报告。
 *   6. 在文档同目录输出两张对比图：<名字>_整理前.xxx / <名字>_整理后.xxx，
 *      同名直接覆盖。把两张图叠起来、上层混合模式设成「差值」，就能一眼看出
 *      整理有没有把画面改坏（这是排查 bug 最快的办法）。
 *   7. 全过程包在**一个历史步骤**里：Ctrl+Z 一步回到整理前。
 *
 * ---------------------------------------------------------------------------
 * 【这个脚本故意不做的事】（重要）
 *   × 不做"全量解锁"。只会在整理过程中、某个图层（或挡住它的上级组）马上要被
 *     改动而它正锁着的时候，才解锁它自己 / 那个组。
 *   × 不删除「隐藏」图层，包括眼睛关掉的图层（AE 导入隐藏层只是不显示，不会丢效果；
 *     删掉才是不可逆的）。
 *   × 唯一会删图层的地方：跨文件夹的剪贴蒙版原图层——它的内容已经逐个烘焙进叶子图层了，
 *     留着会在 PS 里重复叠一层（不想删：OPTIONS.deleteFolderClipOriginal = false）。
 *   × 不擅自改任何图层的可见性开关。唯一例外是 OPTIONS.clipBaseHidden = "sync"
 *     时，把"基底图层被隐藏的剪贴蒙版图层"自己的眼睛关掉；默认 "report" = 只报告。
 *   × 剪贴整理只碰「显示中」的剪贴链：链里只要有一个隐藏图层就整条跳过。
 *
 * ---------------------------------------------------------------------------
 * 【AE 侧导入建议】
 *   · 导入时选「合成」(Import Kind = Composition)。
 *   · 样式已拆成真实图层，「图层选项」选哪个都不会丢效果。
 *   · 保存前建议保持「首选项 > 文件处理 > 最大兼容」开启。
 * ========================================================================== */

/* ==========================================================================
 * 开关（按需要改这里，改完保存，面板重新加载即可）
 * ========================================================================== */
var OPTIONS = {

    // 颜色模式不是 RGB/灰度时自动转 RGB（AE 对非 RGB 的 PSD 支持很差）。建议 true。
    convertToRGB: true,

    // 把图层样式(fx)拆成真实图层。
    // ★ 默认 false：因为「图层 > 图层样式 > 创建图层」这条命令在 PS 里**无法用脚本调用**
    //   （实测 executeAction 三种引用写法 / DialogModes.ALL / runMenuItem 四种 ID 全部失败；
    //    它在菜单里执行时会弹提示框，属纯交互式命令）。打开只会白试 3 次然后跳过。
    //   如果哪天 PS 修好了，把它改成 true 即可。
    splitLayerStyles: false,

    // 拆分样式失败时（例如某些图层组的样式 PS 不允许拆）是否退化成"合并烘焙"：
    // 把样式烤进像素，观感一致，但会失去可编辑性。
    // 默认 false = 失败只写进报告，不动你的图层。
    bakeWhenSplitFails: false,

    // 检测到 AE 表达不了的效果时，是否自动烘焙该图层以保证观感。
    // 默认 false = 只报告、不改动。打开会损失可编辑性，但观感最保险。
    bakeLossyLayers: false,
    // 额外把这两类图层也烘焙成像素（默认 false；打开后它们会一起进烘焙队列）：
    //   · 带图层蒙版 / 矢量蒙版的图层
    //   · 用了智能滤镜(smart filter)的图层
    // 说明：AE 本身能读图层蒙版、也能拿到智能滤镜的渲染结果，所以严格来说不一定非烤不可；
    //       但如果你在 AE 里发现这两类图层的效果不对，就把它们打开。
    bakeMaskedLayers: true,
    // 用「下面建空层 + 向下合并」烘焙（不是栅格化），观感一致、内存友好
    bakeSmartFilterLayers: true,
    // 把所有智能对象图层也这么烘焙掉（嵌套 PSD 的智能对象很吃内存，烤掉能大幅降内存）。
    // 默认 false：智能对象多的时候（这份文档 38 个）事情会变多，需要时再开。
    bakeSmartObjects: false,
    // 每轮最多烘焙几个图层（0 = 不限）。PS 不稳时用分块：跑一次做 N 个，再点一次脚本继续做剩下的。
    bakeChunkSize: 0,
    // 每烘焙几个就清一次缓存（只有 purgeCachesAtEnd = true 时生效）
    bakePurgeEvery: 5,
    // 进度日志：每一步都立刻写进 <文档名>_整理日志.txt（PS 崩了也能看到最后一行）。
    // 排查稳定性问题期间建议保持 true。
    progressLog: true,
    // 跑完是否让 Photoshop 立刻释放缓存（app.purge）。
    // 大文件上能降低"跑完不久就崩"的概率；代价：Ctrl+Z 不能再回退到整理前。
    purgeCachesAtEnd: false,

    // 剪贴蒙版的基底图层被隐藏时怎么办：
    //   "report" = 只报告（默认，绝不擅自改可见性开关）
    //   "sync"   = 把该 clip 图层自己的眼睛关掉（只动它自己这一个开关，并写进报告）
    clipBaseHidden: "report",

    // 按需解锁：只在图层马上要被改动时才解锁它。建议保持 true。
    lazyUnlock: true,

    // ---- 剪贴蒙版(clipping mask)整理 ----
    // AE 对「基底是文件夹」的剪贴蒙版（例：杂色 拷贝 12 盖在「3 拷贝」文件夹上）基本是直接无视，
    // 对复杂的剪贴链也经常出错。这里按手动流程自动化：
    bakeClippingMasks: true,
    // 基底是文件夹的剪贴蒙版：
    //   "auto"   = 把剪贴图层复制到该文件夹里每个叶子图层上、设为剪切蒙版并合并
    //              （子文件夹继续递归进去，只和叶子图层合并）
    //   "report" = 只报告，不动
    clipOverFolder: "auto",
    // 复制烘焙完之后，删掉原来那个跨文件夹的剪贴图层
    // （它的内容已经烘焙进叶子图层了；不删的话 PS 里会重复叠一层）
    deleteFolderClipOriginal: true,
    // 基底是普通图层的剪贴链：自下而上合并进基底图层
    bakeClipChains: false,
    // PS 有时拒绝把图层合并进"形状层/填充层/智能对象"（你这次失败的正是这些）。
    // 打开：先把它栅格化成像素再合并（形状层可编辑性会丢，但剪贴效果能烤进去）。
    rasterizeWhenMergeFails: true,

    // ---- 稳定性（大 PSB 建议保持默认）----
    // 每个阶段各自提交一个历史步骤：PS 能及时释放缓冲，大文件更稳；
    // 代价是 Ctrl+Z 要按几次（按阶段数）。设 false = 整个过程仍然"一步撤销"。
    separateHistorySteps: true,
    // 失败时用"还原历史状态"精确回滚那一步。这个调用在超大文档上有风险（可能是闪退诱因之一），
    // 关掉后失败只报告、不回滚（一般失败的合并本来就没改动文档）。
    historyRollback: false,
    // 只跑其中一部分，用于定位是哪一步出问题：
    //   "all"       = 全跑（默认）
    //   "clip"      = 只跑剪贴蒙版整理
    //   "styles"    = 只跑图层样式拆分
    //   "bakeLossy" = 只跑"AE 不支持效果"的烘焙
    // （预检/扫描/收尾/对比图永远都会跑）
    stages: "all",

    // 结束时校验"除新生成图层外，可见性开关与整理前完全一致"。建议保持 true。
    verifyVisibility: true,
    // 校验/过程中发现可见性被副作用改了，是否自动还原。建议保持 true。
    restoreVisibility: true,

    // 弹窗摘要
    showSummary: true,
    // 在 PSD 同目录写一份完整报告（写不了就退到桌面）
    writeReportFile: true,

    // ---- 对比手段（两套并行，等脚本验证稳定后可各自关掉）----
    // ① 在文档同目录写两张对比图（整理前 / 整理后），同名直接覆盖。
    // ★ 默认 false：写图要 doc.saveAs 把整篇合成一次，实测在"烘焙过的文档"上会把 PS 搞崩
    //   （崩溃点就在这，日志里停在"收尾 3/5"）。图层那套对比手段不受影响。
    saveCompareImages: false,
    // 对比图格式："png"（无损，最适合比对）或 "jpg"（体积小）；
    // 如果当前位深存不了（例如 32 位），会自动改用无损 TIFF。
    compareImageFormat: "png",
    // ② 在图层最上面盖印两个对比图层（"对比-新(整理后)" / "对比-旧(整理前)"），
    //    直接在 PS 里对比，不用切出去看图。
    //    用法：把最上面那层（新）的混合模式改成「差值」，全黑=完全一致，亮的地方就是整理改动过的地方。
    //    注意：对比完记得删掉这两层（否则会被 AE 当成普通图层导入）。
    saveCompareLayers: true,
    // 直接把"新"那层设成「差值」混合模式（默认 false = 两层都是正常模式）
    compareDiffBlend: false,

    // 整理完顺便另存一份给 AE 用的副本（原名 + "_AE.psd/.psb"，原文件不动）。
    // 大文件会花点时间，默认 false。
    saveCopyForAE: false
};

/* ==========================================================================
 * 全局状态
 * ========================================================================== */
var KEY_CACHE = {};                  // stringIDToTypeID 不认识的会抛错，先探再存

/* 进度日志：注意！带初值的全局变量必须定义在这里（入口 main() 之后的赋值不会生效） */
var PLOG = { file: null, path: "", enabled: false };

var SCAN = {                         // 只读扫描结果
    layerCount: 0, groupCount: 0, hiddenCount: 0, lockedCount: 0,
    emptyGroupCount: 0, maxDepth: 0,
    fxIds: [],                       // 有图层样式的图层 id（从上到下的顺序）
    meta: {},                        // id -> {id,name,group,depth,path,parent,visible,locked,hasFX,isBackground}
    vis: {},                         // id -> 整理前的可见性（收尾校验用）
    clipHiddenBase: [],              // 基底被隐藏的剪贴蒙版图层
    bakeQueue: []                    // 需要烘焙的图层 id（OPTIONS.bakeLossyLayers 时用）
};

var R = {                            // 报告
    docName: "", docInfo: "", startTime: 0, elapsed: 0,
    preflight: [],
    unlocked: [],                    // 按需解锁的图层
    split: [], splitFailed: [],
    baked: [],                       // 烘焙过的图层
    visFixed: [],                    // 过程中被副作用改掉、已当场还原的可见性
    syncClip: [],                    // clipBaseHidden = "sync" 时改过的图层
    clip: {                          // 剪贴蒙版整理结果
        folderChains: [],            // 跨文件夹的剪贴链（复制到叶子图层并烘焙）
        bakedChains: [],             // 普通剪贴链（合并进基底）
        skipped: [], failed: [],     // 跳过的原因 / 失败明细
        rasterized: [],              // 为了能合并而先栅格化的图层
        elapsed: 0
    },
    risks: {
        fillOpacity: [], advancedBlend: [], knockout: [], transparencyShapes: [],
        maskHidesFx: [], channelLock: [], dissolve: [], colorLookup: [],
        disabledMask: [], missingFont: [], clipHiddenBase: [],
        masked: [], smartFilter: [],
        skipAdjust: [], skipClipped: [],
        text: 0, warpText: 0, smartObject: 0, shapeOrFill: 0,
        adjustment: 0, videoOr3D: 0
    },
    visChecked: null,
    notes: [], errors: [],
    selActiveId: -1,
    cmpBeforeLayer: null, cmpAfterLayer: null,
    cmpBeforeImage: null, cmpAfterImage: null, cmpNoteDone: false,
    fxBakedByBake: 0, fxBakedByClip: 0,
    psVersion: "?"
};

var IDX = { map: {}, dirty: true };   // id -> 图层对象（结构一变就重建，避免拿到过期对象）

/* ==========================================================================
 * 入口
 * ========================================================================== */
if (app.documents.length === 0) {
    alert("请先打开一个 PSD / PSB 文档。");
} else {
    var __doc = app.activeDocument;
    var __prevDialogs = app.displayDialogs;
    R.docName = __doc.name;
    R.startTime = new Date().getTime();
    try { R.psVersion = app.version; } catch (eVer) { R.psVersion = "?"; }

    app.displayDialogs = DialogModes.NO;      // 脚本里不要弹任何对话框

    // 跑整理（默认每个阶段各自一个历史步骤；OPTIONS.separateHistorySteps = false 则整体一步）
    // ⚠ 入口就在这里：所有「带初值的全局变量」必须定义在这一行之前（函数声明会自动提升，var 初值不会）
main();

    app.displayDialogs = __prevDialogs;

    // 报告放在历史步骤之外做（弹窗 + 写文件）
    afterRun(__doc);
}

/* ==========================================================================
 * 主流程：分阶段执行
 *   每个阶段各自包一个 suspendHistory（大文件下 PS 能及时释放缓冲，更不容易崩），
 *   某个阶段抛错也不影响后面的阶段继续跑。
 * ========================================================================== */
function main() {
    var doc = app.activeDocument;
    var list = stageList();
    var tStage = 0;
    try {
        plogSetup(doc);
        for (var i = 0; i < list.length; i++) {
            plog("--- 阶段开始：" + list[i].label);
            tStage = new Date().getTime();
            try {
                if (OPTIONS.separateHistorySteps) {
                    doc.suspendHistory("一键整理给AE - " + list[i].label, list[i].fn + "()");
                } else {
                    eval(list[i].fn + "()");
                }
                plog("--- 阶段结束：" + list[i].label + "（" +
                     (Math.round((new Date().getTime() - tStage) / 100) / 10) + " 秒）");
            } catch (e1) {
                R.errors.push("阶段「" + list[i].label + "」出错：" + e1 + lineInfo(e1));
                plog("!!! 阶段「" + list[i].label + "」出错：" + cleanMsg("" + e1));
            }
            if (OPTIONS.purgeCachesAtEnd) {
                try { app.purge(PurgeTarget.ALLCACHES); plog("（已清理缓存）"); } catch (eP) {}
            }
        }
        plogEnd(R.errors.length === 0);
    } catch (e) {
        R.errors.push("整理过程中出错：" + e + lineInfo(e));
        plog("!!! 整理过程中出错：" + cleanMsg("" + e));
        plogEnd(false);
    } finally {
        try { restoreActiveLayer(); } catch (e3) {}
        if (OPTIONS.purgeCachesAtEnd) {
            try { app.purge(PurgeTarget.ALLCACHES); } catch (e5) {}
        }
        R.elapsed = Math.round((new Date().getTime() - R.startTime) / 100) / 10;
    }
}

// 根据 OPTIONS.stages 决定跑哪些阶段（预检/收尾永远跑）
function stageList() {
    var all = [
        { key: "prepare",   label: "预检+扫描+整理前对比图", fn: "stagePrepare" },
        { key: "bakeLossy", label: "按开关烘焙(不支持的效果/蒙版/智能滤镜)", fn: "stageBakeLossy" },
        { key: "clip",      label: "剪贴蒙版整理",           fn: "stageClip" },
        { key: "styles",    label: "图层样式拆成图层",       fn: "stageStyles" },
        { key: "finish",    label: "收尾(校验+整后对比图)",  fn: "stageFinish" }
    ];
    var want = ("" + OPTIONS.stages).toLowerCase();
    if (want === "all" || want === "") return all;

    var out = [];
    for (var i = 0; i < all.length; i++) {
        var k = all[i].key;
        if (k === "prepare" || k === "finish" || k === want) out.push(all[i]);
    }
    return out;
}

// 单步撤销模式下，一次跑完所有阶段
function runAllStages() {
    var list = stageList();
    for (var i = 0; i < list.length; i++) {
        try {
            eval(list[i].fn + "()");
        } catch (e) {
            R.errors.push("阶段「" + list[i].label + "」出错：" + e + lineInfo(e));
        }
    }
}

/* ---------- 阶段 1：预检 + 扫描 + 盖印"旧"对比图层 ---------- */
function stagePrepare() {
    var doc = app.activeDocument;
    rememberSelection(doc);
    removeOldCompareLayers(doc);            // 重复运行时先清掉上次留下的对比图层
    preflight(doc);
    scanDocument(doc);                      // 先扫描：记下整理前的图层数 / 可见性 / 风险点
    if (SCAN.layerCount === 0) {
        R.notes.push("文档里没有任何图层，什么也没做。");
        return;
    }
    plog("文档信息：" + R.docInfo + "，图层 " + SCAN.layerCount + " 个（组 " + SCAN.groupCount + " 个，隐藏 " + SCAN.hiddenCount + " 个）");
    // 扫描之后再盖印"旧"，这样报告里的图层数还是整理前的真实数量
    captureCompareImage(doc, "before");     // ① 文件夹里的"整理前"图
    captureCompareLayer(doc, "before");     // ② 图层上的"对比-旧(整理前)"
}

// 上一次跑留下的对比图层（同名）先删掉，避免重复运行越叠越多
function removeOldCompareLayers(doc) {
    var names = ["对比-旧(整理前)", "对比-新(整理后)"];
    var removed = 0;
    for (var n = 0; n < names.length; n++) {
        var guard = 0;
        var found = findTopLevelLayerByName(doc, names[n]);
        while (found && guard++ < 50) {
            try {
                if (isLayerSet(found)) break;
                found.remove();
                removed++;
                markDirty();
            } catch (e) {
                break;
            }
            found = findTopLevelLayerByName(doc, names[n]);
        }
    }
    if (removed > 0) R.notes.push("清掉了上次留下的 " + removed + " 个对比图层（" + names.join(" / ") + "）。");
    return removed;
}

// 只在最顶层找（不动图层组里同名的东西）
function findTopLevelLayerByName(doc, name) {
    var arr = doc.layers;
    for (var i = 0; i < arr.length; i++) {
        var nm = "";
        try { nm = arr[i].name; } catch (e) {}
        if (nm === name) return arr[i];
    }
    return null;
}

/* ---------- 阶段 2：烘焙 AE 表达不了的效果（可选） ---------- */
function stageBakeLossy() {
    if (SCAN.bakeQueue.length === 0) return;
    if (!(OPTIONS.bakeLossyLayers || OPTIONS.bakeMaskedLayers || OPTIONS.bakeSmartFilterLayers)) return;
    bakeLayers(app.activeDocument, SCAN.bakeQueue);
}

/* ---------- 阶段 3：剪贴蒙版整理 ---------- */
function stageClip() {
    var doc = app.activeDocument;

    // 先同步"基底被隐藏的剪贴蒙版"的可见性（可选；隐藏的链后面会被跳过）
    if (OPTIONS.clipBaseHidden === "sync") syncClipHiddenBase(doc);

    bakeClippingMasks(doc);

    // 统计：这一步真正烤掉了几个带样式的图层（总数减去烘焙阶段已经烤掉的，别抢功劳）
    try { R.fxBakedByClip = Math.max(0, countFxLost(doc) - R.fxBakedByBake); }
    catch (eFx) { R.fxBakedByClip = 0; }
}

/* ---------- 阶段 4：图层样式 → 真实图层 ---------- */
function stageStyles() {
    if (OPTIONS.splitLayerStyles) splitAllLayerStyles(app.activeDocument);
}

/* ---------- 阶段 5：收尾（校验 + 盖印"新"对比图层 + 另存副本） ---------- */
function stageFinish() {
    var doc = app.activeDocument;

    plog("收尾 1/5：可见性逐层校验");
    if (OPTIONS.saveCopyForAE) { plog("收尾：另存 AE 副本"); saveAECopy(doc); }
    try { verifyVisibility(doc); } catch (e2) { R.errors.push("可见性校验失败：" + e2); }
    plog("收尾 1/5 完成");

    // 先把报告写盘：万一后面"整篇合成"那几步把 PS 搞崩，报告也已经在硬盘上了
    plog("收尾 2/5：先把报告写到硬盘");
    try { writeReportFile(doc, buildReport(doc, true).join("\r\n")); } catch (eR) {}
    plog("收尾 2/5 完成");

    plog("收尾 3/5：写【整理后】对比图（需要对整篇文档做一次合成）");
    captureCompareImage(doc, "after");
    plog("收尾 3/5 完成");

    plog("收尾 4/5：盖印【对比-新(整理后)】图层（也要合成一次）");
    captureCompareLayer(doc, "after");
    plog("收尾 4/5 完成");

    plog("收尾 5/5：写完最终报告");
    try { writeReportFile(doc, buildReport(doc, true).join("\r\n")); } catch (eR2) {}
    plog("收尾 5/5 完成");
}

/* ==========================================================================
 * 1. 预检
 * ========================================================================== */
function preflight(doc) {
    var mode = null;
    try { mode = doc.mode; } catch (e) {}
    var modeName = describeMode(mode);

    var bits = "?";
    try { bits = describeBits(doc); } catch (e2) {}

    var w = pxOf(doc.width);
    var h = pxOf(doc.height);
    R.docInfo = modeName + " / " + bits + " 位 / " + (w === null ? "?" : w) + " × " +
                (h === null ? "?" : h) + " px";

    // --- 颜色模式 ---
    if (isNonRGBMode(mode)) {
        if (OPTIONS.convertToRGB) {
            try {
                doc.changeMode(ChangeMode.RGB);
                R.preflight.push("颜色模式：" + modeName + " → RGB（AE 对非 RGB 的 PSD 支持很差，先转掉更安全）");
            } catch (e3) {
                R.errors.push("转 RGB 失败：" + e3 + "（请手动 图像 > 模式 > RGB 颜色）");
            }
        } else {
            R.preflight.push("⚠ 颜色模式是 " + modeName + "：AE 对这类 PSD 支持很差，" +
                             "建议手动转成 RGB（或把 OPTIONS.convertToRGB 改成 true）。");
        }
    } else {
        R.preflight.push("颜色模式：" + modeName + "，AE 可以直接导入。");
    }

    if (bits == 32) {
        R.preflight.push("位深 32 位/通道：AE 能导入，但文件很大、保存更慢，注意性能。");
    }

    // --- 尺寸 vs AE 合成上限 ---
    var MAXAE = 30000;
    if (w !== null && h !== null && (w > MAXAE || h > MAXAE)) {
        R.preflight.push("⚠ 文档尺寸 " + w + " × " + h + " 超过 AE 合成/图层的上限 " + MAXAE +
                         " px，导入后会被裁切。建议先在 PS 里缩小或裁切。");
    }

    // --- 图层复合 ---
    try {
        var lc = doc.layerComps.length;
        if (lc > 0) {
            R.preflight.push("文档里有 " + lc + " 个图层复合(Layer Comp)：AE 按「当前可见状态」导入，" +
                             "保存前请确认选中的是你要的那个复合。");
        }
    } catch (e4) {}
}

/* ==========================================================================
 * 2. 只读扫描（结构 + 样式 + 风险点 + 可见性快照）
 * ========================================================================== */
function scanDocument(doc) {
    IDX.dirty = true;
    indexRefresh(doc);
    walkScan(doc, 0, "", -1);
}

function walkScan(container, depth, pathPrefix, parentId) {
    if (depth > 40) return;
    if (depth > SCAN.maxDepth) SCAN.maxDepth = depth;

    var arr = container.layers;            // 缓存一次：ExtendScript 里 .layers 每次访问都会重建
    var n = arr.length;

    for (var i = 0; i < n; i++) {
        var layer = arr[i];
        var id = getIdOf(layer);
        var name = "?";
        try { name = layer.name; } catch (e) {}
        var isGroup = false;
        try { isGroup = (layer.typename == "LayerSet"); } catch (e2) {}
        var visible = safeVisible(layer);
        var path = pathPrefix ? (pathPrefix + " / " + name) : name;

        // 读一次图层描述符：样式 / 锁定 / 各种 AE 表达不了的属性
        var desc = getLayerDescriptorById(id);
        var keySet = {};
        try { collectKeyNames(desc, keySet, 3); } catch (e3) {}

        var hasFX = !!(keySet["Lefx"] || keySet["layerEffects"] || keySet["class:layerEffects"]);
        var locked = readLockState(layer, keySet, desc);

        SCAN.layerCount++;
        if (SCAN.layerCount % 25 === 0) plog("扫描中… 已读 " + SCAN.layerCount + " 个图层（当前：" + path + "）");
        if (isGroup) SCAN.groupCount++;
        if (!visible) SCAN.hiddenCount++;
        if (locked.any) SCAN.lockedCount++;
        SCAN.vis[id] = visible;
        SCAN.meta[id] = {
            id: id, name: name, group: isGroup, depth: depth, path: path,
            parent: parentId, visible: visible, locked: locked, hasFX: hasFX,
            isBackground: isBackground(layer)
        };
        if (hasFX) SCAN.fxIds.push(id);

        if (isGroup) {
            var kids = null;
            try { kids = layer.layers; } catch (e4) { kids = null; }
            if (kids && kids.length === 0) SCAN.emptyGroupCount++;
        }

        // 风险检测（只读）
        try { inspectRisk(layer, id, isGroup, path, keySet, desc); } catch (e5) {}

        // 递归进组
        if (isGroup) walkScan(layer, depth + 1, path, id);
    }

    // 本层的剪贴蒙版基底检查
    try { checkClipBases(arr, pathPrefix); } catch (e6) {}
}

function inspectRisk(layer, id, isGroup, path, keySet, desc) {
    // 填充不透明度：AE 没有对应项
    if (keySet["fillOpacity"]) {
        var fo = readFillOpacity(layer, desc);
        if (fo !== null && fo < 99.99) R.risks.fillOpacity.push({ path: path, v: fo });
    }

    // 高级混合：混合剪贴图层 / 混合内部效果
    if (truthyDeep(desc, "blendClipped") || truthyDeep(desc, "blendInterior")) {
        R.risks.advancedBlend.push(path);
    }

    // 挖空
    if (keySet["knockout"]) {
        var ko = readValueDeep(desc, "knockout", 3);
        var kov = (ko.found && ko.value !== null) ? ("" + ko.value) : "";
        if (kov && kov.toLowerCase().indexOf("none") < 0) R.risks.knockout.push({ path: path, v: kov });
    }

    // 透明形状图层
    if (truthyDeep(desc, "transparencyShapesLayer")) R.risks.transparencyShapes.push(path);

    // 蒙版隐藏效果（图层蒙版 / 矢量蒙版）
    if (truthyDeep(desc, "layerMaskAsGlobalMask")) R.risks.maskHidesFx.push(path + "（图层蒙版隐藏效果）");
    if (truthyDeep(desc, "vectorMaskAsGlobalMask")) R.risks.maskHidesFx.push(path + "（矢量蒙版隐藏效果）");

    // 通道限制（关掉了某个通道）
    // 注意：这个字段几乎每个图层的描述符里都有（默认值），只能看值里有没有真的 false
    if (keySet["channelRestrictions"] && hasFalseBoolDeep(desc, "channelRestrictions")) {
        R.risks.channelLock.push(path);
    }

    // 颜色查找调整层：AE 没有对应调整层
    if (keySet["colorLookup"] || keySet["class:colorLookup"]) R.risks.colorLookup.push(path);

    // 被禁用的蒙版（AE 里蒙版是生效的）
    if (keySet["userMaskEnabled"]) {
        var um = readValueDeep(desc, "userMaskEnabled", 3);
        if (um.found && um.value === false) R.risks.disabledMask.push(path);
    }
    if (keySet["vectorMaskEnabled"]) {
        var vm = readValueDeep(desc, "vectorMaskEnabled", 3);
        if (vm.found && vm.value === false) R.risks.disabledMask.push(path + "（矢量蒙版被禁用）");
    }

    // 溶解(Dissolve)：PS 独有
    var bm = blendModeString(layer);
    if (bm && bm.toUpperCase().indexOf("DISSOLVE") >= 0) R.risks.dissolve.push(path);

    // 调整层
    if (keySet["adjustment"] || keySet["Adjs"] || keySet["class:adjustment"]) R.risks.adjustment++;

    // 文字层
    if (isTextLayer(layer, keySet)) {
        R.risks.text++;
        if (hasRealWarp(desc, keySet)) R.risks.warpText++;
        var f = checkFont(layer);
        if (f) R.risks.missingFont.push({ path: path, font: f });
    }

    // 智能对象 / 形状填充层 / 视频 3D 层：AE 按当前分辨率栅格化，观感一致，只统计
    if (isSmartObjectLayer(layer, keySet)) R.risks.smartObject++;
    if (isShapeOrFillLayer(layer, keySet)) R.risks.shapeOrFill++;
    if (isVideoOr3DLayer(layer, keySet)) R.risks.videoOr3D++;

    // 带图层蒙版 / 矢量蒙版、用了智能滤镜的图层（统计出来，是否烘焙由开关决定）
    if (keySet["userMaskEnabled"] || keySet["userMask"] || keySet["vectorMaskEnabled"] || keySet["vmsk"]) {
        R.risks.masked.push(path);
    }
    if (keySet["filterFX"] || keySet["filterFXList"] || keySet["class:FilterFX"]) {
        R.risks.smartFilter.push(path);
    }

    // 这两类绝对不能单独烘焙（用"下面建空层+合并"会改坏画面），先拦下来并记进报告
    var refuseWhy = bakeRefusal(layer, keySet, desc);
    if (refuseWhy && id >= 0) {
        if (refuseWhy === "adjust") R.risks.skipAdjust.push(path);
        else R.risks.skipClipped.push(path);
    }

    // 需要烘焙的图层（三类开关各自负责自己那类原因）
    var bakeWhy = refuseWhy ? null : bakeReason(layer, isGroup, keySet, desc, bm);
    if (id >= 0 && bakeWhy) SCAN.bakeQueue.push({ id: id, why: bakeWhy });
}

// 剪贴蒙版：基底（同级中该 clip 链下方第一个非 clip 图层）被隐藏
function checkClipBases(arr, pathPrefix) {
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
        var lyr = arr[i];
        if (!isGrouped(lyr)) continue;
        if (!safeVisible(lyr)) continue;                // 自己都关着，不用管

        var base = null;
        for (var j = i + 1; j < arr.length; j++) {
            if (!isGrouped(arr[j])) { base = arr[j]; break; }
        }
        if (!base) continue;
        if (safeVisible(base)) continue;                // 基底是显示的，没问题

        var name = "?", baseName = "?";
        try { name = lyr.name; } catch (e) {}
        try { baseName = base.name; } catch (e2) {}
        var item = {
            path: (pathPrefix ? pathPrefix + " / " : "") + name,
            base: baseName, id: getIdOf(lyr), baseId: getIdOf(base)
        };
        SCAN.clipHiddenBase.push(item);
        R.risks.clipHiddenBase.push(item);
    }
}

/* ==========================================================================
 * 3. 图层样式 → 真实图层（按需解锁）
 * ========================================================================== */
function splitAllLayerStyles(doc) {
    var evt = sid("createLayersFromLayerFX");
    if (evt === false) {
        R.notes.push("⚠ 当前 Photoshop 找不到「创建图层」(createLayersFromLayerFX) 命令，" +
                     "已跳过样式拆分。请手动执行 图层 > 图层样式 > 创建图层。");
        return;
    }
    if (SCAN.fxIds.length === 0) return;

    var tried = 0, consecutiveFail = 0;
    for (var i = 0; i < SCAN.fxIds.length; i++) {
        var id = SCAN.fxIds[i];
        var meta = SCAN.meta[id];
        if (!meta) continue;

        var layer = byId(doc, id);
        if (!layer) continue;                   // 已经不存在了（例如已被烘焙），跳过
        if (!hasLayerFXById(id)) continue;       // 已经没有样式了，跳过

        var okBefore = R.split.length;
        tried++;

        splitOneLayerStyle(doc, layer, meta, evt);

        if (R.split.length > okBefore) {
            consecutiveFail = 0;
        } else {
            consecutiveFail++;
            // 命令根本用不了时，不要傻试 27 次（每次都要回滚，很慢）
            if (R.split.length === 0 && consecutiveFail >= 3) {
                R.notes.push("「创建图层」命令连续失败 " + consecutiveFail + " 次，判断它在当前 PS 里" +
                             "用脚本调不了，已跳过剩余图层（省时间）。请手动拆分，或把 " +
                             "OPTIONS.bakeWhenSplitFails 改成 true 让它自动烘焙成像素。");
                break;
            }
        }
    }
}

function splitOneLayerStyle(doc, layer, meta, evt) {
    var id = meta.id;
    var visBefore = safeVisible(layer);

    // ---- 按需解锁：它自己 + 挡住它的上级组 ----
    unlockChainForEdit(doc, id, meta);

    // 解锁之后再记历史点：万一拆分失败需要回滚，只回滚这次尝试，解锁结果保留
    var histBefore = safeHistoryState(doc);

    // ---- 选中它 ----
    if (!selectLayerById(id)) {
        rollbackStep(doc, histBefore, layersBefore);
        restoreVisibleIfChanged(doc, id, visBefore);
        R.splitFailed.push({ path: meta.path, err: "无法选中该图层" });
        return;
    }

    // ---- 执行官方「创建图层」----
    var layersBefore = countLayersDom(doc);
    var ok = false, err = "";
    try {
        var d = new ActionDescriptor();
        var r = new ActionReference();
        r.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        d.putReference(charIDToTypeID("null"), r);
        executeAction(evt, d, DialogModes.NO);
        ok = true;
    } catch (e3) {
        ok = false;
        err = "" + e3;
    }
    markDirty();

    // ---- 校验：样式必须已经从该图层上消失 ----
    var stillHasFX = true;
    if (ok) {
        var lyr2 = byId(doc, id);
        stillHasFX = lyr2 ? hasLayerFXById(id) : false;
    }

    if (ok && !stillHasFX) {
        R.split.push({ path: meta.path, group: meta.group });
    } else {
        // 失败：只有文档真的被改动了才回滚（回滚很慢，能省就省）
        rollbackStep(doc, histBefore, layersBefore);
        R.splitFailed.push({
            path: meta.path,
            err: cleanMsg(err) || "命令执行后样式仍在（图层组的样式 PS 可能不允许拆分）"
        });
        if (OPTIONS.bakeWhenSplitFails) {
            var m2 = SCAN.meta[id];
            if (m2) bakeOneLayer(doc, m2, "样式拆分失败，改用合并烘焙");
        }
    }

    restoreVisibleIfChanged(doc, id, visBefore);
}

/* ==========================================================================
 * 4. 按需解锁（只动"马上要被改动"的那个图层 / 挡住它的组）
 * ========================================================================== */
function unlockChainForEdit(doc, id, meta) {
    if (!OPTIONS.lazyUnlock) return;

    var chain = [id];
    var p = meta ? meta.parent : -1;
    var guard = 0;
    while (p !== null && p !== undefined && p >= 0 && guard++ < 40) {
        chain.push(p);
        var pm = SCAN.meta[p];
        p = pm ? pm.parent : -1;
    }

    // 从最外层往里解锁（外层锁着的话，里面也改不动）
    for (var i = chain.length - 1; i >= 0; i--) {
        var cid = chain[i];
        var lyr = byId(doc, cid);
        if (!lyr) continue;
        var lm = SCAN.meta[cid];
        unlockIfLocked(doc, lyr, cid, lm ? lm.path : ("" + cid));
    }
}

function unlockIfLocked(doc, layer, id, path) {
    if (isBackground(layer)) return;                 // 背景层的锁解不掉，也不需要

    var st = readLockState(layer, null, null);
    var lm = SCAN.meta[id];
    if ((!st || !st.any) && lm && lm.locked && lm.locked.any) st = lm.locked;   // DOM 读不到就用扫描结果
    if (!st || !st.any) return;

    var was = describeLock(st);
    var visBefore = safeVisible(layer);

    // 方式一：ActionManager 精确改锁定属性（不碰可见性、不影响子图层）
    var done = amUnlock(id);

    // 校验：没解开就退到老办法（DOM）。它可能连带改可见性，所以前后都要校验。
    var st2 = readLockState(layer, null, null);
    if (st2 && st2.any) {
        try {
            layer.allLocked = false;
            done = true;
        } catch (e) {
            done = false;
        }
        var st3 = readLockState(layer, null, null);
        if (st3 && st3.any) done = false;          // 还是锁着（例如背景层）
    } else {
        done = true;
    }

    if (done) R.unlocked.push({ path: path, was: was });

    restoreVisibleIfChanged(doc, id, visBefore);
}

// ActionManager 精确解锁：只改这个图层自己的锁定标志
function amUnlock(id) {
    var lockKey = sid("layerLocking");
    if (lockKey === false) return false;

    var flags = ["protectAll", "protectTransparency", "protectComposite", "protectPosition"];
    try {
        var desc = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), id);
        desc.putReference(charIDToTypeID("null"), ref);

        var lockDesc = new ActionDescriptor();
        var any = false;
        for (var i = 0; i < flags.length; i++) {
            var k = sid(flags[i]);
            if (k !== false) { lockDesc.putBoolean(k, false); any = true; }
        }
        if (!any) return false;

        desc.putObject(charIDToTypeID("T   "), lockKey, lockDesc);
        executeAction(charIDToTypeID("setd"), desc, DialogModes.NO);
        return true;
    } catch (e) {
        // 退一步：试试 applyLocking 事件
        try {
            var noneKey = sid("protectNone");
            if (noneKey === false) return false;
            var d2 = new ActionDescriptor();
            var r2 = new ActionReference();
            r2.putIdentifier(charIDToTypeID("Lyr "), id);
            d2.putReference(charIDToTypeID("null"), r2);
            var l2 = new ActionDescriptor();
            l2.putBoolean(noneKey, true);
            d2.putObject(lockKey, lockKey, l2);
            executeAction(sid("applyLocking"), d2, DialogModes.NO);
            return true;
        } catch (e2) {
            return false;
        }
    }
}

function readLockState(layer, keySet, desc) {
    var st = { all: false, pixels: false, position: false, transparency: false, any: false };
    try { st.all = layer.allLocked ? true : false; } catch (e) {}
    try { st.pixels = layer.pixelsLocked ? true : false; } catch (e2) {}
    try { st.position = layer.positionLocked ? true : false; } catch (e3) {}
    try { st.transparency = layer.transparentPixelsLocked ? true : false; } catch (e4) {}

    // DOM 读不到的（例如图层组上的某些锁），用描述符里的 layerLocking 兜底
    if (!st.any && desc && keySet && keySet["layerLocking"]) {
        var r1 = readValueDeep(desc, "protectAll", 2);
        if (r1.found && r1.value === true) st.all = true;
        var r2 = readValueDeep(desc, "protectPosition", 2);
        if (r2.found && r2.value === true) st.position = true;
        var r3 = readValueDeep(desc, "protectComposite", 2);
        if (r3.found && r3.value === true) st.pixels = true;
        var r4 = readValueDeep(desc, "protectTransparency", 2);
        if (r4.found && r4.value === true) st.transparency = true;
    }

    st.any = !!(st.all || st.pixels || st.position || st.transparency);
    return st;
}

function describeLock(st) {
    var parts = [];
    if (st.all) parts.push("锁定全部");
    if (st.pixels) parts.push("锁定图像像素");
    if (st.position) parts.push("锁定位置");
    if (st.transparency) parts.push("锁定透明像素");
    return parts.length ? parts.join(" + ") : "锁定";
}

/* ==========================================================================
 * 5. 拆分失败时的"合并烘焙"（可选）
 * ========================================================================== */
function bakeLayers(doc, queue) {
    // 记下这一步烤掉了几个带样式的图层（报告归因用）
    var fxBefore = countFxLost(doc);
    var limit = OPTIONS.bakeChunkSize || 0;
    var done = 0;
    for (var i = 0; i < queue.length; i++) {
        if (limit > 0 && done >= limit) {
            var left = queue.length - done;
            R.notes.push("OPTIONS.bakeChunkSize = " + limit + "：本轮只烘焙了 " + done +
                         " 个，还剩 " + left + " 个 —— 再点一次脚本就会继续做剩下的。");
            plog("分块烘焙：本轮 " + done + " 个，剩余 " + left + " 个下次继续");
            break;
        }
        var meta = SCAN.meta[queue[i].id];
        if (!meta) continue;
        bakeOneLayer(doc, meta, queue[i].why);
        done++;
        if (OPTIONS.purgeCachesAtEnd && (OPTIONS.bakePurgeEvery || 0) > 0 &&
            done % OPTIONS.bakePurgeEvery === 0) {
            try { app.purge(PurgeTarget.ALLCACHES); plog("（已清理缓存，累计烘焙 " + done + " 个）"); } catch (eP2) {}
        }
    }
    R.fxBakedByBake = countFxLost(doc) - fxBefore;
}

function bakeOneLayer(doc, meta, why) {
    plog("烘焙：" + meta.path + "（原因：" + why + "）");
    var layer = byId(doc, meta.id);
    if (!layer) return false;

    // 隐藏的图层不动（免得因为烘焙反而把它"点亮"）
    if (!safeVisible(layer)) {
        R.notes.push("跳过烘焙（图层是隐藏的）：" + meta.path);
        return false;
    }

    // 说明：智能对象/智能滤镜一律走下面的「下面建空层 + 向下合并」
    // （= 选择层空对象合并.jsx 的做法）。实测「栅格化」这条更重的路会把 PS 搞崩，
    // 而合并法对嵌套 PSD 的智能对象内存友好得多。
    var isGroup = meta.group;
    var name = meta.name;
    var mode = null;
    try { mode = layer.blendMode; } catch (e) {}
    var visBefore = safeVisible(layer);
    unlockChainForEdit(doc, meta.id, meta);

    // 解锁之后再记历史点（回滚时保留解锁结果）
    var histBefore = safeHistoryState(doc);
    var layersBefore = countLayersDom(doc);

    var ok = false;
    try {
        if (isGroup) {
            if (!selectLayerById(meta.id)) throw new Error("无法选中图层组");
            var merged = layer.merge();                 // 合并组：压成一层，样式一并烘焙
            if (merged) {
                try { merged.name = name; } catch (e3) {}
                if (mode !== null) { try { merged.blendMode = mode; } catch (e4) {} }
                ok = true;
            }
        } else {
            if (!selectLayerById(meta.id)) throw new Error("无法选中图层");
            // 在它下方建一个同名空图层，然后把它向下合并进去（PS 官方示例脚本用的办法）
            if (!makeLayerBelow(name)) throw new Error("创建下方空图层失败");
            markDirty();
            if (!selectLayerById(meta.id)) throw new Error("合并前无法重新选中图层");
            if (!mergeDown()) throw new Error("合并失败");
            var res = doc.activeLayer;
            try { res.name = name; } catch (e5) {}
            if (mode !== null) { try { res.blendMode = mode; } catch (e6) {} }
            ok = true;
        }
    } catch (e7) {
        ok = false;
    }
    markDirty();

    if (ok) {
        R.baked.push({ path: meta.path, why: why || "", group: isGroup });
    } else {
        // 只有真的改动了才回滚
        rollbackStep(doc, histBefore, layersBefore);
        R.errors.push("烘焙失败（已回滚该步）：" + meta.path);
    }
    restoreVisibleIfChanged(doc, meta.id, visBefore);
    return ok;
}

function makeLayerBelow(name) {
    var belowKey = sid("below");
    if (belowKey === false) return false;
    try {
        var d = new ActionDescriptor();
        var r = new ActionReference();
        r.putClass(charIDToTypeID("Lyr "));
        d.putReference(charIDToTypeID("null"), r);
        d.putBoolean(belowKey, true);
        var u = new ActionDescriptor();
        u.putString(charIDToTypeID("Nm  "), name);
        d.putObject(charIDToTypeID("Usng"), charIDToTypeID("Lyr "), u);
        executeAction(charIDToTypeID("Mk  "), d, DialogModes.NO);
        return true;
    } catch (e) {
        return false;
    }
}

function mergeDown() {
    try {
        executeAction(charIDToTypeID("Mrg2"), new ActionDescriptor(), DialogModes.NO);
        return true;
    } catch (e) {
        return false;
    }
}

/* ==========================================================================
 * 5b. 剪贴蒙版(clipping mask)整理
 *
 *   · 基底是「文件夹」的剪贴蒙版（例：杂色 拷贝 12 盖在「3 拷贝」文件夹上）：
 *     AE 会直接无视这个图层 → 把剪贴图层复制到该文件夹里每个叶子图层上，
 *     设为剪切蒙版后合并进叶子（子文件夹递归进去，只和叶子合并），
 *     最后删掉原来那个跨文件夹的剪贴图层。
 *   · 基底是「普通图层」的剪贴链：自下而上把剪贴图层合并进基底图层。
 *   · 链里只要有一个隐藏图层就整条跳过（AE 本来就看不见，不值得动）。
 * ========================================================================== */
function bakeClippingMasks(doc) {
    if (!OPTIONS.bakeClippingMasks) return;
    var t0 = new Date().getTime();

    // 先把所有剪贴链快照下来；按嵌套深度从深到浅处理，避免嵌套时互相干扰
    var folderChains = [], artChains = [];
    collectClipChains(doc, folderChains, artChains);
    plog("剪贴整理：跨文件夹链 " + folderChains.length + " 条，普通链 " + artChains.length + " 条" +
         "（模式：clipOverFolder=" + OPTIONS.clipOverFolder + ", bakeClipChains=" + OPTIONS.bakeClipChains + "）");
    folderChains.sort(byDepthDesc);
    artChains.sort(byDepthDesc);

    // --- 1) 先把「基底是普通图层」的剪贴链拍平 ---
    //     必须先做这一步：文件夹里的叶子图层自己可能也是剪贴蒙版，
    //     拍平之后再把这些叶子当成普通图层来承接跨文件夹的剪贴图层，
    //     复制出来的副本才能正好按叶子自己的形状剪贴。
    if (OPTIONS.bakeClipChains) {
        for (var k = 0; k < artChains.length; k++) {
            try { processArtClipChain(doc, artChains[k]); }
            catch (e2) { R.clip.failed.push("剪贴链「" + chainNameOf(artChains[k]) + "」：" + cleanMsg("" + e2)); }
        }
    } else {
        // 不处理也要列出来，否则报告会显示成"0 条"，会误导
        for (var k2 = 0; k2 < artChains.length; k2++) {
            R.clip.bakedChains.push({
                path: artChains[k2].path, name: chainNameOf(artChains[k2]),
                base: artChains[k2].baseName, count: 0, failed: 0, reportedOnly: true
            });
        }
    }

    // --- 2) 再处理「基底是文件夹」的链：复制到叶子图层并烘焙 ---
    if (OPTIONS.clipOverFolder === "report") {
        if (folderChains.length > 0) {
            R.notes.push("OPTIONS.clipOverFolder = \"report\"：跨文件夹的剪贴蒙版只报告未处理（共 " +
                         folderChains.length + " 个）。");
        }
        for (var i = 0; i < folderChains.length; i++) {
            R.clip.folderChains.push({
                path: folderChains[i].path, name: chainNameOf(folderChains[i]),
                base: folderChains[i].baseName, leaves: 0, baked: 0, failed: 0,
                removed: 0, chainLen: folderChains[i].clipIds.length, reportedOnly: true
            });
        }
    } else {
        for (var j = 0; j < folderChains.length; j++) {
            try { processFolderClipChain(doc, folderChains[j]); }
            catch (e1) { R.clip.failed.push("跨文件夹剪贴链「" + chainNameOf(folderChains[j]) + "」：" + cleanMsg("" + e1)); }
        }
    }

    R.clip.elapsed = Math.round((new Date().getTime() - t0) / 100) / 10;
}

// 整理前带样式、现在样式没了（被合并进像素）的图层数
function countFxLost(doc) {
    var n = 0;
    for (var i = 0; i < SCAN.fxIds.length; i++) {
        try { if (!byId(doc, SCAN.fxIds[i]) || !hasLayerFXById(SCAN.fxIds[i])) n++; } catch (e) {}
    }
    return n;
}

function byDepthDesc(a, b) { return (b.depth || 0) - (a.depth || 0); }

function chainNameOf(rec) {
    var s = "";
    for (var i = 0; i < rec.clipIds.length; i++) {
        var m = SCAN.meta[rec.clipIds[i]];
        var nm2 = m ? m.name : ("#" + rec.clipIds[i]);
        s += (s ? " + " : "") + nm2;
    }
    return s;
}

// 把每一层的图层列表都扫一遍，收集剪贴链
function collectClipChains(doc, folderChains, artChains) {
    forEachLevel(doc, "", 0, function (arr, pathPrefix, depth) {
        var i = 0;
        while (i < arr.length) {
            if (!isGrouped(arr[i])) { i++; continue; }

            var clipIds = [];
            var k = i;
            while (k < arr.length && isGrouped(arr[k])) { clipIds.push(getIdOf(arr[k])); k++; }

            if (k < arr.length) {                       // 链下方必须还有一个基底图层
                var base = arr[k];
                var rec = {
                    clipIds: clipIds,
                    baseId: getIdOf(base),
                    baseName: safeLayerName(base),
                    path: pathPrefix,
                    depth: depth
                };
                if (isLayerSet(base)) folderChains.push(rec);
                else artChains.push(rec);
            }
            i = k + 1;
        }
        return true;
    });
}

// 遍历所有层级的图层列表（含各级图层组）
function forEachLevel(container, pathPrefix, depth, cb) {
    if (depth > 40) return false;
    var arr = container.layers;
    if (cb(arr, pathPrefix, depth) === false) return false;
    for (var i = 0; i < arr.length; i++) {
        var l = arr[i];
        if (!isLayerSet(l)) continue;
        var nm2 = safeLayerName(l);
        var p = pathPrefix ? (pathPrefix + " / " + nm2) : nm2;
        if (forEachLevel(l, p, depth + 1, cb) === false) return false;
    }
    return true;
}

function isLayerSet(layer) {
    try { return (layer.typename == "LayerSet"); } catch (e) { return false; }
}

function safeLayerName(layer) {
    try { return layer.name; } catch (e) { return "?"; }
}

// 递归收集文件夹里的叶子图层（子文件夹继续往下，只收普通图层）
function collectLeafTargets(folder) {
    var out = { ids: [], folders: 0 };
    collectLeavesWalk(folder, out, 0);
    return out;
}

function collectLeavesWalk(folder, out, depth) {
    if (depth > 40) return;
    var arr = folder.layers;
    for (var i = 0; i < arr.length; i++) {
        var l = arr[i];
        if (isLayerSet(l)) {
            out.folders++;
            collectLeavesWalk(l, out, depth + 1);
        } else {
            out.ids.push(getIdOf(l));
        }
    }
}

// ---- 跨文件夹的剪贴链：复制到每个叶子图层上并烘焙 ----
function processFolderClipChain(doc, rec) {
    var base = byId(doc, rec.baseId);
    if (!base) return;

    var name = chainNameOf(rec);
    var leaves = collectLeafTargets(base);

    // 链里有隐藏图层 → 整条跳过（AE 本来就看不见）
    if (!safeVisible(base)) {
        R.clip.skipped.push("跨文件夹剪贴蒙版「" + name + "」→ 基底文件夹「" + rec.baseName + "」：基底是隐藏的，已跳过");
        return;
    }
    for (var h = 0; h < rec.clipIds.length; h++) {
        var cl = byId(doc, rec.clipIds[h]);
        if (cl && !safeVisible(cl)) {
            R.clip.skipped.push("跨文件夹剪贴蒙版「" + name + "」→ 基底文件夹「" + rec.baseName + "」：剪贴图层本身是隐藏的，已跳过");
            return;
        }
    }
    if (leaves.ids.length === 0) {
        R.clip.skipped.push("跨文件夹剪贴蒙版「" + name + "」→ 基底文件夹「" + rec.baseName + "」：文件夹里没有普通图层，已跳过");
        return;
    }

    var baked = 0, failed = 0;

    // 链里有多个剪贴图层时，从最靠近基底的开始（保证叠加顺序不变）
    for (var c = rec.clipIds.length - 1; c >= 0; c--) {
        var cmId = rec.clipIds[c];
        var cm = byId(doc, cmId);
        if (!cm) continue;

        unlockChainForEdit(doc, cmId, SCAN.meta[cmId]);
        var cmName = safeLayerName(cm);

        for (var l = 0; l < leaves.ids.length; l++) {
            cm = byId(doc, cmId);                  // 结构一直在变，每次重新取
            if (!cm) break;
            var leaf = byId(doc, leaves.ids[l]);
            if (!leaf) continue;
            plog("  复制并烘焙：" + cmName + " → " + safeLayerName(leaf) + "（" + (l + 1) + "/" + leaves.ids.length + "）");
            if (bakeOneClipCopy(doc, cm, leaf, cmName)) baked++;
            else failed++;
        }
    }

    // 原来的跨文件夹剪贴图层：内容已经烘焙进叶子了，删掉（不然 PS 里会重复叠一层）
    var removed = 0;
    if (OPTIONS.deleteFolderClipOriginal) {
        for (var r = 0; r < rec.clipIds.length; r++) {
            var lyr = byId(doc, rec.clipIds[r]);
            if (!lyr) continue;
            try { lyr.remove(); removed++; markDirty(); } catch (e2) {}
        }
    }

    R.clip.folderChains.push({
        path: rec.path, name: name, base: rec.baseName,
        leaves: leaves.ids.length, subFolders: leaves.folders,
        baked: baked, failed: failed, removed: removed, chainLen: rec.clipIds.length
    });
}

// 把一个剪贴图层复制到目标图层上方、设为剪切蒙版，然后合并进目标图层
function bakeOneClipCopy(doc, cm, leaf, cmName) {
    var leafId = getIdOf(leaf);
    var leafName = safeLayerName(leaf);
    var mode = null;
    try { mode = leaf.blendMode; } catch (e0) {}
    var visBefore = safeVisible(leaf);

    unlockChainForEdit(doc, leafId, SCAN.meta[leafId]);

    var histBefore = safeHistoryState(doc);
    var layersBefore = countLayersDom(doc);

    var ok = false, err = "";
    try {
        var copy = cm.duplicate(leaf, ElementPlacement.PLACEBEFORE);   // 复制到目标图层正上方
        markDirty();
        if (!copy) throw new Error("复制剪贴图层失败");

        try { copy.name = cmName + "→" + leafName; } catch (e2) {}
        try { copy.grouped = true; } catch (e3) {}                     // 设为剪切蒙版

        // 合并进目标图层（含"形状层不肯合并时先栅格化再合并"的兜底）
        var res = mergeInto(doc, getIdOf(copy), leafId, leafName);
        if (!res.ok) throw new Error(res.err || "合并失败");

        var merged = doc.activeLayer;
        try { merged.name = leafName; } catch (e4) {}                  // 保留原图层名字
        if (mode !== null) { try { merged.blendMode = mode; } catch (e5) {} }

        ok = true;
    } catch (e6) {
        err = cleanMsg("" + e6);
        rollbackStep(doc, histBefore, layersBefore);
    }

    if (!ok) R.clip.failed.push("「" + cmName + "」→「" + leafName + "」：" + (err || "失败"));

    markDirty();
    restoreVisibleIfChanged(doc, leafId, visBefore);
    return ok;
}

// 把 topId 那个图层合并进 bottomId；用"图层数有没有减少"来判断是否真的合并成功。
// PS 对"形状层/填充层/智能对象"有时会拒绝直接合并，这时先把目标层栅格化再合并。
function mergeInto(doc, topId, bottomId, label) {
    var before = countLayersDom(doc);

    // 方式一：向下合并
    if (selectLayerById(topId) && mergeDown()) {
        if (countLayersDom(doc) < before) return { ok: true, rasterized: false };
    }
    // 方式二：两个一起选中再合并（和 ps 粘贴图层蒙版合并.jsx 一样）
    if (selectLayerById(topId) && addLayerToSelection(bottomId) && mergeSelectedLayers()) {
        if (countLayersDom(doc) < before) return { ok: true, rasterized: false };
    }

    // 方式三：先把目标层栅格化成像素，再合并
    if (OPTIONS.rasterizeWhenMergeFails) {
        if (rasterizeLayer(doc, bottomId)) {
            if (selectLayerById(topId) && mergeDown()) {
                if (countLayersDom(doc) < before) {
                    R.clip.rasterized.push(label);
                    return { ok: true, rasterized: true };
                }
            }
            if (selectLayerById(topId) && addLayerToSelection(bottomId) && mergeSelectedLayers()) {
                if (countLayersDom(doc) < before) {
                    R.clip.rasterized.push(label);
                    return { ok: true, rasterized: true };
                }
            }
        }
    }

    return { ok: false, err: "PS 拒绝合并（目标层可能是形状/填充/智能对象层）" };
}

function rasterizeLayer(doc, id) {
    var lyr = byId(doc, id);
    if (!lyr) return false;
    if (isLayerSet(lyr)) return false;                 // 图层组不栅格化
    try {
        if (!selectLayerById(id)) return false;
        lyr.rasterize(RasterizeType.ENTIRELAYER);
        markDirty();
        return true;
    } catch (e) {
        return false;
    }
}

// ---- 普通剪贴链：自下而上合并进基底图层 ----
function processArtClipChain(doc, rec) {
    var base = byId(doc, rec.baseId);
    if (!base) return;

    var name = chainNameOf(rec);

    if (!safeVisible(base)) {
        R.clip.skipped.push("剪贴链「" + name + "」→ 基底「" + rec.baseName + "」：基底是隐藏的，已跳过");
        return;
    }
    for (var h = 0; h < rec.clipIds.length; h++) {
        var cl = byId(doc, rec.clipIds[h]);
        if (cl && !safeVisible(cl)) {
            R.clip.skipped.push("剪贴链「" + name + "」→ 基底「" + rec.baseName + "」：链里有隐藏图层，已跳过");
            return;
        }
    }

    unlockChainForEdit(doc, rec.baseId, SCAN.meta[rec.baseId]);

    var baked = 0, failed = 0;
    for (var c = rec.clipIds.length - 1; c >= 0; c--) {                // 从最靠近基底的开始
        var clipId = rec.clipIds[c];
        var clip = byId(doc, clipId);
        if (!clip) continue;

        unlockChainForEdit(doc, clipId, SCAN.meta[clipId]);

        var histBefore = safeHistoryState(doc);
        var layersBefore = countLayersDom(doc);
        var ok = false, err = "";

        try {
            var res = mergeInto(doc, clipId, rec.baseId, rec.baseName);
            if (!res.ok) throw new Error(res.err || "合并失败");
            ok = true;
        } catch (e1) {
            err = cleanMsg("" + e1);
            rollbackStep(doc, histBefore, layersBefore);
        }

        if (ok) baked++;
        else failed++;
        markDirty();
    }

    R.clip.bakedChains.push({ path: rec.path, name: name, base: rec.baseName, count: baked, failed: failed });
}

// 把图层加入当前选择（和 Adobe 官方脚本里的 addSelectedLayer 同款）
function addLayerToSelection(id) {
    try {
        var desc = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), id);
        desc.putReference(charIDToTypeID("null"), ref);
        desc.putEnumerated(stringIDToTypeID("selectionModifier"),
                           stringIDToTypeID("selectionModifierType"),
                           stringIDToTypeID("addToSelection"));
        desc.putBoolean(charIDToTypeID("MkVs"), false);
        executeAction(charIDToTypeID("slct"), desc, DialogModes.NO);
        return true;
    } catch (e) {
        return false;
    }
}

// 合并当前选中的多个图层
function mergeSelectedLayers() {
    try {
        var lyr = app.activeDocument.activeLayer;
        if (lyr) { lyr.merge(); return true; }
    } catch (e) {}
    return mergeDown();                    // 退一步：向下合并
}

/* ==========================================================================
 * 6. 剪贴蒙版：基底被隐藏（默认只报告）
 * ========================================================================== */
function syncClipHiddenBase(doc) {
    for (var i = 0; i < SCAN.clipHiddenBase.length; i++) {
        var item = SCAN.clipHiddenBase[i];
        var lyr = byId(doc, item.id);
        var base = byId(doc, item.baseId);
        if (!lyr || !base) continue;
        if (!safeVisible(lyr) || safeVisible(base)) continue;   // 状态已经变了，不重复处理

        try {
            lyr.visible = false;                 // 只关它自己这一个开关
            R.syncClip.push({ path: item.path, base: item.base });
            SCAN.vis[item.id] = false;           // 更新基线，免得收尾校验又给还原回去
        } catch (e) {
            R.errors.push("关闭剪贴蒙版图层失败：" + item.path);
        }
    }
}

/* ==========================================================================
 * 7. 可见性校验（"不碰别人的开关"的兜底）
 * ========================================================================== */
function verifyVisibility(doc) {
    if (!OPTIONS.verifyVisibility) return;

    var total = 0;
    var changed = [];
    walkAllLayers(doc, function (layer, id) {
        total++;
        if (SCAN.vis[id] === undefined) return;           // 本次新生成的图层，跳过
        var now = safeVisible(layer);
        if (now !== SCAN.vis[id]) {
            var nm = "?";
            try { nm = layer.name; } catch (e) {}
            changed.push({ id: id, path: nm, from: now, to: SCAN.vis[id] });
            if (OPTIONS.restoreVisibility) {
                try { layer.visible = SCAN.vis[id]; } catch (e2) {}
            }
        }
    });

    R.visChecked = { total: total, changed: changed, restored: !!OPTIONS.restoreVisibility };
}

function walkAllLayers(container, cb) {
    walkAllLayersDepth(container, cb, 0);
}

function walkAllLayersDepth(container, cb, depth) {
    if (depth > 40) return;
    var arr = container.layers;
    for (var i = 0; i < arr.length; i++) {
        var layer = arr[i];
        cb(layer, getIdOf(layer));
        var isGroup = false;
        try { isGroup = (layer.typename == "LayerSet"); } catch (e) {}
        if (isGroup) walkAllLayersDepth(layer, cb, depth + 1);
    }
}

// 某个图层自己的可见性被副作用改掉了 → 立刻还原（并记账）
function restoreVisibleIfChanged(doc, id, visBefore) {
    if (id === null || id === undefined || id < 0) return;
    var lyr = byId(doc, id);
    if (!lyr) return;
    var now = safeVisible(lyr);
    if (now === visBefore) return;

    R.visFixed.push({ path: (SCAN.meta[id] ? SCAN.meta[id].path : ("" + id)), from: now, to: visBefore });
    try { lyr.visible = visBefore; } catch (e) {}
}

/* ==========================================================================
 * 8. 另存 AE 副本（可选）
 * ========================================================================== */
function saveAECopy(doc) {
    try {
        var f = null;
        try { f = doc.fullName; } catch (e) { f = null; }
        if (!f) { R.notes.push("文档还从未保存过，跳过另存副本。"); return; }

        var base = baseName(doc.name);
        var ext = /\.psb$/i.test(doc.name) ? ".psb" : ".psd";
        var target = new File(f.parent.fsName + "/" + base + "_AE" + ext);

        var opts = new PhotoshopSaveOptions();
        try { opts.embedColorProfile = true; } catch (e1) {}
        try { opts.layers = true; } catch (e2) {}
        try { opts.alphaChannels = true; } catch (e3) {}
        try { opts.annotations = true; } catch (e4) {}

        doc.saveAs(target, opts, true);              // asCopy = true，原文件不动
        R.notes.push("已另存给 AE 的副本：" + target.fsName);
    } catch (e5) {
        R.errors.push("另存副本失败：" + e5);
    }
}

/* ==========================================================================
 * 9. 对比手段（两套并行）
 *    ① 往文档同目录写两张图片（整理前 / 整理后），同名覆盖
 *    ② 在图层最上面盖印两个图层（新 / 旧），配合「差值」直接在 PS 里看差异
 * ========================================================================== */

/* ---------- ① 文件夹里的两张对比图 ---------- */
function captureCompareImage(doc, phase) {
    if (!OPTIONS.saveCompareImages) return null;

    var label = (phase === "before") ? "整理前" : "整理后";
    try {
        var folder = null;
        try { folder = doc.path; } catch (e) { folder = null; }
        if (!folder) {
            if (!R.cmpNoteDone) {
                R.notes.push("文档还没有保存过，没法把对比图放到它的目录里，已跳过对比图。");
                R.cmpNoteDone = true;
            }
            return null;
        }

        var base = baseName(R.docName);
        var fmt = ("" + OPTIONS.compareImageFormat).toLowerCase();
        var ext = (fmt === "jpg" || fmt === "jpeg") ? ".jpg" : ".png";
        var file = new File(folder.fsName + "/" + base + "_" + label + ext);

        var out = writeCompareFile(doc, file, fmt);
        if (out) {
            if (phase === "before") R.cmpBeforeImage = out;
            else R.cmpAfterImage = out;
            return out;
        }
        R.errors.push("对比图（" + label + "）输出失败：" + file.fsName);
    } catch (e2) {
        R.errors.push("对比图（" + label + "）出错：" + e2);
    }
    return null;
}

// 用 saveAs(asCopy = true) 输出合并后的画面：不改文档、不改它的关联文件、不用新建文档
function writeCompareFile(doc, file, fmt) {
    removeIfExists(file);

    var ok = false;
    if (fmt === "jpg" || fmt === "jpeg") ok = trySaveJPEG(doc, file);
    else ok = trySavePNG(doc, file);
    if (ok) return file.fsName;

    // 兜底：TIFF（8/16/32 位、带透明都能存），保证任何位深都有图可比
    var tif = new File(file.fsName.replace(/\.[^\.]+$/, "") + ".tif");
    removeIfExists(tif);
    if (trySaveTIFF(doc, tif)) {
        R.notes.push("PNG/JPG 存不了当前位深（" + R.docInfo + "），对比图改用无损 TIFF：" + tif.fsName);
        return tif.fsName;
    }
    return null;
}

function removeIfExists(f) {
    try { if (f.exists) f.remove(); } catch (e) {}     // 同名直接覆盖，也不弹"是否替换"
}

function trySavePNG(doc, file) {
    try {
        var o = new PNGSaveOptions();
        try { o.compression = 6; } catch (e) {}
        try { o.interlaced = false; } catch (e2) {}
        doc.saveAs(file, o, true);                      // asCopy = true
        return true;
    } catch (e3) {
        return false;
    }
}

function trySaveJPEG(doc, file) {
    try {
        var o = new JPEGSaveOptions();
        try { o.quality = 12; } catch (e) {}
        try { o.embedColorProfile = true; } catch (e2) {}
        try { o.formatOptions = FormatOptions.STANDARDBASELINE; } catch (e3) {}
        doc.saveAs(file, o, true);
        return true;
    } catch (e4) {
        return false;
    }
}

function trySaveTIFF(doc, file) {
    try {
        var o = new TiffSaveOptions();
        try { o.imageCompression = TIFFEncoding.LZW; } catch (e) {}
        try { o.layers = false; } catch (e2) {}        // 只存合并后的画面
        try { o.alphaChannels = true; } catch (e3) {}
        try { o.embedColorProfile = true; } catch (e4) {}
        doc.saveAs(file, o, true);
        return true;
    } catch (e5) {
        return false;
    }
}

/* ---------- ② 图层上的两个对比图层 ---------- */
function captureCompareLayer(doc, phase) {
    if (!OPTIONS.saveCompareLayers) return null;

    var isBefore = (phase === "before");
    var name = isBefore ? "对比-旧(整理前)" : "对比-新(整理后)";

    var histBefore = safeHistoryState(doc);
    var layersBefore = countLayersDom(doc);
    var oldLayer = null;
    var hidOld = false;

    try {
        // ★ 盖印"新"之前必须先把"对比-旧"藏起来：否则旧画面也被一起盖进去，
        //   得到的就不是"整理后的画面"，而拿它做差值会变成"整理前 vs 整理后"，纯误导。
        if (!isBefore) {
            oldLayer = findTopLevelLayerByName(doc, "对比-旧(整理前)");
            if (oldLayer) {
                try { if (oldLayer.visible) { oldLayer.visible = false; hidOld = true; markDirty(); } } catch (eH) {}
            }
        }
        // 走「盖印可见图层」= Ctrl+Shift+Alt+E 的 AM 写法（mergeVisible + duplicate）：
        // 手工按这个热键是没问题的，所以这里跟它走同一条路（不是全选+拷贝合并+粘贴）。
        // 先选中"最上面的图层"，盖印出来的图层就会落在最顶层。
        var top0 = null;
        try { top0 = doc.layers[0]; } catch (eT) { top0 = null; }
        if (top0) { try { selectLayerById(getIdOf(top0)); } catch (eS) {} }
        if (!stampVisibleWithDuplicate()) throw new Error("盖印可见图层(mergeVisible+duplicate)失败");
        markDirty();

        var lyr = doc.activeLayer;
        var id = getIdOf(lyr);
        var top = null;
        try { top = doc.layers[0]; } catch (e2) { top = null; }
        if (top && getIdOf(top) !== id) {
            try { lyr.move(top, ElementPlacement.PLACEBEFORE); markDirty(); } catch (e3) {}
        }

        // ★ 校验：盖印层必须落在"文档最顶层"。如果活动图层原本是图层组，
        //   盖印会落在组里面 → 被组的混合模式/蒙版/剪贴再作用一次 → 差分图会出现淡淡的色差。
        try {
            var back2 = byId(doc, id);
            if (back2 && back2.parent !== doc) {
                if (top) {
                    try { back2.move(top, ElementPlacement.PLACEBEFORE); markDirty(); } catch (e4) {}
                }
                var back3 = byId(doc, id);
                if (back3 && back3.parent !== doc) {
                    R.notes.push("对比图层「" + name + "」没能移到文档最顶层（仍在图层组内），" +
                                 "差分对比可能因此出现淡淡色差。");
                } else {
                    R.notes.push("对比图层「" + name + "」原先落在图层组内，已移到最顶层。");
                }
            }
        } catch (e5) {}

        var made = byId(doc, id);
        if (made) {
            try { made.name = name; } catch (e4) {}
            // 可选：直接把"新"那层设成差值，一进文档就是差异图
            if (!isBefore && OPTIONS.compareDiffBlend) {
                try { made.blendMode = BlendMode.DIFFERENCE; } catch (e6) {}
            }
        }
        // 安全检查：盖印必须只是"多出一层"；如果变成合并（图层变少）就立刻回滚
        if (countLayersDom(doc) !== layersBefore + 1) {
            throw new Error("盖印后图层数是 " + countLayersDom(doc) + "，不是 " + (layersBefore + 1) +
                            "（说明可见图层被合并掉了，已回滚）");
        }

        // 把"对比-旧"的眼睛还原（不能让盖印改动它的显示状态）
        if (hidOld) {
            try { oldLayer.visible = true; markDirty(); } catch (eH2) {}
            hidOld = false;
        }

        if (isBefore) R.cmpBeforeLayer = name; else R.cmpAfterLayer = name;
        return name;
    } catch (e5) {
        if (hidOld) { try { oldLayer.visible = true; markDirty(); } catch (eH3) {} }
        R.errors.push("建立对比图层（" + (isBefore ? "旧" : "新") + "）失败：" + cleanMsg("" + e5));
        rollbackStep(doc, histBefore, layersBefore);
        return null;
    }
}

// 盖印可见图层（= Ctrl+Shift+Alt+E，PS 里手工按这个不崩；duplicate:true 表示"盖印"而不是"合并"）
function stampVisibleWithDuplicate() {
    var evt = sid("mergeVisible");
    if (evt === false) return false;
    try {
        var d = new ActionDescriptor();
        d.putBoolean(sid("duplicate"), true);
        executeAction(evt, d, DialogModes.NO);
        return true;
    } catch (e) {
        return false;
    }
}

// （备用，现在不用了）全选 + 拷贝合并
function copyMergedToClipboard() {
    var doc = app.activeDocument;
    try { doc.selection.selectAll(); } catch (e) {}
    var evt = sid("copyMerged");
    if (evt === false) return false;
    try {
        executeAction(evt, new ActionDescriptor(), DialogModes.NO);
        return true;
    } catch (e2) {
        return false;
    }
}

// 原位粘贴（和 ps 粘贴图层蒙版合并.jsx 里的做法一样）
function pasteInPlace() {
    var evt = sid("paste");
    if (evt === false) return false;
    try {
        var d = new ActionDescriptor();
        d.putBoolean(sid("inPlace"), true);
        executeAction(evt, d, DialogModes.NO);
        return true;
    } catch (e) {
        return false;
    }
}

/* ==========================================================================
 * 10. 报告
 * ========================================================================== */
function afterRun(doc) {
    var text = buildReport(doc, true).join("\r\n");
    var wrotePath = null;
    if (OPTIONS.writeReportFile) wrotePath = writeReportFile(doc, text);

    if (OPTIONS.showSummary) {
        var summary = buildReport(doc, false).join("\r\n");
        if (wrotePath) summary += "\r\n\r\n（完整报告已写到：" + wrotePath + "）";
        else if (OPTIONS.writeReportFile) summary += "\r\n\r\n（报告文件写入失败，以上为全部内容）";
        alert(summary);
    }
}

function buildReport(doc, forFile) {
    var L = [];
    var MAXITEMS = forFile ? 1000 : 6;
    var t = new Date();
    var stamp = t.getFullYear() + "-" + pad2(t.getMonth() + 1) + "-" + pad2(t.getDate()) + " " +
                pad2(t.getHours()) + ":" + pad2(t.getMinutes()) + ":" + pad2(t.getSeconds());

    L.push("======== PSD/PSB → AE 一键整理报告 ========");
    L.push("文件：" + R.docName + "（已整理，尚未保存；Ctrl+Z 可整体撤销）");
    L.push("时间：" + stamp + "　耗时约 " + R.elapsed + " 秒");
    L.push("Photoshop：" + (R.psVersion || "?") + "　脚本：ps 一键整理给AE");
    L.push("模式：" + (OPTIONS.separateHistorySteps ? "分阶段历史步骤（Ctrl+Z 按阶段撤销）" : "整体一步撤销") +
           "，失败回滚：" + (OPTIONS.historyRollback ? "开" : "关") +
           "，阶段：" + describeStages());
    L.push("本次会改动：" + describeModifications());
    L.push("文档：" + R.docInfo);
    L.push("图层：" + SCAN.layerCount + " 个（图层组 " + SCAN.groupCount + " 个，最大嵌套 " +
           SCAN.maxDepth + " 层，其中隐藏 " + SCAN.hiddenCount + " 个，锁定 " + SCAN.lockedCount + " 个）");

    // [1] 预检
    L.push("");
    L.push("【1】预检");
    if (R.preflight.length === 0) L.push("  · 无需处理。");
    for (var i = 0; i < R.preflight.length; i++) L.push("  · " + R.preflight[i]);

    // [2] 图层样式
    L.push("");
    L.push("【2】图层样式(fx)");
    if (SCAN.fxIds.length === 0) {
        L.push("  · 文档里没有图层样式。");
    } else if (!OPTIONS.splitLayerStyles) {
        L.push("  · 带图层样式的图层 " + SCAN.fxIds.length + " 个（已跳过拆分，样式原样保留）。");
        if (R.fxBakedByBake > 0 || R.fxBakedByClip > 0) {
            var whyTxt2 = [];
            if (R.fxBakedByBake > 0) whyTxt2.push("烘焙阶段 " + R.fxBakedByBake + " 个");
            if (R.fxBakedByClip > 0) whyTxt2.push("剪贴整理 " + R.fxBakedByClip + " 个");
            L.push("  · 其中 " + (R.fxBakedByBake + R.fxBakedByClip) +
                   " 个的样式被合并进像素了（" + whyTxt2.join("、") + "）。");
        }
        L.push("  · 为什么跳过：PS 的「图层 > 图层样式 > 创建图层」无法用脚本调用——");
        L.push("    实测 executeAction（三种引用写法）、DialogModes.ALL、runMenuItem（四种 ID）全部失败；");
        L.push("    它在菜单里执行时会弹提示框，属于纯交互式命令。");
        L.push("  · 给 AE 的两个办法：");
        L.push("     1) AE 导入时把「图层选项」选成「可编辑图层样式」，让 AE 自己把样式转成图层（样式仍可编辑）；");
        L.push("     2) 要 100% 保住观感：把 OPTIONS.bakeWhenSplitFails 改成 true，脚本会把样式烘焙进像素");
        L.push("        （观感一致，但样式不再可单独编辑）。");
        L.push("    注意：「图层组(文件夹)上的样式」AE 侧不一定支持，这类建议用办法 2。");
        L.push("    如果哪天 PS 修好了这条命令，把 OPTIONS.splitLayerStyles 改成 true 即可恢复自动拆分。");
    } else {
        L.push("  · 带图层样式的图层共 " + SCAN.fxIds.length + " 个：成功拆分 " + R.split.length +
               " 个，失败 " + R.splitFailed.length + " 个。");
        if (R.fxBakedByBake > 0 || R.fxBakedByClip > 0) {
            var whyTxt = [];
            if (R.fxBakedByBake > 0) whyTxt.push("烘焙阶段 " + R.fxBakedByBake + " 个");
            if (R.fxBakedByClip > 0) whyTxt.push("剪贴整理 " + R.fxBakedByClip + " 个");
            L.push("  · 其中 " + (R.fxBakedByBake + R.fxBakedByClip) +
                   " 个的样式被合并进像素了（" + whyTxt.join("、") + "）。");
        }
        if (R.split.length > 0) {
            L.push("  · 已拆分的那些：AE 会按普通图层导入，不再依赖「可编辑图层样式」选项。");
        }
        if (R.splitFailed.length > 0) {
            if (R.split.length === 0) {
                L.push("  · ⚠ 一个都没拆成功：当前 Photoshop 用脚本调不动「创建图层」命令。两个办法：");
                L.push("     1) AE 导入时把「图层选项」选成「可编辑图层样式」，让 AE 自己把样式转成图层；");
                L.push("     2) 把 OPTIONS.bakeWhenSplitFails 改成 true，让脚本把样式烘焙进像素" +
                       "（观感一致，但样式不再可单独编辑）。");
                L.push("  · 已实测确认：这个命令在 PS 27.8 里用脚本调不动" +
                       "（executeAction 三种引用写法 / DialogModes.ALL / runMenuItem 大小写变体，10 种全失败；");
                L.push("    它执行时会弹一个需要人工确认的提示框，所以只适合手工点菜单执行）。");
            }
            L.push("  · 拆分失败清单：");
            var fs = firstN(R.splitFailed, MAXITEMS);
            for (var j = 0; j < fs.length; j++) L.push("     - " + fs[j].path + "　原因：" + fs[j].err);
            var rlA = restLine(R.splitFailed, MAXITEMS);
            if (rlA) L.push(rlA);
        }
    }
    if (R.baked.length > 0) {
        L.push("  · 已烘焙（样式烤进像素）：" + R.baked.length + " 个");
        var bk = firstN(R.baked, MAXITEMS);
        for (var k = 0; k < bk.length; k++) {
            L.push("     - " + bk[k].path + "　原因：" + bk[k].why +
                   (bk[k].group ? "（整个文件夹被合并成了一层）" : ""));
        }
        var rlB = restLine(R.baked, MAXITEMS);
        if (rlB) L.push(rlB);
    }

    // [3] 剪贴蒙版整理
    L.push("");
    L.push("【3】剪贴蒙版(clipping mask)整理");
    if (!OPTIONS.bakeClippingMasks) {
        L.push("  · 已关闭该步骤（OPTIONS.bakeClippingMasks = false）。");
    } else {
        var clipR = R.clip;
        if (clipR.folderChains.length === 0) {
            L.push("  · 没有「基底是文件夹」的剪贴蒙版。");
        } else {
            L.push("  · 「基底是文件夹」的剪贴蒙版：" + clipR.folderChains.length + " 个" +
                   (OPTIONS.clipOverFolder === "report" ? "（只报告，未处理）"
                                                        : "：已复制到该文件夹的叶子图层并烘焙"));
            var fcList = firstN(clipR.folderChains, MAXITEMS);
            for (var f1 = 0; f1 < fcList.length; f1++) {
                var it = fcList[f1];
                var line1 = "     - " + it.name + " → 文件夹「" + it.base + "」";
                if (it.reportedOnly) {
                    line1 += "　（未处理）";
                } else {
                    line1 += "　叶子图层 " + it.leaves + " 个";
                    if (it.subFolders) line1 += "（含子文件夹 " + it.subFolders + " 个）";
                    line1 += "，烘焙成功 " + it.baked + " 个";
                    if (it.failed) line1 += "，失败 " + it.failed + " 个";
                    if (it.removed) line1 += "，已删掉原图层 " + it.removed + " 个";
                }
                L.push(line1);
            }
            var rlF = restLine(clipR.folderChains, MAXITEMS);
            if (rlF) L.push(rlF);
            if (OPTIONS.clipOverFolder !== "report" && OPTIONS.deleteFolderClipOriginal) {
                L.push("     ↑ 原来那个跨文件夹的剪贴图层已删除（内容已经烤进叶子图层；" +
                       "不想删就把 OPTIONS.deleteFolderClipOriginal 改成 false）");
            }
        }

        var totalClipBaked = 0;
        for (var b1 = 0; b1 < clipR.bakedChains.length; b1++) totalClipBaked += clipR.bakedChains[b1].count;
        L.push("  · 普通剪贴链：" + clipR.bakedChains.length + " 条" +
               (OPTIONS.bakeClipChains
                ? ("（共把 " + totalClipBaked + " 个剪贴图层合并进了各自基底）")
                : "（本档位只报告，未处理）"));
        var bcList = firstN(clipR.bakedChains, MAXITEMS);
        for (var b2 = 0; b2 < bcList.length; b2++) {
            L.push("     - " + bcList[b2].name + " → 基底「" + bcList[b2].base + "」" +
                   (bcList[b2].reportedOnly ? "　（未处理）" : ("（合并了 " + bcList[b2].count + " 个）")));
        }
        var rlBc = restLine(clipR.bakedChains, MAXITEMS);
        if (rlBc) L.push(rlBc);

        if (clipR.skipped.length > 0) {
            L.push("  · 跳过 " + clipR.skipped.length + " 条：");
            var skList = firstN(clipR.skipped, MAXITEMS);
            for (var s1 = 0; s1 < skList.length; s1++) L.push("     - " + skList[s1]);
            var rlS = restLine(clipR.skipped, MAXITEMS);
            if (rlS) L.push(rlS);
        }
        if (clipR.failed.length > 0) {
            L.push("  · 失败 " + clipR.failed.length + " 个：");
            var flList = firstN(clipR.failed, MAXITEMS);
            for (var f2 = 0; f2 < flList.length; f2++) L.push("     - " + flList[f2]);
            var rlFl = restLine(clipR.failed, MAXITEMS);
            if (rlFl) L.push(rlFl);
        }
        if (clipR.rasterized.length > 0) {
            L.push("  · PS 不肯直接合并，先栅格化成像素的图层：" + clipR.rasterized.length + " 个" +
                   "（形状层/填充层/智能对象，栅格化后形状不可再编辑，但剪贴效果烤进去了）");
            var rzList = firstN(clipR.rasterized, MAXITEMS);
            for (var rz1 = 0; rz1 < rzList.length; rz1++) L.push("     - " + rzList[rz1]);
            var rlRz = restLine(clipR.rasterized, MAXITEMS);
            if (rlRz) L.push(rlRz);
        }
        // 只有真的烤过东西，才说那句"已经烤进图层了"
        var didClipWork = false;
        for (var dk = 0; dk < clipR.folderChains.length; dk++) {
            if (clipR.folderChains[dk].baked > 0) didClipWork = true;
        }
        for (var dk2 = 0; dk2 < clipR.bakedChains.length; dk2++) {
            if (clipR.bakedChains[dk2].count > 0) didClipWork = true;
        }
        if (didClipWork) {
            L.push("  · 提示：这一步把剪贴效果烤进图层了（观感一致，但剪贴关系不能再单独调）；" +
                   "两张对比图叠起来看「差值」就能立刻确认有没有烤坏。");
        } else if (clipR.folderChains.length > 0 || clipR.bakedChains.length > 0) {
            L.push("  · 本档位只报告、没有改动任何剪贴关系。要真正处理：");
            L.push("    OPTIONS.clipOverFolder 改成 \"auto\"（跨文件夹的复制到叶子图层并烘焙）");
            L.push("    OPTIONS.bakeClipChains 改成 true（普通剪贴链合并进基底）");
        }
        if (clipR.elapsed) L.push("  · 本步骤耗时约 " + clipR.elapsed + " 秒。");
    }

    // [4] 按需解锁
    L.push("");
    L.push("【4】按需解锁（只解锁即将被改动的图层 / 挡住它的上级组）");
    if (R.unlocked.length === 0) {
        L.push("  · 没有需要解锁的图层，一个锁都没动。");
    } else {
        L.push("  · 本次解锁 " + R.unlocked.length + " 个：");
        var un = firstN(R.unlocked, MAXITEMS);
        for (var m = 0; m < un.length; m++) L.push("     - " + un[m].path + "（原：" + un[m].was + "）");
        var rlC = restLine(R.unlocked, MAXITEMS);
        if (rlC) L.push(rlC);
    }

    // [4] 可见性校验
    L.push("");
    L.push("【5】可见性开关校验（保证不碰别人的眼睛开关）");
    if (!OPTIONS.verifyVisibility) {
        L.push("  · 已关闭校验（OPTIONS.verifyVisibility = false）。");
    } else if (R.visChecked) {
        L.push("  · 整理前后逐层比对：" + R.visChecked.total + " 个图层（本次新生成的图层不参与比对）。");
        if (R.visChecked.changed.length === 0) {
            L.push("  · ✔ 除新生成图层外，所有图层的显示/隐藏开关与整理前完全一致。");
        } else if (R.visChecked.restored) {
            L.push("  · 发现 " + R.visChecked.changed.length + " 处被副作用改掉的开关，已全部还原：");
            var ch = firstN(R.visChecked.changed, MAXITEMS);
            for (var q = 0; q < ch.length; q++) L.push("     - " + ch[q].path);
            var rlD = restLine(R.visChecked.changed, MAXITEMS);
            if (rlD) L.push(rlD);
        } else {
            L.push("  · ⚠ 有 " + R.visChecked.changed.length + " 处开关和整理前不一致（未开启自动还原）：");
            var ch2 = firstN(R.visChecked.changed, MAXITEMS);
            for (var q2 = 0; q2 < ch2.length; q2++) L.push("     - " + ch2[q2].path);
        }
    }
    if (R.visFixed.length > 0) {
        L.push("  · 解锁/改样式时被连带改掉、已当场还原的开关：" + R.visFixed.length + " 处");
        var vf = firstN(R.visFixed, MAXITEMS);
        for (var v = 0; v < vf.length; v++) L.push("     - " + vf[v].path);
        var rlE = restLine(R.visFixed, MAXITEMS);
        if (rlE) L.push(rlE);
    }

    // [5] 需要留意的地方
    var rk = R.risks;
    var hasRisk = (rk.fillOpacity.length + rk.advancedBlend.length + rk.knockout.length +
                   rk.transparencyShapes.length + rk.maskHidesFx.length + rk.channelLock.length +
                   rk.dissolve.length + rk.colorLookup.length + rk.disabledMask.length +
                   rk.missingFont.length + rk.clipHiddenBase.length +
                   rk.masked.length + rk.smartFilter.length +
                   rk.skipAdjust.length + rk.skipClipped.length) > 0;

    L.push("");
    L.push("【6】AE 可能不支持 / 表现不同的地方" +
           (OPTIONS.bakeLossyLayers ? "（已按开关烘焙过）" : "（默认只报告，不改动）"));
    if (!hasRisk) {
        L.push("  · 没有检测到需要留意的地方。");
    } else {
        pushRisk(L, "填充不透明度 < 100%（AE 无对应项，可能按 100% 处理）", rk.fillOpacity, MAXITEMS, function (x) {
            return x.path + "　" + (x.v === null ? "" : (Math.round(x.v * 100) / 100 + "%"));
        });
        pushRisk(L, "高级混合（混合剪贴图层 / 混合内部效果）", rk.advancedBlend, MAXITEMS);
        pushRisk(L, "挖空(knockout)", rk.knockout, MAXITEMS, function (x) { return x.path + "　" + x.v; });
        pushRisk(L, "透明形状图层", rk.transparencyShapes, MAXITEMS);
        pushRisk(L, "蒙版隐藏效果", rk.maskHidesFx, MAXITEMS);
        pushRisk(L, "通道限制（关掉了某个通道）", rk.channelLock, MAXITEMS);
        pushRisk(L, "「溶解」混合模式（PS 独有）", rk.dissolve, MAXITEMS);
        pushRisk(L, "颜色查找(Color Lookup)调整层（AE 没有对应调整层）", rk.colorLookup, MAXITEMS);
        pushRisk(L, "被禁用的图层/矢量蒙版（AE 里蒙版是生效的）", rk.disabledMask, MAXITEMS);
        pushRisk(L, "文字用了本机缺失的字体（AE 里会替换字体）", rk.missingFont, MAXITEMS, function (x) {
            return x.path + "　字体：" + x.font;
        });
        pushRisk(L, "剪贴蒙版的基底图层是隐藏的", rk.clipHiddenBase, MAXITEMS, function (x) {
            return x.path + "　基底：" + x.base;
        });
        pushRisk(L, "带图层蒙版 / 矢量蒙版的图层" + (OPTIONS.bakeMaskedLayers
                    ? "（已按开关一起烘焙）"
                    : "（当前不烘焙；要烘焙把 OPTIONS.bakeMaskedLayers 改成 true）"),
                  rk.masked, MAXITEMS);
        pushRisk(L, "调整层（不单独烘焙：合并进空层会把调整效果弄丢）", rk.skipAdjust, MAXITEMS);
        pushRisk(L, "剪贴蒙版图层（不单独烘焙：在它下面插空层会改掉剪贴基底）", rk.skipClipped, MAXITEMS);
        pushRisk(L, "用了智能滤镜的图层" + (OPTIONS.bakeSmartFilterLayers
                    ? "（已按开关一起烘焙）"
                    : "（当前不烘焙；要烘焙把 OPTIONS.bakeSmartFilterLayers 改成 true）"),
                  rk.smartFilter, MAXITEMS);
        if (rk.clipHiddenBase.length > 0 && OPTIONS.clipBaseHidden !== "sync") {
            L.push("     ↑ 想让它自己把眼睛关掉（只动这一个开关），把 OPTIONS.clipBaseHidden 改成 \"sync\"。");
        }
        if (OPTIONS.bakeLossyLayers) {
            L.push("  · 说明：以上图层已按开关烘焙成像素（观感一致，但失去可编辑性）。");
        } else {
            if (!OPTIONS.bakeLossyLayers &&
            (rk.fillOpacity.length + rk.advancedBlend.length + rk.knockout.length +
             rk.transparencyShapes.length + rk.maskHidesFx.length + rk.dissolve.length +
             rk.colorLookup.length) > 0) {
            L.push("  · 上面还有「AE 表达不了的效果」没处理：要自动烘焙成像素就把 OPTIONS.bakeLossyLayers 改成 true。");
        }
        }
    }

    // [6] 统计
    L.push("");
    L.push("【7】其它统计");
    L.push("  · 文字图层 " + rk.text + " 个" +
           (rk.warpText ? ("（其中带文字变形 " + rk.warpText + " 个，AE 表现可能不同）") : ""));
    L.push("  · 智能对象 " + rk.smartObject + " 个（AE 按当前分辨率栅格化，观感一致）");
    L.push("  · 形状层 / 纯色·渐变·图案填充层 " + rk.shapeOrFill + " 个（AE 同样按像素导入）");
    L.push("  · 调整层 " + rk.adjustment + " 个（大部分 AE 有对应调整层；「颜色查找」见上）");
    if (rk.videoOr3D > 0) L.push("  · ⚠ 视频层 / 3D 层 " + rk.videoOr3D + " 个：AE 导入 PSD 时无法保留，请单独处理。");

    // [7] 没做的事
    L.push("");
    L.push("【8】本次没有做的事（按你的要求）");
    L.push("  · 没有做全量解锁（只解锁了第【4】节列出的图层）。");
    L.push("  · 没有删除任何隐藏图层，隐藏图层 " + SCAN.hiddenCount + " 个全部原样保留。");
    var removedClipOriginals = 0;
    for (var rc = 0; rc < R.clip.folderChains.length; rc++) {
        removedClipOriginals += (R.clip.folderChains[rc].removed || 0);
    }
    if (removedClipOriginals > 0) {
        L.push("  · 唯一删掉图层的地方：第【3】节那 " + removedClipOriginals +
               " 个「跨文件夹的剪贴蒙版」原图层（内容已经烘焙进叶子图层，留着会在 PS 里重复叠一层）。");
        L.push("    想保留它们就把 OPTIONS.deleteFolderClipOriginal 改成 false。");
    } else {
        L.push("  · 剪贴整理没有删除任何图层。");
    }
    if (R.baked.length > 0) {
        L.push("  · 改变图层结构的是烘焙步骤：按开关合并/栅格化了 " + R.baked.length +
               " 个图层（清单见第【2】节，其中图层组会被压成一层）。");
    }
    L.push("  · 没有修改任何图层的显示/隐藏开关（第【5】节已逐层校验）。");
    if (R.syncClip.length > 0) {
        L.push("  · 例外：按 OPTIONS.clipBaseHidden = \"sync\" 关掉了 " + R.syncClip.length +
               " 个剪贴蒙版图层自己的眼睛（" + R.syncClip[0].path + " 等）。");
    }

    // [8] 建议
    L.push("");
    L.push("【9】给 AE 导入的建议");
    if (R.split.length > 0) {
        L.push("  · 导入时选「合成」(Import Kind = Composition)；已拆成真实图层的样式按普通图层导入。");
    } else if (SCAN.fxIds.length > 0) {
        L.push("  · 导入时选「合成」(Import Kind = Composition)，并把「图层选项」选成「可编辑图层样式」");
        L.push("    —— 样式没在 PS 侧拆，让 AE 自己转（图层组上的样式 AE 可能不支持，见第【2】节办法 2）。");
    } else {
        L.push("  · 导入时选「合成」(Import Kind = Composition)；文档里没有图层样式，图层选项随便选。");
    }
    L.push("  · 保存前建议保持「首选项 > 文件处理 > 最大兼容」为开启状态。");
    L.push("  · 建议另存一份给 AE 用的副本，保留原始分层文件（或把 OPTIONS.saveCopyForAE 改成 true）。");

    // [10] 对比（图片 + 图层，两套都有）
    L.push("");
    if ((OPTIONS.bakeChunkSize || 0) > 0) {
        L.push("");
        L.push("【分块烘焙】OPTIONS.bakeChunkSize = " + OPTIONS.bakeChunkSize +
               "：每次只烤这么多个。没烤完的，再点一次脚本会接着做（已经烤过的不会再烤）。");
    }

    L.push("【10】对比手段（① 文件夹图片=" + (OPTIONS.saveCompareImages ? "开" : "关") +
           "，② 图层盖印=" + (OPTIONS.saveCompareLayers ? "开" : "关") + "）");

    // ① 文件夹里的两张图
    L.push("  ① 文件夹里的两张图（同名会直接覆盖）：");
    if (!OPTIONS.saveCompareImages) {
        L.push("     · 已关闭（OPTIONS.saveCompareImages = false）。");
    } else if (R.cmpBeforeImage || R.cmpAfterImage) {
        L.push("     · 整理前：" + (R.cmpBeforeImage || "（输出失败）"));
        L.push("     · 整理后：" + (R.cmpAfterImage || "（输出失败）"));
        L.push("     · 用任何看图工具比；或在 PS 里打开两张叠起来，上层改「差值」。");
    } else {
        L.push("     · 没有输出（文档还没保存过，或目录不可写）。");
    }

    // ② 图层上的两个对比图层
    L.push("  ② 图层最上面盖印的两个对比图层：");
    if (!OPTIONS.saveCompareLayers) {
        L.push("     · 已关闭（OPTIONS.saveCompareLayers = false）。");
    } else if (R.cmpBeforeLayer || R.cmpAfterLayer) {
        L.push("     · " + (R.cmpAfterLayer
               ? ("最上面：" + R.cmpAfterLayer + (OPTIONS.compareDiffBlend ? "（混合模式=差值）" : ""))
               : "整理后对比图层：建立失败"));
        L.push("     · " + (R.cmpBeforeLayer ? ("下面一层：" + R.cmpBeforeLayer) : "整理前对比图层：建立失败"));
        L.push("     · 看差异：把最上面那层的混合模式改成「差值」→ 全黑=完全一致，亮的地方就是整理改动过的。");
        L.push("     · 看原样：切换最上面那层的眼睛开关，就能在新旧画面之间来回看。");
        L.push("     · 它们是盖印出来的普通像素层（隐藏图层不参与，和 AE 看到的一致）。");
        L.push("     · ⚠ 对比完记得删掉这两层，否则会被 AE 当成普通图层一起导入。");
    } else {
        L.push("     · 没有建立（可能文档里没有可盖印的画面，或盖印失败——见【出错】）。");
    }

    if (PLOG.path) {
        L.push("");
        L.push("【进度日志】");
        L.push("  · " + PLOG.path);
        L.push("  · 每一阶段 / 每一步都写在这里；万一 PS 崩了，看最后一行就知道崩在哪。");
    }

    if (R.notes.length > 0) {
        L.push("");
        L.push("【备注】");
        for (var z = 0; z < R.notes.length; z++) L.push("  · " + R.notes[z]);
    }
    if (R.errors.length > 0) {
        L.push("");
        L.push("【出错】");
        for (var y = 0; y < R.errors.length; y++) L.push("  · " + R.errors[y]);
    }

    L.push("");
    L.push("================================");
    return L;
}

function pushRisk(L, title, arr, maxItems, fmt) {
    if (!arr || arr.length === 0) return;
    L.push("  · " + title + "：" + arr.length + " 个");
    var items = firstN(arr, maxItems);
    for (var i = 0; i < items.length; i++) {
        var txt;
        try { txt = fmt ? fmt(items[i]) : (items[i].path || ("" + items[i])); } catch (e) { txt = "" + items[i]; }
        L.push("     - " + txt);
    }
    var rest = restLine(arr, maxItems);
    if (rest) L.push(rest);
}

/* ==========================================================================
 * 工具函数
 * ========================================================================== */
function pad2(n) { return (n < 10 ? "0" : "") + n; }


function plogTime() {
    var d = new Date();
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function plog(s) {
    if (!PLOG.enabled || !PLOG.file) return;
    try {
        PLOG.file.encoding = "UTF-8";
        if (PLOG.file.open("a")) {
            PLOG.file.write("[" + plogTime() + "] " + s + "\r\n");
            PLOG.file.close();
        }
    } catch (e) {}
}

function plogSetup(doc) {
    if (!OPTIONS.progressLog) return;
    var name = baseName(R.docName) + "_整理日志.txt";
    var f = null;
    try { if (doc.path) f = new File(doc.path.fsName + "/" + name); } catch (e) {}
    if (!f) { try { f = new File(Folder.desktop.fsName + "/" + name); } catch (e2) {} }
    if (!f) return;
    try { if (f.exists) f.remove(); } catch (e3) {}
    PLOG.file = f;
    PLOG.path = f.fsName;
    PLOG.enabled = true;
    plog("===== 整理开始 =====");
    plog("Photoshop " + (R.psVersion || "?") + "，文档：" + R.docName);
    plog("本次会改动：" + describeModifications());
}

function plogEnd(ok) {
    plog("===== 整理" + (ok ? "结束" : "中断") + " =====");
}


// 报告用：这次实际会跑哪些阶段（被关掉的直接标出来）
function describeStages() {
    var list = stageList();
    var labels = [];
    for (var i = 0; i < list.length; i++) {
        var lb = list[i].label;
        if (list[i].key === "bakeLossy" && !(OPTIONS.bakeLossyLayers || OPTIONS.bakeMaskedLayers || OPTIONS.bakeSmartFilterLayers)) lb += "〔已关闭〕";
        if (list[i].key === "styles" && !OPTIONS.splitLayerStyles) lb += "〔已关闭〕";
        labels.push(lb);
    }
    return OPTIONS.stages + "（" + labels.join(" → ") + "）";
}

// 报告用：这次到底会改动什么（哪一步被关掉了，一眼能看出来）
function describeModifications() {
    var out = [];
    if (OPTIONS.bakeLossyLayers) out.push("烘焙「AE 不支持的效果」");
    if (OPTIONS.bakeMaskedLayers) out.push("烘焙「带蒙版的图层」");
    if (OPTIONS.bakeSmartFilterLayers) out.push("烘焙「用智能滤镜的图层」");
    if (OPTIONS.bakeSmartObjects) out.push("烘焙「智能对象图层」");
    if (OPTIONS.clipOverFolder !== "report") out.push("跨文件夹剪贴蒙版 → 复制到叶子图层并烘焙");
    if (OPTIONS.bakeClipChains) out.push("普通剪贴链 → 合并进基底图层");
    if (OPTIONS.splitLayerStyles) out.push("图层样式拆成真实图层");
    if (OPTIONS.clipBaseHidden === "sync") out.push("同步「基底被隐藏」的剪贴图层可见性");
    if (OPTIONS.saveCopyForAE) out.push("另存一份 AE 副本");
    if (OPTIONS.saveCompareLayers) out.push("盖印两个对比图层");
    if (OPTIONS.saveCompareImages) out.push("写两张对比图到文档目录");
    if (out.length === 0) return "什么都不改（纯检测模式）";
    return out.join("；");
}

function firstN(arr, n) {
    var out = [];
    var m = Math.min(arr.length, n);
    for (var i = 0; i < m; i++) out.push(arr[i]);
    return out;
}

function restLine(arr, n) {
    if (arr.length <= n) return "";
    return "     …另外 " + (arr.length - n) + " 项（见报告文件）";
}

function lineInfo(e) {
    try { if (e && e.line) return "（第 " + e.line + " 行）"; } catch (e2) {}
    return "";
}

function baseName(name) {
    return ("" + name).replace(/\.[^\.]+$/, "");
}

function pxOf(u) {
    if (u === null || u === undefined) return null;
    if (typeof u === "number") return Math.round(u);
    try { if (u.as) return Math.round(u.as("px")); } catch (e) {}
    try { if (typeof u.value === "number") return Math.round(u.value); } catch (e2) {}
    return null;
}

function describeMode(mode) {
    // 用 == 逐个比对，不依赖枚举转字符串的结果
    var pairs = [];
    try { pairs.push([DocumentMode.BITMAP, "位图"]); } catch (e) {}
    try { pairs.push([DocumentMode.GRAYSCALE, "灰度"]); } catch (e1) {}
    try { pairs.push([DocumentMode.INDEXEDCOLOR, "索引颜色"]); } catch (e2) {}
    try { pairs.push([DocumentMode.RGB, "RGB"]); } catch (e3) {}
    try { pairs.push([DocumentMode.CMYK, "CMYK"]); } catch (e4) {}
    try { pairs.push([DocumentMode.LAB, "Lab"]); } catch (e5) {}
    try { pairs.push([DocumentMode.MULTICHANNEL, "多通道"]); } catch (e6) {}
    try { pairs.push([DocumentMode.DUOTONE, "双色调"]); } catch (e7) {}
    for (var i = 0; i < pairs.length; i++) {
        if (mode == pairs[i][0]) return pairs[i][1];
    }
    return "" + mode;
}

// 位深：8 / 16 / 32（直接打印枚举会变成 BitsPerChannelType.EIGHT，很难看）
function describeBits(doc) {
    var b = null;
    try { b = doc.bitsPerChannel; } catch (e) { return "?"; }

    var pairs = [];
    try { pairs.push([BitsPerChannelType.EIGHT, 8]); } catch (e1) {}
    try { pairs.push([BitsPerChannelType.SIXTEEN, 16]); } catch (e2) {}
    try { pairs.push([BitsPerChannelType.THIRTYTWO, 32]); } catch (e3) {}
    for (var i = 0; i < pairs.length; i++) {
        if (b == pairs[i][0]) return pairs[i][1];
    }
    var s = "" + b;
    if (s.indexOf("THIRTYTWO") >= 0) return 32;
    if (s.indexOf("SIXTEEN") >= 0) return 16;
    if (s.indexOf("EIGHT") >= 0) return 8;
    return s;
}

function isNonRGBMode(mode) {
    var bad = [];
    try { bad.push(DocumentMode.CMYK); } catch (e) {}
    try { bad.push(DocumentMode.LAB); } catch (e1) {}
    try { bad.push(DocumentMode.INDEXEDCOLOR); } catch (e2) {}
    try { bad.push(DocumentMode.BITMAP); } catch (e3) {}
    try { bad.push(DocumentMode.MULTICHANNEL); } catch (e4) {}
    try { bad.push(DocumentMode.DUOTONE); } catch (e5) {}
    for (var i = 0; i < bad.length; i++) {
        if (mode == bad[i]) return true;
    }
    return false;
}

/* ---------- 字符串 ID ---------- */
function sid(name) {
    if (KEY_CACHE.hasOwnProperty(name)) return KEY_CACHE[name];
    var v = false;
    try { v = stringIDToTypeID(name); } catch (e) { v = false; }
    KEY_CACHE[name] = v;
    return v;
}

/* ---------- 图层描述符 / 键名收集 ---------- */
function getLayerDescriptorById(id) {
    if (id === null || id === undefined || id < 0) return null;
    try {
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), id);
        return executeActionGet(ref);
    } catch (e) {
        return null;
    }
}

// 把一个描述符里出现过的所有键名 / 类名收集到 out
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
        var k = null;
        try { k = desc.getKey(i); } catch (e2) { continue; }

        var ks = "";
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

// 在描述符里递归找某个键，返回 {found, value}
function readValueDeep(desc, keyName, depth) {
    var res = { found: false, value: null };
    if (!desc) return res;
    var key = sid(keyName);
    if (key === false) return res;

    try {
        if (desc.hasKey(key)) {
            var t = desc.getType(key);
            if (t == DescValueType.BOOLEANTYPE) { res.found = true; res.value = desc.getBoolean(key); return res; }
            if (t == DescValueType.ENUMERATEDTYPE) {
                try { res.value = typeIDToStringID(desc.getEnumerationValue(key)); }
                catch (e0) { res.value = "?"; }
                res.found = true;
                return res;
            }
            try { res.value = desc.getUnitDoubleValue(key); res.found = true; return res; } catch (e1) {}
            try { res.value = desc.getDouble(key); res.found = true; return res; } catch (e2) {}
            try { res.value = desc.getInteger(key); res.found = true; return res; } catch (e3) {}
            try { res.value = desc.getString(key); res.found = true; return res; } catch (e4) {}
            res.found = true;
            res.value = "?";
            return res;
        }
    } catch (e4) {}

    if (depth <= 0) return res;

    try {
        var n = desc.count;
        for (var i = 0; i < n; i++) {
            var k = desc.getKey(i);
            var t2 = desc.getType(k);
            if (t2 == DescValueType.OBJECTTYPE) {
                var o = null;
                try { o = desc.getObjectValue(k); } catch (e5) { continue; }
                var r = readValueDeep(o, keyName, depth - 1);
                if (r.found) return r;
            } else if (t2 == DescValueType.LISTTYPE) {
                try {
                    var lst = desc.getList(k);
                    for (var j = 0; j < lst.count; j++) {
                        if (lst.getType(j) == DescValueType.OBJECTTYPE) {
                            var r2 = readValueDeep(lst.getObjectValue(j), keyName, depth - 1);
                            if (r2.found) return r2;
                        }
                    }
                } catch (e6) {}
            }
        }
    } catch (e7) {}

    return res;
}

function truthyDeep(desc, keyName) {
    var r = readValueDeep(desc, keyName, 3);
    return !!(r.found && r.value === true);
}

// 找到 keyName 那个对象，看它里面有没有 false（用来判断"是不是真的关了通道"）
function hasFalseBoolDeep(desc, keyName) {
    var key = sid(keyName);
    if (key === false || !desc) return false;
    var obj = null;
    try { if (desc.hasKey(key)) obj = desc.getObjectValue(key); } catch (e) {}
    if (obj === null) {
        try {
            for (var i = 0; i < desc.count; i++) {
                var k = desc.getKey(i);
                if (desc.getType(k) == DescValueType.OBJECTTYPE) {
                    var o = desc.getObjectValue(k);
                    if (o && o.hasKey(key)) { obj = o.getObjectValue(key); break; }
                }
            }
        } catch (e2) {}
    }
    if (!obj) return false;
    return scanForFalse(obj, 3);
}

function scanForFalse(desc, depth) {
    if (!desc || depth < 0) return false;
    var n = 0;
    try { n = desc.count; } catch (e) { return false; }
    for (var i = 0; i < n; i++) {
        var k = desc.getKey(i);
        var t = desc.getType(k);
        if (t == DescValueType.BOOLEANTYPE) {
            try { if (desc.getBoolean(k) === false) return true; } catch (e2) {}
        } else if (t == DescValueType.OBJECTTYPE) {
            try { if (scanForFalse(desc.getObjectValue(k), depth - 1)) return true; } catch (e3) {}
        }
    }
    return false;
}

// 文字变形：描述符里几乎每个文字层都有 warp 字段，只有 warpStyle 不是 none 才算真变形
function hasRealWarp(desc, keySet) {
    if (!keySet) return false;
    if (!(keySet["warp"] || keySet["warpStyle"] || keySet["class:warp"])) return false;
    var v = readValueDeep(desc, "warpStyle", 4);
    if (!v.found || v.value === null || v.value === undefined) return false;
    var s = ("" + v.value).toLowerCase();
    if (s === "" || s === "?" || s === "undefined") return false;
    return s.indexOf("none") < 0;
}

// 去掉换行、截断，避免报告被 PS 的多行报错撑乱
function cleanMsg(s) {
    if (!s) return "";
    s = ("" + s).replace(/[\r\n\t]+/g, " ");
    s = s.replace(/\s{2,}/g, " ");
    if (s.length > 160) s = s.substring(0, 160) + "…";
    return s;
}

// 只走 DOM 数图层（不发 AM 请求，很快）：用来判断刚才那一步到底改没改文档
function countLayersDom(container) {
    return countDomWalk(container, 0);
}

function countDomWalk(container, depth) {
    if (depth > 40) return 0;
    var n = 0;
    var arr = container.layers;
    for (var i = 0; i < arr.length; i++) {
        n++;
        var l = arr[i];
        var isGroup = false;
        try { isGroup = (l.typename == "LayerSet"); } catch (e) {}
        if (isGroup) n += countDomWalk(l, depth + 1);
    }
    return n;
}

// 取"当前历史状态"作为回滚点。
// OPTIONS.historyRollback = false 时直接不读：这个调用在超大文档上风险较高（闪退诱因之一）。
function safeHistoryState(doc) {
    if (!OPTIONS.historyRollback) return null;
    try { return doc.activeHistoryState; } catch (e) { return null; }
}

// 失败时精确回滚刚才那一步。
// 只有"文档真的被改动了"（图层总数变了）且开关打开时才回滚；回滚本身很慢，能省就省。
function rollbackStep(doc, histBefore, layersBefore) {
    if (!OPTIONS.historyRollback) return false;
    if (!histBefore) return false;
    if (countLayersDom(doc) === layersBefore) return false;
    try {
        doc.activeHistoryState = histBefore;
        markDirty();
        return true;
    } catch (e) {
        R.errors.push("回滚历史状态失败（这一步的中间产物可能留在文档里）：" + cleanMsg("" + e));
        return false;
    }
}

// 填充不透明度：先试 DOM，再试描述符
function readFillOpacity(layer, desc) {
    try {
        var v = layer.fillOpacity;
        if (typeof v === "number") return v;
    } catch (e) {}
    var r = readValueDeep(desc, "fillOpacity", 3);
    if (r.found && typeof r.value === "number") return r.value;
    return null;
}

/* ---------- 图层属性判断 ---------- */
function isBackground(layer) {
    try { return !!layer.isBackgroundLayer; } catch (e) { return false; }
}

function safeVisible(layer) {
    try { return layer.visible ? true : false; } catch (e) { return true; }
}

function getIdOf(layer) {
    try { return layer.id; } catch (e) { return -1; }
}

function isGrouped(layer) {
    try { return layer.grouped ? true : false; } catch (e) { return false; }
}

function blendModeString(layer) {
    // 先直接和枚举比（最可靠），再退回字符串形式
    try { if (layer.blendMode == BlendMode.DISSOLVE) return "DISSOLVE"; } catch (e) {}
    var s = "";
    try { s = "" + layer.blendMode; } catch (e2) { return ""; }
    if (s.indexOf("BlendMode") >= 0) s = s.replace("BlendMode.", "");
    return s;
}

function layerKindOf(layer) {
    try { return layer.kind; } catch (e) { return null; }
}

function kindIs(layer, kindName) {
    var k = layerKindOf(layer);
    if (k === null || k === undefined) return false;
    var target = null;
    try { target = LayerKind[kindName]; } catch (e) { return false; }
    if (target === null || target === undefined) return false;
    if (k == target) return true;
    try { return ("" + k).indexOf(kindName) >= 0; } catch (e2) {}
    return false;
}

function isTextLayer(layer, keySet) {
    if (kindIs(layer, "TEXT")) return true;
    return !!(keySet && (keySet["textKey"] || keySet["textStyle"] || keySet["class:textLayer"]));
}

function isSmartObjectLayer(layer, keySet) {
    if (kindIs(layer, "SMARTOBJECT")) return true;
    return !!(keySet && keySet["smartObject"]);
}

function isShapeOrFillLayer(layer, keySet) {
    if (kindIs(layer, "SOLIDFILL") || kindIs(layer, "GRADIENTFILL") || kindIs(layer, "PATTERNFILL")) return true;
    if (kindIs(layer, "SHAPE")) return true;
    return false;
}

function isVideoOr3DLayer(layer, keySet) {
    if (kindIs(layer, "VIDEO") || kindIs(layer, "LAYER3D")) return true;
    return !!(keySet && (keySet["videoLayer"] || keySet["layer3D"]));
}

// 这个图层需不需要烘焙？返回原因字符串（null = 不需要）。
// 三类开关各自负责自己那类原因，互不牵连：
//   bakeLossyLayers        → AE 表达不了的效果（颜色查找/溶解/透明形状图层/蒙版隐藏效果/挖空/填充不透明度/高级混合）
//   bakeMaskedLayers       → 带图层蒙版 / 矢量蒙版的图层
//   bakeSmartFilterLayers  → 用了智能滤镜的图层
// 这两类图层不能单独烘焙（返回 "adjust" / "clipped"，否则 null）：
//   · 调整层："下面建空层再向下合并"= 把调整合并进一个透明层，结果是调整效果整个丢失
//     （实测：光效 / 色相饱和度 1 就是这么被弄坏的，画面出现一块变色）
//   · 剪贴蒙版图层：在它下面插一层会改掉它的剪贴基底，效果同样会变
function bakeRefusal(layer, keySet, desc) {
    if (hasTopLevelKey(desc, "adjustment") || hasTopLevelKey(desc, "Adjs")) return "adjust";
    if (isGrouped(layer)) return "clipped";
    return null;
}

function bakeReason(layer, isGroup, keySet, desc, bm) {
    if (isBackground(layer)) return null;
    if (bakeRefusal(layer, keySet, desc)) return null;

    if (OPTIONS.bakeLossyLayers) {
        if (keySet["colorLookup"] || keySet["class:colorLookup"]) return "颜色查找调整层";
        if (bm && bm.toUpperCase().indexOf("DISSOLVE") >= 0) return "「溶解」混合模式";
        if (truthyDeep(desc, "transparencyShapesLayer")) return "透明形状图层";
        if (truthyDeep(desc, "layerMaskAsGlobalMask") || truthyDeep(desc, "vectorMaskAsGlobalMask")) return "蒙版隐藏效果";
        if (keySet["knockout"]) {
            var ko = readValueDeep(desc, "knockout", 3);
            var kov = (ko.found && ko.value !== null) ? ("" + ko.value).toLowerCase() : "";
            if (kov && kov.indexOf("none") < 0) return "挖空(knockout)";
        }
        if (keySet["fillOpacity"]) {
            var fo = readFillOpacity(layer, desc);
            if (fo !== null && fo < 99.99) return "填充不透明度 " + fo + "%";
        }
        if (truthyDeep(desc, "blendClipped") || truthyDeep(desc, "blendInterior")) return "高级混合";
    }

    if (OPTIONS.bakeSmartFilterLayers &&
        (keySet["filterFX"] || keySet["filterFXList"] || keySet["class:FilterFX"])) {
        return "智能滤镜(按开关)";
    }
    if (OPTIONS.bakeMaskedLayers &&
        (keySet["userMaskEnabled"] || keySet["userMask"] || keySet["vectorMaskEnabled"] || keySet["vmsk"])) {
        return "图层蒙版(按开关)";
    }
    if (OPTIONS.bakeSmartObjects &&
        (keySet["smartObject"] || keySet["class:smartObject"] || keySet["placedLayer"])) {
        return "智能对象(按开关)";
    }
    return null;
}

// 字体是否可用（查不了就不报，避免误报）
function checkFont(layer) {
    var ps = null;
    try { ps = layer.textItem.font; } catch (e) { return null; }
    if (!ps) return null;
    try {
        if (!app.fonts) return null;
        var n = app.fonts.length;
        for (var i = 0; i < n; i++) {
            var f = app.fonts[i];
            var cand = null;
            try { cand = f.postScriptName; } catch (e2) { cand = null; }
            if (!cand) { try { cand = f.name; } catch (e3) { cand = null; } }
            if (cand && cand === ps) return null;
        }
        return ps;
    } catch (e4) {
        return null;
    }
}

/* ---------- 图层索引（结构一变就重建，避免拿到过期对象） ---------- */
function markDirty() { IDX.dirty = true; }

function indexRefresh(doc) {
    IDX.map = {};
    IDX.order = [];
    indexWalk(doc, 0);
    IDX.dirty = false;
}

function indexWalk(container, depth) {
    if (depth > 40) return;
    var arr = container.layers;
    for (var i = 0; i < arr.length; i++) {
        var l = arr[i];
        var lid = getIdOf(l);
        if (lid >= 0) {
            IDX.map[lid] = l;
            IDX.order.push(lid);
        }
        var isGroup = false;
        try { isGroup = (l.typename == "LayerSet"); } catch (e2) {}
        if (isGroup) indexWalk(l, depth + 1);
    }
}

function byId(doc, id) {
    if (id === null || id === undefined || id < 0) return null;
    if (IDX.dirty) indexRefresh(doc);
    var l = IDX.map[id];
    if (l) return l;
    indexRefresh(doc);                    // 可能是新生成的图层，重建一次再找
    return IDX.map[id] || null;
}

/* ---------- 选中 / 选择状态 ---------- */
function selectLayerById(id) {
    try {
        var desc = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), id);
        desc.putReference(charIDToTypeID("null"), ref);
        desc.putBoolean(charIDToTypeID("MkVs"), false);
        executeAction(charIDToTypeID("slct"), desc, DialogModes.NO);
        return true;
    } catch (e) {
        return false;
    }
}

function rememberSelection(doc) {
    try { R.selActiveId = doc.activeLayer.id; } catch (e) { R.selActiveId = -1; }
}

function restoreActiveLayer() {
    if (R.selActiveId === null || R.selActiveId === undefined || R.selActiveId < 0) return;
    var doc = app.activeDocument;
    var lyr = byId(doc, R.selActiveId);
    if (!lyr) return;
    try { doc.activeLayer = lyr; } catch (e) { selectLayerById(R.selActiveId); }
}

/* ---------- 当前是否还有样式 ---------- */
function hasLayerFXById(id) {
    var d = getLayerDescriptorById(id);
    if (!d) return false;
    try { if (d.hasKey(charIDToTypeID("Lefx"))) return true; } catch (e) {}
    var k = sid("layerEffects");
    if (k !== false) {
        try { if (d.hasKey(k)) return true; } catch (e2) {}
    }
    return false;
}

/* ---------- 写报告文件 ---------- */
function writeReportFile(doc, text) {
    var fileName = baseName(R.docName) + "_AE整理报告.txt";
    var targets = [];

    try {
        var p = doc.path;
        if (p) targets.push(new File(p.fsName + "/" + fileName));
    } catch (e) {}
    try {
        var desk = Folder.desktop;
        if (desk) targets.push(new File(desk.fsName + "/" + fileName));
    } catch (e2) {}

    for (var i = 0; i < targets.length; i++) {
        try {
            var f = targets[i];
            f.encoding = "UTF-8";
            if (f.open("w")) {
                f.write("\ufeff" + text);        // BOM，方便记事本直接认出 UTF-8
                f.close();
                return f.fsName;
            }
        } catch (e3) {}
    }
    return null;
}
