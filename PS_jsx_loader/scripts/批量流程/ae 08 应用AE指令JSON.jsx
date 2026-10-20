// ===========================================================================
// ae 08 应用AE指令JSON
// ---------------------------------------------------------------------------
// 【最简入口】：只做一件事 —— 让你选一个 _ae.json，然后交给引擎处理。
//
// 标准用法（一步到位，不依赖任何目录枚举）：
//   1. 引擎路径已写死在下面的 ENGINE_PATH 里（通常不用改）
//   2. 引擎的完整路径填在下面的 ENGINE_PATH（默认值就是正确路径，通常不用改）
//   3. 以后直接跑本脚本即可
//
// 手动导入 PS 文件的流程：
//   文件 > 导入 > 文件 -> 选 psd/psb
//     Import Kind: Composition - Retain Layer Sizes
//     勾上 Editable Layer Styles
//   然后跑本脚本，选同一份文件旁边的 <原名>_ae.json
//
// ★ 为什么不"自动找引擎"：实测某些 AE 环境下 getFiles() 返回的 .name 是
//   URL 编码的（ae_lib%20%E5%BC%95%E6%93%8E_...），中文匹配永远失败，
//   于是报"找不到引擎文件"。所以这里【写死完整路径】+【直接试 File().exists】，
//   完全不用 getFiles()。
// ===========================================================================

(function () {

/* ==========================================================================
 * ★ 引擎路径：写死在这里最可靠（引擎换位置只改这一行）
 * ========================================================================== */
var ENGINE_PATH = "C:/Program Files (x86)/Common Files/Adobe/CEP/extensions/PS_jsx_loader/scripts/批量流程/ae_lib 引擎_应用AE指令.jsx";
var ENGINE_NAME = "ae_lib 引擎_应用AE指令.jsx";

/* ---------------- 1) 选 JSON ---------------- */
var jsonPath = "";
try {
    if (typeof arguments !== "undefined" && arguments && arguments.length > 0 && arguments[0]) {
        jsonPath = "" + arguments[0];
    }
} catch (eArg) {}

if (!jsonPath) {
    var jf = File.openDialog("选择 ps 07 生成的 _ae.json", "*.json");
    if (!jf) { alert("没有选择 JSON，已取消。"); return; }
    jsonPath = jf.fsName;
}

var jFile = File(jsonPath);
if (!jFile.exists) { alert("JSON 不存在：\n" + jsonPath); return; }

/* ---------------- 2) 找引擎（不用 getFiles） ---------------- */
function tryFile(p) {
    try { var f = File(p); return (f && f.exists) ? f : null; } catch (e) { return null; }
}

var eng = tryFile(ENGINE_PATH);
var engPath = ENGINE_PATH;

if (!eng) {
    /* 退一步：按"脚本自己所在目录"和几个已知目录，直接拼完整文件名试。
       ★ 不枚举目录 —— 绕开 getFiles() 的 URL 编码问题。 */
    var dirs = [];
    try { var self = File($.fileName); if (self && self.parent) dirs.push(self.parent.fsName); } catch (eS1) {}
    try {
        var self2 = File(decodeURI("" + $.fileName));
        if (self2 && self2.parent) dirs.push(self2.parent.fsName);
    } catch (eS2) {}
    dirs.push("C:/Program Files (x86)/Common Files/Adobe/CEP/extensions/PS_jsx_loader/scripts/批量流程");
    dirs.push("C:/Program Files (x86)/Common Files/Adobe/CEP/extensions/PS_jsx_loader/scripts/诊断");

    for (var i = 0; i < dirs.length; i++) {
        if (!dirs[i]) continue;
        var c = tryFile(dirs[i] + "/" + ENGINE_NAME);
        if (c) { eng = c; engPath = c.fsName; break; }
    }
}

if (!eng) {
    var triedList = "  1. " + ENGINE_PATH + "\n";
    triedList += "  2. <脚本所在目录>/" + ENGINE_NAME + "\n";
    triedList += "  3. C:/.../scripts/批量流程/" + ENGINE_NAME + "\n";
    triedList += "  4. C:/.../scripts/诊断/" + ENGINE_NAME + "\n";
    alert("找不到引擎文件。\n\n我试过这些路径：\n" + triedList + "\n" +
          "$.fileName = " + $.fileName + "\n\n" +
          "请确认 " + ENGINE_NAME + " 在哪里，\n" +
          "然后把它的完整路径填到本脚本开头的 ENGINE_PATH 那一行。");
    return;
}

/* ---------------- 3) 加载引擎 ---------------- */
try { $.global.AE_HANDOFF_JSON = jsonPath; } catch (eG) {}

try {
    $.evalFile(eng);
} catch (eEval) {
    alert("加载引擎失败：\n" + engPath + "\n\n" + eEval);
    return;
}

/* ---------------- 4) 跑 ---------------- */
try {
    if (typeof AEHandoffRun === "function") AEHandoffRun();
    else alert("引擎里没有找到 AEHandoffRun() 入口。");
} catch (eRun) {
    alert("执行失败：\n" + eRun);
}

})();
