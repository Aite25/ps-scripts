#target photoshop
/* ==========================================================================
 * ps 00 批处理 —— 整个文件夹
 * --------------------------------------------------------------------------
 * 按顺序处理一整个文件夹里的 psd/psb：
 *     ps 01 解锁所有图层并保持显示状态
 *     ps 02 删除所有非显示图层
 *     ps 03 烘焙所有智能对象
 *     ps 04 烘焙不支持的效果
 *     ps 05 合并带蒙版的图层
 *     ps 06 提取文件夹蒙版
 *     ── 到 06 为止都是"加图层 / 烤像素"，对工程结构破坏性小 ──
 *     ★ 06 跑完自动备份一份 <原名>_备份ps06提取文件夹蒙版.psb（可关）
 *     ps 07 烘焙文件夹剪贴蒙版   ← 待写
 *     ps 08 烘焙文件夹样式/效果   ← 待写
 *   （新增步骤直接加到下面 OPTIONS.batchScripts 数组末尾即可）
 *
 * 为什么在 06 之后备份
 *   07/08 要动文件夹结构（把剪贴层复制进每个子级并合并、把文件夹样式分发给子级），
 *   是整条流水线里对工程破坏性最大的两步 —— 所以进 07 之前留一份可回退的副本。
 *
 * 特点
 *   · 可以选【执行到第几号为止】（勾"全部执行"就跑完列表里所有步骤）
 *   · 可以在某一步之后【自动备份一份 .psb】（默认第 06 号之后；对工程破坏性大的步骤之前的保险）
 *   · 每份文件分步计时（解锁/删除/烘焙/保存各几秒）→ 能看出时间到底花在哪
 *   · 出错只跳过这一份并记录，原文件不动（不保存）
 *   · 支持"崩溃后重跑"：已处理过的文件按输出目录里是否已存在来判断
 *   · .bat 启动时（存在 %TEMP%\psjsx_batch_auto.txt）自动用记住的设置，不弹窗
 *
 * 关于备份格式（.psd 源文件也照样生效）
 *   备份一律存成 .psb，不使用源文件的扩展名。原因：
 *     .psd 有 2 GB / 30000 像素的硬上限，你的立绘大图很容易超（04 系列那份原始件 3 GB）；
 *     .psb 没有这个限制，是"任何情况下都能存下去"的安全选择。
 *   备份用 saveAs(asCopy=true)，所以：源文件（无论 psd 还是 psb）都不会被改动，
 *   文档本身也没换路径，后面 07/08 继续在同一个文档上跑，不受影响。
 * ========================================================================== */

var OPTIONS = {
    srcFolder: "",              // 要处理的文件夹（留空 = 弹窗时手动选）
    outFolder: "",              // 输出文件夹（留空 = 源文件夹下的 "已处理"）
    saveMode: "copy",           // copy = 另存到输出文件夹（原文件不动，推荐）；overwrite = 覆盖原文件
    suffix: "_已处理",
    skipDone: true,             // 跳过已经处理过的（输出目录里已存在同名结果）
    closePS: false,             // 全部处理完是否退出 Photoshop
    askOptions: true,
    remember: true,
    // ★ 备份：跑到【第 backupAfterStep 号】之后另存一份备份（默认 6 = ps 06 之后）
    //   设成 0 或负数 = 关掉备份。
    //   注意：只有这一号真在 batchScripts 里、"执行到"也没把它截掉，才会备份。
    backupAfterStep: 6,
    // ★ 执行到第几号为止：默认 99 = 全部执行（batchScripts 里有几号就跑几号）
    stopAtStep: 99,
    // ★ 某一步失败时，是否跳过【这份文件剩下的步骤】直接做下一份
    //   true  = 失败即放弃这份文件（省时间，避免在坏文档上继续折腾）
    //   false = 仍然跑完剩下的步骤（默认：更容易看出是"哪一步"的问题）
    skipRestOnStepError: true,
    batchScripts: [             // ★ 顺序 = 运行顺序
        "ps 01 解锁所有图层并保持显示状态.jsx",
        "ps 02 删除所有非显示图层.jsx",
        "ps 03 烘焙所有智能对象.jsx",
        "ps 04 烘焙不支持的效果.jsx",
        "ps 05 合并带蒙版的图层.jsx",
        "ps 06 提取文件夹蒙版.jsx",
        "ps 07 输出AE指令JSON.jsx"
        // 08 烘焙文件夹样式效果 —— 写好之后加到这里
    ]
};

var PREF_NAME = "ps_00_批处理_选项.txt";
var AUTO_MARKER = "psjsx_batch_auto.txt";
var HERE = null;
var LOG = { f: null, path: "" };
var PB = { win: null, bar: null, txt: null };
var RESULT = { done: 0, skipped: 0, failed: [], times: {}, stopped: 0 };

main();

