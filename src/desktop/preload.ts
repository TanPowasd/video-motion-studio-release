import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('vmotionDesktop', {
  pickAsset: () => ipcRenderer.invoke('asset:pick'),
  pickPluginSource: (kind: 'file' | 'folder') => ipcRenderer.invoke('plugin:pick', kind),
  openProject: (root?: string) => ipcRenderer.invoke('project:open', root),
  createProject: (options: unknown) => ipcRenderer.invoke('project:create', options),
  pickProjectDirectory: (directory?: string) => ipcRenderer.invoke('project:directory', directory),
  projectHome: () => ipcRenderer.invoke('project:list'),
  showHome: () => ipcRenderer.invoke('project:home'),
  openAgentWorkbench: () => ipcRenderer.invoke('agent:open'),
  openStudioWorkbench: () => ipcRenderer.invoke('studio:open'),
  captureTestWindow: () => ipcRenderer.invoke('test:capture'),
  showFile: (file: string) => ipcRenderer.invoke('file:show', file),
});
