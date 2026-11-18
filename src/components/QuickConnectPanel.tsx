import React, { useCallback, useMemo, useState } from 'react';
import {
  Check,
  ClipboardPaste,
  ExternalLink,
  KeyRound,
  Loader2,
  Sparkles,
  Zap,
} from 'lucide-react';
import { PROVIDER_PRESETS } from '../data/providerPresets';
import { readClipboardText } from '../utils/androidBridge';
import type { GatewaySettings, ProviderPreset, ProviderPresetId, SafeProviderSummary } from '../types/hub';

interface QuickConnectPanelProps {
  providers: SafeProviderSummary[];
  settings?: GatewaySettings;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onProvidersChanged: () => void;
}

interface BatchResponse {
  ok?: boolean;
  providers?: SafeProviderSummary[];
  count?: number;
  message?: string;
  error?: { message?: string };
}

// Apenas as APIs que já vêm pré-estabelecidas no app e funcionam só com a chave.
// GitHub Models foi descontinuado e o Cloudflare exige o ID da conta na URL,
// então esses dois continuam no formulário manual. Provedores que o usuário
// adicionar depois também continuam no formulário manual.
const MANUAL_ONLY = new Set(['github', 'cloudflare']);
const FREE_PRESETS: ProviderPreset[] = PROVIDER_PRESETS.filter(
  (preset) => preset.category === 'free_tier' && !MANUAL_ONLY.has(preset.id)
);

function responseMessage(data: BatchResponse | null, fallback: string): string {
  return data?.error?.message || data?.message || fallback;
}

// Modelos que não servem para conversa/código e só geram erro.
const EXCLUDE_MODEL =
  /embed|embedding|aqa|imagen|image-generation|image|tts|whisper|audio|moderation|rerank|guard|safety|parse|video|detector|ocr/i;
const CODE_MODEL =
  /coder|code|deepseek|qwen|llama|gemini|gemma|gpt|claude|glm|kimi|moonshot|mistral|codestral|devstral|grok|nemotron|minimax|sonar|command|phi|starcoder|llama/i;

/**
 * Escolhe modelos que existem de verdade na chave do usuário. Quando o provedor
 * devolve a lista real, usamos ela (nada de nomes fixos que causam 404); se não,
 * caímos nos modelos sugeridos do preset.
 */
function pickModels(ids: string[], preset: ProviderPreset): string[] {
  const usable = ids.filter((id) => !EXCLUDE_MODEL.test(id));
  const code = usable.filter((id) => CODE_MODEL.test(id));
  const pool = code.length ? code : usable;
  const chosen: string[] = [];
  if (preset.defaultModel && ids.includes(preset.defaultModel)) chosen.push(preset.defaultModel);
  for (const id of pool) {
    if (chosen.length >= 6) break;
    if (!chosen.includes(id)) chosen.push(id);
  }
  if (!chosen.length) {
    for (const id of preset.suggestedModels.length ? preset.suggestedModels : [preset.defaultModel]) {
      if (id && !chosen.includes(id)) chosen.push(id);
    }
  }
  return chosen.slice(0, 8);
}

/**
 * Conexão em um toque para as APIs grátis pré-estabelecidas:
 * o usuário só faz o login no portal e copia a chave; o app registra o
 * provedor, adiciona todos os modelos grátis dele, testa e liga a troca
 * automática de IA, sem preencher campo por campo.
 */
