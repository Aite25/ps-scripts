/* ==========================================================================
 * _共享 窗口位置.jsx
 * --------------------------------------------------------------------------
 * ★ 这是【给其它脚本调用的共享文件，不要直接双击运行】。
 *   批量流程里的 ps 00 / ps 00_single / ps 01~07 会在弹窗之前自动加载它。
 *   （它不是流水线步骤，所以不在 ps 00 的 batchScripts 列表里。）
 *
 * 目的：把脚本弹的窗口（选项面板 / 进度条）放到【指定的那块屏幕】上，
 *       并且把【外层运行器】和【批处理子步骤】的窗口分上下两层，互相不遮。
 *
 * --------------------------------------------------------------------------
 * ★★ 本文件【不做任何探测】（按用户要求，之前那套 vbs/PowerShell 探测已删掉）★★
 *   只读一个手工写的文件：
 *
 *       %TEMP%\psjsx_screen_manual.txt      内容：left,top,width,height
 *       例如：1920,0,1920,1032          （副屏的工作区）
 *
 *   · 有这个文件 -> 窗口放到那块屏上
 *   · 没有 / 内容不合法 -> 返回 false，窗口按系统默认位置显示（通常是主屏）
 *   · 想换屏幕就直接编辑这个文件（改完下一个弹窗就生效，不用重启 PS）
 *
 *   怎么查到这块屏的矩形：Windows 显示设置里看两块屏的分辨率和相对位置，
 *   或者随便跑一句 PowerShell：
 *       Add-Type -AssemblyName System.Windows.Forms
 *       [System.Windows.Forms.Screen]::AllScreens | % { $_.DeviceName + " " + $_.WorkingArea }
 *
 * --------------------------------------------------------------------------
 * 窗口分两层（解决"00single 的进度条被子步骤的进度条盖住"）：
 *     · 外层运行器（ps 00 / ps 00_single）—— 调用时带 isRunner=true -> 放【上 1/3】
 *     · 批处理里的子步骤（$.global.PSJSX_BATCH === true）  -> 放【下 1/3】
 *     · 其它（单独跑某个步骤）                            -> 放【上 1/3】
 *   这样 ps 00_single 的进度条在上、当前那个步骤的进度条在下，两个都看得见。
 *
 * 用法（在 w.show() 之前调用；失败无所谓，包在 try 里）：
 *     try { placeWindowOnHostScreen(w); } catch (e) {}          // 普通窗口
 *     try { placeWindowOnHostScreen(w, true); } catch (e) {}    // 外层运行器的窗口
 *
 * 已知限制：ScriptUI 内建的 alert() / confirm() 是系统对话框，位置改不了，
 *           所以本助手只能管 new Window(...) 出来的窗口。
 * ========================================================================== */

/* ---------------- 读小文件 ---------------- */
function PSJSX_readText(path) {
    var f = null;
    try {
        f = File(path);
        if (!f.exists) return null;
        if (!f.open("r")) { try { f.close(); } catch (c0) {} return null; }
        var s = null;
        try { s = f.read(); } catch (r0) { s = null; }
        try { f.close(); } catch (c1) {}
        return (s === null) ? null : ("" + s);
    } catch (e) {
        try { if (f) f.close(); } catch (c2) {}
        return null;
    }
}

/* 解析 "left,top,宽,高"（多余内容 / 换行都忽略，取前 4 个整数） */
function PSJSX_parseRect(txt) {
    try {
        if (!txt) return null;
        var t = ("" + txt).replace(/[\r\n]+/g, ",");
        var p = t.split(",");
        var nums = [];
        for (var i = 0; i < p.length && nums.length < 4; i++) {
            var v = ("" + p[i]).replace(/^\s+|\s+$/g, "");
            if (v === "") continue;
            if (v.charAt(0) === "#") break;
            var n = parseInt(v, 10);
            if (isNaN(n)) return null;
            nums.push(n);
        }
        if (nums.length < 4) return null;
        if (nums[2] < 200 || nums[3] < 200) return null;         /* 明显不合理 */
        return { l: nums[0], t: nums[1], w: nums[2], h: nums[3] };
    } catch (e) { return null; }
}

/* ---------------- 手册文件路径 ---------------- */
function PSJSX_manualPath() {
    try {
        var d = Folder.temp;
        if (!d) return "";
        return d.fsName + "/psjsx_screen_manual.txt";
    } catch (e) { return ""; }
}

