var doc = app.activeDocument;

// 递归函数遍历图层（反向遍历）
function deleteUnvisiLayers(layers) {
    for (var i = layers.length - 1; i >= 0; i--) {
        var layer = layers[i];

        // 如果图层是图层组，先递归处理其子图层
        if (layer.typename === "LayerSet") {
            deleteUnvisiLayers(layer.layers);
        }

        // 检查是否可见，不可见则删除
        if (!layer.visible) {
            layer.remove();
        }
    }
}

deleteUnvisiLayers(doc.layers);