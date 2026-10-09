# 偏旁部件拼字（字形库）

文字可以不依赖字体文件：用户把常用部件（偏旁）画成矢量笔画，再用 Unicode IDS 结构把部件拼成汉字，得到自己的字形库。字形库是普通工程资源，可被文字图层和字幕按字使用；字形库中没有的字按设置回退到原字体。原有的字体用法完全不变：不设置 `glyphSet` 的图层、工程文件和渲染结果与之前一致。

## 资源格式

字形库保存于 `components/glyphs/<id>.vmglyph.json`（ID 为小写字母、数字和连字符），格式见 `schemas/glyphSet.schema.json`，也可用 `project_schema name=glyphSet` 读取。

```json
{
  "kind": "glyph-set",
  "version": 1,
  "id": "brush",
  "name": "我的部件体",
  "extends": "builtin:demo",
  "metrics": { "em": 1000, "ascent": 880, "descent": 120, "advance": 1000, "space": 320, "margin": 80, "gap": 40 },
  "style": { "strokeWidth": 96, "cap": "round", "join": "round", "roundness": 0.35, "slant": 6, "strokeScaling": 0.35 },
  "operators": { "⿰": { "ratio": 0.48 } },
  "components": {
    "氵": { "name": "三点水", "strokes": [{ "points": [[300,120],[480,240]] }, { "points": [[220,400],[420,520]] }, { "points": [[200,920],[480,620]] }], "prefer": { "width": 0.28 } },
    "囗": { "strokes": [{ "points": [[100,80],[100,940]] }, { "points": [[100,80],[900,80],[900,940]] }, { "points": [[100,910],[900,910]] }], "inner": [0.2,0.18,0.6,0.62] },
    "left-wood": { "ids": "⿱十八" }
  },
  "glyphs": {
    "湖": "⿰氵胡",
    "胡": "⿰古月",
    "国": "⿴囗玉",
    "湘": { "ids": "⿰氵相", "adjust": { "": { "ratio": 0.3 }, "1.0": { "scale": [0.95, 1] } } },
    "，": { "strokes": [{ "points": [[200,780],[235,850],[160,960]], "width": 1.1 }] }
  },
  "kerning": { "江河": -20 }
}
```

- **metrics**：em 方框（默认 1000），基线位于 `ascent`；`advance` 为默认字宽，`space` 为英文空格宽度；`margin` 是字身与 em 框的边距，`gap` 是拆分部件之间的间隙（嵌套时按比例缩小）。
- **style**（全局笔画参数，作用于全部笔画型部件）：`strokeWidth` 笔画粗细（em 单位），`cap` 圆头/方头/平头，`join`，`roundness` 折线转角圆润度（0 保持尖角），`slant` 倾斜角度，`strokeScaling` 嵌套部件变小时笔画同步减细的程度（宽度 × 缩放^k）。
- **components**（部件）：在 1000×1000 设计框内绘制，按数组顺序即笔顺。笔画为中线 `points`（折线）或 `d`（SVG 路径，支持 M/L/H/V/C/S/Q/T/Z，不支持弧线 A），可设 `width` 倍率；也可用 `fills` 写闭合轮廓。`prefer.width/height` 是在 ⿰/⿱ 等拆分中偏好的占比，`inset` 是放置时的内缩，`inner` 是作为包围结构外框时留给内部部件的区域。部件本身也可以写 `ids` 由其他部件组成。
- **glyphs**（字形）：字符 → IDS 字符串；或对象 `{ids, adjust, advance, strokes, fills}`。`adjust` 以 IDS 节点路径（`""` 为根，`"0"`、`"1.0"` 为子节点）为键，可设 `ratio`、`inner`、`box`、`offset`、`scale`。字形也可以直接给出路径，不使用拼字。
- **extends**：继承另一个字形库（例如 `builtin:demo`），只覆盖本文件写出的字段；`copyFrom`（glyphs_plan create）则把全部内容复制进来便于修改。
- 引用方式：工程字形库直接写 ID；内置库写 `builtin:<id>`。若工程中没有同名文件，`demo` 也解析为内置 `builtin:demo`。内置库只读。

