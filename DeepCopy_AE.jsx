/*
 * DeepCopy_AE.jsx  –  True deep-copy / recursive comp duplication for After Effects
 * v1.4.0
 *
 * Works as a dockable ScriptUI panel (Window > DeepCopy_AE.jsx) or run it
 * directly via File > Scripts > Run Script File.
 *
 * Tested on AE CC 2019 through AE 2026. Pure ES3 – no modern JS features,
 * because ExtendScript still ships an ES3 engine even in 2026. Yes, really.
 *
 * Features:
 *  - Recursive precomp duplication with full isolation between copies
 *  - Auto-incrementing copy numbers & guaranteed unique project folders per run
 *  - Optional asset cloning (re-imports footage, recreates solids & placeholders)
 *  - Optional physical media duplication on disk (single files & image sequences)
 *  - Expression relinking for comp("...") and footage("...") references
 *
 * MIT License
 */

(function (thisObj) {

    // --- polyfill-ish helpers (ES3 has none of the nice stuff) -----------

    function arrayIndexOf(arr, item) {
        for (var i = 0; i < arr.length; i++) {
            if (arr[i] === item) return i;
        }
        return -1;
    }

    function hasKey(obj, key) {
        return obj.hasOwnProperty(key);
    }

    function trim(s) {
        return s.replace(/^\s+/, "").replace(/\s+$/, "");
    }

    function escapeRegex(s) {
        return s.replace(/([.*+?^${}()|[\]\\])/g, "\\$1");
    }

    function zeroPad(num, width) {
        var s = String(num);
        while (s.length < width) s = "0" + s;
        return s;
    }

    function sanitizeFileName(name) {
        var cleaned = String(name).replace(/[<>:"\/\\|?*\x00-\x1F]/g, "_");
        cleaned = trim(cleaned).replace(/\.+$/, "");
        if (cleaned.length === 0) cleaned = "untitled";
        return cleaned;
    }

    function splitFileName(fileName) {
        var dotIdx = fileName.lastIndexOf(".");
        if (dotIdx <= 0) {
            return { base: fileName, ext: "" };
        }
        return {
            base: fileName.substring(0, dotIdx),
            ext: fileName.substring(dotIdx)
        };
    }

    function isFileWriteAllowed() {
        try {
            if (app.preferences.havePref("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY")) {
                return app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY") === 1;
            }
            if (app.preferences.havePref("Main Pref Section v2", "Pref_SCRIPTING_FILE_NETWORK_SECURITY")) {
                return app.preferences.getPrefAsLong("Main Pref Section v2", "Pref_SCRIPTING_FILE_NETWORK_SECURITY") === 1;
            }
        } catch (e) {}
        return true;
    }

    function ensureFolderExists(folderObj) {
        if (folderObj === null) return false;
        if (folderObj.exists) return true;
        if (folderObj.parent !== null && !folderObj.parent.exists) {
            ensureFolderExists(folderObj.parent);
        }
        return folderObj.create();
    }

    function getUniqueDestFile(destFolder, originalFileName) {
        var parts = splitFileName(originalFileName);
        var candidate = new File(destFolder.fsName + "/" + originalFileName);
        var counter = 1;
        while (candidate.exists) {
            counter++;
            candidate = new File(destFolder.fsName + "/" + parts.base + "_" + counter + parts.ext);
        }
        return candidate;
    }

    function getUniqueDestFolder(parentFolder, baseName) {
        var safeBase = sanitizeFileName(baseName);
        var candidate = new Folder(parentFolder.fsName + "/" + safeBase);
        var counter = 1;
        while (candidate.exists) {
            counter++;
            candidate = new Folder(parentFolder.fsName + "/" + safeBase + "_" + counter);
        }
        ensureFolderExists(candidate);
        return candidate;
    }

    // =====================================================================
    //  Figure out what the user wants to clone
    // =====================================================================

    function detectSelection() {
        var result = {
            mode: null,
            comps: [],
            layers: null,
            parentComp: null,
            label: "No valid selection"
        };

        var activeItem = app.project.activeItem;

        // Timeline mode – user has a comp open and selected precomp layer(s).
        if (activeItem !== null && activeItem instanceof CompItem) {
            var selLayers = activeItem.selectedLayers;
            if (selLayers.length > 0) {
                var precompLayers = [];
                for (var i = 0; i < selLayers.length; i++) {
                    var lyr = selLayers[i];
                    if (lyr instanceof AVLayer && lyr.source !== null && lyr.source instanceof CompItem) {
                        precompLayers.push(lyr);
                    }
                }
                if (precompLayers.length > 0) {
                    result.mode = "A";
                    result.comps = [activeItem];
                    result.layers = precompLayers;
                    result.parentComp = activeItem;
                    result.label = "Target: \"" + activeItem.name + "\" (Comp + all precomps)";
                    return result;
                }
            }
        }

        // Project panel mode – user clicked comp(s) in the project window
        var projSel = app.project.selection;
        if (projSel.length > 0) {
            var compItems = [];
            for (var j = 0; j < projSel.length; j++) {
                if (projSel[j] instanceof CompItem) {
                    compItems.push(projSel[j]);
                }
            }
            if (compItems.length > 0) {
                result.mode = "B";
                result.comps = compItems;
                result.layers = null;
                result.parentComp = null;
                if (compItems.length === 1) {
                    result.label = "Target: \"" + compItems[0].name + "\" (Comp)";
                } else {
                    result.label = "Target: " + compItems.length + " comps in Project Panel";
                }
                return result;
            }
        }

        // Last resort – just use whatever comp is currently open
        if (activeItem !== null && activeItem instanceof CompItem) {
            result.mode = "B";
            result.comps = [activeItem];
            result.layers = null;
            result.parentComp = null;
            result.label = "Target: \"" + activeItem.name + "\" (Active Comp)";
            return result;
        }

        return result;
    }

    // =====================================================================
    //  Project panel folder helpers
    // =====================================================================

    function findRootFolder(folderName) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof FolderItem && item.name === folderName && item.parentFolder === app.project.rootFolder) {
                return item;
            }
        }
        return null;
    }

    function getOrCreateFolder(folderName) {
        var existing = findRootFolder(folderName);
        if (existing !== null) return existing;
        return app.project.items.addFolder(folderName);
    }

    function subFolderExists(parentFolder, childName) {
        for (var i = 1; i <= parentFolder.numItems; i++) {
            var item = parentFolder.item(i);
            if (item instanceof FolderItem && item.name === childName) {
                return true;
            }
        }
        return false;
    }

    function getOrCreateSubFolder(parentFolder, childName) {
        for (var i = 1; i <= parentFolder.numItems; i++) {
            var item = parentFolder.item(i);
            if (item instanceof FolderItem && item.name === childName) {
                return item;
            }
        }
        var f = app.project.items.addFolder(childName);
        f.parentFolder = parentFolder;
        return f;
    }

    // Always creates a brand-new subfolder; never drops into an existing one
    function createUniqueSubFolder(parentFolder, baseName) {
        var candidate = baseName;
        var extra = 1;
        while (subFolderExists(parentFolder, candidate)) {
            extra++;
            candidate = baseName + " (" + extra + ")";
        }
        var f = app.project.items.addFolder(candidate);
        f.parentFolder = parentFolder;
        return f;
    }

    // Find the next unused copy index across existing Copy folders & comp names
    function getNextCopyIndex(parentFolder, sourceComp, suffix) {
        var maxIdx = 0;
        var folderRegex = /^Copy\s+(\d+)$/i;

        if (parentFolder !== null) {
            for (var i = 1; i <= parentFolder.numItems; i++) {
                var item = parentFolder.item(i);
                if (item instanceof FolderItem) {
                    var m = folderRegex.exec(item.name);
                    if (m !== null) {
                        var n = parseInt(m[1], 10);
                        if (!isNaN(n) && n > maxIdx) maxIdx = n;
                    }
                }
            }
        }

        var compRegex = new RegExp("^" + escapeRegex(sourceComp.name + suffix) + "(\\d+)$");
        for (var j = 1; j <= app.project.numItems; j++) {
            var projItem = app.project.item(j);
            if (projItem instanceof CompItem) {
                var cm = compRegex.exec(projItem.name);
                if (cm !== null) {
                    var cn = parseInt(cm[1], 10);
                    if (!isNaN(cn) && cn > maxIdx) maxIdx = cn;
                }
            }
        }

        return maxIdx + 1;
    }

    // =====================================================================
    //  Physical disk duplication helper (single files & image sequences)
    // =====================================================================

    function isLikelyImageSequence(footageItem) {
        var mainSrc = footageItem.mainSource;
        if (!(mainSrc instanceof FileSource)) return false;
        if (mainSrc.isStill) return false;
        if (footageItem.file === null) return false;
        return /\.(png|jpe?g|tga|exr|tif|tiff|dpx|bmp|cin|sgi|iff|rla|rpf)$/i.test(footageItem.file.name);
    }

    function duplicateMediaOnDisk(sourceFile, isSeq, copyDiskDir, stats) {
        if (copyDiskDir === null) return null;
        if (!ensureFolderExists(copyDiskDir)) {
            stats.diskFailed++;
            return null;
        }

        var decodedName = File.decode(sourceFile.name);

        if (isSeq) {
            // Match all sibling sequence frames sharing the same prefix, digits, and extension
            var parts = splitFileName(decodedName);
            var seqMatch = /^(.*?)(\d+)$/.exec(parts.base);
            var seqFolderName = (seqMatch !== null && seqMatch[1].length > 0)
                ? seqMatch[1].replace(/[_\-\.\s]+$/, "")
                : parts.base;
            if (seqFolderName.length === 0) seqFolderName = "Sequence";

            var seqDestFolder = getUniqueDestFolder(copyDiskDir, seqFolderName);
            var copiedFirstFrame = null;

            if (seqMatch !== null) {
                var prefix = seqMatch[1];
                var extLower = parts.ext.toLowerCase();
                var framePattern = new RegExp("^" + escapeRegex(prefix) + "\\d+" + escapeRegex(extLower) + "$", "i");
                var siblings = sourceFile.parent.getFiles();

                for (var i = 0; i < siblings.length; i++) {
                    var f = siblings[i];
                    if (!(f instanceof File)) continue;
                    var fName = File.decode(f.name);
                    if (framePattern.test(fName)) {
                        var destFrame = new File(seqDestFolder.fsName + "/" + fName);
                        if (f.copy(destFrame) && destFrame.exists) {
                            stats.diskFiles++;
                            if (f.fsName === sourceFile.fsName) {
                                copiedFirstFrame = destFrame;
                            }
                        } else {
                            stats.diskFailed++;
                        }
                    }
                }
            }

            // Fallback: at least copy the referenced file if pattern matching missed it
            if (copiedFirstFrame === null) {
                var fallbackFrame = new File(seqDestFolder.fsName + "/" + decodedName);
                if (sourceFile.copy(fallbackFrame) && fallbackFrame.exists) {
                    stats.diskFiles++;
                    copiedFirstFrame = fallbackFrame;
                } else {
                    stats.diskFailed++;
                    return null;
                }
            }

            return copiedFirstFrame;
        }

        // Standard single media file
        var destFile = getUniqueDestFile(copyDiskDir, decodedName);
        if (sourceFile.copy(destFile) && destFile.exists) {
            stats.diskFiles++;
            return destFile;
        }

        stats.diskFailed++;
        return null;
    }

    // =====================================================================
    //  Footage / asset cloning helper
    // =====================================================================

    function cloneFootageItem(footageItem, copyNumStr, clonedAssetsMap, suffix, targetFolder, originalAssets, duplicateOnDisk, copyDiskDir, stats) {
        var srcId = String(footageItem.id);
        if (hasKey(clonedAssetsMap, srcId)) {
            return clonedAssetsMap[srcId];
        }

        var mainSrc = footageItem.mainSource;
        var newFootage = null;
        var newName = footageItem.name + suffix + copyNumStr;

        // 1. Disk-based media (video, image, audio, image sequence)
        if (mainSrc instanceof FileSource) {
            if (footageItem.footageMissing || footageItem.file === null || !footageItem.file.exists) {
                return null;
            }

            // Skip individual layers imported from layered PSD/AI files –
            // ExtendScript's importFile() would flatten them into a merged image.
            if (footageItem.name.indexOf("/") !== -1 && /\.(psd|ai)$/i.test(footageItem.file.name)) {
                return null;
            }

            var isSeq = isLikelyImageSequence(footageItem);
            var fileToImport = footageItem.file;

            if (duplicateOnDisk && copyDiskDir !== null) {
                var diskClone = duplicateMediaOnDisk(footageItem.file, isSeq, copyDiskDir, stats);
                if (diskClone !== null) {
                    fileToImport = diskClone;
                } else {
                    // Disk copy failed – skip importing a broken duplicate
                    return null;
                }
            }

            try {
                var io = new ImportOptions(fileToImport);
                if (isSeq) {
                    io.sequence = true;
                }
                if (io.canImportAs(ImportAsType.FOOTAGE)) {
                    io.importAs = ImportAsType.FOOTAGE;
                }

                newFootage = app.project.importFile(io);
                newFootage.name = newName;

                // Mirror key footage interpretation settings
                try {
                    newFootage.mainSource.alphaMode = mainSrc.alphaMode;
                    if (mainSrc.alphaMode === AlphaMode.PREMULTIPLIED) {
                        newFootage.mainSource.premulColor = mainSrc.premulColor;
                    }
                    newFootage.mainSource.invertAlpha = mainSrc.invertAlpha;
                    if (!mainSrc.isStill) {
                        newFootage.mainSource.conformFrameRate = mainSrc.conformFrameRate;
                        newFootage.mainSource.loop = mainSrc.loop;
                    }
                } catch (interpErr) {}
            } catch (importErr) {
                return null;
            }
        }
        // 2. Solid layers
        else if (mainSrc instanceof SolidSource) {
            try {
                var tmpComp = app.project.items.addComp(
                    "__dc_tmp_solid__",
                    footageItem.width,
                    footageItem.height,
                    footageItem.pixelAspect,
                    1,
                    30
                );
                var tmpLayer = tmpComp.layers.addSolid(
                    mainSrc.color,
                    newName,
                    footageItem.width,
                    footageItem.height,
                    footageItem.pixelAspect
                );
                newFootage = tmpLayer.source;
                tmpComp.remove();
            } catch (solidErr) {
                return null;
            }
        }
        // 3. Placeholders
        else if (mainSrc instanceof PlaceholderSource) {
            try {
                var fps = (footageItem.frameRate && footageItem.frameRate > 0) ? footageItem.frameRate : 30;
                var dur = (footageItem.duration && footageItem.duration > 0) ? footageItem.duration : 10;
                newFootage = app.project.importPlaceholder(newName, footageItem.width, footageItem.height, fps, dur);
            } catch (phErr) {
                return null;
            }
        }

        if (newFootage !== null) {
            if (targetFolder !== null) {
                var assetsFolder = getOrCreateSubFolder(targetFolder, "Assets");
                newFootage.parentFolder = assetsFolder;
            }
            clonedAssetsMap[srcId] = newFootage;
            originalAssets.push(footageItem);
            stats.assets++;
        }

        return newFootage;
    }

    // =====================================================================
    //  The recursive deep-clone engine
    // =====================================================================

    function deepCloneComp(sourceComp, copyNumStr, clonedMap, clonedAssetsMap, originalAssets, suffix, targetFolder, copyAssets, duplicateOnDisk, copyDiskDir, stats) {
        var srcId = String(sourceComp.id);

        if (hasKey(clonedMap, srcId)) {
            return clonedMap[srcId];
        }

        var newComp = sourceComp.duplicate();
        newComp.name = sourceComp.name + suffix + copyNumStr;

        // Register *before* recursing so circular references don't infinite-loop
        clonedMap[srcId] = newComp;
        stats.comps++;

        if (targetFolder !== null) {
            newComp.parentFolder = targetFolder;
        }

        for (var i = 1; i <= newComp.numLayers; i++) {
            var layer = newComp.layer(i);

            if (!(layer instanceof AVLayer)) continue;
            if (layer.source === null) continue;

            // Precomp layer -> recurse
            if (layer.source instanceof CompItem) {
                var wasLocked = layer.locked;
                if (wasLocked) layer.locked = false;

                var childClone = deepCloneComp(
                    layer.source,
                    copyNumStr,
                    clonedMap,
                    clonedAssetsMap,
                    originalAssets,
                    suffix,
                    targetFolder,
                    copyAssets,
                    duplicateOnDisk,
                    copyDiskDir,
                    stats
                );
                layer.replaceSource(childClone, false);

                if (wasLocked) layer.locked = true;
            }
            // Footage / Solid / Placeholder layer -> clone asset if enabled
            else if (copyAssets && layer.source instanceof FootageItem) {
                if (layer.nullLayer) continue; // avoid cluttering Assets with Null solids

                var wasLockedAsset = layer.locked;
                var origLayerName = layer.name;
                if (wasLockedAsset) layer.locked = false;

                var assetClone = cloneFootageItem(
                    layer.source,
                    copyNumStr,
                    clonedAssetsMap,
                    suffix,
                    targetFolder,
                    originalAssets,
                    duplicateOnDisk,
                    copyDiskDir,
                    stats
                );

                if (assetClone !== null) {
                    try {
                        layer.replaceSource(assetClone, false);
                        // Keep original layer name so thisComp.layer("...") expressions stay valid
                        layer.name = origLayerName;
                    } catch (e) {}
                }

                if (wasLockedAsset) layer.locked = true;
            }
        }

        return newComp;
    }

    // =====================================================================
    //  Expression relinking
    // =====================================================================

    function relinkExpressionsInPropGroup(propGroup, nameMap) {
        if (propGroup.propertyType === PropertyType.PROPERTY) {
            if (propGroup.canSetExpression && propGroup.expressionEnabled) {
                var expr = propGroup.expression;
                if (expr !== null && expr !== "") {
                    var changed = false;
                    for (var m = 0; m < nameMap.length; m++) {
                        var entry = nameMap[m];
                        var fn = entry.fnName; // "comp" or "footage"

                        var dqOld = fn + '("' + entry.oldName + '")';
                        var dqNew = fn + '("' + entry.newName + '")';
                        var sqOld = fn + "('" + entry.oldName + "')";
                        var sqNew = fn + "('" + entry.newName + "')";

                        if (expr.indexOf(dqOld) !== -1) {
                            expr = expr.split(dqOld).join(dqNew);
                            changed = true;
                        }
                        if (expr.indexOf(sqOld) !== -1) {
                            expr = expr.split(sqOld).join(sqNew);
                            changed = true;
                        }
                    }
                    if (changed) {
                        try { propGroup.expression = expr; } catch (e) {}
                    }
                }
            }
            return;
        }

        if (propGroup.propertyType === PropertyType.INDEXED_GROUP ||
            propGroup.propertyType === PropertyType.NAMED_GROUP) {
            for (var p = 1; p <= propGroup.numProperties; p++) {
                try { relinkExpressionsInPropGroup(propGroup.property(p), nameMap); } catch (e) {}
            }
        }
    }

    function relinkAllExpressions(clonedMap, originals, clonedAssetsMap, originalAssets) {
        var nameMap = [];

        for (var k = 0; k < originals.length; k++) {
            var origComp = originals[k];
            var srcId = String(origComp.id);
            if (hasKey(clonedMap, srcId)) {
                var clonedComp = clonedMap[srcId];
                if (origComp.name !== clonedComp.name) {
                    nameMap.push({ fnName: "comp", oldName: origComp.name, newName: clonedComp.name });
                }
            }
        }

        for (var a = 0; a < originalAssets.length; a++) {
            var origAsset = originalAssets[a];
            var assetId = String(origAsset.id);
            if (hasKey(clonedAssetsMap, assetId)) {
                var clonedAsset = clonedAssetsMap[assetId];
                if (origAsset.name !== clonedAsset.name) {
                    nameMap.push({ fnName: "footage", oldName: origAsset.name, newName: clonedAsset.name });
                }
            }
        }

        if (nameMap.length === 0) return;

        for (var k2 = 0; k2 < originals.length; k2++) {
            var srcId2 = String(originals[k2].id);
            if (!hasKey(clonedMap, srcId2)) continue;
            var comp = clonedMap[srcId2];
            for (var li = 1; li <= comp.numLayers; li++) {
                try { relinkExpressionsInPropGroup(comp.layer(li), nameMap); } catch (e) {}
            }
        }
    }

    function collectOriginalComps(sourceComp, collected) {
        if (arrayIndexOf(collected, sourceComp) !== -1) return collected;
        collected.push(sourceComp);
        for (var i = 1; i <= sourceComp.numLayers; i++) {
            var layer = sourceComp.layer(i);
            if (layer instanceof AVLayer && layer.source !== null && layer.source instanceof CompItem) {
                collectOriginalComps(layer.source, collected);
            }
        }
        return collected;
    }

    // =====================================================================
    //  Main execution – ties everything together
    // =====================================================================

    function executeDeepCopy(opts) {
        var sel = opts.selection;
        var copyCount = opts.copyCount;
        var suffix = opts.suffix;
        var copyAssets = opts.copyAssets;
        var duplicateOnDisk = opts.duplicateOnDisk && copyAssets;
        var baseDiskFolder = opts.baseDiskFolder;
        var organizeFolder = opts.organizeFolder;
        var updateExpr = opts.updateExpr;
        var replaceLayer = opts.replaceLayer;
        var progressBar = opts.progressBar;
        var statusText = opts.statusText;
        var palette = opts.palette;

        var totalComps = sel.comps.length;
        var totalSteps = totalComps * copyCount;
        var currentStep = 0;
        progressBar.maxvalue = totalSteps;
        progressBar.value = 0;

        var stats = {
            comps: 0,
            assets: 0,
            diskFiles: 0,
            diskFailed: 0
        };

        // Precompute starting index & padWidth per source comp so repeat runs
        // continue numbering (Copy 2, Copy 3...) instead of reusing Copy 1.
        var startIndices = [];
        var padWidths = [];
        var parentFolders = [];

        for (var pre = 0; pre < totalComps; pre++) {
            var sc = sel.comps[pre];
            var pf = organizeFolder ? getOrCreateFolder("DeepCopy - " + sc.name) : findRootFolder("DeepCopy - " + sc.name);
            var startIdx = getNextCopyIndex(pf, sc, suffix);
            var maxIdx = startIdx + copyCount - 1;
            var pw = String(maxIdx).length;
            if (pw < 1) pw = 1;

            parentFolders.push(pf);
            startIndices.push(startIdx);
            padWidths.push(pw);
        }

        var allRootClones = [];
        var firstCopyClonedMap = null;

        for (var ci = 0; ci < copyCount; ci++) {
            var copyRoots = [];

            for (var si = 0; si < totalComps; si++) {
                var sourceComp = sel.comps[si];
                var copyNum = startIndices[si] + ci;
                var copyNumStr = zeroPad(copyNum, padWidths[si]);

                currentStep++;
                statusText.text = "Cloning copy " + (ci + 1) + " of " + copyCount + " (#" + copyNumStr + ")...";
                progressBar.value = currentStep;
                if (palette && palette.update) palette.update();

                // Fresh maps per copy -> full isolation between copies
                var clonedMap = {};
                var clonedAssetsMap = {};
                var originalAssets = [];

                var targetFolder = null;
                if (organizeFolder) {
                    targetFolder = createUniqueSubFolder(parentFolders[si], "Copy " + copyNumStr);
                }

                // Per-copy destination directory on disk (only created if a file is actually copied)
                var copyDiskDir = null;
                if (duplicateOnDisk && baseDiskFolder !== null) {
                    var compDiskParent = new Folder(baseDiskFolder.fsName + "/" + sanitizeFileName(sourceComp.name));
                    copyDiskDir = new Folder(compDiskParent.fsName + "/Copy_" + copyNumStr);
                    var dirExtra = 1;
                    while (copyDiskDir.exists) {
                        dirExtra++;
                        copyDiskDir = new Folder(compDiskParent.fsName + "/Copy_" + copyNumStr + "_" + dirExtra);
                    }
                }

                var rootClone = deepCloneComp(
                    sourceComp,
                    copyNumStr,
                    clonedMap,
                    clonedAssetsMap,
                    originalAssets,
                    suffix,
                    targetFolder,
                    copyAssets,
                    duplicateOnDisk,
                    copyDiskDir,
                    stats
                );

                if (updateExpr) {
                    relinkAllExpressions(clonedMap, collectOriginalComps(sourceComp, []), clonedAssetsMap, originalAssets);
                }

                copyRoots.push(rootClone);
                if (ci === 0) firstCopyClonedMap = clonedMap;
            }

            allRootClones.push(copyRoots);
        }

        // Timeline layer replacement (Mode A, single copy)
        if (sel.mode === "A" && replaceLayer && copyCount === 1 && sel.layers !== null && firstCopyClonedMap !== null) {
            for (var ri = 0; ri < sel.layers.length; ri++) {
                var tlLayer = sel.layers[ri];
                if (tlLayer.source === null) continue;
                var srcId = String(tlLayer.source.id);
                if (hasKey(firstCopyClonedMap, srcId)) {
                    var wasLockedTL = tlLayer.locked;
                    if (wasLockedTL) tlLayer.locked = false;
                    try { tlLayer.replaceSource(firstCopyClonedMap[srcId], false); } catch (e) {}
                    if (wasLockedTL) tlLayer.locked = true;
                }
            }
        }

        var totalCreated = totalComps * copyCount;
        var summary = "Done! " + totalCreated + " " + (totalCreated === 1 ? "copy" : "copies");
        if (copyAssets) {
            summary += ", " + stats.assets + " asset" + (stats.assets === 1 ? "" : "s");
        }
        if (duplicateOnDisk) {
            summary += ", " + stats.diskFiles + " file" + (stats.diskFiles === 1 ? "" : "s") + " on disk";
            if (stats.diskFailed > 0) {
                summary += " (" + stats.diskFailed + " failed)";
            }
        }
        summary += ".";

        statusText.text = summary;
        progressBar.value = progressBar.maxvalue;
        if (palette && palette.update) palette.update();
    }

    // =====================================================================
    //  UI
    // =====================================================================

    function buildUI(thisObj) {
        var palette = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", "Deep Copy v1.4", undefined, { resizeable: true });

        palette.orientation = "column";
        palette.alignChildren = ["fill", "top"];
        palette.spacing = 8;
        palette.margins = 12;

        // -- Selection banner --
        var selGroup = palette.add("group");
        selGroup.orientation = "row";
        selGroup.alignChildren = ["fill", "center"];
        selGroup.alignment = ["fill", "top"];

        var selLabel = selGroup.add("statictext", undefined, "Target: (click Refresh)");
        selLabel.alignment = ["fill", "center"];
        selLabel.characters = 35;

        var refreshBtn = selGroup.add("button", undefined, "Refresh");
        refreshBtn.preferredSize = [60, 24];

        // -- Copy count --
        var countPanel = palette.add("panel", undefined, "Number of Copies");
        countPanel.orientation = "column";
        countPanel.alignChildren = ["fill", "top"];
        countPanel.spacing = 6;
        countPanel.margins = [10, 14, 10, 8];

        var countInputGroup = countPanel.add("group");
        countInputGroup.orientation = "row";
        countInputGroup.alignChildren = ["left", "center"];

        countInputGroup.add("statictext", undefined, "Count:");
        var countInput = countInputGroup.add("edittext", undefined, "1");
        countInput.characters = 6;
        countInput.alignment = ["fill", "center"];

        var presetGroup = countPanel.add("group");
        presetGroup.orientation = "row";
        presetGroup.alignChildren = ["center", "center"];
        presetGroup.alignment = ["fill", "top"];

        var presets = [1, 5, 10, 25, 50, 100];
        for (var pi = 0; pi < presets.length; pi++) {
            (function (val) {
                var btn = presetGroup.add("button", undefined, String(val));
                btn.preferredSize = [38, 24];
                btn.onClick = function () { countInput.text = String(val); };
            })(presets[pi]);
        }

        // -- Options --
        var optPanel = palette.add("panel", undefined, "Options");
        optPanel.orientation = "column";
        optPanel.alignChildren = ["fill", "top"];
        optPanel.spacing = 6;
        optPanel.margins = [10, 14, 10, 8];

        var suffixGroup = optPanel.add("group");
        suffixGroup.orientation = "row";
        suffixGroup.alignChildren = ["left", "center"];

        suffixGroup.add("statictext", undefined, "Suffix:");
        var suffixInput = suffixGroup.add("edittext", undefined, "_copy_");
        suffixInput.characters = 14;
        suffixInput.alignment = ["fill", "center"];

        var chkCopyAssets = optPanel.add("checkbox", undefined, "Copy Assets (Footage & Solids)");
        chkCopyAssets.value = true;

        var chkDuplicateOnDisk = optPanel.add("checkbox", undefined, "Also Duplicate Media Files on Disk");
        chkDuplicateOnDisk.value = false;
        chkDuplicateOnDisk.indent = 16;

        // Disk output folder picker
        var diskDirGroup = optPanel.add("group");
        diskDirGroup.orientation = "row";
        diskDirGroup.alignChildren = ["fill", "center"];
        diskDirGroup.alignment = ["fill", "top"];
        diskDirGroup.indent = 16;

        var diskDirInput = diskDirGroup.add("edittext", undefined, "(Default: Project Folder / DeepCopy_Media)");
        diskDirInput.alignment = ["fill", "center"];
        diskDirInput.characters = 24;
        diskDirInput.enabled = false;

        var browseBtn = diskDirGroup.add("button", undefined, "Browse...");
        browseBtn.preferredSize = [68, 22];
        browseBtn.enabled = false;

        var clearDirBtn = diskDirGroup.add("button", undefined, "Reset");
        clearDirBtn.preferredSize = [48, 22];
        clearDirBtn.enabled = false;

        var chkOrganize = optPanel.add("checkbox", undefined, "Organize in Project Folder");
        chkOrganize.value = true;

        var chkExpressions = optPanel.add("checkbox", undefined, "Update Comp & Footage Expressions");
        chkExpressions.value = true;

        var chkReplace = optPanel.add("checkbox", undefined, "Replace Selected Timeline Layer (if 1 copy)");
        chkReplace.value = true;

        // -- Go button + progress --
        var execPanel = palette.add("group");
        execPanel.orientation = "column";
        execPanel.alignChildren = ["fill", "top"];
        execPanel.spacing = 6;

        var deepCopyBtn = execPanel.add("button", undefined, "DEEP COPY");
        deepCopyBtn.preferredSize = [0, 36];
        deepCopyBtn.alignment = ["fill", "top"];

        var progressBar = execPanel.add("progressbar", undefined, 0, 100);
        progressBar.preferredSize = [0, 8];
        progressBar.alignment = ["fill", "top"];

        var statusText = execPanel.add("statictext", undefined, "Ready");
        statusText.alignment = ["fill", "top"];
        statusText.characters = 42;

        // -- Event wiring --

        var currentSelection = null;
        var customDiskFolder = null;

        function updateDiskControls() {
            var assetsOn = chkCopyAssets.value;
            chkDuplicateOnDisk.enabled = assetsOn;
            var diskOn = assetsOn && chkDuplicateOnDisk.value;
            diskDirInput.enabled = diskOn;
            browseBtn.enabled = diskOn;
            clearDirBtn.enabled = diskOn;
        }

        chkCopyAssets.onClick = updateDiskControls;
        chkDuplicateOnDisk.onClick = updateDiskControls;

        browseBtn.onClick = function () {
            var picked = Folder.selectDialog("Select destination folder for duplicated media files:");
            if (picked !== null) {
                customDiskFolder = picked;
                diskDirInput.text = picked.fsName;
            }
        };

        clearDirBtn.onClick = function () {
            customDiskFolder = null;
            diskDirInput.text = "(Default: Project Folder / DeepCopy_Media)";
        };

        function refreshSelection() {
            currentSelection = detectSelection();
            selLabel.text = currentSelection.label;
        }

        refreshBtn.onClick = function () { refreshSelection(); };

        deepCopyBtn.onClick = function () {
            refreshSelection();

            if (currentSelection.mode === null) {
                alert(
                    "Deep Copy \u2014 Nothing Selected\n\n" +
                    "Select a precomp layer in the timeline, or pick one or\n" +
                    "more compositions in the Project panel, then try again.",
                    "Deep Copy"
                );
                return;
            }

            var rawCount = trim(countInput.text);
            var copyCount = parseInt(rawCount, 10);
            if (isNaN(copyCount) || copyCount < 1) {
                alert("Enter a valid number of copies (1 or more).", "Deep Copy");
                return;
            }
            if (copyCount > 999) {
                alert("Max is 999 copies. Calm down :)", "Deep Copy");
                return;
            }

            var suffix = suffixInput.text;
            if (suffix.length === 0) suffix = "_";

            var doCopyAssets = chkCopyAssets.value;
            var doDiskCopy = doCopyAssets && chkDuplicateOnDisk.value;
            var resolvedDiskFolder = null;

            if (doDiskCopy) {
                if (!isFileWriteAllowed()) {
                    alert(
                        "File Writing Is Disabled\n\n" +
                        "To duplicate media files on disk, enable:\n" +
                        "Preferences > Scripting & Expressions >\n" +
                        "\"Allow Scripts to Write Files and Access Network\"",
                        "Deep Copy"
                    );
                    return;
                }

                if (customDiskFolder !== null) {
                    resolvedDiskFolder = customDiskFolder;
                } else {
                    var typedPath = trim(diskDirInput.text);
                    if (typedPath.length > 0 && typedPath.indexOf("(Default:") !== 0) {
                        resolvedDiskFolder = new Folder(typedPath);
                    } else if (app.project.file !== null) {
                        resolvedDiskFolder = new Folder(app.project.file.parent.fsName + "/DeepCopy_Media");
                    } else {
                        var chosen = Folder.selectDialog(
                            "This project hasn't been saved yet.\nChoose a folder for duplicated media files:"
                        );
                        if (chosen === null) {
                            statusText.text = "Cancelled.";
                            return;
                        }
                        resolvedDiskFolder = chosen;
                    }
                }
            }

            if (copyCount > 25 || (doDiskCopy && copyCount > 10)) {
                var msg = "About to create " + copyCount + " deep copies of " +
                    currentSelection.comps.length + " comp" +
                    (currentSelection.comps.length === 1 ? "" : "s") + ".";
                if (doDiskCopy) {
                    msg += "\n\nPhysical disk duplication is enabled — this may use significant disk space.";
                }
                msg += "\n\nContinue?";
                if (!confirm(msg)) {
                    statusText.text = "Cancelled.";
                    return;
                }
            }

            statusText.text = "Starting...";
            progressBar.value = 0;
            if (palette.update) palette.update();

            app.beginUndoGroup("Deep Copy");
            try {
                executeDeepCopy({
                    selection: currentSelection,
                    copyCount: copyCount,
                    suffix: suffix,
                    copyAssets: doCopyAssets,
                    duplicateOnDisk: doDiskCopy,
                    baseDiskFolder: resolvedDiskFolder,
                    organizeFolder: chkOrganize.value,
                    updateExpr: chkExpressions.value,
                    replaceLayer: chkReplace.value,
                    progressBar: progressBar,
                    statusText: statusText,
                    palette: palette
                });
            } catch (e) {
                statusText.text = "Error: " + e.toString();
                alert("Something went wrong:\n\n" + e.toString(), "Deep Copy");
            } finally {
                app.endUndoGroup();
            }
        };

        // Responsive resize
        palette.onResizing = palette.onResize = function () {
            this.layout.resize();
        };

        updateDiskControls();
        refreshSelection();

        if (palette instanceof Window) {
            palette.center();
            palette.show();
        } else {
            palette.layout.layout(true);
            palette.layout.resize();
        }

        return palette;
    }

    buildUI(thisObj);

})(this);
