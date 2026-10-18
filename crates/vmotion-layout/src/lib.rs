//! Vmotion JSX layout: flexbox + CSS grid through `taffy`, compiled to
//! `wasm32-unknown-unknown` and called synchronously from the JSX lowering
//! (src/sdk/jsx-layout.ts). Text leaves are measured by the host through the
//! imported `measure` function, so wrapping uses exactly the Skia font metrics the
//! renderer draws with. No allocator tricks, no wasm-bindgen: the host writes a flat
//! f32 stream into `input_ptr()`, calls `compute()`, and reads `output_ptr()`.
//!
//! Input stream (all f32), per node in pre-order:
//!   parent (-1 root), leaf kind (0 box, 1 measured), display, position,
//!   flexDirection, flexWrap, justifyContent, alignItems, alignSelf, alignContent,
//!   justifyItems, justifySelf, gridAutoFlow, overflowX, overflowY,
//!   7 dimensions (width height minW minH maxW maxH flexBasis) as (kind, value),
//!   inset l r t b, margin l r t b (kind, value), padding l r t b, border l r t b,
//!   gap column row (kind, value), flexGrow, flexShrink, aspectRatio (NaN = none),
//!   gridColumnStart/End, gridRowStart/End as (kind, value),
//!   gridTemplateColumns, gridTemplateRows (component lists),
//!   gridAutoColumns, gridAutoRows (track lists).
//! Output: per node x, y, width, height (location relative to the parent box).
use taffy::prelude::*;
use taffy::{
    compute_cached_layout, compute_flexbox_layout, compute_grid_layout, compute_block_layout,
    compute_leaf_layout, compute_root_layout, Cache, CacheTree, GridTemplateRepetition,
    MaxTrackSizingFunction, MinTrackSizingFunction, Overflow, RepetitionCount,
};

#[link(wasm_import_module = "env")]
extern "C" {
    /// Host text measure: writes width/height into the measure slot.
    fn measure(node: u32, known_w: f32, known_h: f32, avail_w: f32, avail_h: f32);
}

struct Node {
    style: Style,
    measured: bool,
    cache: Cache,
    layout: Layout,
    children: Vec<usize>,
}
struct Tree {
    nodes: Vec<Node>,
}

static mut INPUT: Vec<f32> = Vec::new();
static mut OUTPUT: Vec<f32> = Vec::new();
static mut SLOT: [f32; 2] = [0.0, 0.0];
static mut ERROR: u32 = 0;

#[no_mangle]
pub extern "C" fn input_ptr(len: u32) -> *mut f32 {
    unsafe {
        let input = &mut *core::ptr::addr_of_mut!(INPUT);
        input.clear();
        input.resize(len as usize, 0.0);
        input.as_mut_ptr()
    }
}
#[no_mangle]
pub extern "C" fn output_ptr() -> *const f32 {
    unsafe { (*core::ptr::addr_of!(OUTPUT)).as_ptr() }
}
#[no_mangle]
pub extern "C" fn measure_slot() -> *mut f32 {
    core::ptr::addr_of_mut!(SLOT) as *mut f32
}
#[no_mangle]
pub extern "C" fn error_code() -> u32 {
    unsafe { ERROR }
}

