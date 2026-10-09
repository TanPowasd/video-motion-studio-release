import type { ProjectCreationInput, ProjectHome } from '../core/project-creation.js';
declare global {
  interface Window {
    vmotionDesktop?: {
      pickAsset: () => Promise<string | undefined>;
      pickPluginSource?: (kind: 'file' | 'folder') => Promise<string | undefined>;
      pickProjectDirectory: (directory?: string) => Promise<string | undefined>;
      projectHome: () => Promise<ProjectHome>;
      openProject: (root?: string) => Promise<void>;
      createProject: (options: ProjectCreationInput & { directory: string }) => Promise<void>;
      showHome: () => Promise<void>;
      openAgentWorkbench: (route?: string) => Promise<void>;
      openStudioWorkbench: () => Promise<void>;
      showFile: (file: string) => Promise<void>;
    };
  }
}
export {};
