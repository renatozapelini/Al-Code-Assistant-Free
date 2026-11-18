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
// Após o desregistro, recarrega a página para garantir que nenhum SW controle
// as requisições (protegido contra loop infinito pelo sessionStorage).
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    const hadSw = registrations.length > 0;
    for (const registration of registrations) {
      void registration.unregister();
    }
    if (hadSw && !sessionStorage.getItem('code-assistants-sw-cleared')) {
      sessionStorage.setItem('code-assistants-sw-cleared', '1');
      window.location.reload();
    }
  });
}

// Limpa a flag de limpeza de SW após o recarregamento, para não bloquear recargas futuras.
if (typeof window !== 'undefined' && sessionStorage.getItem('code-assistants-sw-cleared')) {
  sessionStorage.removeItem('code-assistants-sw-cleared');
}

// Se está rodando pelo EXE (localhost), garante a identificação do Windows
// ou Android com a versão real do aplicativo. Sobrescreve apenas se o HTML
// não injetou a identificação (ex.: quando carregado via service worker cache).
if (
  isLocalhost &&
  typeof window !== 'undefined' &&
  !isDesktopApp()
) {
  const isAndroid = /android/i.test(navigator.userAgent);
  (window as Window & { CodeAssistantsDesktop?: { version: string; platform: string } }).CodeAssistantsDesktop = {
    version: APP_VERSION,
    platform: isAndroid ? 'android' : 'windows',
  };
}

// O APK tem CSP que proíbe workers; o .exe serve os assets do próprio arquivo.
// Não registra SW quando rodando pelo EXE (localhost).
if (!androidBridge() && !isDesktopApp() && !isLocalhost) {
  registerSW({ immediate: true });
}

createRoot(document.getElementById('root')!).render(<App />);
