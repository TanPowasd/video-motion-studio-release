import type { Scene, Node } from '../../core/model.js';
import type { RenderJob } from '../../media/export.js';
import type { StudioTab } from '../studio/types.js';
import type { CodeCheckReport } from '../CodeCheck.js';
import type { VisualAuditReport } from '../VisualAuditPanel.js';
import type { InteractionGraph, CompositionDraft } from '../../core/interaction.js';
import type { ParameterDefinitions } from '../../core/parameters.js';
import type { CompositionRoute } from '../navigation.js';
import type { PanelLayout } from '../panelLayout.js';
import type { ApplicationState as State } from '../../service/rpc-contract.js';
export interface WorkbenchState {
  project: {
    state: State | undefined;
  };
  route: {
    workspace: string;
    studioTab: StudioTab | undefined;
    drawingId: string;
    focusPath: string[];
    composition:
      | (
          | {
              scene: Scene;
              width: number;
              height: number;
              breadcrumbs: Array<{ id: string; name: string; type: string }>;
            }
          | undefined
        )
      | undefined;
    sceneId: string;
    focusContextFrames: number[];
  };
  tasks: {
    exportGpu: string;
    saving: boolean;
    exportPath: string;
    format: string;
    jobs: RenderJob[];
  };
  preview: {
    sceneFrames: Record<string, number>;
    sequenceFrame: number;
    playing: boolean;
    previewReady: boolean;
    previewFrame: number;
    previewBusy: boolean;
    previewQuality: number;
    previewMedia: 'auto' | 'original';
    waveforms: Record<string, number[]>;
  };
  panels: {
    layout: PanelLayout;
    inspectorTab: 'properties' | 'effects' | 'animation';
    filter: string;
    modal: ('export' | 'connect' | 'settings' | undefined) | undefined;
  };
  selection: {
    selectedIds: string[];
    interactions: InteractionGraph | undefined;
    canvasDraft: CompositionDraft[] | undefined;
    componentParams: ParameterDefinitions;
    clipSelection: string[];
  };
  diagnostics: {
    error: string;
    visualCheck: VisualAuditReport | undefined;
    visualCheckBusy: boolean;
  };
  code: {
    codePath: string;
    code: string;
    codeDirty: boolean;
    codeBusy: boolean;
    codeCheck: CodeCheckReport | undefined;
    codeJump: { line: number; column?: number } | undefined;
    codeBase:
      | {
          path: string;
          hash: string;
          version: 'active' | 'pending';
        }
      | undefined;
  };
  drawing: {
    brush: number;
    paintColor: string;
    hold: number;
    onion: boolean;
    stroke: Node['points'];
  };
  assets: {
    assetTab: boolean;
    selectedAsset: string;
    soundEditing: string | undefined;
    mediaManaging: boolean;
    pluginManaging: boolean;
  };
}

export function createWorkbenchState(initialRoute: CompositionRoute): WorkbenchState {
  return {
    project: {
      state: undefined,
    },
    route: {
      workspace: initialRoute.workspace,
      studioTab: undefined,
      drawingId: initialRoute.drawingId ?? '',
      focusPath: initialRoute.path,
      composition: undefined,
      sceneId: initialRoute.sceneId,
      focusContextFrames: initialRoute.contextFrames ?? [],
    },
    tasks: {
      exportGpu: 'auto',
      saving: false,
      exportPath: '',
      format: 'mp4',
      jobs: [],
    },
    preview: {
      sceneFrames: {},
      sequenceFrame: 0,
      playing: false,
      previewReady: false,
      previewFrame: 0,
      previewBusy: false,
      previewQuality: 960,
      previewMedia: 'auto',
      waveforms: {},
    },
    panels: {
      layout: { left: 250, right: 304, timeline: 260, showLeft: true, showRight: true },
      inspectorTab: 'properties',
      filter: '',
      modal: undefined,
    },
    selection: {
      selectedIds: [],
      interactions: undefined,
      canvasDraft: undefined,
      componentParams: {},
      clipSelection: [],
    },
    diagnostics: {
      error: '',
      visualCheck: undefined,
      visualCheckBusy: false,
    },
    code: {
      codePath: '',
      code: '',
      codeDirty: false,
      codeBusy: false,
      codeCheck: undefined,
      codeJump: undefined,
      codeBase: undefined,
    },
    drawing: {
      brush: 6,
      paintColor: '#c1b6ff',
      hold: 30,
      onion: false,
      stroke: [],
    },
    assets: {
      assetTab: false,
      selectedAsset: '',
      soundEditing: undefined,
      mediaManaging: false,
      pluginManaging: false,
    },
  };
}
