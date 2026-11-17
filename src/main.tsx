import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';
import { androidBridge } from './utils/androidBridge';
import { isDesktopApp } from './utils/platform';
import { APP_VERSION } from './version';

const isLocalhost =
  typeof window !== 'undefined' &&
  (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost');

// Desregistra service workers antigos que podem estar interceptando requisições
// e causando erro 404 ou impedindo o app de se reconhecer como Windows.
// Isso roda assim que o JavaScript carrega, antes de renderizar a interface.
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      void registration.unregister();
    }
  });
}

// Se está rodando pelo EXE (localhost) e o HTML não injetou a identificação
// do Windows, define aqui como fallback para o app se reconhecer como desktop.
if (
  isLocalhost &&
  !isDesktopApp() &&
  typeof window !== 'undefined'
) {
  (window as Window & { CodeAssistantsDesktop?: { version: string; platform: string } }).CodeAssistantsDesktop = {
    version: APP_VERSION,
    platform: 'windows',
  };
}

// O APK tem CSP que proíbe workers; o .exe serve os assets do próprio arquivo.
// Não registra SW quando rodando pelo EXE (localhost).
if (!androidBridge() && !isDesktopApp() && !isLocalhost) {
  registerSW({ immediate: true });
}

createRoot(document.getElementById('root')!).render(<App />);
