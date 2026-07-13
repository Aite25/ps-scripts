var doc = app.activeDocument;
// 获取所有选中的图层
var selectedLayers = getSelectedLayers();

// 记录粘贴前图层的数量，以便后续处理粘贴的图层
var initialLayerCount = doc.layers.length;

// 遍历选中的图层并进行操作
for (var i = 0; i < selectedLayers.length; i++) {
    var layer = selectedLayers[i];
    if (layer.typename === "ArtLayer") { // 选中的是一个图层
        // 选中当前图层
        selectLayers(layer);
        // 保存原图层名称和混合模式
        var originalName = layer.name;
        var originalBlendMode = layer.blendMode;

        // 执行粘贴命令
        doc.paste();
        
        // 获取粘贴后的所有图层（从粘贴前的图层数量到现在的图层数量之间的图层）
        var pastedLayers = [];
        for (var j = initialLayerCount; j < doc.layers.length; j++) {
            pastedLayers.push(doc.layers[j]);
        }

        // 创建剪切蒙版
        var pastedLayer = doc.activeLayer;
        pastedLayer.grouped = true;

        // 把当前图层加入选择
        addLayerToSelection(layer);

        // 合并图层
        mergeLayers();
        var mergedLayer = getSelectedLayers()[0];

        // 还原混合模式和名称
        mergedLayer.name = originalName;
        mergedLayer.blendMode = originalBlendMode;

    } else if (layer.typename === "LayerSet") { // 选中的是一个组
        // 这里可以根据需要添加组的处理逻辑
    }
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

// 选择复数图层
function selectLayers(layersArray) {
    // 检查是否有打开的文档
    if (app.documents.length === 0) {
        alert("没有打开的文档！");
        return;
    }

    var doc = app.activeDocument;
    var layerIndices = [];

    // 判断layersArray是否为数组
    if (!(layersArray instanceof Array)) {
        layersArray = [layersArray];
    }

    // 获取每个图层的索引（Photoshop 的图层索引从 1 开始）
    for (var i = 0; i < layersArray.length; i++) {
        layerIndices.push(layersArray[i].itemIndex);
    }

    // 构建 ActionDescriptor 设置选中状态
    var ref = new ActionReference();
    for (var j = 0; j < layerIndices.length; j++) {
        ref.putIndex(charIDToTypeID("Lyr "), layerIndices[j]);
    }

    var desc = new ActionDescriptor();
    desc.putReference(charIDToTypeID("null"), ref);
    desc.putBoolean(charIDToTypeID("MkVs"), false);

    // 执行选中操作
    executeAction(charIDToTypeID("slct"), desc, DialogModes.NO);
}

// 把图层加入选择
function addLayerToSelection(layer) {
    // 获取当前选中的图层索引
    var ref = new ActionReference();
    ref.putProperty(stringIDToTypeID("property"), stringIDToTypeID("targetLayers"));
    ref.putEnumerated(stringIDToTypeID("document"), stringIDToTypeID("ordinal"), stringIDToTypeID("targetEnum"));

    var desc = executeActionGet(ref);
    var targetLayers = desc.getList(stringIDToTypeID("targetLayers"));

    var selectedIndices = [];
    for (var i = 0; i < targetLayers.count; i++) {
        var index = targetLayers.getReference(i).getIndex() + 1; // Photoshop索引从1开始
        selectedIndices.push(index);
    }

    // 添加当前图层索引
    selectedIndices.push(layer.itemIndex);

    // 设置新的选中状态
    var newRef = new ActionReference();
    for (var j = 0; j < selectedIndices.length; j++) {
        newRef.putIndex(charIDToTypeID("Lyr "), selectedIndices[j]);
    }

    var newDesc = new ActionDescriptor();
    newDesc.putReference(charIDToTypeID("null"), newRef);
    newDesc.putBoolean(charIDToTypeID("MkVs"), false);

    // 执行选中操作
    executeAction(charIDToTypeID("slct"), newDesc, DialogModes.NO);
}

// 合并选择的多个图层
function mergeLayers() {
    var doc = app.activeDocument;
    // 获取选中的图层
    var selectedLayers = getSelectedLayers();
    if (selectedLayers.length > 1) {
        // 合并选中的图层
        var mergedLayer = doc.activeLayer.merge();
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
                var index = targetLayers.getReference(i).getIndex() + 1;
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
}