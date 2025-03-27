var doc = app.activeDocument;
// 递归函数遍历图层
function unlockLayers(layers) {
    for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        var visi = layer.visible;
        layer.allLocked = false;
        layer.visible = visi;
        
        // 如果图层是图层组，递归遍历其子图层
        if (layer.typename === "LayerSet") {
            unlockLayers(layer.layers);
        }
    }
}
unlockLayers(doc.layers);