## IDS 结构

支持 ⿰ 左右、⿱ 上下、⿲ 左中右、⿳ 上中下、⿴ 全包围、⿵ 上三包、⿶ 下三包、⿷ 左三包、⿸ 左上包、⿹ 右上包、⿺ 左下包、⿻ 叠加，可任意嵌套（最多 16 层），例如 `⿰氵⿱木口`。扩展写法：

- 运算符后的 `[0.3]`（⿰⿱ 比例）、`[0.3,0.4,0.3]`（⿲⿳ 三段）、`[x,y,w,h]`（包围内部区域），例如 `⿰[0.3]氵可`。
- `{名称}` 引用多字符部件 ID，例如 `⿰{left-wood}口`。
- 叶子可以是部件，也可以是字形库中的另一个字（`湖=⿰氵胡`，`胡=⿰古月`）；循环引用报 `GLYPH_CYCLE`。

比例的决定顺序：节点 adjust → 运算符参数 → 子部件 `prefer` → 字形库 `operators` → 内置默认值。布局只依赖文档内容，结果确定、可复现；同一份字形库在预览、导出、CLI 与 MCP 中完全一致。语法错误给出 `GLYPH_IDS` 与字符位置；Unicode 15.1 新增的 ⿼⿽⿾⿿㇯ 暂不支持。

## 文字图层与字幕

```json
{ "id": "title", "type": "text", "text": "明月照江河 Vmotion", "fontSize": 120, "glyphSet": "builtin:demo", "glyphFallback": "font" }
```

- `glyphSet`：字形库 ID；设为 `null` 或省略即仅用字体。
- `glyphFallback`：`font`（默认，缺字用图层字体）、`tofu`（缺字画一个方框，便于检查）、`none`（缺字不显示、不占宽度）。
- 按字解析：字形库中能成功拼出的字使用字形，其余按回退处理；空格在 `font` 回退下沿用字体空格。换行、对齐、逐字/逐词/逐行动画范围、路径文字、reveal、选择框与 graphics_inspect 都使用同一套混排度量。字形笔画通过原生矢量路径绘制，使用图层填充色、描边和动画颜色；预览与导出像素一致（测试逐字节比较）。
- 字幕：`captions_import` 新增 `glyphSet`/`glyphFallback`，生成的字幕组件声明对应参数并在测量高度时导入工程字形库 JSON，修改组件参数即可切换字形库。未指定 glyphSet 时生成的组件源码与之前相同。
- SDK：`measureTextBlock(text, {glyphSet:'builtin:demo'})` 直接使用内置库；工程字形库可传入导入的 JSON：`measureTextBlock(text, props, {glyphSet: doc})`。另有 `parseIds`、`GlyphComposer`、`drawComposedGlyph`、`glyphSetSchema` 等导出。
- 校验：图层引用不存在或无效的字形库报 `GLYPH_SET_MISSING`（错误）；字形库中有拼不出的字报 `GLYPH_INCOMPLETE`（警告，渲染时使用回退）。

## 工具（发现分类 glyphs）

**glyphs_inspect**（只读）

- 默认返回全部字形库摘要（内置与工程）。
- `set` + `components:true` / `glyphs:true`：分页列出部件或字形（offset/limit）。
- `text`：对一段文字给出覆盖率；`project:true`：扫描所有使用字形库的文字图层与字幕，按字形库报告覆盖率、缺字及次数和位置（`场景/图层` 或 `captions:文件`）。由 TypeScript 组件运行时生成的文字无法静态扫描，不在报告内。
- `chars`：逐字说明来源、IDS、部件框、笔画数或错误。
- `expression` + `adjust`：实时拼字，返回解析结果与部件；`preview`：渲染字符预览图。图片通过 MCP 原生 media block 返回（`media:false` 关闭），JSON 中只有路径/尺寸/pixelHash。

**glyphs_plan**（返回候选，不直接修改工程）

