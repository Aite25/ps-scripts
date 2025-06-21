// 创建双色填充并复制蒙版（增强版）
// 功能：在选择的图层或文件夹上新建两个纯色填充（白色和黑色），白色在上黑色在下
// 为白色填充图层创建图层蒙版，然后将选择图层的图层蒙版复制到白色填充图层
// 使用增强的蒙版检测和复制方法，兼容性更好

// 检查是否有活动文档
if (app.documents.length === 0) {
    alert("请先打开一个文档！");
} else {
    try {
        // 创建一个撤销点
        app.activeDocument.suspendHistory("创建双色填充并复制蒙版", "main()");
    } catch (e) {
        alert("执行脚本时出错: " + e);
    }
}

function main() {
    try {
        var doc = app.activeDocument;
        // 获取所有选中的图层
        var selectedLayers = getSelectedLayers();
        
        // 如果没有选中图层，提示用户
        if (selectedLayers.length === 0) {
            alert("请先选择至少一个图层或组！");
            return;
        }
        
        // 遍历选中的图层并进行操作
        for (var i = 0; i < selectedLayers.length; i++) {
            var layer = selectedLayers[i];
            try {
                processLayer(layer);
            } catch (e) {
                alert("处理图层 '" + layer.name + "' 时出错: " + e);
                // 继续处理下一个图层
            }
        }
    } catch (e) {
        alert("执行主函数时出错: " + e);
    }
}

// 处理单个图层或组的函数
function processLayer(layer) {
    try {
        var doc = app.activeDocument;
        var originalName = layer.name;
        
        // 激活当前图层
        try {
            selectLayerById(layer.id);
        } catch (e) {
            try {
                app.activeDocument.activeLayer = layer;
            } catch (selectErr) {
                return;
            }
        }
        
        // 检查当前图层类型
        if (layer.typename === "LayerSet") {
            // 如果是图层组，使用不同的方法处理
            processLayerSet(layer);
        } else {
            // 如果是普通图层，按照原来的方式处理
            // 检查当前图层是否有蒙版
            var hasMask = hasLayerMask(layer);
            
            // 创建白色填充图层
            var whiteLayer = createSolidColorLayerSafe("白色填充", [255, 255, 255]);
            if (!whiteLayer) {
                return;
            }
            
            // 创建黑色填充图层
            var blackLayer = createSolidColorLayerSafe("黑色填充", [0, 0, 0]);
            if (!blackLayer) {
                return;
            }
            
            // 移动填充图层到原图层的上方，白色在最上方，黑色在白色下方
            try {
                moveLayerSafe(whiteLayer, layer, true);
                moveLayerSafe(blackLayer, whiteLayer, false);
            } catch (moveErr) {
                // 移动图层时出错
            }
            
            // 为白色图层创建蒙版
            try {
                // 创建白色图层的蒙版
                var maskCreated = createEmptyMaskForLayer(whiteLayer);
                
                if (maskCreated) {
                    // 如果原图层有蒙版，复制到白色图层
                    if (hasMask) {
                        // 使用增强的复制蒙版函数
                        copyLayerMask(layer, whiteLayer);
                    }
                }
            } catch (maskErr) {
                // 处理蒙版时出错
            }
            
            // 合并白色图层和黑色图层
            try {
                // 选择白色图层
                app.activeDocument.activeLayer = whiteLayer;
                // 合并图层
                mergeLayerDown();
                // 获取合并后的图层（现在是当前活动图层）
                var mergedLayer = app.activeDocument.activeLayer;
                // 将合并后的图层命名为原图层名 + " mask"
                mergedLayer.name = originalName + " mask";
            } catch (mergeErr) {
                // 合并图层时出错
            }
        }
    } catch (e) {
        alert("处理图层 '" + layer.name + "' 时出错: " + e);
    }
}

