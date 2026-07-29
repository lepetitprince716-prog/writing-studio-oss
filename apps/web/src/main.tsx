import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { applyTheme, useStudio } from './store.js';
import './styles.css';

// Reflect the stored theme before first paint to avoid a flash of the wrong theme.
applyTheme(useStudio.getState().theme);

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