struct Reader<'a> {
    data: &'a [f32],
    at: usize,
    bad: bool,
}
impl Reader<'_> {
    fn f(&mut self) -> f32 {
        match self.data.get(self.at) {
            Some(v) => {
                self.at += 1;
                *v
            }
            None => {
                self.bad = true;
                0.0
            }
        }
    }
    fn u(&mut self) -> u32 {
        let v = self.f();
        if v.is_finite() && v >= 0.0 { v as u32 } else { 0 }
    }
    fn dim(&mut self) -> Dimension {
        let (k, v) = (self.u(), self.f());
        match k {
            1 => Dimension::length(v),
            2 => Dimension::percent(v),
            _ => Dimension::auto(),
        }
    }
    fn lpa(&mut self) -> LengthPercentageAuto {
        let (k, v) = (self.u(), self.f());
        match k {
            1 => LengthPercentageAuto::length(v),
            2 => LengthPercentageAuto::percent(v),
            _ => LengthPercentageAuto::auto(),
        }
    }
    fn lp(&mut self) -> LengthPercentage {
        let (k, v) = (self.u(), self.f());
        match k {
            2 => LengthPercentage::percent(v),
            _ => LengthPercentage::length(v),
        }
    }
    fn placement(&mut self) -> GridPlacement {
        let (k, v) = (self.u(), self.f());
        match k {
            1 => GridPlacement::from_line_index(v as i16),
            2 => GridPlacement::from_span(v.max(1.0) as u16),
            _ => GridPlacement::Auto,
        }
    }
    fn track(&mut self) -> TrackSizingFunction {
        let (mink, minv, maxk, maxv) = (self.u(), self.f(), self.u(), self.f());
        let min = match mink {
            1 => MinTrackSizingFunction::length(minv),
            2 => MinTrackSizingFunction::percent(minv),
            3 => MinTrackSizingFunction::min_content(),
            4 => MinTrackSizingFunction::max_content(),
            _ => MinTrackSizingFunction::auto(),
        };
        let max = match maxk {
            1 => MaxTrackSizingFunction::length(maxv),
            2 => MaxTrackSizingFunction::percent(maxv),
            3 => MaxTrackSizingFunction::min_content(),
            4 => MaxTrackSizingFunction::max_content(),
            5 => MaxTrackSizingFunction::fr(maxv),
            6 => MaxTrackSizingFunction::fit_content(LengthPercentage::length(maxv)),
            7 => MaxTrackSizingFunction::fit_content(LengthPercentage::percent(maxv)),
            _ => MaxTrackSizingFunction::auto(),
        };
        TrackSizingFunction { min, max }
    }
    fn tracks(&mut self) -> Vec<TrackSizingFunction> {
        let n = self.u().min(1024);
        (0..n).map(|_| self.track()).collect()
    }
    fn template(&mut self) -> Vec<GridTemplateComponent<String>> {
        let n = self.u().min(1024);
        let mut out = Vec::with_capacity(n as usize);
        for _ in 0..n {
            if self.u() == 1 {
                let c = self.f();
                let count = if c == -1.0 {
                    RepetitionCount::AutoFill
                } else if c == -2.0 {
                    RepetitionCount::AutoFit
                } else {
                    RepetitionCount::Count(c.max(1.0) as u16)
                };
                let tracks = self.tracks();
                out.push(GridTemplateComponent::Repeat(GridTemplateRepetition {
                    count,
                    tracks,
                    line_names: Vec::new(),
                }));
            } else {
                out.push(GridTemplateComponent::Single(self.track()));
            }
        }
        out
    }
}
fn overflow(v: u32) -> Overflow {
    match v {
        1 => Overflow::Clip,
        2 => Overflow::Hidden,
        _ => Overflow::Visible,
    }
}
fn align(v: u32) -> Option<AlignItems> {
    match v {
        1 => Some(AlignItems::Start),
        2 => Some(AlignItems::End),
        3 => Some(AlignItems::FlexStart),
        4 => Some(AlignItems::FlexEnd),
        5 => Some(AlignItems::Center),
        6 => Some(AlignItems::Baseline),
        7 => Some(AlignItems::Stretch),
        _ => None,
    }
}
fn align_content(v: u32) -> Option<AlignContent> {
    match v {
        1 => Some(AlignContent::Start),
        2 => Some(AlignContent::End),
        3 => Some(AlignContent::FlexStart),
        4 => Some(AlignContent::FlexEnd),
        5 => Some(AlignContent::Center),
        6 => Some(AlignContent::Stretch),
        7 => Some(AlignContent::SpaceBetween),
        8 => Some(AlignContent::SpaceEvenly),
        9 => Some(AlignContent::SpaceAround),
        _ => None,
    }
}