/* ------------------------------ 主流程 ------------------------------ */
function main() {
    try { HERE = File($.fileName).parent; } catch (e0) { HERE = Folder(Folder.userData); }
    loadPrefs();

    var auto = autoMarkerExists();
    if (auto) { OPTIONS.askOptions = false; consumeAutoMarker(); }

    if (OPTIONS.askOptions && !askDialog()) return;
    savePrefs();

    var src = OPTIONS.srcFolder;
    if (!src) { failOut("没有指定要处理的文件夹 —— 请先从面板运行一次并选好文件夹（或检查记住的选项）。"); return; }
    var srcF = Folder(src);
    if (!srcF.exists) { failOut("文件夹不存在：" + src); return; }

    logOpen(srcF);
    plog("===== 批处理开始 =====");
    forceLogFlush();   // ★ 关键节点立刻落盘
    plog("源文件夹：" + srcF.fsName);
    plog("保存方式：" + (OPTIONS.saveMode === "overwrite" ? "覆盖原文件" : "另存到输出文件夹（加后缀 " + OPTIONS.suffix + "）"));
    plog("顺序：" + OPTIONS.batchScripts.join(" → "));
    plog("执行到：" + (OPTIONS.stopAtStep > 90
        ? ("全部（列表里最大是第 " + maxStepNo() + " 号）")
        : ("第 " + OPTIONS.stopAtStep + " 号为止；第 " + (OPTIONS.stopAtStep + 1) + " 号及之后会跳过")));
    plog("备份：" + (OPTIONS.backupAfterStep > 0
        ? ("跑完第 " + OPTIONS.backupAfterStep + " 号之后存一份 .psb 备份")
        : "关"));
    plog("跳过已处理：" + ((OPTIONS.skipDone && OPTIONS.saveMode !== "overwrite")
        ? "开（输出目录里已有同名结果就跳过，可用于崩溃后接着跑）"
        : "关（覆盖模式不适用，或你手动关闭了）"));

    // ★ 输出目录 = 源目录 时提醒（以前这种配置会把所有文件都误排除掉）
    var sameFolder = (normFolderPath(srcF) === normFolderPath(Folder(OPTIONS.outFolder || (srcF.fsName + "/已处理"))));
    if (sameFolder) {
        plog("⚠ 输出文件夹与源文件夹【相同】：");
        plog("   · 结果会和源文件混在同一个文件夹里（覆盖模式更是直接改原文件）");
        plog("   · 「跳过已处理」只能靠文件名后缀（" + OPTIONS.suffix + "）判断");
        plog("   建议：把输出留空（= 源文件夹下的「已处理」子目录），或另选一个输出目录。");
    }

    var files = listFiles(srcF);
    plog("找到 " + files.length + " 个文件（.psd / .psb）");
    if (files.length === 0) { finish(); return; }

    pbOpen("批处理：" + files.length + " 个文件", files.length);

    var t0 = nowMs();
    for (var i = 0; i < files.length; i++) {
        processOne(files[i], i + 1, files.length);
    }
    RESULT.totalSec = Math.round((nowMs() - t0) / 100) / 10;

    pbClose();
    finish();
}

/* ------------------------------ 单个文件 ------------------------------ */
function processOne(file, idx, total) {
    var nm = file.name;
    pbStep("(" + idx + "/" + total + ") " + nm);

    var dest = destFor(file);
    // ★ 覆盖模式下 destFor() 返回的是原文件本身，拿它判断"已处理过"会导致全部被跳过。
    // ★ 输出目录 = 源目录时（dest 也在源目录里），同样不能靠"dest 存在"判断；
    //   改成看【文件名是否已经带结果后缀】（结果才会带，源文件不会）。
    var skipNow = false;
    if (OPTIONS.skipDone && OPTIONS.saveMode !== "overwrite") {
        if (sameFolderIsSource(file)) {
            if (nm.length > OPTIONS.suffix.length && nm.lastIndexOf(OPTIONS.suffix) === nm.length - OPTIONS.suffix.length) {
                skipNow = true;
            }
        } else if (dest && dest.exists) {
            skipNow = true;
        }
    }
    if (skipNow) {
        RESULT.skipped++;
        plog("[" + idx + "/" + total + "] " + nm + " —— 已有结果，跳过");
        return;
    }

    var doc = null;
    var t0 = nowMs();
    try {
        plog("[" + idx + "/" + total + "] 打开：" + nm);
        forceLogFlush();   // ★ 每份文件开始立刻落盘
        doc = app.open(file);

        $.global.PSJSX_BATCH = true;
    /* ★ 整文件夹批处理：明确【不建】对比层（几百个文件都建差值层会白占内存），
       子脚本用 diffSkipped() 判断就是看这个开关。
       （ps 00_single 只处理当前一个文件，它会把这里设成 true，跑完保留对比层。） */
    try { $.global.PSJSX_DIFF_OK = false; } catch (eDOK0) {}
        var steps = [];
        var backedUp = false;
        var skippedRest = false;   // ★ 是否因为某一步失败而跳过了剩余步骤
        // 备份点：只有 backupAfterStep 那一号【真在】脚本列表里、"执行到"也没把它截掉，才会备份
        var bkStep = OPTIONS.backupAfterStep;
        var bkInList = (bkStep > 0) && (stepNumberOf(scriptNameForStep(bkStep)) > 0);
        var bkWillRun = bkInList && (bkStep <= OPTIONS.stopAtStep);
        if (bkStep > 0 && !bkInList) {
            plog("    ! 备份点设的是第 " + bkStep + " 号，但脚本列表里没有这一号 → 备份点在列表末尾");
        }

        for (var i = 0; i < OPTIONS.batchScripts.length; i++) {
            var sName = OPTIONS.batchScripts[i];
            var thisNo = stepNumberOf(sName);

            /* ★★ 守卫：ae 开头的脚本【永远不在 PS 里执行】
               （ae 08 应用AE指令JSON.jsx 是给 After Effects 用的，
                它是独立的一步，要在 AE 里手动跑；
                万一有人手滑把它写进 batchScripts，这里也会拦下来。） */
            if (/^ae\s/i.test("" + sName)) {
                plog("    · 跳过 AE 侧脚本（要在 AE 里手动跑）：" + sName);
                steps.push("跳过(AE侧) " + labelOf(sName));
                continue;
            }

            // ★ 执行到第几号为止
            if (thisNo > 0 && OPTIONS.stopAtStep < 90 && thisNo > OPTIONS.stopAtStep) {
                plog("    · 「执行到」= 第 " + OPTIONS.stopAtStep + " 号 → 从这里起跳过：" + sName);
                steps.push("跳过 " + labelOf(sName));
                continue;
            }

            var sr = runStep(sName, i, OPTIONS.batchScripts.length, nm);
            steps.push(sr.summary);

            // ★ 这一步失败了：按开关决定要不要跳过这份文件剩下的步骤
            if (!sr.ok) {
                RESULT.failed.push(nm + "：" + labelOf(sName) + " 失败 —— " + (sr.err || "未知"));
                if (OPTIONS.skipRestOnStepError) {
                    plog("    ★ 「" + labelOf(sName) + "」失败 → 按设置跳过这份文件剩下的步骤，直接做下一份");
                    RESULT.stopped = (RESULT.stopped || 0) + 1;
                    skippedRest = true;
                    break;
                } else {
                    plog("    ! 「" + labelOf(sName) + "」失败，但设置为「不跳过」 → 继续跑剩下的步骤");
                }
            }

            // ★ 备份：默认在第 06 号（提取文件夹蒙版）跑完后存一份
            //   01~06 只是"加图层/烤像素"，07/08 要动文件夹结构（破坏性大），所以进 07 前留副本
            if (!backedUp && bkWillRun && thisNo === bkStep) {
                var tB = nowMs();
                var bPath = backupNow(doc, file);
                var bSec = Math.round((nowMs() - tB) / 100) / 10;
                backedUp = true;
                if (bPath) {
                    plog("    ★ 已备份（第 " + bkStep + " 号之后）：" + bPath + "　" + bSec + " 秒");
                    steps.push("备份 " + bSec + "s");
                } else {
                    plog("    ! 备份失败（" + bSec + " 秒），继续往下跑；原文件未受影响");
                    RESULT.failed.push(nm + "：备份失败（已继续处理）");
                }
            }
        }

        // 备份点在"列表末尾"（列表里没有那一号）时，跑完所有步骤再备份
        if (!backedUp && bkStep > 0 && !bkInList) {
            var tB2 = nowMs();
            var bPath2 = backupNow(doc, file);
            var bSec2 = Math.round((nowMs() - tB2) / 100) / 10;
            backedUp = true;
            if (bPath2) {
                plog("    ★ 已备份（列表末尾）：" + bPath2 + "　" + bSec2 + " 秒");
                steps.push("备份 " + bSec2 + "s");
            } else {
                plog("    ! 备份失败（" + bSec2 + " 秒），继续往下跑");
                RESULT.failed.push(nm + "：备份失败（已继续处理）");
            }
        }
        if (!backedUp && bkStep > 0 && !bkWillRun) {
            plog("    · 「执行到」= 第 " + OPTIONS.stopAtStep + " 号，没跑到备份点（第 " + bkStep + " 号）→ 这一步不备份");
        }
        $.global.PSJSX_BATCH = false;
    try { $.global.PSJSX_DIFF_OK = false; } catch (eDOK1) {}

        // 保存
        var tS = nowMs();
        var savedTo = saveDoc(doc, file);
        var saveSec = Math.round((nowMs() - tS) / 100) / 10;

        var totalSec = Math.round((nowMs() - t0) / 100) / 10;
        plog("    完成：" + nm + "（共 " + totalSec + " 秒；" + steps.join("，") + "；保存 " + saveSec + " 秒）" +
             (skippedRest ? "　★ 有步骤失败，剩余步骤已跳过" : ""));
        collectTimes(steps, totalSec, saveSec);

        RESULT.done++;
        try { doc.close(SaveOptions.DONOTSAVECHANGES); } catch (eC) {}
        doc = null;
        forceLogFlush();   // ★ 每份文件结束立刻落盘
    } catch (e) {
        RESULT.failed.push(nm + "：" + cleanMsg("" + e));
        plog("    ✗ 失败：" + nm + " —— " + cleanMsg("" + e) + "（不保存，原文件不动）");
        try { $.global.PSJSX_BATCH = false;
    try { $.global.PSJSX_DIFF_OK = false; } catch (eDOK1) {} } catch (eG) {}
        if (doc) { try { doc.close(SaveOptions.DONOTSAVECHANGES); } catch (eC2) {} }
    }
}

