// Identifica onde a interface está rodando. O aplicativo Windows injeta
// window.CodeAssistantsDesktop no HTML servido pelo próprio executável; o APK
// usa o bridge AndroidApp. No navegador comum os dois ficam ausentes.

export interface DesktopInfo {
  version: string;
  platform: string;
}

declare global {
  interface Window {
    CodeAssistantsDesktop?: DesktopInfo;
  }
}

export function desktopInfo(): DesktopInfo | undefined {
  if (typeof window === 'undefined') return undefined;
  const info = window.CodeAssistantsDesktop;
  return info && typeof info === 'object' && typeof info.version === 'string' ? info : undefined;
}

export function isDesktopApp(): boolean {
  return desktopInfo() !== undefined;
}

/** Versão instalada informada pelo próprio executável, quando existir. */
export function installedVersion(): string | undefined {
  return desktopInfo()?.version;
}
