# 踩坑记录 —— 只写「不能这么做」

> **成功的写法不用看文档 —— 直接看 `scripts\` 里的代码就行。**
> 本文记录的是**试过但不行**的做法、**实际的报错**、以及**为什么不行**。
>
> 目的：让下一个 agent（或我自己换电脑后）**不要重走这些弯路**。
> 环境：Photoshop 2023 (24.x) / After Effects 2024 / Windows / CEP 面板。

---

## 一、烘焙（烤像素）

### ✗ `layer.rasterize()` —— 会把图毁掉

```js
layer.rasterize(RasterizeType.SHAPELAYER);    // 对"纯色填充层"在这台 PS 上直接失败
layer.rasterize(RasterizeType.FILLCONTENT);   // 兜底"成功"了，但结果是错的
```

**实测结果**：`FILLCONTENT` 只把**填充色**变成像素，**矢量蒙版原封不动留着**
→ 画面变成「整幅纯色 + 一个矢量蒙版」
→ 差值最深 **90/255**、非零像素 **372 万** —— 图彻底废了。

**教训**：兜底链不能随便往下掉。掉到 `FILLCONTENT` 是"看似成功、结果错"
—— 比直接报错更危险，因为日志里全是 ✔。

### ✗ 对 `LayerSet` 调 `.rasterize()`

**文件夹没有 `rasterize()`** —— 组上的矢量蒙版**做不到**烘焙。
只能在统计里报出来，别想着处理。

### ✗ 烘焙后还原 `opacity` / `fillOpacity`

合并已经把不透明度算进像素了，再还原一次 = **乘两遍**
（50% 的层会变成 25%）。

**只还原**：`blendMode` / `name` / `visible` / `grouped`。

---

## 二、图层对象与序号

### ✗ 在整棵文档树里按 `itemIndex` 找图层

```js
function layerByIndex(root, index) {
    for (...) { if (L.itemIndex === index) return L;   // ✗ 撞号
                if (isSet) recurse... }
}
```

**`itemIndex` 是"该层在**父级**里的序号"** —— 不同文件夹会有相同的序号，
递归查找会**先命中别的文件夹里的层**。

**实际后果**（本项目真实踩到）：
合并后名字被改成**别的图层**的名字 ✗、混合模式也是别人的 ✗。

✗ 表现：日志里 `主要图层：「 矢量智能对象 拷贝」` —— 那是**上面那层**，
不是基底 ✗。

### ✗ 以为 `itemIndex` 越大越靠下

**实际是越大越靠上**：

```
itemIndex=21   「矢量智能对象 拷贝」   ← 上面的剪贴层
itemIndex=20   「 endfield」          ← 下面的基底
```

→ **"最下面那层（基底）= `itemIndex` 最小"**。

这个方向极容易搞反，我第一次就写反了（取 max），结果名字改成了上面那层。

### ✗ 合并/删除图层后继续用旧的图层对象

```js
var a = doc.layers[0], b = doc.layers[1];
a.merge();
b.name;      // ✗ 返回 "?"（悬空引用）
b.merge();   // ✗ 报「命令"选择"当前不可用」
```

**表现**：日志里出现 `应用层「?」` ✗ —— 名字变成问号就是对象失效了。

**✔ 正确**：先做纯数据快照（`id` / `name` / `grouped`），
每步 `findById(doc, id)` 现查。

### ✗ `ActionReference.getIdentifier()` 取图层 id

```js
var lst = desc.getList(stringIDToTypeID("targetLayers"));
lst.getReference(i).getIdentifier();   // ✗ 返回 -1
```

**对 `targetLayers` 完全不可用**。只能拿 `getIndex()`（父级内序号）。

---

## 三、选区与合并（最惨的一块）

### ✗ 用 ActionManager 的 `slct` 建多层选区 —— 5 种写法全失败

目标：选 id `[20, 21]`，期望 `targetLayers.count === 2`。

| # | 写法 | 实际结果 |
|---|---|---|
| A | `putEnumerated("Lyr ","Ordn","Trgt")` + `putReference("null")` + `putList("Lyr ",list)` | **只选中 1 层**（列表被静默忽略） |
| D | 同 A，目标改 `putEnumerated("Dcmn",...)`（文档） | **只选中 1 层** |
| E | `putClass("Dcmn")` + `putList("Lyr ",list)` | ✗ `命令"选择"当前不可用` |
| F | `putClass("Lyr ")` + `putList("Lyr ",list)` | ✗ `命令"选择"当前不可用` |
| B | `putList("null", list)`（无目标引用） | ✗ `命令"选择"当前不可用` |

**跨场景完全一致**：顶层图层 ✗、文件夹内图层 ✗、剪贴层+基底 ✗ —— 结果一模一样。
→ **与"是否在文件夹里""是不是剪贴层""是不是智能对象"全都无关**。

**结论**：这个环境下 **脚本建不出多层选区**，多选只能由人手完成（Ctrl+点击）。

**直接后果**：**"脚本自动分组并合并多组"这个需求无法在纯脚本里实现**。

### ✗ `ActionReference.putList` —— 方法根本不存在

```js
var ref = new ActionReference();
ref.putList(charIDToTypeID("Lyr "), list);   // ✗ 运行时：ref.putList 不是函数
```

**`putList` 只在 `ActionDescriptor` 上有。**
`ActionReference` 可用的只有 `putIdentifier / putIndex / putName / putEnumerated / putProperty / putClass / putOffset`。

**这个错误特别坑**：它在第一个测试就抛错 -> 被 `runScript` 静默吞掉
-> 表现为「点了完全没反应、也没日志」✗。

### ✗ 空描述符调 `Mrg2`（想当"合并向下"）

```js
executeAction(charIDToTypeID("Mrg2"), new ActionDescriptor(), DialogModes.NO);
```

在**没有真实多选**的情况下 ✗ → `命令"合并图层"当前不可用`。

**`Mrg2` 的语义**：
- **人手已选 ≥2 层** -> 合并图层 ✔
- **只选中 1 层** -> 报错 ✗（合并图层至少 2 层）
- **选中单个 `LayerSet`** -> 合并组 ✔

### ✗ `ArtLayer.merge()` 做"逐层合并" —— 会吞掉无关图层

实测（选中 4 组、每组 2 层）：

```
—— 组1 ——  L.merge() 成功
   · 结果层 id(1791) 不是应用层 id(1790)      ← 没保留下面那层，生成了新层
