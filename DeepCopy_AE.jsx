/*
 * DeepCopy_AE.jsx  –  True deep-copy / recursive comp duplication for After Effects
 * v1.2.0
 *
 * Works as a dockable ScriptUI panel (Window > DeepCopy_AE.jsx) or run it
 * directly via File > Scripts > Run Script File.
 *
 * Tested on AE CC 2019 through AE 2026. Pure ES3 – no modern JS features,
 * because ExtendScript still ships an ES3 engine even in 2026. Yes, really.
 *
 * https://github.com/user/deepcopy-ae   
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
        // We clone the *whole* active comp (the main comp), not just the
        // nested precomp. That way you get the full hierarchy in one shot.
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

    function getOrCreateFolder(folderName) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof FolderItem && item.name === folderName && item.parentFolder === app.project.rootFolder) {
                return item;
            }
        }
        return app.project.items.addFolder(folderName);
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

    // =====================================================================
    //  The recursive deep-clone engine
    // =====================================================================
    //
    //  The key insight: each copy iteration gets its own clonedMap so that
    //  internal precomp sharing within one copy is preserved (if your main
    //  comp uses the same precomp in two layers, the clone will too), but
    //  separate copies are fully isolated from each other.

    function deepCloneComp(sourceComp, copyIndex, clonedMap, suffix, padWidth, targetFolder) {
        var srcId = String(sourceComp.id);

        // Already cloned this comp during this copy iteration? Reuse it.
        if (hasKey(clonedMap, srcId)) {
            return clonedMap[srcId];
        }

        var newComp = sourceComp.duplicate();
        newComp.name = sourceComp.name + suffix + zeroPad(copyIndex, padWidth);

        // Register *before* recursing so circular references don't infinite-loop
        clonedMap[srcId] = newComp;

        if (targetFolder !== null) {
            newComp.parentFolder = targetFolder;
        }

        // Walk every layer; if it's a precomp, recurse and swap the source
        for (var i = 1; i <= newComp.numLayers; i++) {
            var layer = newComp.layer(i);

            if (!(layer instanceof AVLayer)) continue;
            if (layer.source === null) continue;
            if (!(layer.source instanceof CompItem)) continue;

            // Unlock temporarily if needed – replaceSource throws on locked layers
            var wasLocked = layer.locked;
            if (wasLocked) layer.locked = false;

            var childClone = deepCloneComp(layer.source, copyIndex, clonedMap, suffix, padWidth, targetFolder);

            // fixExpressions=false because we do our own expression pass later
            layer.replaceSource(childClone, false);

            if (wasLocked) layer.locked = true;
        }

        return newComp;
    }

    // =====================================================================
    //  Expression relinking
    // =====================================================================
    //
    //  After cloning, any expression that says comp("Original Name") still
    //  points at the original. We walk every property in every cloned comp
    //  and swap those references to the new names.
    //
    //  Using split/join instead of regex for the actual replacement – avoids
    //  headaches with special characters in comp names (parentheses etc.).

    function relinkExpressionsInPropGroup(propGroup, nameMap) {
        if (propGroup.propertyType === PropertyType.PROPERTY) {
            if (propGroup.canSetExpression && propGroup.expressionEnabled) {
                var expr = propGroup.expression;
                if (expr !== null && expr !== "") {
                    var changed = false;
                    for (var m = 0; m < nameMap.length; m++) {
                        var entry = nameMap[m];

                        // Handle both quote styles: comp("name") and comp('name')
                        var dqOld = 'comp("' + entry.oldName + '")';
                        var dqNew = 'comp("' + entry.newName + '")';
                        var sqOld = "comp('" + entry.oldName + "')";
                        var sqNew = "comp('" + entry.newName + "')";

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
                        try { propGroup.expression = expr; } catch (e) { /* bad expression – leave it */ }
                    }
                }
            }
            return;
        }

        // Recurse into property groups
        if (propGroup.propertyType === PropertyType.INDEXED_GROUP ||
            propGroup.propertyType === PropertyType.NAMED_GROUP) {
            for (var p = 1; p <= propGroup.numProperties; p++) {
                try { relinkExpressionsInPropGroup(propGroup.property(p), nameMap); } catch (e) {}
            }
        }
    }

    function relinkAllExpressions(clonedMap, originals) {
        // Build old-name → new-name lookup
        var nameMap = [];
        for (var k = 0; k < originals.length; k++) {
            var origComp = originals[k];
            var srcId = String(origComp.id);
            if (hasKey(clonedMap, srcId)) {
                var clonedComp = clonedMap[srcId];
                if (origComp.name !== clonedComp.name) {
                    nameMap.push({ oldName: origComp.name, newName: clonedComp.name });
                }
            }
        }
        if (nameMap.length === 0) return;

        // Update expressions in every cloned comp
        for (var k2 = 0; k2 < originals.length; k2++) {
            var srcId2 = String(originals[k2].id);
            if (!hasKey(clonedMap, srcId2)) continue;
            var comp = clonedMap[srcId2];
            for (var li = 1; li <= comp.numLayers; li++) {
                try { relinkExpressionsInPropGroup(comp.layer(li), nameMap); } catch (e) {}
            }
        }
    }

    // Gather every CompItem in the hierarchy (for expression relinking)
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
        var organizeFolder = opts.organizeFolder;
        var updateExpr = opts.updateExpr;
        var replaceLayer = opts.replaceLayer;
        var progressBar = opts.progressBar;
        var statusText = opts.statusText;
        var palette = opts.palette;

        var padWidth = String(copyCount).length;
        if (padWidth < 1) padWidth = 1;

        var totalComps = sel.comps.length;
        var totalSteps = totalComps * copyCount;
        var currentStep = 0;
        progressBar.maxvalue = totalSteps;
        progressBar.value = 0;

        var allRootClones = [];
        var firstCopyClonedMap = null;

        for (var ci = 1; ci <= copyCount; ci++) {
            var copyRoots = [];

            for (var si = 0; si < totalComps; si++) {
                var sourceComp = sel.comps[si];

                currentStep++;
                statusText.text = "Cloning copy " + ci + " of " + copyCount + "...";
                progressBar.value = currentStep;
                if (palette && palette.update) palette.update();

                // Fresh map per copy → full isolation between copies
                var clonedMap = {};

                var targetFolder = null;
                if (organizeFolder) {
                    var parentFolder = getOrCreateFolder("DeepCopy - " + sourceComp.name);
                    targetFolder = getOrCreateSubFolder(parentFolder, "Copy " + zeroPad(ci, padWidth));
                }

                var rootClone = deepCloneComp(sourceComp, ci, clonedMap, suffix, padWidth, targetFolder);

                if (updateExpr) {
                    relinkAllExpressions(clonedMap, collectOriginalComps(sourceComp, []));
                }

                copyRoots.push(rootClone);
                if (ci === 1) firstCopyClonedMap = clonedMap;
            }

            allRootClones.push(copyRoots);
        }

        // Timeline layer replacement (Mode A, single copy) – swap the
        // selected precomp layer's source to its deep-cloned version
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
        statusText.text = "Done! " + totalCreated + " isolated " + (totalCreated === 1 ? "copy" : "copies") + " created.";
        progressBar.value = progressBar.maxvalue;
        if (palette && palette.update) palette.update();
    }

    // =====================================================================
    //  UI
    // =====================================================================

    function buildUI(thisObj) {
        var palette = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", "Deep Copy", undefined, { resizeable: true });

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

        // Quick presets
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

        var chkOrganize = optPanel.add("checkbox", undefined, "Organize in Project Folder");
        chkOrganize.value = true;

        var chkExpressions = optPanel.add("checkbox", undefined, "Update Comp Expressions");
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
        statusText.characters = 40;

        // -- Event wiring --

        var currentSelection = null;

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

            if (copyCount > 25) {
                var msg = "About to create " + copyCount + " deep copies of " +
                    currentSelection.comps.length + " comp" +
                    (currentSelection.comps.length === 1 ? "" : "s") +
                    ".\n\nThis might take a minute. Continue?";
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