// 处理图层组的函数
function processLayerSet(layerSet) {
    try {
        var originalName = layerSet.name;
        
        // 创建白色填充图层
        var whiteLayer = createSolidColorLayerSafe("白色填充", [255, 255, 255]);
        if (!whiteLayer) {
            return;
        }
        
        // 创建黑色填充图层
        var blackLayer = createSolidColorLayerSafe("黑色填充", [0, 0, 0]);
        if (!blackLayer) {
            return;
        }
        
        // 移动填充图层到原图层组的上方，白色在最上方，黑色在白色下方
        try {
            // 使用安全的移动方法
            moveLayerSafe(whiteLayer, layerSet, true); // true表示放在上方
            moveLayerSafe(blackLayer, whiteLayer, false); // false表示放在下方
        } catch (moveErr) {
            // 移动图层时出错
        }
        
        // 为白色图层创建蒙版
        try {
            // 创建白色图层的蒙版
            var maskCreated = createEmptyMaskForLayer(whiteLayer);
            
            if (maskCreated) {
                // 检查图层组是否有蒙版并尝试复制
                var hasMask = hasLayerMask(layerSet);
                if (hasMask) {
                    // 使用增强的复制蒙版函数
                    copyLayerMask(layerSet, whiteLayer);
                }
            }
        } catch (maskErr) {
            // 处理蒙版时出错
        }
        
        // 合并白色图层和黑色图层
        try {
            // 选择白色图层
            app.activeDocument.activeLayer = whiteLayer;
            // 合并图层
            mergeLayerDown();
            // 获取合并后的图层（现在是当前活动图层）
            var mergedLayer = app.activeDocument.activeLayer;
            // 将合并后的图层命名为原图层组名 + " mask"
            mergedLayer.name = originalName + " mask";
        } catch (mergeErr) {
            // 合并图层时出错
        }
    } catch (e) {
        alert("处理图层组时出错: " + e);
    }
}

// 安全地创建纯色填充图层
function createSolidColorLayerSafe(name, colorArray) {
    try {
        // 记住当前活动图层
        var currentLayer = app.activeDocument.activeLayer;
        
        // 尝试用更简单的方法创建填充图层
        var newSolidLayer = null;
        
        // 方法1：使用标准方法
        try {
            // 创建一个新的普通图层
            var newLayer = app.activeDocument.artLayers.add();
            
            // 填充颜色
            var solidColor = new SolidColor();
            solidColor.rgb.red = colorArray[0];
            solidColor.rgb.green = colorArray[1];
            solidColor.rgb.blue = colorArray[2];
            
            // 填充图层
            app.activeDocument.selection.selectAll();
            app.activeDocument.selection.fill(solidColor);
            app.activeDocument.selection.deselect();
            
            // 重命名图层
            newLayer.name = name;
            
            newSolidLayer = newLayer;
        } catch (e1) {
            // 如果方法1失败，尝试方法2
            try {
                // 方法2：使用原始方法
                var solidColor = new SolidColor();
                solidColor.rgb.red = colorArray[0];
                solidColor.rgb.green = colorArray[1];
                solidColor.rgb.blue = colorArray[2];
                
                var desc = new ActionDescriptor();
                var ref = new ActionReference();
                ref.putClass(stringIDToTypeID('contentLayer'));
                desc.putReference(charIDToTypeID('null'), ref);
                
                var fillDesc = new ActionDescriptor();
                var colorDesc = new ActionDescriptor();
                colorDesc.putDouble(charIDToTypeID('Rd  '), solidColor.rgb.red);
                colorDesc.putDouble(charIDToTypeID('Grn '), solidColor.rgb.green);
                colorDesc.putDouble(charIDToTypeID('Bl  '), solidColor.rgb.blue);
                fillDesc.putObject(charIDToTypeID('Clr '), charIDToTypeID('RGBC'), colorDesc);
                desc.putObject(charIDToTypeID('Usng'), stringIDToTypeID('contentLayer'), fillDesc);
                
                executeAction(charIDToTypeID('Mk  '), desc, DialogModes.NO);
                
                // 重命名图层
                app.activeDocument.activeLayer.name = name;
                
                newSolidLayer = app.activeDocument.activeLayer;
            } catch (e2) {
                return null;
            }
        }
        
        return newSolidLayer;
    } catch (e) {
        return null;
    }
}