/* ---------------- 对外：目标屏幕（只读手册文件，不探测） ---------------- */
function PSJSX_targetScreen() {
    try {
        var g = $.global.PSJSX_SCREEN_ONE;
        if (g && g.w > 200 && g.h > 200) return g;
    } catch (e0) {}
    var p = PSJSX_manualPath();
    if (!p) return null;
    var s = PSJSX_parseRect(PSJSX_readText(p));
    if (!s) return null;
    try { $.global.PSJSX_SCREEN_ONE = s; } catch (e1) {}
    return s;
}

/* ---------------- 对外：把窗口放到那块屏幕上 ----------------
 * 横向居中；纵向按"层"决定（见文件顶部说明）：
 *   外层运行器 / 单独跑某步 -> 上 1/3；批处理里的子步骤 -> 下 1/3
 * 拿不到屏幕信息就返回 false（窗口按系统默认位置显示，不影响功能）。 */
function PSJSX_placeWindow(w, isRunner, isStandalone) {
    try {
        if (!w) return false;
        var s = PSJSX_targetScreen();
        if (!s) return false;

        /* 估一下窗口大小：show() 之前 ScriptUI 一般已经算好了布局 */
        var ww = 0, hh = 0;
        try { var b = w.bounds; if (b && b.length === 4) { ww = b[2] - b[0]; hh = b[3] - b[1]; } } catch (eB) {}
        try { var ps = w.preferredSize; if (ps && (!ww || ww < 50)) { ww = ps.width; hh = ps.height; } } catch (eP) {}
        if (!ww || ww < 80) ww = 420;
        if (!hh || hh < 60) hh = 280;
        if (ww > s.w) ww = s.w;
        if (hh > s.h) hh = s.h;

        /* 是不是"批处理里的子步骤"？ */
        var inBatch = false;
        try { inBatch = ($.global.PSJSX_BATCH === true); } catch (eN) {}

        var x = s.l + Math.round((s.w - ww) / 2);
        var y;
        if (isStandalone === true) {
            /* ★ 独立工具（不在批量流程里）：靠【右】偏上。
               批量流程的进度条都是【横向居中】的，靠右放就不会盖住它们。
               第三层：上 1/3 = 运行器，下 1/3 = 子步骤，右侧 = 独立工具。 */
            x = s.l + s.w - ww - 24;
            y = s.t + 24;
        } else if (inBatch && isRunner !== true) {
            y = s.t + Math.round((s.h - hh) * 2 / 3);      /* ★ 下层：批处理子步骤 */
        } else {
            y = s.t + Math.round((s.h - hh) / 3);          /* 上层：外层运行器 / 单独跑 */
        }
        if (x < s.l) x = s.l;
        if (y < s.t) y = s.t;

        try { w.location = [x, y]; } catch (eL) { return false; }
        return true;
    } catch (e) { return false; }
}

/* ---------------- 方便排查：一句话说明当前会放到哪 ---------------- */
function PSJSX_screenInfo() {
    try {
        var p = PSJSX_manualPath();
        var s = PSJSX_targetScreen();
        if (!s) {
            return "没有找到 / 读不懂屏幕设置文件 —— 窗口按系统默认位置显示（通常是主屏）。\n\n" +
                   "想指定屏幕，建这个文件：\n" + (p ? p : "%TEMP%\\psjsx_screen_manual.txt") +
                   "\n内容格式：left,top,width,height\n例如副屏：1920,0,1920,1032";
        }
        return "弹窗放到：left=" + s.l + " top=" + s.t + " 宽=" + s.w + " 高=" + s.h +
               "\n（设置文件：" + p + "）" +
               "\n外层运行器（ps 00 / ps 00_single）的窗口放上 1/3；" +
               "\n批处理子步骤的窗口放下 1/3 —— 互不遮挡。";
    } catch (e) { return "（屏幕信息读取出错：" + e + "）"; }
}

/* 让其它脚本能通过 $.global 找到（$.evalFile 之后本文件的顶层函数就在全局） */
try { $.global.PSJSX_placeWindow = PSJSX_placeWindow; } catch (eG1) {}
try { $.global.PSJSX_targetScreen = PSJSX_targetScreen; } catch (eG2) {}
try { $.global.PSJSX_screenInfo = PSJSX_screenInfo; } catch (eG3) {}
