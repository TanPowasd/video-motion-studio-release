import { Suspense, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import { ProjectHome } from './ProjectHome.js';
import { McpConnection } from './McpConnection.js';
import { Workbench } from './Workbench.js';
import { Tooltips } from './Tooltips.js';
import { loadRuntimeFonts } from './runtime-fonts.js';
// Font requests must not extend Electron's initial loadURL/switch transaction.
if (document.readyState === 'complete') void loadRuntimeFonts();
else window.addEventListener('load', () => void loadRuntimeFonts(), { once: true });
import { WorkbenchProvider } from './state/workbench-store.js';
function Root() {
  const [route, setRoute] = useState(location.hash);
  useEffect(() => {
    const changed = () => setRoute(location.hash);
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  // Music is one of the Studio modes: the shell renders the music workspace itself so the
  // scene strip, change feed and selection persist across mode switches.
  const workspace = route.startsWith('#/welcome') ? (
    <ProjectHome />
  ) : (
    <WorkbenchProvider>
      <Workbench />
    </WorkbenchProvider>
  );
  return (
    <>
      {workspace}
      <McpConnection />
      <Tooltips />
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <Suspense
    fallback={
      <div className="workspace-loading" role="status">
        <span className="vm-spinner" />
        正在打开工作区…
      </div>
    }
  >
    <Root />
  </Suspense>,
);
