import { lazy, Suspense, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectHome } from './ProjectHome.js';
import { Workbench } from './Workbench.js';
import { loadRuntimeFonts } from './runtime-fonts.js';
// Font requests must not extend Electron's initial loadURL/switch transaction.
if (document.readyState === 'complete') void loadRuntimeFonts();
else window.addEventListener('load', () => void loadRuntimeFonts(), { once: true });
import { WorkbenchProvider } from './state/workbench-store.js';
const MusicWorkspace = lazy(() => import('./music/MusicWorkspace.js'));
function Root() {
  const [route, setRoute] = useState(location.hash);
  useEffect(() => {
    const changed = () => setRoute(location.hash);
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return route.startsWith('#/welcome') ? (
    <ProjectHome />
  ) : route.startsWith('#/music') ? (
    <MusicWorkspace />
  ) : (
    <WorkbenchProvider>
      <Workbench />
    </WorkbenchProvider>
  );
}
createRoot(document.getElementById('root')!).render(
  <Suspense fallback={<div className="workspace-loading">正在打开工作区…</div>}>
    <Root />
  </Suspense>,
);
