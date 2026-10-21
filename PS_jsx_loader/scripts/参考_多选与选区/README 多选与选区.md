# 多选与选区 —— 踩坑结论（给 agent / jsx 作者）

> 本文记录在 **Photoshop 2023（24.x）+ Windows** 上，用 ExtendScript 做
> 「多选图层」「合并图层」时踩到的全部坑，以及**哪些写法实测可用 / 不可用**。
> 结论来自 `ps 诊断_多选与选区测试.jsx` 的实机运行（文档：多层文件夹 + 剪贴链 + 智能对象）。

---

## 一、速查表

| 想做的事 | 结论 |
|---|---|
| 脚本**建多层选区** | ✗ **不可行**（5 种写法全失败，见第二节） |
| **读**当前选区 | ✔ 可用（`targetLayers` + `itemIndex`，但要注意第 5 条） |
| **合并一组**（剪贴层 + 基底） | ✔ 只在**人手已选好**的前提下，用 `Mrg2` 才可靠 |
| 逐层 `ArtLayer.merge()` 模拟合并 | ✗ **危险**：不保留下层 id，且会吞掉其它图层 |
| 智能对象参与合并 | ✔ 需要 `app.displayDialogs = DialogModes.NO`，不要自己 rasterize |

---

## 二、建多层选区：5 种写法全部失败

目标：选中 id 列表 `[20, 21]`，期望 `targetLayers.count === 2`。

| # | 写法 | 实际结果 |
|---|---|---|
| A | `ref.putEnumerated("Lyr ","Ordn","Trgt")` + `desc.putReference("null",ref)` + `desc.putList("Lyr ",list)` | **只选中 1 层**（列表被静默忽略） |
| D | 同 A，但 `putEnumerated("Dcmn",...)`（文档作目标） | **只选中 1 层** |
| E | `putClass("Dcmn")` + `desc.putList("Lyr ",list)` | 异常 `命令"选择"当前不可用` |
| F | `putClass("Lyr ")` + `desc.putList("Lyr ",list)` | 异常 `命令"选择"当前不可用` |
| B | `desc.putList("null", list)`（不带目标引用） | 异常 `命令"选择"当前不可用` |

**跨场景一致**：顶层图层、文件夹内图层、剪贴层+基底 —— **五种写法结果完全一样**，
所以**与"是否在文件夹里""是不是剪贴层""是不是智能对象"全都无关**。

**结论**：在当前环境里，**ActionManager 的 `slct` 无法通过 `Lyr ` 列表建立多层选区**。
多选只能由人手完成（Ctrl+点击），脚本只能**读取**选区。

**因此凡是"脚本自动合并多组"的需求，都无法在纯脚本里完成** —— 除非找到别的原语。

---

## 三、`ActionReference` 没有 `putList`

```js
var ref = new ActionReference();
ref.putList(charIDToTypeID("Lyr "), list);   // ✗ 运行时报「putList 不是函数」
```

`putList` 只在 **`ActionDescriptor`** 上有。`ActionReference` 可用的是
`putIdentifier / putIndex / putName / putEnumerated / putProperty / putClass / putOffset`。

> 我最初凭印象写了 `ref.putList(...)`，导致脚本在第一个测试就抛错中断
> （而且被 `runScript` 静默吞掉，表现为"点了没反应"）。

---

## 四、`getIdentifier()` 对 `targetLayers` 返回 -1

```js
var lst = desc.getList(stringIDToTypeID("targetLayers"));
var id = lst.getReference(i).getIdentifier();   // ✗ 返回 -1
var idx = lst.getReference(i).getIndex();       // ✔ 可用（父级内序号，从 1 开始）
```

**想拿 id 只能自己遍历文档比对**，或者干脆按 `getIndex()` 定位（注意下一条）。

---

## 五、`itemIndex` 的方向：**越大越靠上**

面板从上往下数，`itemIndex` **递增**。实测：

```
itemIndex=21   「矢量智能对象 拷贝」   ← 上面的剪贴层
itemIndex=20   「 endfield」          ← 下面的基底（应用层）
```

**推论**：
- **基底（应用层）= 同组里 `itemIndex` 最小** 的那个
- 找"最下面那层"要取 **min**，不是 max

**这个方向极容易搞反** —— 我第一次写成取 max，导致合并后名字被改成上面那层。

---

## 六、`itemIndex` 是"父级内的序号"，跨文件夹会撞号

```js
/* ✗ 错：在整棵树里按 itemIndex 找 */
function layerByIndex(root, index) {
    for (...) { if (L.itemIndex === index) return L;   // 命中别的文件夹里的同号层
                if (isSet) recurse... }
}
```

**后果**：在有嵌套文件夹的文档里，可能取回**别处的图层** ->
`name` / `blendMode` 全部取错 -> 合并后名字混合模式被改成别人的。

**✔ 正确**：多选时选中的层**一定同属一个父级**（剪贴链和基底必然同父级），
所以只在 **`doc.activeLayer.parent`** 里按 `itemIndex` 匹配：

```js
var par = doc.activeLayer.parent;
for (var i = 0; i < par.layers.length; i++) {
    if (par.layers[i].itemIndex === index) return par.layers[i];
}
```

---

## 七、合并相关：`Mrg2` 的三种语义