/* ------------------------------ 备份（06 之后） ------------------------------ */
/* 某个步骤脚本是不是"第 N 号"
   ★ 必须以「ps」+ 空格 开头才算步骤脚本（否则文件名叫 "psxxx" 的会被误判成序号） */
/* ---------------- 步骤结果标记（读子脚本写的 psjsx_step_result.txt） ----------------
 * 子脚本（01~07）会在批处理模式下写这个文件：
 *   启动成功先写 "OK"，之后若出错再覆盖成 "FAIL|原因"。
 * 因为 $.evalFile 只在"抛异常"时报错，而子脚本多半自己把异常吞了，
 * 所以必须靠这个文件才能知道这一步到底成没成。 */
function stepResultPath() { try { return Folder.temp.fsName + "/psjsx_step_result.txt"; } catch (e) { return ""; } }
function stepResultClear() {
    try { var p = stepResultPath(); if (!p) return; var f = File(p); if (f.exists) f.remove(); } catch (e) {}
}
function stepResultRead() {
    try {
        var p = stepResultPath();
        if (!p) return "";
        var f = File(p);
        if (!f.exists) return "";
        if (!f.open("r")) return "";
        var s = f.read();
        f.close();
        return ("" + s).replace(/[\r\n]+/g, " ").replace(/^\s+|\s+$/g, "");
    } catch (e) { return ""; }
}

function stepNumberOf(scriptName) {
    var m = /^ps\s+(\d+)/i.exec("" + scriptName);
    if (!m) return -1;
    return parseInt(m[1], 10);
}

/* 步骤脚本的"标签"（去掉 ps NN 前缀和 .jsx 后缀），runStep 与日志共用 */
function labelOf(scriptName) {
    return ("" + scriptName).replace(/^ps\s*\d+\s*/, "").replace(/\.jsx$/i, "");
}

/* 脚本列表里最大的那个号（= 全部执行时实际会跑到哪一号） */
function maxStepNo() {
    var mx = 0;
    for (var i = 0; i < OPTIONS.batchScripts.length; i++) {
        var n = stepNumberOf(OPTIONS.batchScripts[i]);
        if (n > mx) mx = n;
    }
    return mx;
}

/* 按号找脚本名（列表里没有返回 ""） */
function scriptNameForStep(no) {
    for (var i = 0; i < OPTIONS.batchScripts.length; i++) {
        if (stepNumberOf(OPTIONS.batchScripts[i]) === no) return OPTIONS.batchScripts[i];
    }
    return "";
}

/* 收尾统一用：实际会跑到的最后一步号（stopAtStep 与列表取小） */
function effectiveLastStep() {
    var mx = maxStepNo();
    if (OPTIONS.stopAtStep < 90 && OPTIONS.stopAtStep < mx) return OPTIONS.stopAtStep;
    return mx;
}

/* 备份文件名的标记：只留步骤号与中文名（去扩展名、去空白与非法字符）
   "ps 06 提取文件夹蒙版.jsx" → "ps06提取文件夹蒙版" */