—— 组2 ——  ★ 应用层 id=1788 已经不存在
—— 组3 ——  ★ 应用层 id=1786 已经不存在
—— 组4 ——  ★ 应用层 id=1390 已经不存在
```

**一次 `merge()` 把 6 个无关图层也吃掉了** —— 它**不是**"只并下面那一层"。

→ 这是"多组一次处理"最终失败的**直接原因**，也是最反直觉的一条。

### ✗ 用"`itemIndex` 连续"给剪贴组分组

两个剪贴组在面板里**本来就相邻、序号也连续** ✗
→ 会被错误地并成一组 → 全合成一个图层 ✗。

**✔ 判据只能是 `layer.grouped`**：
`true` = 剪贴层（在上面）；`false` = 应用层（一组到此结束）。

---

## 四、智能对象与对话框

### ✗ 只设 `executeAction` 的 `DialogModes.NO`

```js
executeAction(cT("Mrg2"), new ActionDescriptor(), DialogModes.NO);   // 不够
```

**ExtendScript 的方法**（`layer.merge()` / `layerSet.merge()`）看的是
**`app.displayDialogs`**，不是 `executeAction` 的第三个参数。

**症状**：智能对象参与合并 -> PS 弹"栅格化确认框" -> 脚本里没人点 ->
操作被取消 -> 报 **`用户取消了操作`** ✗。

**✔ 正确**：

```js
var prev = app.displayDialogs;
app.displayDialogs = DialogModes.NO;
try { ...合并... } finally { if (prev !== null) app.displayDialogs = prev; }
```

### ✗ 主动 `rasterize` 智能对象"以防万一"

没必要，而且**会破坏剪贴关系**。合并时 PS 自己会处理。

---

## 五、`suspendHistory`

### ✗ 在 IIFE 里直接传 `"main()"`

```js
(function () {
    function main() { ... }
    doc.suspendHistory("名字", "main()");   // ✗ 全局作用域找不到 main
})();
```

**`suspendHistory` 的第二个参数是【在全局作用域执行】的字符串** —— IIFE 里的函数它看不到。

**症状**：`suspendHistory` 抛错 -> 被 `catch` 捕获 -> 于是"退路"又跑了一遍 `main()`
-> **操作做了两遍**（日志里出现重复的剪贴链）。

**✔ 正确**：`$.global.PSJSX_HOOK = main;` 然后传 `"PSJSX_HOOK()"`。

### ✗ `catch` 里重跑 `main()`

`suspendHistory` 抛错**可能来自内部的 main** ✗ —— 重跑等于**把操作做两遍**
（合并会多吞一层 ✗）。

**✔ 正确**：只有错误信息里明确含 `suspendHistory` 才重试，否则当成真失败。

---

## 六、面板（CEP `index.html`）

### ✗ 用 `location.href = url + "?r=" + Date.now()` 重载面板

```js
location.href = base + "?r=" + Date.now();   // ✗ 面板直接白屏
```

**CEP 加载的是 `file://` 地址** —— 给它拼 query 会让页面**打不开** ✗：

