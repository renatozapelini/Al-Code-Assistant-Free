import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';
import { androidBridge } from './utils/androidBridge';
import { isDesktopApp } from './utils/platform';

// O APK tem CSP que proíbe workers; o .exe serve os assets do próprio arquivo.
// Nos dois casos não há service worker, apenas no navegador/PWA.
if (!androidBridge() && !isDesktopApp()) registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(<App />);
