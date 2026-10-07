# 可编程组件的结构化参数

组件源码声明参数，界面和外部 agent 通过同一套参数数据编辑图表、布局和视觉效果。软件不接入模型，TypeScript 的编译器会根据参数声明推导 `render(ctx, params)` 的值类型。

```ts
import { defineComponent, rect } from '@vmotion/sdk';

export default defineComponent({
  name: '数据组件',
  parameters: {
    mode: { type: 'enum', options: ['bar', 'line'], default: 'bar' },
    visible: { type: 'boolean', default: true },
    origin: { type: 'vec2', default: { x: 120, y: 180 }, min: 0 },
    data: {
      type: 'array',
      minLength: 1,
      maxLength: 12,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', default: '新数据' },
          value: { type: 'number', min: 0, max: 100, default: 50 },
        },
      },
      default: [{ label: '第一项', value: 40 }],
    },
    style: {
      type: 'object',
      properties: { color: { type: 'color', default: '#79b6ff' } },
    },
  },
  render(ctx, params) {
    // params.mode is 'bar' | 'line'; params.data is an array of {label, value}.
    if (!params.visible) return [];
    return params.data.map((item, i) =>
      rect(`bar-${i}`, {
        x: params.origin.x + i * 50,
        y: params.origin.y,
        width: 30,
        height: item.value,
        fill: params.style.color,
      }),
    );
  },
});
```

| 类型 | 约束与属性 | 编辑界面 |
| --- | --- | --- |
| number | min/max、integer、step、default | 数字输入、关键帧 |
| string | minLength/maxLength、default | 文本输入 |
| color | CSS 颜色字符串、default | 色板与文本输入 |
| boolean | default | 复选框 |
| enum | options 为字符串或有限数字，default | 下拉选项 |
| vec2 / vec3 | x/y(/z)、min/max、step、default | 逐坐标数字与关键帧 |
| array | items、minLength/maxLength、default | 分页编辑、插入/删除/排序、JSON |
| object | properties、default | 嵌套参数组 |

每个参数支持 label、description。可省略 default：数字按范围选取 0，字符串为空、布尔为 false、颜色为白色，向量为 0，枚举使用首个选项，数组按 minLength 生成项目，对象使用子字段默认值。自定义默认值会验证。每次求值返回独立的数据副本，组件不能通过修改默认数组影响后续帧。

未知参数、未知嵌套字段、错误类型、越界值、无效枚举、非法默认值会被拒绝，并给出参数路径。声明中避免把任意内部配置混进 params；需要的字段应明确暴露。参数层级上限 16，单次值检查预算 10 万项，数组默认最多 1 万项；更大的画稿与媒体数据使用资源文件。

数字叶节点可使用 `params.origin.x`、`params.data.1.value`、`params.style.line.width` 关键帧。Rust 与 TypeScript 通过同一字段路径求值。参数值要覆盖所有求值时刻：integer 参数应使用 hold，弹簧/贝塞尔超调可能越过声明的范围，此时渲染会返回诊断。枚举、字符串与布尔暂不支持数字关键帧。

编辑界面先显示组件参数，再显示普通变换。◇ 在当前帧建立关键帧时会一次补齐默认数据。已有数值动画时，数字编辑更新当前帧关键帧。重置参数会恢复默认并删除该字段及子字段的动画。

MCP `component_parameters` 返回声明、defaults、静态 values、当前 evaluated 值、JSON Schema 与可动画的数字路径；`component_parameters_edit` 支持：

```json
{
  "sceneId": "intro",
  "nodeId": "chart",
  "revision": "<project-revision>",
  "frame": 30,
  "updates": [{ "path": "style.color", "value": "#ffcc88" }],
  "keys": [
    { "path": "origin.x", "frame": 0, "value": 120, "easing": "linear" },
    { "path": "origin.x", "frame": 90, "value": 220, "easing": "easeInOut" }
  ],
  "arrays": [{ "type": "move", "path": "data", "from": 2, "to": 0 }]
}
```

`arrays` 支持 insert/remove/move，调整项目索引时同步映射关键帧路径，删除项目会删除它的动画。插入时可给 value，省略时使用项目默认值。`updates` 用于直接替换某个值；替换整个数组时索引动画仍按索引定义，涉及结构变动建议使用 arrays。

生成的嵌套组件使用 path 定位，参数修改仍保存到所属组件 overrides，源码不自动重写。所有参数编辑使用工程 revision 和一次原子事务，支持撤销。

```powershell
node dist/cli/index.mjs component-params --project examples/parameter-lab --scene intro --node chart --frame 90
node dist/cli/index.mjs component-edit --project examples/parameter-lab --request-file ./params.json
```

`examples/parameter-lab` 是可编辑的完整示例，包含枚举、布尔、向量、数组对象及数据/位置动画。

## Agent 精简参数查询

component_query支持普通/生成组件与模板端口：paths选择相对参数路径，默认16参数/32数值通道分页，offset/limit与channelOffset/channelLimit显示完整计数及nextOffset。数组/对象与长文本只返回长度及有界预览；includeSchema/fullValues显式读取选定定义与完整值。原component_parameters保持完整响应和1000通道上限；新接口可查询第1000通道以后，不重复生成完整Schema。

值来自主题与原生关键帧，不代表所有最终表达式/布局/路径；需drivers_inspect和最终画面取证。查询revision可拒绝过期版本，错误索引/未声明路径不会部分成功。默认仍求值全部参数，响应精简不代表整体大数据求值已经消失。
