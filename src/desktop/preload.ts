import { contextBridge, ipcRenderer } from 'electron';
// Read once, synchronously, so the page's boot script can apply the theme before first paint.
let themePreference: unknown;
try {
  themePreference = ipcRenderer.sendSync('theme:initial');
} catch {
  themePreference = undefined;
}
contextBridge.exposeInMainWorld('vmotionDesktop', {
  themePreference:
    themePreference === 'dark' || themePreference === 'light' || themePreference === 'system'
      ? themePreference
      : undefined,
  setThemePreference: (preference: 'system' | 'dark' | 'light') => ipcRenderer.invoke('theme:set', preference),
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
