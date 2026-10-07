# 工程引用、选择换源与镜头查询

组织模块提供工程用途图、声明引用批量替换、生成引用采样和镜头窗口查询。所有创作修改仍走同一候选/预检/版本/hash/原子提交与共享undo；软件不接入模型。默认MCP10入口保持，通过tools_search或pluginId=vmotion.organization按需发现四个工具。

project_references的section可选references/entities/reachable/uncertainties，默认24项、最高100，offset/nextOffset和coverage报告未返回部分。entity={kind,id}选择工程、scene、sequence、asset、drawing或file，direction控制incoming/outgoing。references中kinds过滤目标种类，files精确匹配来源文件；query匹配ID/文件/关系。detail返回原始JSON pointer、按对象ID构成的stablePath与代码行列，默认只提供ID和摘要。引用ID根据来源文件、稳定路径、关系、目标产生，重排同ID对象保留；引用换源后ID改变，应重新查询。

已知JSON角色包括工程注册、scene节点/结构新增/嵌套/overrides、sceneDependencies、时间轴source、component/theme/effectGraph/subgraph/mesh资源、sound采样、storyboard来源与配音、主题parent、模板固定清单、plugin入口/贡献/pin以及tracking来源。画稿笔迹不按任意字符串推测引用；发布素材的sourceDocumentId记录来源画稿。字体只按注册字体名/别名匹配为保守用途证据，不作为直接ID替换项。任意params、表达式和自定义JSON字段的语义没有自动猜测，未知资源明确uncertain。

静态TypeScript解析只识别import/export的相对模块和精确字符串字面量。相对导入按当前tracked文件解析，资源新增/删除会重新解析目标；字面量只是hint，includeHints=true才进入默认用途结果。代码可以通过参数、拼接、数据或函数生成引用，因此coverage.runtimeComplete始终false，uncertainties列出代码/未知JSON/超预算源。源文件超过8MiB不做静态解析，仍可显式读取。未使用结果不授权删文件；全部声明可达也不证明最终像素可见。registered-unprobed表示素材清单记录，实际文件需media_inspect/status。

引用扫描LRU128文件/8MiB估算，最后索引最多24MiB估算，按实际tracked源文本及资源角色检查；查询不编译组件、不解码媒体、不重加载磁盘。index.scans/scanHits/indexBuilds/indexHits与保留量提供证据，未变源重复请求不再次JSON/AST解析。构建索引仍需遍历文件/关系，分页限制响应而不是把编译或遍历工作缩成24项。最多100000引用、reachable最多10000实体；超限明确报错。元数据字节估算不是进程总RAM认证。

reference_sample显式选择1–12个scene/group/component样本与局部frame/path/contextFrames，展开真实代码/嵌套引用，默认分页返回24项。detail提供nodeId、path、localFrame、contextFrames及可编辑状态，供现有composition工具写生成overrides。按实际locator缓存编辑作用域，每个样本最多256作用域，超限报错。样本包括不活跃对象的引用证据，不是遮罩/混合后可见性证明；需要frame_capture或visual_audit查看画面。任意帧/代码不确定性仍未覆盖，采样不改工程或历史。

reference_plan必须传当前revision，items选择同kind的from/to；可用referenceIds或files缩小范围，不指定时修改全部已声明的可编辑引用。expectedUses是筛选后的可编辑引用数，包含注册记录/代码hint的total不能直接作为它。每个引用每批只改一次，ID过期或重复重叠拒绝；保留节点/片段ID、变换、普通/叠层动画、源时间窗口、TS代码与旧源资源。

```json
{
  "revision":"当前工程版本",
  "items":[{
    "from":{"kind":"asset","id":"old-picture"},
    "to":{"kind":"asset","id":"new-picture"},
    "referenceIds":["从 project_references 取到的32位引用ID"],
    "expectedUses":1
  }]
}
```

资产换源保持注册类型，实际probe信息/fingerprint写入同一候选，素材发生变化时拒绝提交。时间轴和静态分镜的窗口保留，已知片段换源检查最后源帧不超替换时长、锁定轨道拒绝；场景/序列循环与资源错误在验证前保存不了。图层参数/尺寸不自动重适配，新源构图由Agent决定。JSON文件原hash固定，计划不保存活动工程；source-only修改可显式传samples，图片最多12帧、changes摘要最多24条，coverage说明遗漏。按返回candidate预检，再原样apply，整批一次undo。

资源file换源要求目标为tracked源文件；外部图片/音视频路径使用media_relink_plan。代码字面量、工程注册路径、templateInstance/pinned模板/plugin/跟踪出处不是可编辑引用，须使用各自版本迁移/重新分析工具。批量换源不偷偷解除hash pin、不删旧素材、不移动真实文件。source引用的任意TypeScript编译/新参数域最终要用原生采样预检；错误保留最后可用工程。

生成图层现可通过overrides设置assetId/audioAssetId/component/source，不必改写原始TypeScript。project_references只检索已经持久化的overrides；尚未覆盖的动态内容先reference_sample定位，再composition_edit_layer或批量工具显式创建覆盖。共享组件源码和其他未覆盖实例保持原逻辑。

sequence_query默认24个存储片段，可按sequenceId/trackIds/clipIds/source与end-exclusive range筛选；返回轨道锁定/静音、start/end/duration/sourceIn/sourceLast/speed/linkID。detail才返回选定完整clip，包括fade/source windows。不同轨道按开始时刻与稳定ID排序，嵌套序列只列source reference而不自动递归展开，整片实际边界/音画仍用sequence_audit/导出验证。

CLI project-references/reference-plan/reference-sample/sequence-query均用--request JSON，与MCP服务和工具的严格验证一致。examples/source-organization-lab展示原三处引用中的选择换源，实例文字/动画保持；作者脚本--render-only保留修改，重写需--rebuild。组织模块当前面向Agent和代码，交互式大型依赖图/自动未用资源删除/智能镜头匹配仍待实现。

当前便携真实MCP参考工程默认24引用页为7039字节，完整工程188954字节，约减少96.3%；100条detail页34786、runtime定位detail12447、默认镜头页5517字节。21次同一文件集查询无新增JSON/AST扫描，索引估算407454/24MiB。度量是JSON UTF8字节与解析次数，不是假设模型token或整体视频性能。MCP仍10入口13729字节；四接口Schema1675–2362字节，条件缓存124–128字节。检查只覆盖指定样本和静态角色，不能据此宣称全片引用完整。