// 安全地移动图层
function moveLayerSafe(layerToMove, relativeTo, placeAbove) {
    try {
        if (placeAbove) {
            layerToMove.move(relativeTo, ElementPlacement.PLACEBEFORE);
        } else {
            layerToMove.move(relativeTo, ElementPlacement.PLACEAFTER);
        }
    } catch (e) {
        // 尝试使用替代方法
        try {
            // 选择要移动的图层
            app.activeDocument.activeLayer = layerToMove;
            
            // 创建描述符
            var desc = new ActionDescriptor();
            var ref = new ActionReference();
            ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            desc.putReference(charIDToTypeID("null"), ref);
            
            var relRef = new ActionReference();
            relRef.putIdentifier(charIDToTypeID("Lyr "), relativeTo.id);
            desc.putReference(charIDToTypeID("T   "), relRef);
            
            // 决定放在图层上方还是下方
            if (placeAbove) {
                desc.putBoolean(charIDToTypeID("Adjs"), false);
                desc.putInteger(charIDToTypeID("Vrsn"), 5);
            } else {
                desc.putBoolean(charIDToTypeID("Adjs"), true);
                desc.putInteger(charIDToTypeID("Vrsn"), 5);
            }
            
            executeAction(charIDToTypeID("move"), desc, DialogModes.NO);
        } catch (moveErr) {
            // 移动图层失败
        }
    }
}

// 为图层创建空白蒙版
function createEmptyMaskForLayer(targetLayer) {
    try {
        // 选择目标图层
        app.activeDocument.activeLayer = targetLayer;
        
        try {
            // 方法1：使用最直接的方法添加图层蒙版 - 执行菜单命令"图层 > 图层蒙版 > 显示全部"
            if (targetLayer.typename === "ArtLayer") {
                targetLayer.addLayerMask(AddLayerMaskType.REVEALALL);
                return true; // 成功创建蒙版
            } else {
                throw new Error("不是艺术图层，尝试其他方法");
            }
        } catch (e1) {
            // 方法2：使用动作描述符添加蒙版 - 最常用的方法
            try {
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
                var idRvlA = charIDToTypeID("RvlA"); // 使用"RvlA"(全部显示)
                desc.putEnumerated(idUsng, idUsrM, idRvlA);
                executeAction(idMk, desc, DialogModes.NO);
                return true; // 成功创建蒙版
            } catch (e2) {
                // 方法3：简化版本的动作描述符
                try {
                    var idMk = charIDToTypeID("Mk  ");
                    var desc = new ActionDescriptor();
                    var idNw = charIDToTypeID("Nw  ");
                    var idChnl = charIDToTypeID("Chnl");
                    desc.putClass(idNw, idChnl);
                    var idAt = charIDToTypeID("At  ");
                    var ref = new ActionReference();
                    var idChnl = charIDToTypeID("Chnl");
                    var idMsk = charIDToTypeID("Msk ");
                    ref.putEnumerated(idChnl, idChnl, idMsk);
                    desc.putReference(idAt, ref);
                    executeAction(idMk, desc, DialogModes.NO);
                    return true; // 成功创建蒙版
                } catch (e3) {
                    // 所有方法都失败
                    return false;
                }
            }
        }
    } catch (e) {
        return false;
    }
}

