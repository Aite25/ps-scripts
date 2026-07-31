// 脚本：拷贝文件夹图层样式给所有一级子图层，并隐藏文件夹图层样式
// 功能：将选中文件夹的图层样式复制到该文件夹下所有直接子图层，然后隐藏文件夹的图层样式

var doc = app.activeDocument;
doc.suspendHistory("拷贝文件夹图层样式到子图层", "main()");

function main() {
    // 获取选中的图层
    var selectedLayers = getSelectedLayers();

    if (selectedLayers.length === 0) {
        alert("请先选择一个或多个文件夹（图层组）！");
        return;
    }

    for (var i = 0; i < selectedLayers.length; i++) {
        var layer = selectedLayers[i];
        if (layer.typename !== "LayerSet") {
            alert("\"" + layer.name + "\" 不是文件夹，已跳过。");
            continue;
        }
        processLayerSet(layer);
    }
}

function processLayerSet(layerSet) {
    // 检查文件夹是否有图层样式
    if (!hasLayerEffects(layerSet)) {
        alert("文件夹 \"" + layerSet.name + "\" 没有图层样式，已跳过。");
        return;
    }

    // 获取所有直接子图层（不递归进入嵌套组）
    var children = [];
    for (var i = 0; i < layerSet.layers.length; i++) {
        children.push(layerSet.layers[i]);
    }

    if (children.length === 0) {
        alert("文件夹 \"" + layerSet.name + "\" 内没有子图层。");
        return;
    }

    // 1. 从文件夹直接读取图层效果描述符
    var effectsDesc = getLayerEffectsDesc(layerSet.id);

    // 2. 遍历子图层，写入图层效果
    for (var j = 0; j < children.length; j++) {
        applyEffectsToLayer(children[j].id, effectsDesc);
    }

    // 3. 选中文件夹，清除图层效果
    selectLayerById(layerSet.id);
    clearLayerEffects();
}

// ========== 图层样式检测与操作 ==========

// 检查图层是否有图层样式（fx）
function hasLayerEffects(layer) {
    try {
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), layer.id);
        var desc = executeActionGet(ref);
        return desc.hasKey(stringIDToTypeID("layerEffects"));
    } catch (e) {
        return false;
    }
}

// 从指定图层读取图层效果描述符
function getLayerEffectsDesc(layerId) {
    var ref = new ActionReference();
    ref.putIdentifier(charIDToTypeID("Lyr "), layerId);
    var desc = executeActionGet(ref);
    return desc.getObjectValue(stringIDToTypeID("layerEffects"));
}

// 将图层效果描述符写入指定图层
function applyEffectsToLayer(layerId, effectsDesc) {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putIdentifier(charIDToTypeID("Lyr "), layerId);
    desc.putReference(charIDToTypeID("null"), ref);
    desc.putObject(charIDToTypeID("T   "), stringIDToTypeID("layerEffects"), effectsDesc);
    executeAction(charIDToTypeID("setd"), desc, DialogModes.NO);
}

// 清除当前选中图层的所有图层效果
function clearLayerEffects() {
    try {
        var ref = new ActionReference();
        ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        var layerDesc = executeActionGet(ref);
        if (!layerDesc.hasKey(stringIDToTypeID("layerEffects"))) return;

        var fxDesc = layerDesc.getObjectValue(stringIDToTypeID("layerEffects"));
        var disabledDesc = new ActionDescriptor();
        for (var i = 0; i < fxDesc.count; i++) {
            var key = fxDesc.getKey(i);
            var fxType = fxDesc.getType(key);
            if (fxType == DescValueType.OBJECTTYPE) {
                var obj = fxDesc.getObjectValue(key);
                obj.putBoolean(stringIDToTypeID("enabled"), false);
                disabledDesc.putObject(key, key, obj);
            }
        }

        var setDesc = new ActionDescriptor();
        setDesc.putReference(charIDToTypeID("null"), ref);
        setDesc.putObject(charIDToTypeID("T   "), stringIDToTypeID("layerEffects"), disabledDesc);
        executeAction(charIDToTypeID("setd"), setDesc, DialogModes.NO);
    } catch (e) {
        alert("清除图层效果失败: " + e);
    }
}

// ========== 通用工具函数 ==========

// 根据ID选择图层
function selectLayerById(id) {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putIdentifier(charIDToTypeID("Lyr "), id);
    desc.putReference(charIDToTypeID("null"), ref);
    desc.putBoolean(charIDToTypeID("MkVs"), false);
    executeAction(charIDToTypeID("slct"), desc, DialogModes.NO);
}

// 获取所有选中的图层
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
    } else {
        try {
            selectedLayers.push(app.activeDocument.activeLayer);
        } catch (e) {}
    }
    return selectedLayers;
}

// 根据索引递归获取图层
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
    return findLayerByIndex(app.activeDocument, index);
}