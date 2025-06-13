var doc = app.activeDocument;
// 获取所有选中的图层
var secL = getSelectedLayers();
// 遍历选中的图层并进行操作
for (var i = 0; i < secL.length; i++) {
    var layer = secL[i];
    if (layer.typename === "ArtLayer") {// 选中的是一个图层
        processLayer(layer);
    }else if(layer.typename === "LayerSet"){// 选中的是一个组
        // 组不进行处理
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