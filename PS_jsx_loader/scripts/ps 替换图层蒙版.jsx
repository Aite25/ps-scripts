// 脚本：将第二个选择的图层的图层蒙版替换给第一个选择的图层
// 描述：此脚本会自动将第二个选择的图层的蒙版复制给第一个选择的图层，如果第二个选择的图层没有蒙版，可以选择创建一个全白蒙版
// 作者：GitHub Copilot
// 日期：2025-06-21
// 版本：1.5 - 修改为使用用户选择的图层而不是文档索引

// 主函数
function main() {
    // 检查是否有文档打开
    if (app.documents.length === 0) {
        alert("请先打开一个文档！");
        return;
    }
    
    try {
        // 获取当前活动文档
        var doc = app.activeDocument;
        
        // 获取用户选择的图层
        var selectedLayers = getSelectedLayers();
        
        // 检查是否选择了至少两个图层
        if (selectedLayers.length < 2) {
            alert("请至少选择两个图层！\n当前选择了 " + selectedLayers.length + " 个图层。\n\n第一个选择的图层将作为目标图层，第二个选择的图层将作为源图层。");
            return;
        }
        
        // 获取第一和第二个选择的图层
        var targetLayer = selectedLayers[0]; // 第一个选择的图层（目标图层）
        var sourceLayer = selectedLayers[1]; // 第二个选择的图层（源图层）
        
        // 显示将要操作的图层信息
        var infoMsg = "将要执行的操作：\n";
        infoMsg += "源图层（第二个选择）: " + sourceLayer.name + "\n";
        infoMsg += "目标图层（第一个选择）: " + targetLayer.name + "\n";
        
        // 添加蒙版检测结果信息
        var sourceMaskInfo = hasLayerMaskDetailed(sourceLayer);
        infoMsg += "\n源图层蒙版检测详情：\n" + sourceMaskInfo.message;
        
        alert(infoMsg);
        
        // 检查源图层是否有蒙版
        if (!sourceMaskInfo.hasMask) {
            var confirmCreate = Window.confirm("源图层（" + sourceLayer.name + "）没有图层蒙版！\n\n是否要为源图层创建一个全白（全不透明）的蒙版，然后复制到目标图层？");
            if (confirmCreate) {
                // 为源图层创建一个新的全白蒙版
                addWhiteMask(sourceLayer);
            } else {
                return; // 用户选择不创建蒙版，退出脚本
            }
        }
          // 如果目标图层已有蒙版，先删除它
        var targetMaskInfo = hasLayerMaskDetailed(targetLayer);
        if (targetMaskInfo.hasMask) {
            removeLayerMask(targetLayer);
        }
        
        // 复制源图层的蒙版到目标图层
        if (copyLayerMask(sourceLayer, targetLayer)) {
            alert("蒙版已成功从\"" + sourceLayer.name + "\"复制到\"" + targetLayer.name + "\"！");
        }
    } catch (e) {
        alert("发生错误：" + e);
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
    } else {
        // 如果没有多选图层，返回当前活动图层
        if (app.activeDocument.activeLayer) {
            selectedLayers.push(app.activeDocument.activeLayer);
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
    return findLayerByIndex(app.activeDocument, index);
}

// 检查图层是否有蒙版并返回详细信息（增强版，综合多种检测方法）
function hasLayerMaskDetailed(layer) {
    if (!layer) return { hasMask: false, message: "无效的图层对象" };
    
    var result = { hasMask: false, message: "" };
    var methods = [];
    
    try {
        // 方法1: 直接检查 maskEnabled 属性
        try {
            if (layer.maskEnabled) {
                methods.push("方法1 (maskEnabled): 检测到蒙版");
                result.hasMask = true;
            } else {
                methods.push("方法1 (maskEnabled): 未检测到蒙版");
            }
        } catch (e) {
            methods.push("方法1 (maskEnabled): 检测失败 - " + e.message);
        }
        
        // 方法2: 尝试检查 hasOwnProperty
        try {
            if (layer.hasOwnProperty("mask") || layer.hasOwnProperty("maskEnabled")) {
                methods.push("方法2 (hasOwnProperty): 检测到蒙版属性");
                result.hasMask = true;
            } else {
                methods.push("方法2 (hasOwnProperty): 未检测到蒙版属性");
            }
        } catch (e) {
            methods.push("方法2 (hasOwnProperty): 检测失败 - " + e.message);
        }
        
        // 方法3: 使用 ActionManager 检查（最可靠，同时兼容图层组/文件夹）
        try {
            var ref = new ActionReference();
            ref.putIdentifier(charIDToTypeID("Lyr "), layer.id);
            var layerDesc = executeActionGet(ref);
            
            // 检查是否有用户蒙版（像素蒙版），使用 userMaskEnabled 键更可靠，对图层组同样有效
            if (layerDesc.hasKey(stringIDToTypeID("userMaskEnabled"))) {
                methods.push("方法3 (ActionManager ID): 检测到用户蒙版");
                result.hasMask = true;
            } else {
                methods.push("方法3 (ActionManager ID): 未检测到用户蒙版");
            }
            
            // 也检查矢量蒙版
            if (layerDesc.hasKey(stringIDToTypeID("vectorMaskEnabled"))) {
                methods.push("方法3 (ActionManager ID): 检测到矢量蒙版");
                result.hasMask = true;
            }
        } catch (e1) {
            methods.push("方法3 (ActionManager ID): 检测失败 - " + e1.message);
        }
        
        // 构建详细信息消息
        result.message = methods.join("\n");
        
        return result;
    } catch (e) {
        return { 
            hasMask: false, 
            message: "检查图层蒙版时出错: " + e.message 
        };
    }
}

// 检查图层是否有蒙版（简化版，只返回布尔值）
function hasLayerMask(layer) {
    return hasLayerMaskDetailed(layer).hasMask;
}

// 删除图层蒙版
function removeLayerMask(layer) {
    try {
        // 记录当前活动图层
        var currentActiveLayer = app.activeDocument.activeLayer;
        
        // 选择图层
        app.activeDocument.activeLayer = layer;
        
        // 删除蒙版
        var idDlt = charIDToTypeID("Dlt ");
        var desc = new ActionDescriptor();
        var idnull = charIDToTypeID("null");
        var ref = new ActionReference();
        var idChnl = charIDToTypeID("Chnl");
        var idMsk = charIDToTypeID("Msk ");
        ref.putEnumerated(idChnl, idChnl, idMsk);
        desc.putReference(idnull, ref);
        executeAction(idDlt, desc, DialogModes.NO);
        
        // 恢复原始活动图层
        app.activeDocument.activeLayer = currentActiveLayer;
        
        return true;
    } catch (e) {
        // 如果删除失败，可能是因为没有蒙版，忽略错误
        return false;
    }
}

// 从源图层复制蒙版到目标图层
function copyLayerMask(sourceLayer, targetLayer) {
    try {
        // 记录文档历史状态以便在出错时恢复
        var initialState = app.activeDocument.activeHistoryState;
        
        // 记录当前活动图层
        var currentActiveLayer = app.activeDocument.activeLayer;
        
        // 方案：将源蒙版复制为临时 Alpha 通道 → 加载为选区 → 从选区创建目标蒙版 → 删除临时通道
        // 此方案完全避免进入蒙版编辑状态，兼容普通图层和文件夹图层
        var tempChannel = null;
        try {
            // 1. 激活源图层
            app.activeDocument.activeLayer = sourceLayer;

            // 2. 将源图层蒙版通道复制为独立 Alpha 通道
            var descDup = new ActionDescriptor();
            var refDupSrc = new ActionReference();
            refDupSrc.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
            descDup.putReference(charIDToTypeID("null"), refDupSrc);
            var refDupDst = new ActionReference();
            refDupDst.putClass(charIDToTypeID("Chnl"));
            descDup.putReference(charIDToTypeID("T   "), refDupDst);
            executeAction(charIDToTypeID("Dplc"), descDup, DialogModes.NO);

            // 3. 记录刚复制出的临时通道（位于通道面板末尾）
            var channels = app.activeDocument.channels;
            tempChannel = channels[channels.length - 1];

            // 4. 将临时通道加载为选区（ExtendScript 原生 API，最可靠）
            app.activeDocument.selection.load(tempChannel, SelectionType.REPLACE, false);

            // 5. 激活目标图层
            app.activeDocument.activeLayer = targetLayer;

            // 6. 确保目标图层没有蒙版，有则先删除
            if (hasLayerMask(targetLayer)) {
                removeLayerMask(targetLayer);
            }

            // 7. 基于当前选区为目标图层创建蒙版（显示选区内容）
            var descMk = new ActionDescriptor();
            descMk.putClass(charIDToTypeID("Nw  "), charIDToTypeID("Chnl"));
            var refMkAt = new ActionReference();
            refMkAt.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
            descMk.putReference(charIDToTypeID("At  "), refMkAt);
            descMk.putEnumerated(charIDToTypeID("Usng"), charIDToTypeID("UsrM"), charIDToTypeID("RvlS"));
            executeAction(charIDToTypeID("Mk  "), descMk, DialogModes.NO);

            // 8. 取消选区
            app.activeDocument.selection.deselect();

            // 9. 删除临时 Alpha 通道
            tempChannel.remove();
            tempChannel = null;

            // 10. 恢复原始活动图层
            app.activeDocument.activeLayer = currentActiveLayer;

            return true;
        } catch (e) {
            // 清理临时通道
            if (tempChannel) {
                try { tempChannel.remove(); } catch (e2) {}
            }
            alert("复制蒙版过程中出错: " + e + "\n\n尝试恢复文档状态...");
            try {
                app.activeDocument.activeHistoryState = initialState;
            } catch (restoreError) {
                alert("无法恢复文档状态: " + restoreError);
            }
            return false;
        }
    } catch (e) {
        alert("复制蒙版时出错：" + e);
        return false;
    }
}

// 为图层添加全白（完全不透明）的图层蒙版
function addWhiteMask(layer) {
    try {
        // 记录当前活动图层
        var currentActiveLayer = app.activeDocument.activeLayer;
        
        // 选择目标图层
        app.activeDocument.activeLayer = layer;
        
        // 创建图层蒙版（白色/完全显示）
        var idMk = charIDToTypeID("Mk  ");
        var desc = new ActionDescriptor();
        var idNw = charIDToTypeID("Nw  ");
        var idChnl = charIDToTypeID("Chnl");
        desc.putClass(idNw, idChnl);
        var idAt = charIDToTypeID("At  ");
        var ref = new ActionReference();
        var idChnl = charIDToTypeID("Chnl");
        var idChnl = charIDToTypeID("Chnl");
        var idMsk = charIDToTypeID("Msk ");
        ref.putEnumerated(idChnl, idChnl, idMsk);
        desc.putReference(idAt, ref);
        var idUsng = charIDToTypeID("Usng");
        var idUsrM = charIDToTypeID("UsrM");
        var idRvlA = charIDToTypeID("RvlA"); // 白色蒙版，完全显示
        desc.putEnumerated(idUsng, idUsrM, idRvlA);
        executeAction(idMk, desc, DialogModes.NO);
        
        // 恢复原始活动图层
        app.activeDocument.activeLayer = currentActiveLayer;
        
        return true;
    } catch (e) {
        alert("创建蒙版时出错：" + e);
        return false;
    }
}

// 执行主函数
app.activeDocument.suspendHistory("替换图层蒙版", "main()");