- 面板变**空白**
- **连那个 ⟳ 按钮也没了** -> 只能重启 PS 才恢复

**✗ 也不能**：`location.reload()`（CEP 里拿到的还是缓存那份，点了跟没点一样 ✗）。

**✔ 正确**：就地重建（清状态 -> `loadButtons()`），
或者用「热重载」按钮（注入新的 `<style>`/`<script>` ✗ 不导航 ✗）。

**⚠️ 但"就地重建"加载不了改过的 `index.html`** ✗ ——
新增 HTML 元素时必须**关掉面板再打开**（窗口 > 扩展功能）。

### ✗ 拖拽预览：把蓝框插进 `#btn-container`

```js
container.insertBefore(indicator, row);   // ✗ 抛 NotFoundError
```

**脚本行不是 `#btn-container` 的直接子节点** —— 层级是：

```
#btn-container > .folder-sec > .sec-body > .btn-row
```

`insertBefore` 抛 `NotFoundError` ✗ -> 被外层 `try/catch` 吞掉 ✗ ->
**完全没有预览**（但拖放本身还能工作 ✗）✔ —— 表现为"落点对、就是不显示蓝框"。

### ✗ 每次 `dragover` 都重建蓝框/高亮

`dragover` 频率极高（鼠标一动一次）✗。每次删除+重插一个**普通流里的 22px 元素** ->
整列上下跳 26px ✗ -> 配合 `getBoundingClientRect()` 的**强制重排** ->
浏览器真的会把中间帧画出来 -> **肉眼可见的疯狂闪烁** ✗。

**✔ 正确**：把预览状态算成一个值，**只在值变化时**才写 DOM ✗。

### ✗ 落点判定读取"会被自己推动的布局"

蓝框插入会推走内容 26px ✗ -> "光标下面是哪一行/哪个文件夹"每帧都在变 ✗ ->
目标在相邻两块之间**反复横跳** ✗ -> 闪烁。

**✔ 正确**：拖拽开始时**冻结几何**，判定只用「光标位置 + 冻结坐标」（纯函数 ✗）。

### ✗ 判定分散在行 handler 里

文件夹标题行有自己的 handler ✗、脚本行有自己的 handler ✗、**两者之间的空隙没人管** ✗
-> 光标在边界来回压就闪 ✗。