// ======= 从 ps 按索引替换图层蒙版.jsx 提取的增强蒙版检测和复制函数 =======

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
        
        // 方法3: 使用 ActionManager 检查 (最可靠的方法)
        try {
            var ref = new ActionReference();
            ref.putIdentifier(charIDToTypeID("Lyr "), layer.id);
            var desc = executeActionGet(ref);
            
            // 检查是否有用户蒙版
            if (desc.hasKey(charIDToTypeID("UsrM"))) {
                methods.push("方法3 (ActionManager ID): 检测到用户蒙版");
                result.hasMask = true;
            } else {
                methods.push("方法3 (ActionManager ID): 未检测到用户蒙版");
            }
            
            // 也检查一下矢量蒙版
            if (desc.hasKey(charIDToTypeID("vscm"))) {
                methods.push("方法3 (ActionManager ID): 检测到矢量蒙版");
                result.hasMask = true;
            }
        } catch (e1) {
            methods.push("方法3 (ActionManager ID): 检测失败 - " + e1.message);
            
            try {
                // 如果通过ID引用失败，尝试通过索引引用
                var ref = new ActionReference();
                ref.putProperty(charIDToTypeID("Prpr"), charIDToTypeID("UsrM"));
                ref.putIndex(charIDToTypeID("Lyr "), app.activeDocument.layers.indexOf(layer) + 1);
                executeActionGet(ref);
                methods.push("方法3 (ActionManager 索引): 检测到蒙版");
                result.hasMask = true;
            } catch (e2) {
                methods.push("方法3 (ActionManager 索引): 未检测到蒙版");
            }
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
        
        // 使用最直接的方法 - 通过选区
        try {
            // 1. 确保目标图层没有蒙版，如果有先删除
            if (hasLayerMask(targetLayer)) {
                removeLayerMask(targetLayer);
            }
            
            // 2. 选择源图层
            app.activeDocument.activeLayer = sourceLayer;
            
            // 3. 加载图层蒙版为选区
            var idsetd = charIDToTypeID("setd");
            var desc = new ActionDescriptor();
            var idnull = charIDToTypeID("null");
            var ref = new ActionReference();
            var idChnl = charIDToTypeID("Chnl");
            ref.putProperty(idChnl, charIDToTypeID("fsel"));
            desc.putReference(idnull, ref);
            var idT = charIDToTypeID("T   ");
            var ref2 = new ActionReference();
            var idChnl = charIDToTypeID("Chnl");
            var idChnl = charIDToTypeID("Chnl");
            var idMsk = charIDToTypeID("Msk ");
            ref2.putEnumerated(idChnl, idChnl, idMsk);
            desc.putReference(idT, ref2);
            executeAction(idsetd, desc, DialogModes.NO);
            
            // 4. 选择目标图层
            app.activeDocument.activeLayer = targetLayer;
            
            // 5. 基于选区创建蒙版
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
            var idRvlS = charIDToTypeID("RvlS"); // 使用选区
            desc.putEnumerated(idUsng, idUsrM, idRvlS);
            executeAction(idMk, desc, DialogModes.NO);
            
            // 6. 取消选区
            app.activeDocument.selection.deselect();
            
            // 7. 恢复原始活动图层
            app.activeDocument.activeLayer = currentActiveLayer;
            
            return true;
        } catch (e) {
            // 如果出错，尝试恢复到初始状态
            try {
                app.activeDocument.activeHistoryState = initialState;
            } catch (restoreError) {
                // 无法恢复文档状态
            }
            return false;
        }
    } catch (e) {
        return false;
    }
}

// 将当前图层与下方图层合并
function mergeLayerDown() {
    try {
        // 使用动作描述符执行"合并向下"命令
        var idMrgd = charIDToTypeID("Mrg2");
        var desc = new ActionDescriptor();
        executeAction(idMrgd, desc, DialogModes.NO);
        return true;
    } catch (e) {
        return false;
    }
}

// 获取选中的图层的辅助函数
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
        // 如果没有多选图层，则返回当前活动图层
        try {
            selectedLayers.push(app.activeDocument.activeLayer);
        } catch (e) {
            // 获取选中图层时出错
        }
    }
    return selectedLayers;
}

// 根据ID选择图层
function selectLayerById(id) {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putIdentifier(charIDToTypeID('Lyr '), id);
    desc.putReference(charIDToTypeID('null'), ref);
    executeAction(charIDToTypeID('slct'), desc, DialogModes.NO);
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
