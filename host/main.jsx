function runScript(filePath) {
    try {
        $.evalFile(filePath);
    } catch (e) {}
}

// --- legacy helpers kept for reference, not used by runScript ---
function __mergeSelectedLayersToEmptyMain_unused() {
    var doc = app.activeDocument;
    var selectedLayers = __getSelectedLayers(doc);
    $.global.__mergeSelectedHandledCount = 0;

    if (!selectedLayers.length) {
        return;
    }

    for (var i = 0; i < selectedLayers.length; i++) {
        var layer = selectedLayers[i];
        if (layer.typename === "ArtLayer") {
            __processLayer(doc, layer);
            $.global.__mergeSelectedHandledCount++;
        }
    }
}

function __processLayer(doc, layer) {
    try {
        var originalBlendMode = layer.blendMode;
        var originalName = layer.name;

        __selectLayerById(layer.id);

        var emptyLayer = doc.artLayers.add();
        emptyLayer.move(layer, ElementPlacement.PLACEAFTER);

        __mergeLayersWithAction(layer.id);

        var mergedLayer = doc.activeLayer;
        mergedLayer.blendMode = originalBlendMode;
        mergedLayer.name = originalName;
    } catch (e) {
        alert("处理图层 '" + layer.name + "' 时出错: " + e);
    }
}

function __selectLayerById(id) {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putIdentifier(charIDToTypeID("Lyr "), id);
    desc.putReference(charIDToTypeID("null"), ref);
    desc.putBoolean(charIDToTypeID("MkVs"), false);
    executeAction(charIDToTypeID("slct"), desc, DialogModes.NO);
}

function __mergeLayersWithAction(topLayerId) {
    __selectLayerById(topLayerId);

    var idMrgd = charIDToTypeID("Mrg2");
    var desc = new ActionDescriptor();
    executeAction(idMrgd, desc, DialogModes.NO);
}

function __getSelectedLayers(doc) {
    var selectedLayers = [];
    try {
        var ref = new ActionReference();
        ref.putProperty(stringIDToTypeID("property"), stringIDToTypeID("targetLayers"));
        ref.putEnumerated(
            stringIDToTypeID("document"),
            stringIDToTypeID("ordinal"),
            stringIDToTypeID("targetEnum")
        );
        var desc = executeActionGet(ref);

        if (desc.hasKey(stringIDToTypeID("targetLayers"))) {
            var targetLayers = desc.getList(stringIDToTypeID("targetLayers"));
            for (var i = 0; i < targetLayers.count; i++) {
                var index = targetLayers.getReference(i).getIndex() + 1;
                var layer = __getLayerByIndex(doc, index);
                if (layer) {
                    selectedLayers.push(layer);
                }
            }
        }
    } catch (e) {
        // ignore and fallback below
    }

    if (!selectedLayers.length) {
        try {
            selectedLayers.push(doc.activeLayer);
        } catch (e2) {
            // no active layer
        }
    }

    return selectedLayers;
}

function __getLayerByIndex(doc, index) {
    function findLayerByIndex(layerSet, itemIndex) {
        for (var i = 0; i < layerSet.layers.length; i++) {
            var layer = layerSet.layers[i];
            if (layer.itemIndex === itemIndex) {
                return layer;
            }
            if (layer.typename === "LayerSet") {
                var foundLayer = findLayerByIndex(layer, itemIndex);
                if (foundLayer) {
                    return foundLayer;
                }
            }
        }
        return null;
    }

    return findLayerByIndex(doc, index);
}