**✔ 正确**：统一在**容器级** `dragover` 判定，覆盖"标题行 / 空隙 / 脚本行"。

### ✗ 预览用一套数据、落点用另一套

预览用冻结几何、`drop` 里却用实时 `getBoundingClientRect()`
-> **"蓝框显示在上面，松手却落在下面"** ✗。

### ✗ 每帧调 `document.elementFromPoint()`

`dragover` 里调它会**强制布局 + 做命中测试** ✗ —— 是能踩到的最贵的一步。
**先用缓存的数据判断"要不要处理"，不需要就立即 return** ✗。

### ✗ 每帧调 `scrollParent()`（内部是 `getComputedStyle` 遍历）

拖拽期间缓存滚动容器和视口高度即可 ✗。

### ✗ 展开文件夹时行宽变化

滚动条"按需出现" ✗ -> 占了 10px -> 行宽在展开那一刻变化 ✗。

**✔ 正确**：给根元素强制 `overflow-y: scroll`（永远预留滚动条位置 ✗）。

### ✗ 面板里"跨文件夹移动脚本"

面板只改**显示顺序**（`localStorage`），**不会挪磁盘文件** ✗ ->
下一次重绘就按文件路径归位 -> 看起来像"没反应"✗。

**✔ 正确**：同文件夹内重排；跨文件夹直接不给预览、松手不动。

### ⚠️ 面板缓存 `index.html` 在内存里

改完 `index.html` 后，**点 ⟳ 没用** ✗ —— 必须用「热重载」或重开面板。

---

## 七、AE 端

### ✗ 一次性导入多个 PSD 再统一应用指令

`ae_lib 引擎`**纯按名字**定位合成/图层 ✗：

```js
folder.item(i).name === name
```

→ 多个 PSD 有同名图层组时会生成重名合成 ✗ -> AE 自动改名成 `名字 2` ✗ ->
JSON 里写的是 `名字` -> **永远对不上** ✗；
即使没改名，也会把 **A 的样式应用到 B 的合成**上 ✗。

**✔ 正确**：**导入一个 -> 立刻应用 -> 再下一个**（串行 ✗）。

### ✗ 逐文件弹窗（批量调用）

引擎结尾有 `alert(汇总)` ✗ -> 批量 N 个文件就是 **N 个模态框** ✗ -> 没法用。

**✔ 正确**：加 `$.global.AE_HANDOFF_QUIET` 静默开关（同时把主报告从桌面改到 `%TEMP%` ✗，
否则桌面会被 N 个报告堆满 ✗）。

---

## 八、窗口定位

### ✗ 用 vbs / PowerShell 探测屏幕

每次 `.show()` 都可能重启探测 ✗ -> **PS 疯狂闪烁** ✗。

**✔ 正确**：**只读一个手工写的文件** `%TEMP%\psjsx_screen_manual.txt`（`left,top,width,height`）。
没有这个文件就按系统默认位置 ✗ —— 不做任何探测。

### ✗ 指望 `alert()` / `confirm()` 定位

它们是**系统对话框** ✗ —— 位置**改不了** ✗，永远在主屏 ✗。
要定位就必须用 `new Window("dialog")` 自绘 ✗。

### ✗ 所有弹窗都用同一个纵向位置

批量的**运行器进度条**（ps 00 / ps 00_single）和**子步骤进度条**会**互相盖住** ✗。

**✔ 正确**：分层 —— 运行器上 1/3 ✗、子步骤下 1/3 ✗、独立工具靠右偏上 ✗。

---

## 九、编码与语法

### ✗ ES6 语法 / `JSON.*` / 数组高阶方法

ExtendScript 是 **ES3** ✗：

```
const / let / 箭头 / class / 模板字符串   ✗
JSON.parse / JSON.stringify             ✗
arr.forEach / map / filter / some / indexOf  ✗
str.trim()                              ✗
```

**替代**：`for` 循环、手写 `contains`/`trim`、用 `$.global` 传对象。

