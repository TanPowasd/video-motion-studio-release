import React from 'react';
export function Icon({ name, size = 17 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    cube: (
      <>
        <path d="m12 2 9 5v10l-9 5-9-5V7Zm-9 5 9 5 9-5M12 12v10" />
      </>
    ),
    sparkles: (
      <>
        <path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Zm8-1v6m-3-3h6" />
      </>
    ),
    volume: (
      <>
        <path d="M3 9h4l5-4v14l-5-4H3Zm12-1c3 2 3 6 0 8m3-11c5 4 5 10 0 14" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V6a4 4 0 0 1 8 0v4" />
      </>
    ),
    unlock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V6a4 4 0 0 1 7-2" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V4H4v12h4" />
      </>
    ),
    repeat: (
      <>
        <rect x="3" y="3" width="6" height="6" rx="1" />
        <rect x="15" y="3" width="6" height="6" rx="1" />
        <rect x="3" y="15" width="6" height="6" rx="1" />
        <rect x="15" y="15" width="6" height="6" rx="1" />
        <path d="M10 6h4M6 10v4m12-4v4m-8 4h4" />
      </>
    ),
    delete: <path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />,
    up: <path d="m5 14 7-7 7 7" />,
    down: <path d="m5 10 7 7 7-7" />,
    play: <path d="m8 5 11 7-11 7Z" />,
    pause: <path d="M8 5v14M16 5v14" />,
    plus: <path d="M12 5v14M5 12h14" />,
    minus: <path d="M5 12h14" />,
    layers: <path d="m12 3 10 6-10 6L2 9Zm-10 11 10 6 10-6" />,
    scene: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M7 7h6v6H7ZM13 13h4v4h-4M13 10h4m-7 3v4" />
      </>
    ),
    film: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M7 3v18M17 3v18M3 8h4m-4 8h4m10-8h4m-4 8h4" />
      </>
    ),
    music: (
      <>
        <path d="M9 18V5l11-2v13M9 9l11-2" />
        <ellipse cx="6" cy="18" rx="3" ry="2" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="2" />
      </>
    ),
    fit: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
    grid: (
      <>
        <rect x="3" y="3" width="18" height="18" />
        <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
      </>
    ),
    text: <path d="M4 5h16M12 5v15M8 20h8" />,
    rect: <rect x="4" y="4" width="16" height="16" rx="2" />,
    ellipse: <circle cx="12" cy="12" r="8" />,
    code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-16-2 20" />,
    brush: <path d="m9 15 8-12 4 4-12 8M9 15c0 4-3 6-7 5 3-1 0-5 4-6Z" />,
    chart: <path d="M4 3v17h17M8 16v-5m5 5V7m5 9V4" />,
    key: <path d="m12 4 8 8-8 8-8-8Z" />,
    arrow: <path d="m8 4 8 8-8 8" />,
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 6 6" />
      </>
    ),
    panel: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2" />
      </>
    ),
    folder: <path d="M3 7V5h6l3 3h9v12H3Z" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    undo: <path d="m9 5-5 4 5 4M4 9h9a7 7 0 0 1 7 7" />,
    redo: <path d="m15 5 5 4-5 4M20 9h-9a7 7 0 0 0-7 7" />,
    export: <path d="M12 15V3m-4 4 4-4 4 4M5 13v7h14v-7" />,
    link: (
      <path d="m9 15 6-6M8 14l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 5 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" />
    ),
    check: <path d="m5 12 4 4L19 6" />,
    skipBack: <path d="M6 5v14M19 5 9 12l10 7Z" />,
    skipForward: <path d="M18 5v14M5 5l10 7-10 7Z" />,
    stepBack: <path d="m15 6-6 6 6 6" />,
    stepForward: <path d="m9 6 6 6-6 6" />,
    command: (
      <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z" />
    ),
    keyboard: (
      <>
        <rect x="2" y="6" width="20" height="13" rx="2" />
        <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 15h10" />
      </>
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </>
    ),
    moon: <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />,
    monitor: (
      <>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8m-4-4v4" />
      </>
    ),
    sidebarLeft: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
      </>
    ),
    sidebarRight: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M15 4v16" />
      </>
    ),
    panelBottom: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 14h18" />
      </>
    ),
    plug: <path d="M9 2v6m6-6v6M6 8h12v3a6 6 0 0 1-12 0Zm6 9v5" />,
    magnet: <path d="M5 4h4v8a3 3 0 0 0 6 0V4h4v8a7 7 0 0 1-14 0Zm0 4h4m6 0h4" />,
    reset: <path d="M4 4v6h6M4.5 15a8 8 0 1 0 1.9-8.3L4 10" />,
    home: <path d="m3 11 9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z" />,
    alignLeft: <path d="M4 3v18M8 7h10v4H8Zm0 6h6v4H8Z" />,
    alignHCenter: <path d="M12 3v18M6 7h12v4H6Zm3 6h6v4H9Z" />,
    alignRight: <path d="M20 3v18M6 7h10v4H6Zm4 6h6v4h-6Z" />,
    alignTop: <path d="M3 4h18M7 8h4v10H7Zm6 0h4v6h-4Z" />,
    alignVCenter: <path d="M3 12h18M7 6h4v12H7Zm6 3h4v6h-4Z" />,
    alignBottom: <path d="M3 20h18M7 6h4v10H7Zm6 4h4v6h-4Z" />,
    distributeH: <path d="M3 4v16m18-16v16M8 8h3v8H8Zm5 2h3v4h-3Z" />,
    distributeV: <path d="M4 3h16M4 21h16M8 8h8v3H8Zm2 5h4v3h-4Z" />,
    ruler: <path d="M3 17 17 3l4 4L7 21Zm4-4 2 2m1-5 2 2m1-5 2 2" />,
    artboard: (
      <>
        <rect x="6" y="6" width="12" height="12" />
        <path d="M6 2v3m12-3v3M6 19v3m12-3v3M2 6h3m-3 12h3M19 6h3m-3 12h3" />
      </>
    ),
    bleed: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="1" strokeDasharray="2 2" />
        <rect x="7" y="7" width="10" height="10" />
      </>
    ),
    image: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8" cy="8" r="2" />
        <path d="m3 18 6-6 4 4 4-6 4 7" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.layers}
    </svg>
  );
}
