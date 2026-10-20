var doc = app.activeDocument;

// 将所有操作包装在一个历史状态中，实现一键撤回
doc.suspendHistory("合并图层到空对象", "main()");

function main() {
    // 获取所有选中的图层
    var secL = getSelectedLayers();
    var skipped = [];
    // 遍历选中的图层并进行操作
    for (var i = 0; i < secL.length; i++) {
        var layer = secL[i];
        if (layer.typename === "ArtLayer") {// 选中的是一个图层
            /* ★ 没有真正显示的不处理：
                 ① 自己被关灯 / 所在文件夹（或更上层任意一级）被关灯
                 ② 是剪贴蒙版，但绑定的基底（往下第一个非剪贴层）被关灯
               这两种情况下 PS 里它是看不见的，做"空对象合并"只会白白多出个图层。 */
            if (!reallyShown(layer)) {
                skipped.push(layer.name + hintWhy(layer));
                continue;
            }
            processLayer(layer);
        }else if(layer.typename === "LayerSet"){// 选中的是一个组
            // 组不进行处理
        }
    }
    if (skipped.length) {
        alert("以下图层没有真正显示，已跳过：" + "\n\n" + skipped.join("\n"));
    }
}

// 处理单个图层的函数
function processLayer(layer) {
    try {
        // 存储原始混合模式和名称
        var originalBlendMode = layer.blendMode;
        var originalName = layer.name;
        
        // 激活当前图层
        selectLayerById(layer.id);
        
        // 创建一个新的空图层并放在当前图层下面
        var emptyLayer = doc.artLayers.add();
        emptyLayer.move(layer, ElementPlacement.PLACEAFTER); // 放在当前图层下面
        
        // 使用更可靠的方式合并图层
        mergeLayersWithAction(layer, emptyLayer);
        
        // 获取当前活动图层（合并后的图层）
        var mergedLayer = doc.activeLayer;
        
        // 设置合并后图层的混合模式为原始图层的混合模式
        mergedLayer.blendMode = originalBlendMode;
        
        // 可选：保留原始图层名称
        mergedLayer.name = originalName;
        
    } catch (e) {
        alert("处理图层 '" + layer.name + "' 时出错: " + e);
    }
}

// 根据ID选择图层
function selectLayerById(id) {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putIdentifier(charIDToTypeID('Lyr '), id);
    desc.putReference(charIDToTypeID('null'), ref);
    desc.putBoolean(charIDToTypeID('MkVs'), false);
    executeAction(charIDToTypeID('slct'), desc, DialogModes.NO);
}

// 使用动作方式合并图层
function mergeLayersWithAction(topLayer, bottomLayer) {
    // 首先选择顶部图层
    selectLayerById(topLayer.id);
    
    // 使用动作描述符来合并向下
    var idMrgd = charIDToTypeID("Mrg2");
    var desc = new ActionDescriptor();
    executeAction(idMrgd, desc, DialogModes.NO);
}

/* ==========================================================================
 * "真正显示"判断
 * --------------------------------------------------------------------------
 * PS 的 layer.visible 只反映【这一层自己】的灯，两个坑：
 *   ① 层在文件夹里，文件夹关灯了 -> 这层的 visible 仍然是 true，但看不见；
 *   ② 层是剪贴蒙版（grouped === true），基底关灯了 -> 这层的 visible 也还是 true。
 * 所以要自己往上爬（祖先链）+ 往下找基底。
 * ========================================================================== */

/* 自己 + 所有祖先的 visible 都为真 */
function selfAndAncestorsVisible(L) {
    var a = L, guard = 0;
    while (a && guard < 64) {
        guard++;
        try { if (a.visible === false) return false; } catch (e1) {}
        var p = null;
        try { p = a.parent; } catch (e2) { p = null; }
        if (!p || p === doc) break;
        a = p;
    }
    return true;
}

/* 剪贴蒙版绑定的基底：往下（itemIndex 增大）第一个 grouped !== true 的层 */
function clipBaseOf(L) {
    var par = null;
    try { par = L.parent; } catch (e) { par = null; }
    if (!par || !par.layers) return null;
    var idx = -1;
    for (var i = 0; i < par.layers.length; i++) {
        if (par.layers[i] === L) { idx = i; break; }
    }
    if (idx < 0) return null;
    for (var j = idx + 1; j < par.layers.length; j++) {
        var M = par.layers[j];
        if (M.grouped === true) continue;
        return M;
    }
    return null;
}

function reallyShown(L) {
    if (!selfAndAncestorsVisible(L)) return false;
    try {
        if (L.grouped === true) {
            var base = clipBaseOf(L);
            if (!base) return false;
            if (!selfAndAncestorsVisible(base)) return false;
        }
    } catch (e) {}
    return true;
}

function hintWhy(L) {
    try {
        if (!selfAndAncestorsVisible(L)) return "  （自己或所在文件夹被关灯）";
        var base = clipBaseOf(L);
        return "  （剪贴蒙版，但基底 '" + (base ? base.name : "?") + "' 被关灯）";
    } catch (e) { return ""; }
}

// 获取所有选中图层的函数
function getSelectedLayers() {
    var selectedLayers = [];
    var ref = new ActionReference();
    ref.putProperty(stringIDToTypeID("property"), stringIDToTypeID("targetLayers"));
    ref.putEnumerated(stringIDToTypeID("document"), stringIDToTypeID("ordinal"), stringIDToTypeID("targetEnum"));
    var desc = executeActionGet(ref);

    if (desc.hasKey(stringIDToTypeID("targetLayers"))) {
        var targetLayers = desc.getList(stringIDToTypeID("targetLayers"));
        for (var i = 0; i < targetLayers.count; i++) {
            var index = targetLayers.getReference(i).getIndex() + 1; // Photoshop索引从1开始
            var layer = getLayerByIndex(index);
            if (layer) selectedLayers.push(layer);
        }
    }
    return selectedLayers;
}

// 根据索引递归获取图层（支持组）
function getLayerByIndex(index) {
    function findLayerByIndex(layerSet, index) {
        for (var i = 0; i < layerSet.layers.length; i++) {
            var layer = layerSet.layers[i];
            if (layer.itemIndex == index) {
                return layer;
            }
            if (layer.typename === "LayerSet") {
                var foundLayer = findLayerByIndex(layer, index);
                if (foundLayer) return foundLayer;
            }
        }
        return null;
    }
    return findLayerByIndex(doc, index);
}