### ⚠️ 编码必须 UTF-8 **无 BOM** + CRLF

和项目里现有 `.jsx` 保持一致 ✗（有 BOM 可能被 ExtendScript 当内容 ✗）。

---

## 十、调试

### ✗ 假设"设置生效了"

本项目的最大教训 ✗：我一直**以为** `slct` 选上了 2 层 ✗ ——
加了 `targetLayers.count` 自检才发现**一直是 1 层** ✗。
后面的所有失败（合并图层不可用 / 只合了一个 / 名字错 ✗）**都源于这个没验证的假设** ✗。

**✔ 正确**：看不到的现象一律"**读回**"验证 ——
选了几层读 `targetLayers.count` ✗、合并了几层比对 id 集合 ✗、设置生效没设完立刻读 ✗。

### ✗ 靠 `console.log` 调试

CEP 面板的 `console` 看不到 ✗。一切诊断必须**写文件**或**弹窗**。

### ✗ 没有顶层 `try/catch`

CEP 的 `runScript` 会**静默吞掉异常** ✗ -> 表现为"点了没反应" ✗，
连日志都没有 ✗（本项目实际发生过：`ref.putList 不是函数` 就是这样被吞的 ✗）。

**✔ 正确**：顶层 `try/catch` + **行号** + 弹窗 + 写日志；
复杂脚本再加**启动探针**（一进来就写 `%TEMP%\xxx_probe.txt`）✗ ——
能区分"没跑起来"和"跑起来后中断"✗。

### ⚠️ PS 那句报错的真面目

> **"发生了常规 Photoshop 错误。该功能可能无法在这个版本的 Photoshop 中使用。"**

**几乎从来不是版本问题** ✗。实测它对应过：

- `slct` / `Mrg2` 的**参数构造错误**
- `Mrg2` 在 **<2 层**时被调用
- **空 `ActionDescriptor`** 执行 `Mrg2`
- **图层对象已失效**

**排查顺序**：查参数 ✗ → 查对象是否有效 ✗ —— 别去怀疑 PS 版本 ✗。

---

## 十一、其它零碎

### ✗ 往桌面写文件

用户明确要求**不要**。备份/临时产物一律放 `%TEMP%`。

### ✗ 在 `Program Files` 下新建文件

需要管理员权限 ✗。能**改**已有文件 ✗，**不能新建** ✗ -> 备份要放 `%TEMP%`。

### ✗ 以为 `ps 07` 的 JSON 文件名是 `_ae指令.json`

实际是 **`<文档名>_ae.json`**（输出到**文档同级**）✗。

### ⚠️ `node --check` 不认 `.jsx` 扩展名

要复制成 `.js` 再 check ✗。
另外 `#target photoshop` 这行会让 Node 报语法错 ✗ —— 校验前先**剥掉所有以 `#` 开头的行** ✗。

---

## 十二、一句话总结每条

| 坑 | 一句话 |
|---|---|
| `rasterize()` | 会毁图，用空对象合并 |
| `itemIndex` | 越大越靠上，且只在父级内有效 |
| 图层对象 | 操作后失效，用 id 快照 + 现查 |
| `slct` 多选 | 这个环境建不出来，只能人手选 |
| `putList` | 只在 `ActionDescriptor` 上 |
| `ArtLayer.merge()` | 会吞掉无关层，别用 |
| 分组 | 只认 `grouped`，不认序号连续 |
| 智能对象 | 要关 `app.displayDialogs` |
| `suspendHistory` | 入口必须挂 `$.global`，失败别重跑 |
| 面板重载 | 不要导航，会白屏 |
| 拖拽预览 | 父节点要对、状态没变就别动 DOM、判定要用冻结几何 |
| AE 多文件 | 必须串行导入 |
| 窗口位置 | 读手册文件，不做探测；分三层 |
| 报错信息 | "可能不支持此版本" = 参数错了 |
| 调试 | 先读回验证，别靠假设 |
