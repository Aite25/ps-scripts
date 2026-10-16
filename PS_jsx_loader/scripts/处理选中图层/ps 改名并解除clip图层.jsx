#target photoshop

/**
 * 遍历所有选中的图层：
 * 1. 在图层名前加上 "clip_"
 * 2. 解除该图层的 clip（剪贴蒙版）状态
 */

var doc = app.activeDocument;
doc.suspendHistory("改名并解除 clip 图层", "main()");

function main() {
    var selectedLayers = getSelectedLayers();

    if (selectedLayers.length === 0) {
        alert("请先选中至少一个图层。");
        return;
    }

    // 按 itemIndex 降序（先处理面板底部图层，避免破坏上方 clip 链）
    selectedLayers.sort(function (a, b) { return b.itemIndex - a.itemIndex; });

    var processed = [];

    for (var i = 0; i < selectedLayers.length; i++) {
        var layer = selectedLayers[i];
        var originalName = layer.name;

        // 1. 解除 clip 状态
        releaseClip(layer);

        // 2. 重命名：加 "clip_" 前缀
        layer.name = "clip_" + originalName;

        processed.push(originalName + " → " + layer.name);
    }
}

function getSelectedLayers() {
        var selectedLayers = [];
        var ref = new ActionReference();
        ref.putProperty(stringIDToTypeID("property"), stringIDToTypeID("targetLayers"));
        ref.putEnumerated(stringIDToTypeID("document"), stringIDToTypeID("ordinal"), stringIDToTypeID("targetEnum"));
        var desc = executeActionGet(ref);

        if (desc.hasKey(stringIDToTypeID("targetLayers"))) {
            var targetList = desc.getList(stringIDToTypeID("targetLayers"));
            for (var i = 0; i < targetList.count; i++) {
                var index = targetList.getReference(i).getIndex() + 1; // PS 索引从 1 开始
                var layer = getLayerByIndex(index);
                if (layer) selectedLayers.push(layer);
            }
        }

        return selectedLayers.length > 0 ? selectedLayers : [doc.activeLayer];
}

// 根据 itemIndex 递归查找图层（支持组内图层）
function getLayerByIndex(index) {
    function findLayer(layerSet, idx) {
        for (var i = 0; i < layerSet.layers.length; i++) {
            var layer = layerSet.layers[i];
            if (layer.itemIndex === idx) return layer;
            if (layer.typename === "LayerSet") {
                var found = findLayer(layer, idx);
                if (found) return found;
            }
        }
        return null;
    }
    return findLayer(doc, index);
}

// 通过 AM 精确选中指定 ID 的图层
function selectLayerById(id) {
    var ref = new ActionReference();
    ref.putIdentifier(charIDToTypeID("Lyr "), id);
    var desc = new ActionDescriptor();
    desc.putReference(charIDToTypeID("null"), ref);
    desc.putBoolean(charIDToTypeID("MkVs"), false);
    executeAction(charIDToTypeID("slct"), desc, DialogModes.NO);
}

// 解除指定图层的 clip 状态
function releaseClip(layer) {
    try {
        selectLayerById(layer.id);
        executeAction(charIDToTypeID("Dgrp"), new ActionDescriptor(), DialogModes.NO);
        return;
    } catch (e) {}
    try { layer.grouped = false; } catch (e2) {}
}
