import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';
import { androidBridge } from './utils/androidBridge';

// Native assets are served by the app itself; its CSP deliberately forbids workers.
if (!androidBridge()) registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(<App />);