fn parse(data: &[f32], count: usize) -> Option<Tree> {
    let mut r = Reader { data, at: 0, bad: false };
    let mut nodes: Vec<Node> = Vec::with_capacity(count);
    for index in 0..count {
        let parent = r.f();
        let measured = r.u() == 1;
        let mut s = Style::default();
        s.display = match r.u() {
            1 => Display::Grid,
            2 => Display::Block,
            3 => Display::None,
            _ => Display::Flex,
        };
        s.position = if r.u() == 1 { Position::Absolute } else { Position::Relative };
        s.flex_direction = match r.u() {
            1 => FlexDirection::Column,
            2 => FlexDirection::RowReverse,
            3 => FlexDirection::ColumnReverse,
            _ => FlexDirection::Row,
        };
        s.flex_wrap = match r.u() {
            1 => FlexWrap::Wrap,
            2 => FlexWrap::WrapReverse,
            _ => FlexWrap::NoWrap,
        };
        s.justify_content = align_content(r.u());
        s.align_items = align(r.u());
        s.align_self = align(r.u());
        s.align_content = align_content(r.u());
        s.justify_items = align(r.u());
        s.justify_self = align(r.u());
        s.grid_auto_flow = match r.u() {
            1 => GridAutoFlow::Column,
            2 => GridAutoFlow::RowDense,
            3 => GridAutoFlow::ColumnDense,
            _ => GridAutoFlow::Row,
        };
        s.overflow = taffy::Point { x: overflow(r.u()), y: overflow(r.u()) };
        s.size = Size { width: r.dim(), height: r.dim() };
        s.min_size = Size { width: r.dim(), height: r.dim() };
        s.max_size = Size { width: r.dim(), height: r.dim() };
        s.flex_basis = r.dim();
        s.inset = Rect { left: r.lpa(), right: r.lpa(), top: r.lpa(), bottom: r.lpa() };
        s.margin = Rect { left: r.lpa(), right: r.lpa(), top: r.lpa(), bottom: r.lpa() };
        s.padding = Rect { left: r.lp(), right: r.lp(), top: r.lp(), bottom: r.lp() };
        s.border = Rect { left: r.lp(), right: r.lp(), top: r.lp(), bottom: r.lp() };
        s.gap = Size { width: r.lp(), height: r.lp() };
        s.flex_grow = r.f().max(0.0);
        s.flex_shrink = r.f().max(0.0);
        let ratio = r.f();
        s.aspect_ratio = if ratio.is_finite() && ratio > 0.0 { Some(ratio) } else { None };
        s.grid_column = Line { start: r.placement(), end: r.placement() };
        s.grid_row = Line { start: r.placement(), end: r.placement() };
        s.grid_template_columns = r.template();
        s.grid_template_rows = r.template();
        s.grid_auto_columns = r.tracks();
        s.grid_auto_rows = r.tracks();
        if r.bad {
            return None;
        }
        nodes.push(Node { style: s, measured, cache: Cache::new(), layout: Layout::with_order(index as u32), children: Vec::new() });
        if parent >= 0.0 {
            let p = parent as usize;
            if p >= index {
                return None;
            }
            nodes[p].children.push(index);
        } else if index != 0 {
            return None;
        }
    }
    Some(Tree { nodes })
}

/// Lay out `count` nodes from the input stream; returns 0 on success (else error_code()).
#[no_mangle]
pub extern "C" fn compute(count: u32, avail_w: f32, avail_h: f32) -> u32 {
    let data = unsafe { &*core::ptr::addr_of!(INPUT) };
    let tree = parse(data, count as usize);
    let Some(mut tree) = tree else {
        unsafe { ERROR = 1 };
        return 1;
    };
    let space = |v: f32| {
        if v == -1.0 {
            AvailableSpace::MinContent
        } else if v.is_finite() && v >= 0.0 {
            AvailableSpace::Definite(v)
        } else {
            AvailableSpace::MaxContent
        }
    };
    if count > 0 {
        compute_root_layout(&mut tree, NodeId::from(0usize), Size { width: space(avail_w), height: space(avail_h) });
    }
    let out = unsafe { &mut *core::ptr::addr_of_mut!(OUTPUT) };
    out.clear();
    for n in &tree.nodes {
        out.extend_from_slice(&[n.layout.location.x, n.layout.location.y, n.layout.size.width, n.layout.size.height]);
    }
    unsafe { ERROR = 0 };
    0
}

