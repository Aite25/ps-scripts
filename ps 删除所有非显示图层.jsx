var doc = app.activeDocument;

// 记录初始状态下所有图层的可见性
var originalVisibility = {};

// 递归函数记录所有图层的初始可见性状态
function recordVisibility(layers, path) {
    for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        var layerPath = path ? path + "/" + layer.name : layer.name;
        originalVisibility[layerPath] = layer.visible;
        
        if (layer.typename === "LayerSet") {
            recordVisibility(layer.layers, layerPath);
        }
    }
}

// 记录所有图层的初始可见性
recordVisibility(doc.layers, "");

// 递归函数遍历图层（反向遍历）
function deleteUnvisiLayers(layers, parentPath) {
    for (var i = layers.length - 1; i >= 0; i--) {
        var layer = layers[i];
        var layerPath = parentPath ? parentPath + "/" + layer.name : layer.name;
        
        // 使用记录的初始可见性状态来判断
        var wasVisible = originalVisibility[layerPath];
        
        // 如果初始状态是不可见，则删除
        if (!wasVisible) {
            try {
                layer.remove();
                continue; // 删除后跳过后续处理
            } catch(e) {
                // 如果删除失败，记录错误但继续执行
                $.writeln("删除图层失败: " + layer.name + ", 错误: " + e);
            }
        }
        
        // 如果图层是可见的图层组，则递归处理其子图层
        if (layer.typename === "LayerSet") {
            deleteUnvisiLayers(layer.layers, layerPath);
        }
    }
}

// 在删除之前先记录所有图层的可见性状态
recordVisibility(doc.layers, "");

// 然后使用记录的信息进行删除操作
deleteUnvisiLayers(doc.layers, "");