import React, { useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  Hammer,
  Key,
  Loader2,
  Monitor,
  Plus,
  Smartphone,
  Sparkles,
  Terminal,
  Trash2,
  XCircle,
} from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import type { GatewayApiKey, GatewaySettings, RealmId } from '../types/hub';
import { downloadQoderAndroidStudioProject } from '../utils/androidProjectZip';

interface AndroidSettingsPanelProps {
  settings: GatewaySettings;
  apiKeys: GatewayApiKey[];
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onSettingsChanged: () => void;
}

interface BuildAgentResult {
  ok: boolean;
  target: string;
  steps: Array<{ name: string; ok: boolean; durationMs: number; detail: string }>;
  artifacts: Array<{
    label: string;
    filename: string;
    sizeBytes: number;
    sha256: string;
    downloadUrl: string;
  }>;
  logs: string;
}

export const AndroidSettingsPanel: React.FC<AndroidSettingsPanelProps> = ({
  settings,
  apiKeys,
  apiFetch,
  onSettingsChanged,
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIosGuide, setShowIosGuide] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [buildingApk, setBuildingApk] = useState(false);
  const [apkStatus, setApkStatus] = useState<string | null>(null);
  const [buildingExe, setBuildingExe] = useState(false);
  const [exeStatus, setExeStatus] = useState<string | null>(null);

  // Compilation Agent ("Agente de Compilação") state
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentTarget, setAgentTarget] = useState<'all' | 'apk' | 'exe' | 'lint'>('all');
  const [agentResult, setAgentResult] = useState<BuildAgentResult | null>(null);
  const [projectErrorLog, setProjectErrorLog] = useState('');
  const [aiDiagnosis, setAiDiagnosis] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const activeKeyValue = apiKeys[0]?.key || 'YOUR_API_KEY';

  const claudeCodeSnippet = `export ANTHROPIC_BASE_URL="${origin}"\nexport ANTHROPIC_AUTH_TOKEN="${activeKeyValue}"\nclaude`;
  const codexSnippet = `export OPENAI_BASE_URL="${origin}/v1"\nexport OPENAI_API_KEY="${activeKeyValue}"\ncodex`;

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // ignore
    }
  };

  const handleRunBuildAgent = async (target: 'all' | 'apk' | 'exe' | 'lint') => {
    setAgentTarget(target);
    setAgentBusy(true);
    setAgentResult(null);
    setAiDiagnosis(null);
    try {
      const res = await apiFetch('/api/hub/build-agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 160)}`);
      }
      const data = (await res.json()) as BuildAgentResult;
      setAgentResult(data);
      if (!data.ok && data.logs) {
        setProjectErrorLog(data.logs);
      }
    } catch (err) {
      setAgentResult({
        ok: false,
        target,
        steps: [
          {
            name: 'Agente de Compilação',
            ok: false,
            durationMs: 0,
            detail:
              err instanceof Error
                ? `${err.message} (No Android/Windows local use os botões diretos abaixo ou conecte ao servidor de build)`
                : 'Falha ao executar agente de compilação.',
          },
        ],
        artifacts: [],
        logs: err instanceof Error ? err.message : 'Erro desconhecido',
      });
    } finally {
      setAgentBusy(false);
    }
  };

  const handleDiagnoseErrorWithAi = async () => {
    if (!projectErrorLog.trim() || diagnosing) return;
    setDiagnosing(true);
    setAiDiagnosis(null);
    try {
      const res = await apiFetch('/api/hub/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'auto-failover',
          stream: false,
          messages: [
            {
              role: 'system',
              content:
                'Você é o Agente de Compilação do Qoder2API Hub. Analise o log de erro de compilação/build enviado pelo usuário (Android APK/Gradle, Windows EXE, Vite/TypeScript, Node ou Python), explique a causa raiz em português direto e forneça os comandos ou alterações exatas para corrigir e finalizar a compilação com sucesso.',
            },
            {
              role: 'user',
              content: `Analise e corrija este erro de compilação ao finalizar meu projeto:\n\n${projectErrorLog.trim()}`,
            },
          ],
        }),
      });
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };
      if (!res.ok) {
        throw new Error(data.error?.message || `HTTP ${res.status}`);
      }
      setAiDiagnosis(data.choices?.[0]?.message?.content || 'Sem resposta do agente IA.');
    } catch (err) {
      setAiDiagnosis(
        `Não foi possível consultar o pool Multi-IA: ${err instanceof Error ? err.message : 'Verifique suas chaves na aba APIs IA.'}`
      );
    } finally {
      setDiagnosing(false);
    }
  };

  const handleDownloadAndroidApk = async () => {
    setBuildingApk(true);
    setApkStatus('Empacotando e assinando Qoder2API-Hub.apk...');
    try {
      const res = await fetch('/api/hub/download/android-apk');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Erro HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Qoder2API-Hub.apk';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setApkStatus('Download de Qoder2API-Hub.apk iniciado. Instale no Android!');
    } catch (err) {
      setApkStatus(err instanceof Error ? err.message : 'Erro ao gerar .apk');
    } finally {
      setBuildingApk(false);
    }
  };

  const handleDownloadWindowsExe = async () => {
    setBuildingExe(true);
    setExeStatus('Compilando Qoder2API-Hub.exe (Windows 11 x64)...');
    try {
      const res = await fetch('/api/hub/download/windows-exe');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Erro HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Qoder2API-Hub.exe';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setExeStatus('Download de Qoder2API-Hub.exe iniciado.');
    } catch (err) {
      setExeStatus(err instanceof Error ? err.message : 'Erro ao gerar .exe');
    } finally {
      setBuildingExe(false);
    }
  };

  const handlePatchSettings = async (patch: Partial<GatewaySettings>) => {
    setSaving(true);
    try {
      await apiFetch('/api/hub/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      onSettingsChanged();
    } finally {
      setSaving(false);
    }
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/hub/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newKeyName.trim() || 'Chave Android / Win11' }),
    });
    setNewKeyName('');
    onSettingsChanged();
  };

  const handleDeleteKey = async (id: string) => {
    await apiFetch(`/api/hub/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    onSettingsChanged();
  };

  return (
    <div className="space-y-6">
      {/* Compilation Agent ("Agente de Compilação") */}
      <section className="bg-[#12151B] border border-emerald-700/40 rounded-2xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-400">
              <Hammer className="w-4 h-4 shrink-0" />
              <span>Agente de Compilação & Finalização de Projeto</span>
            </div>
            <h1 className="text-xl font-bold text-zinc-100">
              Compilar Versões Android (.APK) + Windows 11 (.EXE)
            </h1>
            <p className="text-xs text-zinc-400 max-w-2xl">
              Quando finalizar seu projeto, execute o agente abaixo para validar TypeScript, gerar o bundle atualizado, assinar o APK do Android e compilar o executável portátil do Windows 11 em 1 clique — tudo sem Termux nem configuração manual.
            </p>
          </div>

          <button
            type="button"
            disabled={agentBusy}
            onClick={() => void handleRunBuildAgent('all')}
            className="min-h-[48px] px-5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 text-zinc-950 text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap shrink-0 transition-colors"
          >
            {agentBusy && agentTarget === 'all' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Hammer className="w-4 h-4" />
            )}
            <span>Finalizar e Compilar Tudo (APK + EXE)</span>
          </button>
        </div>

        {/* Individual Agent Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={agentBusy}
            onClick={() => void handleRunBuildAgent('lint')}
            className="min-h-[42px] px-3.5 rounded-xl border border-zinc-800 bg-[#090B0E] hover:bg-zinc-800 text-xs font-medium text-zinc-200 flex items-center gap-1.5"
          >
            {agentBusy && agentTarget === 'lint' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Terminal className="w-3.5 h-3.5 text-emerald-400" />}
            <span>1. Checar Código (tsc)</span>
          </button>
          <button
            type="button"
            disabled={agentBusy}
            onClick={() => void handleRunBuildAgent('apk')}
            className="min-h-[42px] px-3.5 rounded-xl border border-zinc-800 bg-[#090B0E] hover:bg-zinc-800 text-xs font-medium text-zinc-200 flex items-center gap-1.5"
          >
            {agentBusy && agentTarget === 'apk' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Smartphone className="w-3.5 h-3.5 text-emerald-400" />}
            <span>2. Compilar Só Android (.APK)</span>
          </button>
          <button
            type="button"
            disabled={agentBusy}
            onClick={() => void handleRunBuildAgent('exe')}
            className="min-h-[42px] px-3.5 rounded-xl border border-zinc-800 bg-[#090B0E] hover:bg-zinc-800 text-xs font-medium text-zinc-200 flex items-center gap-1.5"
          >
            {agentBusy && agentTarget === 'exe' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Monitor className="w-3.5 h-3.5 text-emerald-400" />}
            <span>3. Compilar Só Windows 11 (.EXE)</span>
          </button>
        </div>

        {/* Agent Execution Steps & Artifacts */}
        {agentResult && (
          <div className="p-4 rounded-xl bg-[#090B0E] border border-zinc-800 space-y-4">
            <div className="space-y-2">
              {agentResult.steps.map((step, i) => (
                <div key={i} className="flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    {step.ok ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    ) : (
                      <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
                    )}
                    <span className="font-medium text-zinc-100 truncate">{step.name}</span>
                  </div>
                  <div className="font-mono tabular-nums text-zinc-400 shrink-0">
                    {step.detail} · {step.durationMs}ms
                  </div>
                </div>
              ))}
            </div>

            {agentResult.artifacts.length > 0 && (
              <div className="pt-3 border-t border-zinc-800/80 grid grid-cols-1 sm:grid-cols-2 gap-3">
                {agentResult.artifacts.map((art) => (
                  <a
                    key={art.filename}
                    href={art.downloadUrl}
                    download={art.filename}
                    className="min-h-[48px] p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/40 hover:bg-emerald-500/25 flex items-center justify-between gap-3 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-emerald-300 truncate">{art.filename}</div>
                      <div className="text-[11px] font-mono text-zinc-400 truncate tabular-nums">
                        {(art.sizeBytes / (1024 * 1024)).toFixed(2)} MB · SHA256 {art.sha256.slice(0, 12)}
                      </div>
                    </div>
                    <Download className="w-4 h-4 text-emerald-300 shrink-0" />
                  </a>
                ))}
              </div>
            )}

            {agentResult.logs && (
              <pre className="p-3 rounded-lg bg-[#12151B] border border-zinc-800/80 text-[11px] font-mono text-zinc-300 overflow-x-auto max-h-40">
                {agentResult.logs}
              </pre>
            )}
          </div>
        )}

        {/* AI Build Error Fixer (for user's finished projects) */}
        <div className="pt-4 border-t border-zinc-800/80 space-y-2.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
            <Sparkles className="w-4 h-4 text-emerald-400" />
            <span>Assistente IA de Compilação (Corrigir Erros ao Finalizar Seu Projeto)</span>
          </div>
          <textarea
            rows={3}
            value={projectErrorLog}
            onChange={(e) => setProjectErrorLog(e.target.value)}
            placeholder="Cole aqui qualquer erro de compilação do seu projeto (Gradle/APK, tsc, Vite, Bun, Electron, Python) para o Agente IA analisar usando suas APIs em failover..."
            className="w-full bg-[#090B0E] border border-zinc-800 rounded-xl p-3 text-xs font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
          <div className="flex justify-end">
            <button
              type="button"
              disabled={diagnosing || !projectErrorLog.trim()}
              onClick={() => void handleDiagnoseErrorWithAi()}
              className="min-h-[44px] px-4 rounded-xl bg-zinc-100 hover:bg-emerald-400 disabled:opacity-40 text-zinc-950 text-xs font-semibold flex items-center gap-2 transition-colors"
            >
              {diagnosing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              <span>Analisar & Corrigir Erro com Multi-IA</span>
            </button>
          </div>
          {aiDiagnosis && (
            <div className="p-4 rounded-xl bg-[#090B0E] border border-emerald-700/40 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed">
              {aiDiagnosis}
            </div>
          )}
        </div>
      </section>

      {/* Direct Downloads: Android APK & Windows 11 EXE */}
      <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 sm:p-6 space-y-4">
        <h2 className="text-base font-semibold text-zinc-100">
          Downloads Diretos (Android + Windows 11)
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Option 1: Ready Signed Android .APK */}
          <div className="p-4 rounded-xl bg-[#090B0E] border border-emerald-700/50 flex flex-col justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                <Smartphone className="w-4 h-4 text-emerald-400" />
                <span>Android (.APK Pronto)</span>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Arquivo <span className="font-mono text-zinc-300">Qoder2API-Hub.apk</span> assinado (Android 7–15) com gateway local na porta <span className="font-mono text-zinc-300">8790</span>, failover Multi-IA e motor COSY em Java — roda direto sem Termux.
              </p>
              {apkStatus && <p className="text-[11px] text-emerald-400 pt-1">{apkStatus}</p>}
            </div>

            <button
              type="button"
              disabled={buildingApk}
              onClick={() => void handleDownloadAndroidApk()}
              className="min-h-[44px] w-full rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 text-zinc-950 text-sm font-semibold flex items-center justify-center gap-2 transition-colors"
            >
              {buildingApk ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              <span>{buildingApk ? 'Gerando .APK...' : 'Baixar Qoder2API-Hub.apk'}</span>
            </button>
          </div>

          {/* Option 2: Ready-to-run Windows 11 .EXE */}
          <div className="p-4 rounded-xl bg-[#090B0E] border border-zinc-800/80 flex flex-col justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                <Monitor className="w-4 h-4 text-emerald-400" />
                <span>Windows 11 (.EXE Portátil)</span>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Executável único <span className="font-mono text-zinc-300">Qoder2API-Hub.exe</span> (Windows 10/11 x64) com todas as 24 APIs de IA, failover e interface embutidos. Dois cliques e abre na porta <span className="font-mono text-zinc-300">8790</span>.
              </p>
              {exeStatus && <p className="text-[11px] text-emerald-400 pt-1">{exeStatus}</p>}
            </div>

            <button
              type="button"
              disabled={buildingExe}
              onClick={() => void handleDownloadWindowsExe()}
              className="min-h-[44px] w-full rounded-xl bg-zinc-100 hover:bg-emerald-400 disabled:opacity-60 text-zinc-950 text-sm font-semibold flex items-center justify-center gap-2 transition-colors"
            >
              {buildingExe ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              <span>{buildingExe ? 'Compilando .EXE...' : 'Baixar Qoder2API-Hub.exe'}</span>
            </button>
          </div>

          {/* Option 3: WebAPK Install + Kotlin Source ZIP */}
          <div className="p-4 rounded-xl bg-[#090B0E] border border-zinc-800/80 flex flex-col justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                <Download className="w-4 h-4 text-emerald-400" />
                <span>WebAPK ou Código Kotlin</span>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                {isInstalled
                  ? 'WebAPK já instalado. Você também pode baixar o projeto Android Studio completo (.ZIP).'
                  : 'Instale como WebAPK pelo navegador ou baixe o projeto Android Studio + GitHub Actions (.ZIP).'}
              </p>
            </div>

            <div className="space-y-2">
              {!isInstalled && isInstallable && (
                <button
                  type="button"
                  onClick={() => void install()}
                  className="min-h-[44px] w-full rounded-xl border border-emerald-600/60 hover:bg-emerald-950/40 text-emerald-300 text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
                >
                  <Smartphone className="w-3.5 h-3.5" />
                  <span>Instalar WebAPK Agora</span>
                </button>
              )}
              {!isInstalled && !isInstallable && isIOS && (
                <button
                  type="button"
                  onClick={() => setShowIosGuide((v) => !v)}
                  className="min-h-[44px] w-full rounded-xl border border-zinc-700 hover:bg-zinc-800 text-zinc-100 text-xs font-medium transition-colors"
                >
                  Instruções iPhone / Safari
                </button>
              )}
              {showIosGuide && (
                <p className="text-[11px] text-zinc-300">
                  No Safari: toque em Compartilhar &gt; Adicionar à Tela de Início.
                </p>
              )}
              <button
                type="button"
                onClick={() => downloadQoderAndroidStudioProject(origin)}
                className="min-h-[44px] w-full rounded-xl border border-zinc-700 hover:bg-zinc-800 text-zinc-100 text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
              >
                <Download className="w-4 h-4" />
                <span>Baixar Projeto Kotlin (.ZIP)</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Gateway Settings & API Keys */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-5 bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 space-y-4">
          <h2 className="text-base font-semibold text-zinc-100">Preferências do Gateway</h2>

          <div className="space-y-3 divide-y divide-zinc-800/70 text-sm">
            <div className="pt-1 flex items-center justify-between gap-3">
              <div>
                <div className="font-medium text-zinc-200">Região Padrão</div>
                <div className="text-xs text-zinc-400">Saída inicial para modelos sem hint</div>
              </div>
              <select
                value={settings.defaultRealm}
                disabled={saving}
                onChange={(e) => void handlePatchSettings({ defaultRealm: e.target.value as RealmId })}
                className="min-h-[44px] bg-[#090B0E] border border-zinc-800 rounded-lg px-3 text-xs font-medium text-zinc-100"
              >
                <option value="intl">Global (qoder.com)</option>
                <option value="cn">China (qoder.com.cn)</option>
              </select>
            </div>

            <div className="pt-3 flex items-center justify-between gap-3">
              <div>
                <div className="font-medium text-zinc-200">Seleção Automática de Região</div>
                <div className="text-xs text-zinc-400">Alterna CN/Global conforme o modelo</div>
              </div>
              <button
                type="button"
                onClick={() => void handlePatchSettings({ autoRealm: !settings.autoRealm })}
                className={`min-h-[40px] px-3.5 rounded-lg text-xs font-semibold transition-colors ${
                  settings.autoRealm ? 'bg-emerald-500 text-zinc-950' : 'bg-zinc-800 text-zinc-300'
                }`}
              >
                {settings.autoRealm ? 'Ativado' : 'Desativado'}
              </button>
            </div>

            <div className="pt-3 flex items-center justify-between gap-3">
              <div>
                <div className="font-medium text-zinc-200">Exigir API Key nas Rotas /v1</div>
                <div className="text-xs text-zinc-400">Protege /v1/chat/completions e /v1/messages</div>
              </div>
              <button
                type="button"
                onClick={() => void handlePatchSettings({ requireApiKey: !settings.requireApiKey })}
                className={`min-h-[40px] px-3.5 rounded-lg text-xs font-semibold transition-colors ${
                  settings.requireApiKey ? 'bg-emerald-500 text-zinc-950' : 'bg-zinc-800 text-zinc-300'
                }`}
              >
                {settings.requireApiKey ? 'Obrigatória' : 'Aberta'}
              </button>
            </div>
          </div>
        </section>

        <section className="lg:col-span-7 bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-emerald-400" />
            <h2 className="text-base font-semibold text-zinc-100">Chaves Locais do Gateway & IDEs</h2>
          </div>

          <form onSubmit={(e) => void handleCreateKey(e)} className="flex gap-2">
            <input
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Nome da chave (ex: Cursor Windows 11)"
              className="flex-1 min-h-[44px] bg-[#090B0E] border border-zinc-800 rounded-xl px-3.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <button
              type="submit"
              className="min-h-[44px] px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              <span>Criar Chave</span>
            </button>
          </form>

          <div className="divide-y divide-zinc-800/70">
            {apiKeys.map((k) => (
              <div key={k.id} className="py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-zinc-200">{k.name}</div>
                  <div className="text-xs font-mono text-zinc-400 truncate">{k.key}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleCopy(k.id, k.key)}
                    className="min-h-[44px] px-3 rounded-lg border border-zinc-800 hover:bg-zinc-800 text-xs text-zinc-200 flex items-center gap-1"
                  >
                    {copiedId === k.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>Copiar</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteKey(k.id)}
                    aria-label={`Excluir chave ${k.name}`}
                    className="min-h-[44px] min-w-[44px] rounded-lg border border-zinc-800 hover:bg-red-950/50 text-zinc-400 hover:text-red-400 flex items-center justify-center"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="pt-3 border-t border-zinc-800/70 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3 rounded-xl bg-[#090B0E] border border-zinc-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-300">Claude Code</span>
                <button
                  type="button"
                  onClick={() => void handleCopy('claude', claudeCodeSnippet)}
                  className="text-xs text-emerald-400 hover:underline"
                >
                  {copiedId === 'claude' ? 'Copiado' : 'Copiar'}
                </button>
              </div>
              <pre className="text-[11px] font-mono text-zinc-400 overflow-x-auto">{claudeCodeSnippet}</pre>
            </div>

            <div className="p-3 rounded-xl bg-[#090B0E] border border-zinc-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-300">Codex / OpenAI</span>
                <button
                  type="button"
                  onClick={() => void handleCopy('codex', codexSnippet)}
                  className="text-xs text-emerald-400 hover:underline"
                >
                  {copiedId === 'codex' ? 'Copiado' : 'Copiar'}
                </button>
              </div>
              <pre className="text-[11px] font-mono text-zinc-400 overflow-x-auto">{codexSnippet}</pre>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