struct ChildIter<'a>(core::slice::Iter<'a, usize>);
impl Iterator for ChildIter<'_> {
    type Item = NodeId;
    fn next(&mut self) -> Option<NodeId> {
        self.0.next().copied().map(NodeId::from)
    }
}
impl taffy::TraversePartialTree for Tree {
    type ChildIter<'a> = ChildIter<'a>;
    fn child_ids(&self, id: NodeId) -> Self::ChildIter<'_> {
        ChildIter(self.nodes[usize::from(id)].children.iter())
    }
    fn child_count(&self, id: NodeId) -> usize {
        self.nodes[usize::from(id)].children.len()
    }
    fn get_child_id(&self, id: NodeId, index: usize) -> NodeId {
        NodeId::from(self.nodes[usize::from(id)].children[index])
    }
}
impl taffy::TraverseTree for Tree {}
impl taffy::LayoutPartialTree for Tree {
    type CustomIdent = String;
    type CoreContainerStyle<'a> = &'a Style where Self: 'a;
    fn get_core_container_style(&self, id: NodeId) -> Self::CoreContainerStyle<'_> {
        &self.nodes[usize::from(id)].style
    }
    fn set_unrounded_layout(&mut self, id: NodeId, layout: &Layout) {
        self.nodes[usize::from(id)].layout = *layout;
    }
    fn resolve_calc_value(&self, _val: *const (), _basis: f32) -> f32 {
        0.0
    }
    fn compute_child_layout(&mut self, id: NodeId, inputs: taffy::tree::LayoutInput) -> taffy::tree::LayoutOutput {
        compute_cached_layout(self, id, inputs, |tree, id, inputs| {
            let index = usize::from(id);
            let node = &tree.nodes[index];
            if node.measured {
                let style = &node.style;
                return compute_leaf_layout(inputs, style, |_, _| 0.0, |known, available| {
                    let enc = |v: AvailableSpace| match v {
                        AvailableSpace::Definite(v) => v,
                        AvailableSpace::MinContent => -1.0,
                        AvailableSpace::MaxContent => -2.0,
                    };
                    unsafe {
                        SLOT = [0.0, 0.0];
                        measure(
                            index as u32,
                            known.width.unwrap_or(f32::NAN),
                            known.height.unwrap_or(f32::NAN),
                            enc(available.width),
                            enc(available.height),
                        );
                        let slot = *core::ptr::addr_of!(SLOT);
                        Size { width: slot[0], height: slot[1] }
                    }
                });
            }
            if node.children.is_empty() {
                let style = &node.style;
                return compute_leaf_layout(inputs, style, |_, _| 0.0, |_, _| Size::ZERO);
            }
            match node.style.display {
                Display::Grid => compute_grid_layout(tree, id, inputs),
                Display::Block => compute_block_layout(tree, id, inputs),
                _ => compute_flexbox_layout(tree, id, inputs),
            }
        })
    }
}
impl CacheTree for Tree {
    fn cache_get(&self, id: NodeId, k: Size<Option<f32>>, a: Size<AvailableSpace>, m: taffy::RunMode) -> Option<taffy::LayoutOutput> {
        self.nodes[usize::from(id)].cache.get(k, a, m)
    }
    fn cache_store(&mut self, id: NodeId, k: Size<Option<f32>>, a: Size<AvailableSpace>, m: taffy::RunMode, o: taffy::LayoutOutput) {
        self.nodes[usize::from(id)].cache.store(k, a, m, o)
    }
    fn cache_clear(&mut self, id: NodeId) {
        self.nodes[usize::from(id)].cache.clear();
    }
}
impl taffy::LayoutFlexboxContainer for Tree {
    type FlexboxContainerStyle<'a> = &'a Style where Self: 'a;
    type FlexboxItemStyle<'a> = &'a Style where Self: 'a;
    fn get_flexbox_container_style(&self, id: NodeId) -> Self::FlexboxContainerStyle<'_> {
        &self.nodes[usize::from(id)].style
    }
    fn get_flexbox_child_style(&self, id: NodeId) -> Self::FlexboxItemStyle<'_> {
        &self.nodes[usize::from(id)].style
    }
}
impl taffy::LayoutGridContainer for Tree {
    type GridContainerStyle<'a> = &'a Style where Self: 'a;
    type GridItemStyle<'a> = &'a Style where Self: 'a;
    fn get_grid_container_style(&self, id: NodeId) -> Self::GridContainerStyle<'_> {
        &self.nodes[usize::from(id)].style
    }
    fn get_grid_child_style(&self, id: NodeId) -> Self::GridItemStyle<'_> {
        &self.nodes[usize::from(id)].style
    }
}
impl taffy::LayoutBlockContainer for Tree {
    type BlockContainerStyle<'a> = &'a Style where Self: 'a;
    type BlockItemStyle<'a> = &'a Style where Self: 'a;
    fn get_block_container_style(&self, id: NodeId) -> Self::BlockContainerStyle<'_> {
        &self.nodes[usize::from(id)].style
    }
    fn get_block_child_style(&self, id: NodeId) -> Self::BlockItemStyle<'_> {
        &self.nodes[usize::from(id)].style
    }
}