动作：`create`（id、name、extends 或 copyFrom、metrics、style）、`setStyle`、`setComponent`（`null` 删除）、`setGlyph`（`null` 删除）、`setOperator`、`setKerning`、`assign`（把字形库与回退设置指派给文字图层或字幕组件）。返回 `planId`、修改的文件、拼不出的字形列表、改动字符的预览图；用 `project_preflight` 检查后原样 `project_apply`，整批修改一次撤销。内置库只读（`GLYPH_READONLY`），重复创建报 `GLYPH_SET_EXISTS`，错误的 IDS、版本冲突在写入前拒绝。

```json
{"name":"tool_call","arguments":{"name":"glyphs_plan","arguments":{
  "actions":[
    {"action":"create","id":"brush","name":"我的部件体","extends":"builtin:demo","style":{"strokeWidth":110,"slant":8}},
    {"action":"setGlyph","char":"湘","glyph":"⿰氵相"},
    {"action":"assign","sceneId":"intro","nodeIds":["title"],"glyphSet":"brush","fallback":"font"}
  ],
  "preview":"湘江"
}}}
```

## CLI

```bash
vmotion glyphs inspect --project P [--set builtin:demo] [--text 文字] [--coverage] [--chars 湖国] [--components|--glyphs]
vmotion glyphs preview --project P --set builtin:demo --text 明月照江河 --ids ⿰氵⿱木口 -o sheet.png
vmotion glyphs plan    --project P --request plan.json [--apply]
```

`plan --apply` 依次执行计划、预检与提交（一次撤销）。开发脚本 `scripts/glyph-sheet.ts` 输出内置库全部字形的对照表，`scripts/render-glyphs-demo.ts` 渲染演示图。

## 编辑器

文字检查器「文字排版」中新增「字形库」选择（含内置库）和「缺字」回退，以及「字形面板…」按钮。字形面板：

- **覆盖率**：工程中所有使用字形库的文字与字幕的覆盖率、缺字（次数、位置提示），当前图层文字的预览；点击缺字跳转到拼字。
- **拼字**：输入 IDS 或点击 12 种结构按钮，实时预览；⿰/⿱ 可拖动分割比例，包围结构可调内部区域；输入字符后保存到字形库。
- **部件 / 字形**：分页列表与预览图，点击部件插入拼字式，点击字形载入编辑。
- **笔画**：调整粗细、转角圆润、倾斜、嵌套减细与笔端，先预览后应用。

内置库只读：第一次保存时自动新建 `my-glyphs`（继承当前内置库），之后的修改写入该文件。所有修改经过预检，一次撤销。

## 内置演示库 builtin:demo（覆盖范围）

`builtin:demo`（演示部件体）全部由程序内的笔画数据生成，不来自任何字体：

- 117 个部件：约 80 个独体字/常用部件（一 二 十 人 大 口 日 月 目 田 木 禾 米 山 水 火 土 王 工 子 女 心 手 又 力 寸 小 门 文 方 马 车 言 贝 见 页 足 等），30 个偏旁（亻 彳 氵 冫 扌 忄 讠 纟 钅 饣 礻 犭 阝 刂 攵 欠 艹 宀 冖 亠 灬 与 辶 走 囗 广 厂 尸 疒 冂 凵 匚 勹 戈 包围部件）。
- 378 个 IDS 拼字，加上可直接使用的独体部件，共约 465 个常用汉字可绘制，另有 14 个全角标点（，。、！？：；·—“”《》等）。
- 定位为演示与起点，不是完整字库。按常用字频率表实测覆盖率：前 100 字约 48%，前 500 字约 34%，前 1000 字约 26%，前 2500 字约 17%。用 `glyphs_inspect text=…` 查看具体文字的覆盖情况，正式使用时请保持 `glyphFallback:"font"` 或用 glyphs_plan 补充部件与拼字。笔画为几何化的中线笔画，字形风格接近圆体手写，没有专业字体的视觉校正。

## 尚未完成（第二批）

- 笔画级部件编辑器（逐点编辑、笔画增删与排序）。目前部件通过 JSON / glyphs_plan 编写。
- 按笔顺书写动画（write-on）；数据中已保留笔顺。
- 导出为 OTF/TTF 字体文件。
- 竖排、比例宽度自动计算、视觉重心自动校正。
