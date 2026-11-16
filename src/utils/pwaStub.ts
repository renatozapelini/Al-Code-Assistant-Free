// Substituto do módulo virtual do vite-plugin-pwa nos builds do aplicativo
// Windows: o .exe serve os assets localmente e não usa service worker.
export function registerSW(): () => void {
  return () => {};
}
