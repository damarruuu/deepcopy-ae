# DeepCopy AE

**True deep-copy / recursive composition duplication for Adobe After Effects.**

In After Effects, duplicating a composition in the Project panel only duplicates the top-level comp—all nested precompositions are still shared with the original. **DeepCopy AE** solves this by recursively cloning the entire composition hierarchy, swapping precomp layer sources, and automatically relinking expressions so each copy is 100% isolated.

## ✨ Features

* **Recursive Deep Cloning:** Duplicates the target composition and every nested precomp at any depth.
* **Smart Internal Sharing:** If a composition reuses the same precomp across multiple layers, that internal relationship is preserved within each new copy while remaining completely isolated from the original and other copies.
* **Expression Relinking:** Automatically updates `comp("Name")` and `comp('Name')` references in expressions across all duplicated compositions so they point to the newly created clones.
* **Batch Duplication:** Create anywhere from `1` to `999` isolated copies in one click, with zero-padded numbering (`_copy_01`, `_copy_02`, etc.) and quick preset buttons (`1`, `5`, `10`, `25`, `50`, `100`).
* **Project Panel Organization:** Optionally groups all generated comps cleanly into `DeepCopy - [Comp Name] / Copy XX` folders.
* **Timeline Layer Replacement:** When duplicating from a selected precomp layer in the timeline (with Count set to `1`), optionally replaces the selected layer's source immediately.
* **Circular Reference Protection & Locked Layer Support:** Safely handles locked layers without throwing errors and prevents infinite loops.
* **Single Undo Group:** Every batch operation is wrapped in a single `Ctrl+Z` / `Cmd+Z` undo step.

## 🖥️ Compatibility

* **Adobe After Effects:** CC 2019 through 2026 (Windows & macOS)
* Written in pure ES3 ExtendScript with zero external dependencies.

## 📦 Installation

### Option 1: Dockable Panel (Recommended)
1. Download `DeepCopy_AE.jsx`.
2. Copy the file into your After Effects `ScriptUI Panels` folder:
   * **Windows:** `C:\Program Files\Adobe\Adobe After Effects <version>\Support Files\Scripts\ScriptUI Panels\`
   * **macOS:** `/Applications/Adobe After Effects <version>/Scripts/ScriptUI Panels/`
3. Restart After Effects.
4. Open the panel from the top menu: **Window > DeepCopy_AE.jsx** and dock it anywhere in your workspace.

### Option 2: Run Without Installing
1. In After Effects, go to **File > Scripts > Run Script File...**
2. Select `DeepCopy_AE.jsx`.

## 🚀 How to Use

1. **Select your target:**
   * **Timeline Mode:** Open a composition and select one or more precomp layers.
   * **Project Panel Mode:** Select one or more compositions directly in the Project panel.
   * **Active Comp Mode:** Leave nothing selected to target the currently active timeline composition.
2. Click **Refresh** in the Deep Copy panel to verify what is targeted.
3. Choose the **Number of Copies** (type a number or click a preset button).
4. Configure your **Options**:
   * **Suffix:** Custom naming separator (default: `_copy_`).
   * **Organize in Project Folder:** Places copies into dedicated folders in the Project panel.
   * **Update Comp Expressions:** Rewrites `comp("...")` expressions to match the new comp names.
   * **Replace Selected Timeline Layer (if 1 copy):** Swaps your selected precomp layer in the timeline with the newly cloned hierarchy.
5. Click **DEEP COPY**.

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.