function backupTag() {
    var nm = scriptNameForStep(OPTIONS.backupAfterStep);
    if (!nm) return "ps" + OPTIONS.backupAfterStep;
    return nm.replace(/\.jsx$/i, "").replace(/[\s\\\/:*?"<>|]+/g, "");
}

/* 备份路径：输出目录里 <原名>_备份<标记>.psb（不覆盖正式结果）
   ★ 为什么备份一律存成 .psb 而不是 .psd：
     .psb 是 Photoshop 的"大文档"格式，没有 2 GB / 30000 像素限制，
     而 .psd 有 —— 你的立绘大图很容易超（比如 04 系列那份 3 GB 的）。
     存成 .psb 是【任何情况下都能存下去】的安全选择；源文件是 psd 也照样存成 psb。 */
function backupDest(file) {
    var outF = outFolderFor(file);
    if (!outF) return null;
    var nm = file.name.replace(/\.(psd|psb)$/i, "");
    return File(outF.fsName + "/" + nm + "_备份" + backupTag() + ".psb");
}

function backupNow(doc, file) {
    try {
        if (!doc) return null;
        var dest = backupDest(file);
        if (!dest) return null;
        if (OPTIONS.saveMode === "overwrite") {
            // 覆盖模式：先存原文件，再另存一份副本当备份
            try { doc.save(); } catch (e0) {}
        }
        var so = new PhotoshopSaveOptions();
        try { so.embedColorProfile = true; } catch (e1) {}
        try { so.alphaChannels = true; } catch (e2) {}
        try { so.layers = true; } catch (e3) {}
        doc.saveAs(dest, so, true, Extension.LOWERCASE);
        return dest.fsName;
    } catch (e) {
        plog("    ! 备份出错：" + cleanMsg("" + e));
        return null;
    }
}

/* 跑一个步骤脚本，返回 "名字 X秒" */
function runStep(scriptName, i, n, docName) {
    /* 返回 { summary: "标签 12.3s", ok: true/false, err: "" } */
    var p = HERE.fsName.replace(/\\/g, "/") + "/" + scriptName;
    var f = File(p);
    var label = labelOf(scriptName);
    if (!f.exists) {
        plog("    ! 找不到步骤脚本：" + scriptName);
        return label + " 缺失";
    }
    var t = nowMs();
    var ok = true, errMsg = "";
    stepResultClear();                       // ★ 清掉上一次的结果标记
    try {
        $.evalFile(f);
    } catch (e) {
        ok = false;
        errMsg = cleanMsg("" + e);
        plog("    ! 步骤出错（" + label + "）：" + errMsg);
    }
    /* ★ 再看子脚本自己写的标记：抛异常已经被上面接住了，
       这一步是为了抓"子脚本自己吞掉异常"的情况 */
    var mk = stepResultRead();
    if (mk && mk.indexOf("FAIL") === 0) {
        ok = false;
        errMsg = mk.replace(/^FAIL\|?/, "");
        plog("    ! 步骤自报失败（" + label + "）：" + errMsg);
    }
    var sec = Math.round((nowMs() - t) / 100) / 10;
    plog("      步骤 " + (i + 1) + "/" + n + "　" + label + "　" + sec + " 秒" + (ok ? "" : "　★ 失败"));
    return { summary: label + " " + sec + "s" + (ok ? "" : "(失败)"), ok: ok, err: errMsg };
}

function collectTimes(steps, totalSec, saveSec) {
    for (var i = 0; i < steps.length; i++) {
        var parts = steps[i].split(" ");
        var sec = parseFloat(parts[parts.length - 1]);
        if (isNaN(sec)) continue;
        var key = steps[i].substring(0, steps[i].length - parts[parts.length - 1].length).replace(/\s+$/, "");
        RESULT.times[key] = (RESULT.times[key] || 0) + sec;
    }
    RESULT.times["__save"] = (RESULT.times["__save"] || 0) + saveSec;
}

/* ------------------------------ 保存 ------------------------------ */
function destFor(file) {
    if (OPTIONS.saveMode === "overwrite") return file;
    var outF = outFolderFor(file);
    if (!outF) return null;
    var nm = file.name.replace(/\.(psd|psb)$/i, "");
    /* ★ 结果一律存成 .psb（不再跟着源文件扩展名走）。
       踩过的坑：源文件 06 明河卡池图.psb 是 2.97GB，结果跟着存成 .psd，
       而 .psd 有 2GB 硬上限 —— Photoshop 不报错，直接写出一个 101KB 的残缺文件。
       备份那边早就用 .psb 了，这里统一。（万一有人非要 .psd，把下面那行改成跟着源扩展名）*/
    var ext = ".psb";
    return File(outF.fsName + "/" + nm + OPTIONS.suffix + ext);
}

function outFolderFor(file) {
    var base = OPTIONS.outFolder;
    if (!base) base = file.parent.fsName + "/已处理";
    var f = Folder(base);
    if (!f.exists) { try { f.create(); } catch (e) { return null; } }
    return f;
}

function saveDoc(doc, file) {
    var dest = destFor(file);
    if (!dest) throw new Error("算不出输出路径");

    if (OPTIONS.saveMode === "overwrite") {
        doc.save();
        return doc.fullName.fsName;
    }
    // 另存为副本：不改变文档自身的路径，关闭时也不会写回原文件
    var so = new PhotoshopSaveOptions();
    try { so.embedColorProfile = true; } catch (e1) {}
    try { so.alphaChannels = true; } catch (e2) {}
    try { so.layers = true; } catch (e3) {}
    doc.saveAs(dest, so, true, Extension.LOWERCASE);

    /* ★★ 保存后校验（踩过的坑）★★
       Photoshop 在"超出格式上限"时【不报错】，而是写出一个残缺文件：
       实测 2.97GB 的文档存成 .psd，得到一个 101KB 的废文件，全批处理却当成功。
       这里检查写出来的文件是不是小得离谱；是的话删掉并抛错，让批处理如实报失败。 */
    var bad = validateSavedFile(dest);
    if (bad) {
        try { dest.remove(); } catch (eRm) {}
        throw new Error("保存结果异常（" + bad + "），已把那个坏文件删掉；原文件未受影响");
    }
    return dest.fsName;
}

/* 检查刚写出来的结果文件是否合理。返回 "" = 正常；否则返回原因。
   判据：文件必须存在、且不能小于 1MB（正常结果都是几十 MB 到几 GB）。
   小文件基本就是"超格式上限被截断"或"写盘失败"。 */
function validateSavedFile(dest) {
    try {
        if (!dest) return "算不出路径";
        if (!dest.exists) return "文件没写出来";
        var sz = 0;
        try { sz = dest.length; } catch (e0) { return "读不到文件大小"; }
        if (sz < 1024 * 1024) {
            return "写出来的文件只有 " + Math.round(sz / 1024) + " KB（正常结果至少几十 MB，多半是被截断了）";
        }
        /* 再验一下文件头：PSD/PSB 都应该以 8BPS 开头 */
        try {
            var sig = "";
            if (dest.open("r")) {
                sig = dest.read(4);
                dest.close();
            }
            if (sig && sig !== "8BPS") return "文件头不是 8BPS（不是有效的 PSD/PSB）";
        } catch (e1) { try { dest.close(); } catch (e2) {} }
        return "";
    } catch (e) { return "校验时出错：" + e; }
}

/* ------------------------------ 文件列举 ------------------------------ */
/* 路径比较用的规范化：统一斜杠、去掉末尾斜杠、转小写
   （ExtendScript 给的 fsName 可能带 / 也可能带 \，Windows 大小写也不敏感） */
function normPath(s) {
    var t = "" + s;
    try { t = t.replace(/\\/g, "/"); } catch (e0) {}
    try { t = t.replace(/\/+$/, ""); } catch (e1) {}
    try { t = t.toLowerCase(); } catch (e2) {}
    return t;
}

function normFolderPath(f) {
    if (!f) return "";
    try { return normPath(f.fsName); } catch (e) { return ""; }
}

/* 结果文件是不是会落在【源文件夹】里（输出=源，或输出留空但被改成了源） */
function sameFolderIsSource(file) {
    var srcP = "", outP = "";
    try { srcP = normFolderPath(file.parent); } catch (e0) {}
    try { outP = normFolderPath(outFolderFor(file)); } catch (e1) {}
    if (!srcP || !outP) return false;
    return (srcP === outP);
}

function listFiles(folder) {
    var out = [];
    // 先用文档里明确的字符串掩码；不行再试函数过滤（不同版本行为不同）
    try {
        out = folder.getFiles("*.psd").concat(folder.getFiles("*.psb"));
    } catch (e) {
        try {
            var a = folder.getFiles(function (f) { return (f instanceof File) && /\.psd$/i.test(f.name); });
            var b = folder.getFiles(function (f) { return (f instanceof File) && /\.psb$/i.test(f.name); });
            out = a.concat(b);
        } catch (e2) { out = []; }
    }

    // 排除输出目录里的文件（别把自己的产物再处理一遍）
    // ★ 不能用 Array.filter —— 这台 PS 的 ExtendScript 没有 ES5 数组方法
    // ★ 路径要【规范化后再比】：以前直接比 fsName，一旦写法不同（斜杠方向/大小写）
    //   就会误判；而且【输出目录 = 源目录】时会把所有文件都排除掉（踩过的坑）。
    var outBase = normFolderPath(Folder(OPTIONS.outFolder || (folder.fsName + "/已处理")));
    var srcBase = normFolderPath(folder);
    var keep = [];
    for (var i = 0; i < out.length; i++) {
        var parentName = "";
        try { parentName = normFolderPath(out[i].parent); } catch (eP) {}
        var isOut = (outBase && parentName === outBase);
        var isSrc = (srcBase && parentName === srcBase);
        // 输出文件夹与源文件夹不同：只排除输出目录里的
        // 两者相同（输出=源）：不能按 parent 排除，否则全被排掉 —— 结果文件靠后缀区分，这里全都留着
        if (outBase && srcBase && outBase === srcBase) {
            keep.push(out[i]);
        } else if (!isOut) {
            keep.push(out[i]);
        }
    }
    keep.sort(function (x, y) {
        var xn = "", yn = "";
        try { xn = x.name; } catch (e1) {}
        try { yn = y.name; } catch (e2) {}
        if (xn < yn) return -1;
        if (xn > yn) return 1;
        return 0;
    });
    return keep;
}

/* ------------------------------ 收尾 ------------------------------ */
function finish() {
    plog("");
    plog("========== 汇总 ==========");
    plog("成功 " + RESULT.done + " 份，跳过 " + RESULT.skipped + " 份，失败 " + RESULT.failed.length + " 份");
    if (RESULT.stopped) plog("其中 " + RESULT.stopped + " 份因为某一步失败而跳过了剩余步骤（skipRestOnStepError=" + (OPTIONS.skipRestOnStepError ? "开" : "关") + "）");
    if (RESULT.totalSec) plog("总耗时约 " + RESULT.totalSec + " 秒");
    var keys = [];
    for (var k in RESULT.times) { if (k !== "__save") keys.push(k); }
    for (var i = 0; i < keys.length; i++) {
        plog("  " + keys[i] + " 累计 " + Math.round(RESULT.times[keys[i]] * 10) / 10 + " 秒");
    }
    if (RESULT.times["__save"]) plog("  保存 累计 " + Math.round(RESULT.times["__save"] * 10) / 10 + " 秒");
    if (RESULT.failed.length > 0) {
        plog("");
        plog("失败明细：");
        for (var j = 0; j < RESULT.failed.length; j++) plog("  · " + RESULT.failed[j]);
    }
    plog("日志：" + LOG.path);
    plog("===== 结束 =====");
    forceLogFlush();   // ★ 收尾前强制落盘
    logClose();

    if (typeof Window !== "undefined" && !OPTIONS.askOptions) {
        // 自动模式（.bat）：不弹窗，直接写个提示文件在输出目录旁边
        try {
            var f = File((OPTIONS.outFolder || (OPTIONS.srcFolder + "/已处理")) + "/_批处理结果.txt");
            f.open("w");
            f.write("成功 " + RESULT.done + "，跳过 " + RESULT.skipped + "，失败 " + RESULT.failed.length + "\n");
            f.write("详细日志：" + LOG.path + "\n");
            for (var q = 0; q < RESULT.failed.length; q++) f.write("失败：" + RESULT.failed[q] + "\n");
            f.close();
        } catch (eW) {}
    } else if (typeof Window !== "undefined") {
        var msg = "批处理完成\n成功 " + RESULT.done + " 份";
        if (RESULT.skipped) msg += "\n跳过 " + RESULT.skipped + " 份（已有结果）";
        if (RESULT.failed.length) msg += "\n失败 " + RESULT.failed.length + " 份（明细在日志里）";
        msg += "\n\n日志：" + LOG.path;
        if (OPTIONS.askOptions) { try { alert(msg); } catch (eA) {} }   // ★ 自动模式不弹窗
    else plog("（自动模式：结果写进日志，不弹窗）");
    }

    if (OPTIONS.closePS) {
        try { app.quit(); } catch (eQ) {}
    }
}

/* ------------------------------ 选项面板 ------------------------------ */
function askDialog() {
    if (typeof Window === "undefined") return true;
    var w = new Window("dialog", "批处理 —— 整个文件夹");
    w.orientation = "column";
    w.alignChildren = "fill";

    /* ---------- ① 文件夹 ---------- */
    var gF = w.add("panel", undefined, "文件夹");
    gF.orientation = "column"; gF.alignChildren = "fill";

    var r1 = gF.add("group");
    var lb1 = r1.add("statictext", undefined, "源　"); lb1.preferredSize.width = 40;
    var etSrc = r1.add("edittext", undefined, OPTIONS.srcFolder || "");
    etSrc.characters = 42; etSrc.alignment = "fill";
    var btnPick = r1.add("button", undefined, "选择…");
    btnPick.onClick = function () {
        var f = Folder.selectDialog("选择要批量处理的文件夹");
        if (f) { etSrc.text = f.fsName; showOutPath(); }
    };

    var r2 = gF.add("group");
    var lb2 = r2.add("statictext", undefined, "输出"); lb2.preferredSize.width = 40;
    var etOut = r2.add("edittext", undefined, OPTIONS.outFolder || "");
    etOut.characters = 42; etOut.alignment = "fill";
    var btnPickOut = r2.add("button", undefined, "选择…");
    btnPickOut.onClick = function () {
        var f = Folder.selectDialog("选择输出文件夹（结果存到这里）");
        if (f) { etOut.text = f.fsName; showOutPath(); }
    };

    var r3 = gF.add("group");
    var rbKeep = r3.add("radiobutton", undefined, "原文件不动，另存到输出（推荐）");
    var rbOver = r3.add("radiobutton", undefined, "覆盖原文件（不可逆）");
    rbKeep.value = (OPTIONS.saveMode !== "overwrite");
    rbOver.value = (OPTIONS.saveMode === "overwrite");

    var r4 = gF.add("group");
    var lblOutPath = r4.add("statictext", undefined, "");
    var btnOpenOut = r4.add("button", undefined, "打开输出文件夹");
    btnOpenOut.onClick = function () {
        try {
            var p = resolveOutFolder();
            if (!p) { alert("还看不到输出文件夹：\n请先选择源文件夹或输出文件夹。"); return; }
            var f = Folder(p);
            if (!f.exists) {
                if (!f.create()) { alert("输出文件夹还不存在，也没能创建：\n" + p); return; }
            }
            f.execute();
        } catch (eO) { alert("打开失败：" + eO); }
    };

    /* 实时显示"结果实际会存到哪"。留空 = 源文件夹下的「已处理」 */
    function resolveOutFolder() {
        var o = "" + etOut.text;
        o = o.replace(/^\s+|\s+$/g, "");
        if (o) return o;
        var s = "" + etSrc.text;
        s = s.replace(/^\s+|\s+$/g, "");
        if (!s) return "";
        return s + "/已处理";
    }
    function showOutPath() {
        try {
            var covering = (rbOver.value === true);
            var p = resolveOutFolder();
            if (covering) {
                lblOutPath.text = "结果：直接写回原文件（覆盖模式）";
                etOut.enabled = false;
                btnPickOut.enabled = false;
                btnOpenOut.enabled = false;
            } else {
                etOut.enabled = true;
                btnPickOut.enabled = true;
                btnOpenOut.enabled = true;
                lblOutPath.text = p ? ("结果存到：" + p) : "结果存到：（留空 = 源文件夹下的「已处理」，请先选文件夹）";
            }
        } catch (eS) {}
    }
    rbKeep.onClick = function () { showOutPath(); };
    rbOver.onClick = function () { showOutPath(); };
    etOut.onChanging = function () { showOutPath(); };
    w.onShow = function () {
        try { etSrc.onChanging = function () { showOutPath(); }; } catch (eS1) {}
        showOutPath();
    };

    /* ---------- ② 选项 ---------- */
    var gO = w.add("panel", undefined, "选项");
    gO.orientation = "column"; gO.alignChildren = "fill";

    var o1 = gO.add("group");
    o1.add("statictext", undefined, "执行到");
    var cbAll = gAddCheckbox(o1, "全部", OPTIONS.stopAtStep > 90);
    var ddlStop = o1.add("dropdownlist", undefined, []);
    buildStepDropdown(ddlStop, OPTIONS.stopAtStep);
    ddlStop.enabled = (OPTIONS.stopAtStep <= 90);
    cbAll.onClick = function () { ddlStop.enabled = (cbAll.value !== true); };
    o1.add("statictext", undefined, "　　后缀");
    var etSuf = o1.add("edittext", undefined, OPTIONS.suffix);
    etSuf.characters = 8;

    var o2 = gO.add("group");
    var cbSkip = gAddCheckbox(o2, "跳过已处理过的", !!OPTIONS.skipDone);
    var cbQuit = gAddCheckbox(o2, "跑完退出 Photoshop", !!OPTIONS.closePS);
    var cbRem = gAddCheckbox(o2, "记住我的选择", !!OPTIONS.remember);

    var o3 = gO.add("group");
    var cbBk = gAddCheckbox(o3, "跑完第", OPTIONS.backupAfterStep > 0);
    var ddlBackup = o3.add("dropdownlist", undefined, []);
    buildStepDropdown(ddlBackup, OPTIONS.backupAfterStep > 0 ? OPTIONS.backupAfterStep : 6);
    ddlBackup.enabled = (OPTIONS.backupAfterStep > 0);
    cbBk.onClick = function () { ddlBackup.enabled = (cbBk.value === true); };
    o3.add("statictext", undefined, "步后另存备份");

    /* ---------- 底部按钮（说明 / 开始 / 取消） ---------- */
    var gB = w.add("group");
    gB.alignment = "fill";
    var btnHelp = gB.add("button", undefined, "说明…");
    btnHelp.onClick = function () {
        alert(
            "【文件夹】\n" +
            "  源　：要批量处理的文件夹（.psd/.psb）\n" +
            "  输出：结果存到哪里。留空 = 源文件夹下的「已处理」子文件夹\n" +
            "  原文件不动 = 结果另存（推荐）；覆盖原文件 = 直接改写，不可逆\n\n" +
            "【选项】\n" +
            "  执行到：按 01 → 07 顺序跑；勾「全部」就跑完列表里所有步骤，\n" +
            "          否则可以选停在第几号。\n" +
            "  后缀　：结果文件名加的后缀，例「11 明河签到活动.psb」→「11 明河签到活动_已处理.psb」\n" +
            "          结果一律存成 .psb（不限 2GB / 80000 像素，大图安全）\n" +
            "  跳过已处理过的：输出目录里已有结果就跳过（崩溃后重跑可接着做）\n" +
            "  跑完第 N 步后另存备份：对工程破坏性大的步骤之前的保险。\n" +
            "          备份名 = <原名>_备份<该步标记>.psb，放输出目录，不覆盖正式结果。\n\n" +
            "【注意】\n" +
            "  · ae 开头的脚本（如 ae 08 应用AE指令JSON）不在 PS 里跑，\n" +
            "    要在 After Effects 里手动执行。\n" +
            "  · 「执行到」没跑到备份点时会跳过备份。"
        );
    };
    var spacerB = gB.add("statictext", undefined, "　　　　　　　　　");
    try { spacerB.preferredSize.width = 20; } catch (eSP) {}
    gB.add("button", undefined, "开始", { name: "ok" });
    gB.add("button", undefined, "取消", { name: "cancel" });

    try { placeWindowOnHostScreen(w, true); } catch (ePL) {}
    if (w.show() !== 1) return false;

    OPTIONS.srcFolder = etSrc.text.replace(/^\s+|\s+$/g, "");
    OPTIONS.outFolder = etOut.text.replace(/^\s+|\s+$/g, "");
    OPTIONS.saveMode = (rbOver.value === true) ? "overwrite" : "copy";

    /* ★ 校验：另存模式下必须知道结果存到哪 */
    if (OPTIONS.saveMode !== "overwrite") {
        if (!OPTIONS.srcFolder && !OPTIONS.outFolder) {
            alert("请先设置【输出文件夹】（在「★ 输出 / 保存位置」面板里），\n" +
                  "或者选择要处理的源文件夹（那样结果会存到它下面的「已处理」）。");
            return false;
        }
        var outPath = resolveOutFolder();
        if (!outPath) {
            alert("算不出输出文件夹，请检查路径。");
            return false;
        }
        var of = Folder(outPath);
        if (!of.exists) {
            if (!of.create()) {
                alert("输出文件夹不存在，也没能创建：\n" + outPath + "\n\n请换一个位置，或手动建好它。");
                return false;
            }
        }
        /* 再确认一次可写：试着建个临时文件 */
        try {
            var probe = File(outPath + "/_写入测试.tmp");
            probe.open("w"); probe.write("ok"); probe.close();
            probe.remove();
        } catch (eW) {
            alert("输出文件夹不可写：\n" + outPath + "\n\n请换一个位置（比如放桌面或 D 盘）。");
            return false;
        }
    }
    OPTIONS.suffix = etSuf.text;
    OPTIONS.skipDone = (cbSkip.value === true);
    OPTIONS.closePS = (cbQuit.value === true);
    OPTIONS.remember = (cbRem.value === true);
    // 执行到哪一步
    OPTIONS.stopAtStep = (cbAll.value === true) ? 99 : stepNoFromDropdown(ddlStop);
    // 备份点
    if (cbBk.value === true) OPTIONS.backupAfterStep = stepNoFromDropdown(ddlBackup);
    else OPTIONS.backupAfterStep = 0;
    return true;
}

/* 往下拉框里填"第 N 号 名字"（只填列表里真实存在的步骤号） */
function buildStepDropdown(ddl, wantNo) {
    try { while (ddl.items.length > 0) ddl.remove(ddl.items[0]); } catch (e0) {}
    var idx = 0, found = -1;
    for (var i = 0; i < OPTIONS.batchScripts.length; i++) {
        var no = stepNumberOf(OPTIONS.batchScripts[i]);
        if (no < 0) continue;
        ddl.add("item", "第 " + no + " 步：" + labelOf(OPTIONS.batchScripts[i]));
        if (no === wantNo) found = idx;
        idx++;
    }
    if (ddl.items.length === 0) { ddl.add("item", "(列表里没有步骤)"); return; }
    ddl.selection = (found >= 0 ? found : ddl.items.length - 1);
}

/* 从下拉框读回步骤号（"第 6 步：提取文件夹蒙版" → 6） */
function stepNoFromDropdown(ddl) {
    try {
        var t = "" + ddl.selection.text;
        var m = /第\s*(\d+)\s*步/.exec(t);
        if (m) return parseInt(m[1], 10);
    } catch (e) {}
    return maxStepNo();
}

/* 往 group 里加一个复选框，后面还能继续 add（不新起 group） */
function gAddCheckbox(parent, text, checked) {
    var cb = parent.add("checkbox", undefined, text);
    cb.value = !!checked;
    return cb;
}

/* ------------------------------ 自动模式标记（供 .bat 用） ------------------------------ */
function autoMarkerFile() {
    try { return File(Folder.temp.fsName + "/" + AUTO_MARKER); } catch (e) { return null; }
}
function autoMarkerExists() {
    var f = autoMarkerFile();
    return (f && f.exists);
}
function consumeAutoMarker() {
    var f = autoMarkerFile();
    if (f && f.exists) { try { f.remove(); } catch (e) {} }
}

/* 出错提示：自动模式（.bat，没 UI）下绝不弹窗 —— 写文件，避免卡住无人值守 */
function failOut(msg) {
    if (!OPTIONS.askOptions) {
        try {
            var f = File(Folder.temp.fsName + "/psjsx_batch_error.txt");
            f.open("w");
            f.write(msg + "\n");
            f.close();
        } catch (e) {}
        try { if (OPTIONS.closePS) app.quit(); } catch (e2) {}
        return;
    }
    if (OPTIONS.askOptions) { try { alert(msg); } catch (eA) {} }   // ★ 自动模式不弹窗
    else plog("（自动模式：结果写进日志，不弹窗）");
}

/* ------------------------------ 进度条 ------------------------------ */
function pbOpen(title, total) {
    if (typeof Window === "undefined") return;
    try {
        PB.win = new Window("palette", title);
        PB.win.orientation = "column";
        PB.win.alignChildren = "fill";
        PB.txt = PB.win.add("statictext", undefined, "准备中…");
        PB.bar = PB.win.add("progressbar", undefined, 0, (total > 0 ? total : 1));
        try { PB.bar.preferredSize.width = 360; } catch (eW1) {}      // progressbar 不一定支持，套保护
        try { PB.win.preferredSize.width = 380; } catch (eW2) {}
        try { placeWindowOnHostScreen(PB.win, true); } catch (ePL) {}
        PB.win.show();
    } catch (e) { PB.win = null; }
}
function pbStep(msg) {
    if (!PB.win) return;
    try { PB.bar.value = PB.bar.value + 1; PB.txt.text = msg; PB.win.update(); } catch (e) {}
}
function pbClose() {
    if (!PB.win) return;
    try { PB.win.close(); } catch (e) {}
    PB.win = null;
}

/* ------------------------------ 日志 ------------------------------ */
/* 日志统一放 <目录>/_日志/。
   优先跟【当前打开的文档】同级（你在 process 里跑，日志就落 process\_日志）；
   没有打开的文档时退回【源文件夹】。
   （以前是跟输出目录走，切到"另存到输出文件夹"会跑到 已处理\_日志 去，不好找） */
function logOpen(srcFolder) {
    var baseF = null;
    try {
        if (app.documents.length > 0 && app.activeDocument.path) baseF = Folder(app.activeDocument.path);
    } catch (e0) { baseF = null; }
    if (!baseF && srcFolder) baseF = srcFolder;
    if (!baseF) { baseF = Folder(Folder.temp); }

    var logF = Folder(baseF.fsName + "/_日志");
    if (!logF.exists) { try { logF.create(); } catch (e2) {} }
    if (!logF.exists) logF = baseF;                    // 建不出来就退回上一层

    var stamp = stampStr();
    LOG.path = logF.fsName + "/批处理_" + stamp + ".txt";
    try { LOG.f = File(LOG.path); LOG.f.open("w"); } catch (e3) { LOG.f = null; }
}
function logClose() {
    if (LOG.f) { try { LOG.f.close(); } catch (e) {} LOG.f = null; }
}
/* 日志落盘策略：不是每行都 close/open（那是 1 次文件 I/O 每行，很慢），
   而是每 25 行才真正 close+reopen 一次（ExtendScript 的 File 有写入缓冲，
   不 close 就不落盘；这样兼顾"崩了不丢太多"与"跑得快"）。 */
var LOG_LINES = 0;
var LOG_LAST_FLUSH = 0;
/* ★ 落盘策略（踩过的坑：原来是"每 25 行才落盘"，结果批处理刚开头就出错时，
     日志不足 25 行 -> 缓冲区从没落盘 -> 日志文件是 0 字节，什么线索都没有）。
   现在改成双条件：每 10 行、或距上次落盘超过 3 秒，就落一次。
   另外 forceLogFlush() 用于"关键时刻立刻落盘"。 */
function LOG_FLUSH() {
    LOG_LINES++;
    var nowMs2 = (new Date()).getTime();
    if ((LOG_LINES % 10 !== 0) && (nowMs2 - LOG_LAST_FLUSH < 3000)) return;
    forceLogFlush();
}
function forceLogFlush() {
    if (!LOG.f) return;
    try { LOG.f.close(); LOG.f.open("a"); LOG_LAST_FLUSH = (new Date()).getTime(); } catch (e) {}
}
function plog(s) {
    if (!LOG.f) return;
    try { LOG.f.write("[" + timeStr() + "] " + s + "\n"); LOG_FLUSH(); } catch (e) {}
}

/* ------------------------------ 选项记忆 ------------------------------ */
function prefFile() {
    try { return File(Folder.userData + "/" + PREF_NAME); } catch (e) { return null; }
}
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
            if (k === "srcFolder") OPTIONS.srcFolder = v;
            if (k === "outFolder") OPTIONS.outFolder = v;
            if (k === "saveMode") OPTIONS.saveMode = v;
            if (k === "suffix") OPTIONS.suffix = v;
            if (k === "skipDone") OPTIONS.skipDone = (v === "1");
            if (k === "closePS") OPTIONS.closePS = (v === "1");
            if (k === "stopAtStep") { var n1 = parseInt(v, 10); if (!isNaN(n1)) OPTIONS.stopAtStep = n1; }
            if (k === "backupAfterStep") { var n2 = parseInt(v, 10); if (!isNaN(n2)) OPTIONS.backupAfterStep = n2; }
            // 兼容旧版（老键 backupAfter 存的是脚本名）：空 = 关掉备份，非空 = 用它那一号
            if (k === "backupAfter") {
                if (!v) OPTIONS.backupAfterStep = 0;
                else { var n3 = stepNumberOf(v); if (n3 > 0) OPTIONS.backupAfterStep = n3; }
            }
        }
    } catch (e) {}
}
function savePrefs() {
    if (!OPTIONS.remember) return;
    var f = prefFile();
    if (!f) return;
    try {
        f.open("w");
        f.write("srcFolder=" + OPTIONS.srcFolder + "\n");
        f.write("outFolder=" + OPTIONS.outFolder + "\n");
        f.write("saveMode=" + OPTIONS.saveMode + "\n");
        f.write("suffix=" + OPTIONS.suffix + "\n");
        f.write("skipDone=" + (OPTIONS.skipDone ? "1" : "0") + "\n");
        f.write("stopAtStep=" + OPTIONS.stopAtStep + "\n");
        f.write("backupAfterStep=" + OPTIONS.backupAfterStep + "\n");
        f.write("closePS=" + (OPTIONS.closePS ? "1" : "0") + "\n");
        f.close();
    } catch (e) {}
}

/* ------------------------------ 工具 ------------------------------ */
function nowMs() { return (new Date()).getTime(); }

function timeStr() {
    var d = new Date();
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}
function stampStr() {
    var d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "_" + pad2(d.getHours()) + pad2(d.getMinutes());
}
function pad2(n) { return (n < 10 ? "0" : "") + n; }
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


function cleanMsg(s) { try { return ("" + s).replace(/[\r\n]+/g, " ").substring(0, 180); } catch (e) { return "" + s; } }
