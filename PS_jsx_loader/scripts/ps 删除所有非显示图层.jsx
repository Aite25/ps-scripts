var doc = app.activeDocument;

// 将所有操作包装在一个历史状态中，实现一键撤回
doc.suspendHistory("删除所有非显示图层", "main()");

function main() {
    // 预处理：若 clip 图层所依赖的基底图层眼睛关闭，则同步关闭该 clip 图层的眼睛
    // 这样后续删除逻辑可以将它们一并清理
    function syncClipVisibility(layers) {
        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            // 先递归处理组内图层
            if (layer.typename === "LayerSet") {
                syncClipVisibility(layer.layers);
            }
            // 若当前图层是 clip 且眼睛打开，检查其基底图层
            if (layer.grouped && layer.visible) {
                // 基底图层是同级中该 clip 链下方第一个非 clip 图层
                var baseLayer = null;
                for (var j = i + 1; j < layers.length; j++) {
                    if (!layers[j].grouped) {
                        baseLayer = layers[j];
                        break;
                    }
                }
                if (baseLayer && !baseLayer.visible) {
                    layer.visible = false;
                }
            }
        }
    }

    // 递归函数遍历图层（反向遍历）
    function deleteUnvisiLayers(layers) {
        for (var i = layers.length - 1; i >= 0; i--) {
            var layer = layers[i];

            // 实时检测当前图层是否可见，可见则跳过
            if (layer.visible) {
                // 可见的图层组仍需递归检查其子图层
                if (layer.typename === "LayerSet") {
                    deleteUnvisiLayers(layer.layers);
                }
                continue;
            }

            // 图层不可见：若为剪贴蒙版则跳过不删除
            if (layer.grouped) {
                continue;
            }

            try {
                layer.remove();
            } catch(e) {}
        }
    }

    syncClipVisibility(doc.layers);
    deleteUnvisiLayers(doc.layers);
}