| 调用 | 语义 | 结果 |
|---|---|---|
| `executeAction("Mrg2", 空描述符)` **且**人手已选 ≥2 层 | **合并图层**（= Ctrl+E） | ✔ **可用**（本项目最终方案） |
| 同上，但选中只有 1 层 | — | ✗ `命令"合并图层"当前不可用` |
| `selectByIds([...]) + Mrg2`（脚本自己造选区） | — | ✗ 因为选区只有 1 层（见第二节） |
| `executeAction("Mrg2")` 选中**一个** `LayerSet` | **合并组** | ✔ 可用（把文件夹拍平） |
| `LayerSet.merge()` | 合并组 | ✔ 可用，且**返回**结果层 |

**要点**：`Mrg2` 不认"脚本造的多选"，但**认"人手造的多选"**。

---

## 八、`ArtLayer.merge()` 是个陷阱

```js
var L = someLayer;
L.merge();          // ✗ 危险
```

实测（同一文档，选中 4 组、每组 2 层）：

```
—— 组1 ——  L.merge() 成功
   · 结果层 id(1791) 不是应用层 id(1790)    ← 没有保留下面那层，生成了新层
—— 组2 ——  ★ 应用层 id=1788 已经不存在
—— 组3 ——  ★ 应用层 id=1786 已经不存在
—— 组4 ——  ★ 应用层 id=1390 已经不存在
```

**一次 `merge()` 把 6 个无关图层也吃掉了** —— 它**不是**"只并下面那一层"。

**结论**：不要用 `ArtLayer.merge()` 做"逐层合并"的实现。

---

## 九、图层对象在操作后会失效

```js
var a = doc.layers[0];
var b = doc.layers[1];
a.merge();          // 合并后...
b.name;             // ✗ 返回 "?"（悬空引用）
b.merge();          // ✗ 报「命令"选择"当前不可用」
```

**✔ 正确做法**：先做**纯数据快照**，每步按 `id` 现查：

```js
/* 快照：id 是数字、name 是字符串，不受图层删除影响 */
items[i].id    = L.id;
items[i].name  = "" + L.name;
items[i].grouped = (L.grouped === true);

/* 每步现查 */
function findById(root, id) {
    for (var i = 0; i < root.layers.length; i++) {
        var L = root.layers[i];
        if (L.id === id) return L;
        if (L.typename === "LayerSet") { var R = findById(L, id); if (R) return R; }
    }
    return null;
}
var fresh = findById(doc, items[i].id);
```

---

## 十、智能对象：`app.displayDialogs` 才是开关

```js
/* ✗ 只设 executeAction 的 DialogModes.NO 不够 */
executeAction(cT("Mrg2"), new ActionDescriptor(), DialogModes.NO);

/* ✔ ExtendScript 方法（layer.merge() / layerSet.merge() 等）看的是 app.displayDialogs */
var prev = app.displayDialogs;
app.displayDialogs = DialogModes.NO;
...合并...
app.displayDialogs = prev;
```

**症状**：智能对象参与合并时弹"栅格化确认框"，脚本里没人点 -> 操作被取消 ->
报 **`用户取消了操作`**。

---

## 十一、PS 的误导性报错

> **发生了常规 Photoshop 错误。该功能可能无法在这个版本的 Photoshop 中使用。**

**这句话几乎从来不是版本问题**。实测它对应过：

- `slct` 的列表键/目标写错
- `Mrg2` 在 <2 层时被调用
- 空 `ActionDescriptor` 执行 `Mrg2`
- 图层对象已失效

**排查方法**：别信"版本不支持"，先检查**参数构造**和**对象是否有效**。

---

## 十二、`grouped` 是判断剪贴关系最可靠的依据

```js
L.grouped === true    // 该层剪贴到【下面那层】
L.grouped === false   // 该层是应用层/基底（一组到此结束）
```

**分组算法**（本轮最终采用的思路）：

```
按 itemIndex 降序（从最上面往下扫）
for each 层:
    收进当前组
    if (!层.grouped) { 本组结束; 新组 }     // 非剪贴层 = 应用层
```

**注意**：不能用"`itemIndex` 连续"当分界 ✗ ——
两个剪贴组在面板里本来就相邻、序号也连续，会被并成一组。

---

## 十三、本项目当前采用的方案（唯一验证可用的）

**半自动 + 一组一次**：

```
人手：在图层面板里手动选中【一组】（剪贴层 + 它下面的应用层）
脚本：
  ① 读选区（getIndex + 父级内匹配）
  ② 基底 = itemIndex 最小
  ③ executeAction("Mrg2", 空描述符)      ← 用现有选区 = 等于 Ctrl+E
  ④ 结果层名字 = 基底原名
  ⑤ 结果层混合模式 = 基底原模式（穿透 -> 正常）
```

**多组就分多次跑**。**"一次选多组、脚本自动分组" 无法可靠实现**（见第八条）。

脚本：`处理选中图层/ps 连同上方图层合并.jsx`
诊断：`诊断/ps 诊断_多选与选区测试.jsx`（本文所有结论的来源）

---

## 十四、调试方法论（这段同样重要）

1. **每个脚本开头写"启动探针"** 文件：能区分"没跑起来 / 跑起来了但中断 / 正常"
2. **顶层一定要 try/catch**：CEP 的 `runScript` 会把异常**静默吞掉**
   -> 表现为"点了没反应"，无从下手
3. **把关键状态写进日志**：选区内容、每组成员、每步结果、异常行号
4. **先核实假设再实现**：我一开始"以为"`slct` 选上了 2 层，
   实测才发现一直是 1 层 —— 后面的所有失败都源于这个未经验证的假设
