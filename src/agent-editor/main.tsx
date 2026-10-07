import React from 'react';
import { createRoot } from 'react-dom/client';
import { AgentWorkbench } from './Workbench.js';
import './agent.css';
createRoot(document.getElementById('root')!).render(<AgentWorkbench />);
