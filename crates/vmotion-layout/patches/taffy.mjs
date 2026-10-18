// Source fixes applied to the vendored taffy 0.9.2 by scripts/build-layout-wasm.mjs.
export const patches = [
  {
    // Flexbox auto margins: free space already subtracts the gaps, but the auto-margin branch
    // never offsets items by the gap, so `marginTop: 'auto'` with `gap` ended one gap short
    // per item. Apply the main-axis gap between items as the justify-content branch does.
    file: 'src/compute/flexbox.rs',
    find: `                if child.margin_is_auto.main_end(constants.dir) {
                    if constants.is_row {
                        child.margin.right = margin;
                    } else {
                        child.margin.bottom = margin;
                    }
                }
            }
        } else {`,
    replace: `                if child.margin_is_auto.main_end(constants.dir) {
                    if constants.is_row {
                        child.margin.right = margin;
                    } else {
                        child.margin.bottom = margin;
                    }
                }
            }
            // vmotion patch: keep the main-axis gap between items (see patches/taffy.mjs).
            let gap = constants.gap.main(constants.dir);
            let reverse = constants.dir.is_reverse();
            let count = line.items.len();
            for (i, child) in line.items.iter_mut().enumerate() {
                let first = if reverse { i + 1 == count } else { i == 0 };
                child.offset_main = if first { 0.0 } else { gap };
            }
        } else {`,
  },
];