export const QuickConnectPanel: React.FC<QuickConnectPanelProps> = ({
  providers,
  settings,
  apiFetch,
  onProvidersChanged,
}) => {
  const [openId, setOpenId] = useState<string | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const connectedFor = useCallback(
    (preset: ProviderPreset) => providers.filter((p) => p.provider === preset.id).length,
    [providers]
  );

  const enabledFor = useCallback(
    (preset: ProviderPreset) => providers.filter((p) => p.provider === preset.id && p.enabled).length,
    [providers]
  );

  const toggleAllForPreset = useCallback(
    (providerId: ProviderPresetId) => {
      const providersOfType = providers.filter((p) => p.provider === providerId);
      if (providersOfType.length === 0) return;
      const allEnabled = providersOfType.every((p) => p.enabled);
      const targetEnabled = !allEnabled;
      providersOfType.forEach((p) => {
        if (p.enabled !== targetEnabled) {
          void apiFetch(`/api/app/providers/${encodeURIComponent(p.id)}/toggle`, {
            method: 'POST',
          }).catch(() => undefined);
        }
      });
    },
    [apiFetch, providers]
  );

  const pasteFromClipboard = useCallback(async (preset: ProviderPreset) => {
    let text = readClipboardText() ?? '';
    if (!text) {
      try {
        text = await navigator.clipboard.readText();
      } catch {
        text = '';
      }
    }
    text = text.trim();
    if (!text) {
      setNotice({
        kind: 'err',
        text: 'Não consegui ler a área de transferência. Toque no campo e cole com um toque longo.',
      });
      return;
    }
    setKeys((current) => ({ ...current, [preset.id]: text }));
    setNotice({ kind: 'ok', text: `Chave copiada de ${preset.name}. Agora toque em “Conectar e ativar”.` });
  }, []);

  const connect = useCallback(
    async (preset: ProviderPreset) => {
      const key = (keys[preset.id] || '').trim();
      if (!key) {
        setNotice({ kind: 'err', text: `Cole a chave de ${preset.name} primeiro.` });
        return;
      }
      if (busyId) return;
      setBusyId(preset.id);
      setNotice(null);

      const created: SafeProviderSummary[] = [];
      try {
        // 1. Descobre os modelos que a chave realmente acessa, em vez de confiar em
        // nomes fixos. Assim os modelos não dão 404 por estarem desatualizados.
        let liveIds: string[] = [];
        try {
          const probeRes = await apiFetch('/api/app/providers/models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: preset.id, baseUrl: preset.baseUrl, apiKey: key }),
          });
          const probe = (await probeRes.json().catch(() => null)) as { ok?: boolean; models?: string[] } | null;
          if (probe?.ok && Array.isArray(probe.models)) liveIds = probe.models;
        } catch {
          // Sem lista real: usamos os modelos sugeridos do preset.
        }

        const models = pickModels(liveIds, preset);
        if (!models.length) {
          setNotice({
            kind: 'err',
            text: `Não encontrei modelos para ${preset.name}. Confira se a chave está correta e ativa no portal.`,
          });
          return;
        }

        const items = models.map((model) => ({
          provider: preset.id,
          name: `${preset.name} · ${model}`,
          baseUrl: preset.baseUrl,
          apiKey: key,
          defaultModel: model,
          protocol: preset.protocol,
        }));

        const res = await apiFetch('/api/app/providers/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        });
        const data = (await res.json().catch(() => null)) as BatchResponse | null;
        if (!res.ok) throw new Error(responseMessage(data, `Não foi possível salvar a chave (${res.status}).`));
        for (const provider of data?.providers ?? []) created.push(provider);

        let okCount = 0;
        let firstError = '';
        for (const provider of created) {
          const tested = (await apiFetch(`/api/app/providers/${encodeURIComponent(provider.id)}/test`, {
            method: 'POST',
          })
            .then((r) => r.json())
            .catch(() => null)) as { ok?: boolean; message?: string } | null;
          if (tested?.ok) okCount++;
          else if (!firstError && tested?.message) firstError = tested.message;
        }

        if (okCount === 0) {
          // Nada funcionou: desfaz o que acabamos de criar para não poluir a fila.
          for (const provider of created) {
            await apiFetch(`/api/app/providers/${encodeURIComponent(provider.id)}`, { method: 'DELETE' }).catch(
              () => undefined
            );
          }
          setNotice({
            kind: 'err',
            text: `A chave de ${preset.name} não respondeu${firstError ? ` (${firstError})` : ''}. Confira se copiou a chave inteira e se ela está ativa no portal.`,
          });
          onProvidersChanged();
          return;
        }

        // Liga a troca automática de IA para as próximas mensagens.
        await apiFetch('/api/app/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoFailoverEnabled: true }),
        }).catch(() => undefined);

        setKeys((current) => ({ ...current, [preset.id]: '' }));
        setOpenId(null);
        setNotice({
          kind: 'ok',
          text: `${preset.name}: ${okCount} de ${created.length} modelo(s) conectados e ativos${liveIds.length ? ' (lista real da sua chave)' : ''}. A troca automática de IA está ligada.`,
        });
        onProvidersChanged();
      } catch (err) {
        setNotice({ kind: 'err', text: err instanceof Error ? err.message : 'Erro ao conectar a API.' });
        onProvidersChanged();
      } finally {
        setBusyId(null);
      }
    },
    [apiFetch, busyId, keys, onProvidersChanged]
  );

  const connectedTotal = useMemo(
    () => FREE_PRESETS.reduce((total, preset) => total + (connectedFor(preset) > 0 ? 1 : 0), 0),
    [connectedFor]
  );

  return (
    <section className="bg-[#12151B] border border-emerald-900/50 rounded-2xl p-4 space-y-4">
      <div className="flex items-start gap-3">
        <Sparkles className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-zinc-100">Conectar IAs grátis (login + 1 toque)</h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            Você só entra no portal e copia a chave. O app registra o provedor, adiciona todos os modelos grátis
            dele, testa e liga a troca automática de IA. Provedores novos você configura manualmente logo abaixo.
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-1.5">
            <span
              className={`text-[11px] px-2 py-0.5 rounded-full border ${
                (settings?.autoFailoverEnabled ?? true)
                  ? 'bg-emerald-950/60 text-emerald-300 border-emerald-900/60'
                  : 'bg-zinc-900 text-zinc-400 border-zinc-800'
              }`}
            >
              Troca automática de IA: {(settings?.autoFailoverEnabled ?? true) ? 'ligada' : 'desligada'}
            </span>
            {connectedTotal > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-950/60 text-emerald-300 border border-emerald-900/60">
                {connectedTotal} provedor(es) grátis conectado(s)
              </span>
            )}
          </div>
        </div>
      </div>

      {notice && (
        <div
          role={notice.kind === 'err' ? 'alert' : 'status'}
          className={`px-4 py-3 rounded-xl text-xs font-medium border ${
            notice.kind === 'ok'
              ? 'bg-emerald-950/30 border-emerald-800/60 text-emerald-300'
              : 'bg-red-950/30 border-red-800/60 text-red-300'
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {FREE_PRESETS.map((preset) => {
          const connected = connectedFor(preset);
          const enabled = enabledFor(preset);
          const isOpen = openId === preset.id;
          const isBusy = busyId === preset.id;
          const keyValue = keys[preset.id] || '';

          return (
            <div
              key={preset.id}
              className="p-3.5 rounded-xl bg-[#090B0E] border border-zinc-800/90 space-y-3 flex flex-col"
            >
              <div className="space-y-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-zinc-100 truncate">{preset.name}</span>
                  <span className="text-[10px] font-medium shrink-0 px-2 py-0.5 rounded-full bg-emerald-950/60 text-emerald-300 border border-emerald-900/60">
                    {preset.badge}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500 line-clamp-2">{preset.description}</p>
                {connected > 0 ? (
                  <div className="flex items-center gap-2">
                    <p className="text-[11px] text-emerald-400 flex items-center gap-1">
                      <Check className="w-3.5 h-3.5" />
                      Conectado · {enabled} de {connected} modelo(s) ativo(s)
                    </p>
                    <button
                      type="button"
                      onClick={() => void toggleAllForPreset(preset.id)}
                      className={`text-[10px] font-medium shrink-0 px-2 py-0.5 rounded-full ${enabled === connected && enabled > 0 ? 'bg-emerald-950/30 text-emerald-300 border border-emerald-800/60' : 'bg-zinc-900/40 text-zinc-400 border border-zinc-800/60'} disabled={enabled === 0}`}
                      disabled={enabled === 0}
                    >
                      {enabled === connected && enabled > 0 ? 'Desativar todos' : 'Ativar todos'}
                    </button>
                  </div>
                ) : (
                  <p className="text-[11px] text-zinc-500">Ainda não conectado.</p>
                )}
              </div>

              {isOpen ? (
                <div className="space-y-2.5 pt-1">
                  <a
                    href={preset.signupUrl}
                    target="_self"
                    rel="noopener noreferrer"
                    className="min-h-[44px] w-full px-3 rounded-xl border border-emerald-600/50 bg-emerald-950/30 hover:bg-emerald-900/40 text-xs font-medium text-emerald-300 flex items-center justify-center gap-2"
                  >
                    <ExternalLink className="w-4 h-4 shrink-0" />
                    <span>1. Abrir portal: faça o login e copie a chave</span>
                  </a>

                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-400">2. Chave de {preset.name}</label>
                    <div className="flex items-center gap-2">
                      <input
                        type={showKey[preset.id] ? 'text' : 'password'}
                        autoComplete="off"
                        spellCheck={false}
                        value={keyValue}
                        onChange={(e) => setKeys((current) => ({ ...current, [preset.id]: e.target.value }))}
                        placeholder="Cole aqui (AIza..., sk-or-..., gsk_...)"
                        className="flex-1 min-w-0 min-h-[44px] bg-[#12151B] border border-zinc-800 rounded-xl px-3 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                      <button
                        type="button"
                        onClick={() => void pasteFromClipboard(preset)}
                        className="min-h-[44px] px-3 rounded-xl border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs font-semibold text-zinc-200 flex items-center gap-1.5 shrink-0"
                      >
                        <ClipboardPaste className="w-4 h-4" />
                        <span>Colar</span>
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setShowKey((current) => ({ ...current, [preset.id]: !current[preset.id] }))
                      }
                      className="text-[11px] text-zinc-500"
                    >
                      {showKey[preset.id] ? 'Ocultar chave' : 'Mostrar chave'}
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!keyValue.trim() || Boolean(busyId)}
                      onClick={() => void connect(preset)}
                      className="flex-1 min-h-[46px] px-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 text-xs font-bold flex items-center justify-center gap-2"
                    >
                      {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                      <span>{isBusy ? 'Conectando…' : '3. Conectar e ativar'}</span>
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(busyId)}
                      onClick={() => setOpenId(null)}
                      className="min-h-[46px] px-3 rounded-xl border border-zinc-800 text-xs text-zinc-400 disabled:opacity-50"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={Boolean(busyId)}
                  onClick={() => {
                    setNotice(null);
                    setOpenId(preset.id);
                  }}
                  className="min-h-[44px] w-full px-3 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-600/60 text-xs font-semibold text-emerald-300 flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <KeyRound className="w-4 h-4" />
                  <span>{connected > 0 ? 'Conectar mais modelos grátis' : 'Conectar grátis'}</span>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};
