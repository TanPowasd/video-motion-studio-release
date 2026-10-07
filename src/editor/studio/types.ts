import type { Snapshot, Node } from '../../core/model.js';
export type StudioTab =
  'graph' | 'motion' | 'space' | 'particles' | 'storyboard' | 'mix' | 'review' | 'performance';
export type StudioContext = {
  snapshot: Snapshot;
  sceneId: string;
  node?: Node;
  nodes?: Node[];
  frame: number;
  path: string[];
  contextFrames: number[];
  selected: Array<{ nodeId: string; path: string[]; contextFrames: number[]; frame: number }>;
  run: (method: string, params?: unknown) => Promise<any>;
  onApplied: () => void;
};
export const studioTabs: Array<{ id: StudioTab; name: string; icon: string; description: string }> =
  [
    { id: 'graph', name: '特效节点', icon: 'scene', description: '连接、分支、参数与输出' },
    { id: 'motion', name: '动作编排', icon: 'layers', description: '动作模板与动画叠加' },
    { id: 'space', name: '三维场景', icon: 'cube', description: '模型、相机、材质与灯光' },
    { id: 'particles', name: '粒子', icon: 'sparkles', description: '发射、运动、生命周期' },
    { id: 'storyboard', name: '分镜与转场', icon: 'film', description: '镜头卡片与配音编排' },
    { id: 'mix', name: '混音', icon: 'music', description: '轨道、总线、效果与响度' },
    { id: 'review', name: '画面检查', icon: 'eye', description: '颜色、稳定性与图层影响' },
    { id: 'performance', name: '渲染性能', icon: 'settings', description: '设备选择、对照与导出' },
  ];
