import React, { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Coins,
  Cpu,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PROVIDER_PRESETS } from '../data/providerPresets';
import type { HubOverview, NavTab, ProviderPresetId } from '../types/hub';

interface AnalyticsProps {
  overview: HubOverview | null;
  onNavigate: (tab: NavTab) => void;
  onTestAllProviders?: () => Promise<void>;
  testingProviders?: boolean;
}

type ScopeFilter = 'all' | 'external' | 'qoder';
type SortKey = 'tokens' | 'reliability' | 'cost' | 'requests';

interface ProviderMetricRow {
  id: string;
  name: string;
  shortName: string;
  model: string;
  kind: 'external' | 'qoder';
  isFreeTier: boolean;
  refRatePer1M: number; // Blended USD per 1M tokens (reference estimate)
  requests: number;
  successes: number;
  failures: number;
  failureRatePct: number;
  reliabilityPct: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  failoverSaves: number;
  estimatedCostUsd: number;
  costPer10kTokensUsd: number;
  enabled: boolean;
  lastError?: string;
}

// Reference blended USD per 1M tokens (used only for cost-effectiveness comparison)
const REFERENCE_USD_PER_1M_TOKENS: Partial<Record<ProviderPresetId, number>> = {
  gemini: 0,
  openrouter: 0,
  groq: 0,
  github: 0,
  cerebras: 0,
  nvidia: 0,
  sambanova: 0,
  huggingface: 0,
  cloudflare: 0,
  pollinations: 0,
  ollama: 0,
  lmstudio: 0,
  deepseek: 0.55,
  qwen: 0.8,
  mistral: 0.9,
  together: 0.9,
  fireworks: 0.9,
  zhipu: 1.0,
  kimi: 1.2,
  perplexity: 1.5,
  grok: 3.0,
  openai: 4.0,
  anthropic: 6.0,
  custom: 0.5,
};

function getPresetRefRate(presetId: ProviderPresetId, model: string, baseUrl: string): {
  isFreeTier: boolean;
  rate: number;
} {
  const lowerModel = model.toLowerCase();
  const lowerUrl = baseUrl.toLowerCase();
  if (
    lowerModel.includes(':free') ||
    lowerUrl.includes('127.0.0.1') ||
    lowerUrl.includes('localhost') ||
    lowerUrl.includes('pollinations')
  ) {
    return { isFreeTier: true, rate: 0 };
  }
  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
  if (preset && (preset.category === 'free_tier' || preset.category === 'local')) {
    return { isFreeTier: true, rate: 0 };
  }
  const rate = REFERENCE_USD_PER_1M_TOKENS[presetId] ?? 0.5;
  return { isFreeTier: rate === 0, rate };
}

function shortenLabel(label: string): string {
  const clean = label.replace(/\s*\([^)]*\)/g, '').trim();
  return clean.length > 16 ? `${clean.slice(0, 15)}…` : clean;
}

function formatCompactTokens(val: number): string {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`;
  return String(val);
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string; payload?: ProviderMetricRow }>;
  label?: string;
}

const TokenChartTooltip: React.FC<CustomTooltipProps> = ({ active, payload }) => {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload;
  if (!row) return null;

  return (
    <div className="bg-[#090B0E] border border-zinc-700/90 rounded-xl px-3.5 py-2.5 shadow-xl text-xs space-y-1.5">
      <div className="font-semibold text-zinc-100">{row.name}</div>
      <div className="font-mono text-[11px] text-zinc-400">{row.model}</div>
      <div className="pt-1 border-t border-zinc-800 space-y-1 tabular-nums font-mono">
        <div className="flex items-center justify-between gap-4">
          <span className="text-emerald-400">Prompt:</span>
          <span className="text-zinc-100">{row.promptTokens.toLocaleString('pt-BR')}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-cyan-400">Resposta:</span>
          <span className="text-zinc-100">{row.completionTokens.toLocaleString('pt-BR')}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-zinc-400">Total Tokens:</span>
          <span className="text-zinc-50 font-semibold">{row.totalTokens.toLocaleString('pt-BR')}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-zinc-400">Custo Est.:</span>
          <span className={row.isFreeTier ? 'text-emerald-400' : 'text-amber-300'}>
            {row.isFreeTier ? '$0.00 (Grátis)' : `$${row.estimatedCostUsd.toFixed(4)}`}
          </span>
        </div>
      </div>
    </div>
  );
};

const FailureChartTooltip: React.FC<CustomTooltipProps> = ({ active, payload }) => {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload;
  if (!row) return null;

  return (
    <div className="bg-[#090B0E] border border-zinc-700/90 rounded-xl px-3.5 py-2.5 shadow-xl text-xs space-y-1.5">
      <div className="font-semibold text-zinc-100">{row.name}</div>
      <div className="pt-1 border-t border-zinc-800 space-y-1 tabular-nums font-mono">
        <div className="flex items-center justify-between gap-4">
          <span className="text-emerald-400">Sucessos:</span>
          <span className="text-zinc-100">{row.successes}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-rose-400">Falhas:</span>
          <span className="text-zinc-100">{row.failures}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-amber-400">Taxa de Falha:</span>
          <span className="text-zinc-50 font-semibold">{row.failureRatePct.toFixed(1)}%</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-zinc-400">Latência Média:</span>
          <span className="text-zinc-200">{row.avgLatencyMs > 0 ? `${row.avgLatencyMs} ms` : '—'}</span>
        </div>
      </div>
    </div>
  );
};

export const Analytics: React.FC<AnalyticsProps> = ({
  overview,
  onNavigate,
  onTestAllProviders,
  testingProviders,
}) => {
  const [scope, setScope] = useState<ScopeFilter>('all');
  const [sortBy, setSortBy] = useState<SortKey>('tokens');

  const rows = useMemo<ProviderMetricRow[]>(() => {
    if (!overview) return [];
    const logs = overview.recentLogs || [];
    const providers = overview.providers || [];
    const accounts = overview.accounts || [];

    const result: ProviderMetricRow[] = [];

    // 1. External / Free Coding AI Providers
    for (const prv of providers) {
      const matchingLogs = logs.filter(
        (l) => l.accountUid === prv.id || (l.provider && l.provider === prv.name)
      );
      const logSuccesses = matchingLogs.filter((l) => l.status < 400).length;
      const logFailures = matchingLogs.filter((l) => l.status >= 400).length;
      const logPromptTokens = matchingLogs.reduce((s, l) => s + (l.promptTokens || 0), 0);
      const logCompletionTokens = matchingLogs.reduce((s, l) => s + (l.completionTokens || 0), 0);
      const logLatencySum = matchingLogs.reduce((s, l) => s + (l.latencyMs || 0), 0);

      const successes = Math.max(prv.requestCount ?? 0, logSuccesses);
      const failures = Math.max(prv.errorCount ?? 0, logFailures);
      const totalAttempts = successes + failures;

      const promptTokens = Math.max(prv.promptTokens ?? 0, logPromptTokens);
      const completionTokens = Math.max(prv.completionTokens ?? 0, logCompletionTokens);
      const totalTokens = promptTokens + completionTokens;

      const totalLatency = Math.max(prv.totalLatencyMs ?? 0, logLatencySum);
      const latencyDivisor = successes > 0 ? successes : matchingLogs.length;
      const avgLatencyMs = latencyDivisor > 0 ? Math.round(totalLatency / latencyDivisor) : 0;

      const failureRatePct = totalAttempts > 0 ? (failures / totalAttempts) * 100 : 0;
      const reliabilityPct = totalAttempts > 0 ? (successes / totalAttempts) * 100 : 100;

      const { isFreeTier, rate } = getPresetRefRate(prv.provider, prv.defaultModel, prv.baseUrl);
      const estimatedCostUsd = (totalTokens / 1_000_000) * rate;
      const costPer10kTokensUsd = (10_000 / 1_000_000) * rate;

      result.push({
        id: prv.id,
        name: prv.name,
        shortName: shortenLabel(prv.name),
        model: prv.defaultModel,
        kind: 'external',
        isFreeTier,
        refRatePer1M: rate,
        requests: totalAttempts,
        successes,
        failures,
        failureRatePct,
        reliabilityPct,
        promptTokens,
        completionTokens,
        totalTokens,
        avgLatencyMs,
        failoverSaves: prv.failoverCount ?? 0,
        estimatedCostUsd,
        costPer10kTokensUsd,
        enabled: prv.enabled,
        lastError: prv.lastError,
      });
    }

    // 2. Qoder Pool (if any accounts or Qoder logs exist)
    const qoderLogs = logs.filter(
      (l) => l.provider === 'Qoder' || (!l.provider && l.accountNickname)
    );
    const qoderReqsFromAccounts = accounts.reduce((s, a) => s + (a.requestCount || 0), 0);
    if (accounts.length > 0 || qoderLogs.length > 0) {
      const qSuccessLogs = qoderLogs.filter((l) => l.status < 400).length;
      const qFailLogs = qoderLogs.filter((l) => l.status >= 400).length;
      const successes = Math.max(qoderReqsFromAccounts, qSuccessLogs);
      const failures = qFailLogs;
      const totalAttempts = successes + failures;
      const promptTokens = qoderLogs.reduce((s, l) => s + (l.promptTokens || 0), 0);
      const completionTokens = qoderLogs.reduce((s, l) => s + (l.completionTokens || 0), 0);
      const totalTokens = promptTokens + completionTokens;
      const totalLatency = qoderLogs.reduce((s, l) => s + (l.latencyMs || 0), 0);
      const avgLatencyMs = qoderLogs.length > 0 ? Math.round(totalLatency / qoderLogs.length) : 0;

      result.push({
        id: 'qoder-pool',
        name: 'Qoder Pool',
        shortName: 'Qoder Pool',
        model: 'Auto / 0x Free',
        kind: 'qoder',
        isFreeTier: true,
        refRatePer1M: 0,
        requests: totalAttempts,
        successes,
        failures,
        failureRatePct: totalAttempts > 0 ? (failures / totalAttempts) * 100 : 0,
        reliabilityPct: totalAttempts > 0 ? (successes / totalAttempts) * 100 : 100,
        promptTokens,
        completionTokens,
        totalTokens,
        avgLatencyMs,
        failoverSaves: qoderLogs.filter((l) => Boolean(l.failoverFrom)).length,
        estimatedCostUsd: 0,
        costPer10kTokensUsd: 0,
        enabled: accounts.some((a) => a.enabled),
      });
    }

    return result;
  }, [overview]);

  const filteredRows = useMemo(() => {
    const scoped =
      scope === 'all' ? rows : rows.filter((r) => r.kind === scope);

    return [...scoped].sort((a, b) => {
      if (sortBy === 'tokens') return b.totalTokens - a.totalTokens || b.requests - a.requests;
      if (sortBy === 'reliability') {
        if (b.requests === 0 && a.requests > 0) return -1;
        if (a.requests === 0 && b.requests > 0) return 1;
        return a.failureRatePct - b.failureRatePct || b.successes - a.successes;
      }
      if (sortBy === 'cost') {
        if (a.refRatePer1M !== b.refRatePer1M) return a.refRatePer1M - b.refRatePer1M;
        return b.totalTokens - a.totalTokens;
      }
      return b.requests - a.requests;
    });
  }, [rows, scope, sortBy]);

  const totals = useMemo(() => {
    const totalTokens = filteredRows.reduce((s, r) => s + r.totalTokens, 0);
    const totalPrompt = filteredRows.reduce((s, r) => s + r.promptTokens, 0);
    const totalCompletion = filteredRows.reduce((s, r) => s + r.completionTokens, 0);
    const totalRequests = filteredRows.reduce((s, r) => s + r.requests, 0);
    const totalFailures = filteredRows.reduce((s, r) => s + r.failures, 0);
    const totalCostUsd = filteredRows.reduce((s, r) => s + r.estimatedCostUsd, 0);
    const freeTokens = filteredRows
      .filter((r) => r.isFreeTier)
      .reduce((s, r) => s + r.totalTokens, 0);
    const globalFailureRate = totalRequests > 0 ? (totalFailures / totalRequests) * 100 : 0;

    const activeWithTraffic = filteredRows.filter((r) => r.requests > 0);
    const mostReliable = [...activeWithTraffic].sort(
      (a, b) => a.failureRatePct - b.failureRatePct || b.successes - a.successes
    )[0];
    const bestCostEffective = [...activeWithTraffic].sort((a, b) => {
      if (a.isFreeTier !== b.isFreeTier) return a.isFreeTier ? -1 : 1;
      if (a.refRatePer1M !== b.refRatePer1M) return a.refRatePer1M - b.refRatePer1M;
      return b.totalTokens - a.totalTokens;
    })[0];

    return {
      totalTokens,
      totalPrompt,
      totalCompletion,
      totalRequests,
      totalFailures,
      totalCostUsd,
      freeTokensPct: totalTokens > 0 ? (freeTokens / totalTokens) * 100 : 100,
      globalFailureRate,
      mostReliable,
      bestCostEffective,
    };
  }, [filteredRows]);

  const chartData = useMemo(() => filteredRows.slice(0, 10), [filteredRows]);
  const hasAnyTraffic = totals.totalRequests > 0 || totals.totalTokens > 0;

  return (
    <div className="space-y-6">
      {/* Header & Filter Controls */}
      <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-emerald-400 font-medium">
              <BarChart3 className="w-4 h-4 shrink-0" />
              <span>Telemetria de Uso, Confiabilidade &amp; Custo por Provedor</span>
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-zinc-100">
              Analytics de Tokens &amp; Taxa de Falhas
            </h1>
            <p className="text-xs text-zinc-400 max-w-2xl">
              Compare quais APIs gratuitas e pagas de IA consomem mais tokens, mantêm menor taxa de falha e entregam o melhor custo-benefício para código.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {onTestAllProviders && (overview?.providers.length ?? 0) > 0 && (
              <button
                type="button"
                disabled={testingProviders}
                onClick={() => void onTestAllProviders()}
                className="min-h-[44px] px-4 rounded-xl border border-zinc-800 bg-[#090B0E] hover:bg-zinc-800 disabled:opacity-50 text-xs font-semibold text-zinc-200 flex items-center gap-2 whitespace-nowrap transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${testingProviders ? 'animate-spin' : ''}`} />
                <span>Testar APIs Agora</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => onNavigate('apis')}
              className="min-h-[44px] px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-semibold flex items-center gap-2 whitespace-nowrap transition-colors"
            >
              <span>Gerenciar APIs IA</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Filter Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 border-t border-zinc-800/80">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: 'all', label: `Todos (${rows.length})` },
                { id: 'external', label: 'IAs de Código (Gratuitas / Externas)' },
                { id: 'qoder', label: 'Qoder Pool' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setScope(opt.id)}
                className={`min-h-[40px] px-3.5 rounded-xl border text-xs font-medium whitespace-nowrap transition-colors ${
                  scope === opt.id
                    ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300'
                    : 'border-zinc-800 bg-[#090B0E] text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="analytics-sort" className="text-xs text-zinc-400 whitespace-nowrap">
              Ordenar por:
            </label>
            <select
              id="analytics-sort"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
              className="min-h-[40px] bg-[#090B0E] border border-zinc-800 rounded-xl px-3 text-xs font-medium text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              <option value="tokens">Maior Consumo de Tokens</option>
              <option value="reliability">Menor Taxa de Falha</option>
              <option value="cost">Melhor Custo-Benefício (Grátis primeiro)</option>
              <option value="requests">Mais Requisições</option>
            </select>
          </div>
        </div>

        {/* KPI Summary Strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 pt-4 border-t border-zinc-800/80">
          <div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <Cpu className="w-3.5 h-3.5 text-emerald-400" />
              <span>Tokens Totais Processados</span>
            </div>
            <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-zinc-50">
              {formatCompactTokens(totals.totalTokens)}
            </div>
            <div className="mt-0.5 text-xs font-mono tabular-nums text-zinc-400">
              {formatCompactTokens(totals.totalPrompt)} in · {formatCompactTokens(totals.totalCompletion)} out
            </div>
          </div>

          <div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <Activity className="w-3.5 h-3.5 text-amber-400" />
              <span>Taxa Global de Falhas</span>
            </div>
            <div
              className={`mt-1 text-2xl font-bold font-mono tabular-nums ${
                totals.globalFailureRate > 15
                  ? 'text-rose-400'
                  : totals.globalFailureRate > 0
                    ? 'text-amber-400'
                    : 'text-emerald-400'
              }`}
            >
              {totals.globalFailureRate.toFixed(1)}%
            </div>
            <div className="mt-0.5 text-xs font-mono tabular-nums text-zinc-400">
              {totals.totalFailures} falha(s) em {totals.totalRequests} tentativa(s)
            </div>
          </div>

          <div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <Coins className="w-3.5 h-3.5 text-emerald-400" />
              <span>Custo Estimado (Ref.)</span>
            </div>
            <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-emerald-400">
              ${totals.totalCostUsd.toFixed(4)}
            </div>
            <div className="mt-0.5 text-xs text-zinc-400 tabular-nums">
              {totals.freeTokensPct.toFixed(0)}% dos tokens em tier gratuito
            </div>
          </div>

          <div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>Mais Confiável Ativa</span>
            </div>
            <div className="mt-1 text-base sm:text-lg font-bold text-zinc-100 truncate">
              {totals.mostReliable ? totals.mostReliable.name : 'Sem tráfego ainda'}
            </div>
            <div className="mt-0.5 text-xs font-mono tabular-nums text-emerald-400 truncate">
              {totals.mostReliable
                ? `${totals.mostReliable.reliabilityPct.toFixed(1)}% ok · ${
                    totals.mostReliable.avgLatencyMs > 0 ? `${totals.mostReliable.avgLatencyMs}ms` : 'ativo'
                  }`
                : 'Envie uma mensagem ou teste as APIs'}
            </div>
          </div>
        </div>
      </section>

      {/* Honest Empty State when zero requests exist yet */}
      {!hasAnyTraffic ? (
        <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-8 text-center space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-[#090B0E] border border-zinc-800 mx-auto flex items-center justify-center">
            <BarChart3 className="w-6 h-6 text-emerald-400" />
          </div>
          <div className="space-y-1.5 max-w-lg mx-auto">
            <h2 className="text-base font-semibold text-zinc-100">
              Aguardando as primeiras requisições para gerar os gráficos
            </h2>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Assim que você conversar pelo Chat ou testar suas APIs de código, este painel exibirá o consumo real de tokens, latência, taxa de falhas e custo estimado por provedor.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            {onTestAllProviders && (overview?.providers.length ?? 0) > 0 && (
              <button
                type="button"
                disabled={testingProviders}
                onClick={() => void onTestAllProviders()}
                className="min-h-[44px] px-4 rounded-xl border border-zinc-700 bg-[#090B0E] hover:bg-zinc-800 text-xs font-semibold text-zinc-100 flex items-center gap-2"
              >
                <RefreshCw className={`w-4 h-4 ${testingProviders ? 'animate-spin' : ''}`} />
                <span>Testar APIs Salvas Agora</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => onNavigate('apis')}
              className="min-h-[44px] px-4 rounded-xl border border-emerald-600/60 bg-emerald-950/30 hover:bg-emerald-900/40 text-xs font-semibold text-emerald-300"
            >
              Descobrir / Adicionar IAs Grátis
            </button>
            <button
              type="button"
              onClick={() => onNavigate('chat')}
              className="min-h-[44px] px-5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-semibold"
            >
              Abrir Chat IA
            </button>
          </div>
        </section>
      ) : (
        <>
          {/* Two-column Recharts Visualization Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Chart 1: Token Usage per Provider */}
            <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-zinc-100">
                    Uso de Tokens por Provedor
                  </h2>
                  <p className="text-xs text-zinc-400">
                    Tokens de entrada (Prompt) vs saída (Resposta) acumulados
                  </p>
                </div>
                <span className="text-xs font-mono tabular-nums text-emerald-400 shrink-0">
                  {formatCompactTokens(totals.totalTokens)} total
                </span>
              </div>

              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={chartData}
                    margin={{ top: 10, right: 12, left: 0, bottom: 18 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272A" vertical={false} />
                    <XAxis
                      dataKey="shortName"
                      tick={{ fill: '#A1A1AA', fontSize: 11 }}
                      axisLine={{ stroke: '#27272A' }}
                      tickLine={false}
                      interval={0}
                      angle={chartData.length > 4 ? -18 : 0}
                      textAnchor={chartData.length > 4 ? 'end' : 'middle'}
                      height={44}
                    />
                    <YAxis
                      tick={{ fill: '#A1A1AA', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v) => formatCompactTokens(Number(v))}
                      width={48}
                    />
                    <Tooltip
                      content={<TokenChartTooltip />}
                      cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                    />
                    <Legend
                      wrapperStyle={{ fontSize: '12px', paddingTop: '4px' }}
                    />
                    <Bar
                      dataKey="promptTokens"
                      name="Prompt (Entrada)"
                      stackId="tokens"
                      fill="#10B981"
                      radius={[0, 0, 0, 0]}
                    />
                    <Bar
                      dataKey="completionTokens"
                      name="Resposta (Saída)"
                      stackId="tokens"
                      fill="#06B6D4"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            {/* Chart 2: Failure Rate & Success/Error Count */}
            <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-zinc-100">
                    Taxa de Falha &amp; Estabilidade
                  </h2>
                  <p className="text-xs text-zinc-400">
                    Sucessos vs erros (429/402/5xx) e % de falha por provedor
                  </p>
                </div>
                <span className="text-xs font-mono tabular-nums text-amber-400 shrink-0">
                  Média {totals.globalFailureRate.toFixed(1)}% falha
                </span>
              </div>

              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={chartData}
                    margin={{ top: 10, right: 12, left: 0, bottom: 18 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272A" vertical={false} />
                    <XAxis
                      dataKey="shortName"
                      tick={{ fill: '#A1A1AA', fontSize: 11 }}
                      axisLine={{ stroke: '#27272A' }}
                      tickLine={false}
                      interval={0}
                      angle={chartData.length > 4 ? -18 : 0}
                      textAnchor={chartData.length > 4 ? 'end' : 'middle'}
                      height={44}
                    />
                    <YAxis
                      yAxisId="left"
                      tick={{ fill: '#A1A1AA', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      allowDecimals={false}
                      width={36}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      domain={[0, 100]}
                      tick={{ fill: '#FBBF24', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v) => `${v}%`}
                      width={42}
                    />
                    <Tooltip
                      content={<FailureChartTooltip />}
                      cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                    />
                    <Legend
                      wrapperStyle={{ fontSize: '12px', paddingTop: '4px' }}
                    />
                    <Bar
                      yAxisId="left"
                      dataKey="successes"
                      name="Sucessos"
                      fill="#10B981"
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      yAxisId="left"
                      dataKey="failures"
                      name="Falhas"
                      fill="#F43F5E"
                      radius={[4, 4, 0, 0]}
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="failureRatePct"
                      name="Taxa de Falha (%)"
                      stroke="#FBBF24"
                      strokeWidth={2.5}
                      dot={{ r: 4, fill: '#FBBF24', stroke: '#090B0E', strokeWidth: 1.5 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </section>
          </div>

          {/* Recommendations Strip */}
          {(totals.mostReliable || totals.bestCostEffective) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {totals.mostReliable && (
                <div className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-4 flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-zinc-100">
                      API Mais Confiável: {totals.mostReliable.name}
                    </div>
                    <p className="text-xs text-zinc-400 mt-0.5 tabular-nums">
                      {totals.mostReliable.reliabilityPct.toFixed(1)}% de sucesso em {totals.mostReliable.requests} requisição(ões) com latência média de{' '}
                      {totals.mostReliable.avgLatencyMs > 0 ? `${totals.mostReliable.avgLatencyMs} ms` : '—'}.
                    </p>
                  </div>
                </div>
              )}

              {totals.bestCostEffective && (
                <div className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-4 flex items-start gap-3">
                  <Coins className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-zinc-100">
                      Melhor Custo-Benefício: {totals.bestCostEffective.name}
                    </div>
                    <p className="text-xs text-zinc-400 mt-0.5 tabular-nums">
                      {totals.bestCostEffective.isFreeTier
                        ? `Tier gratuito ($0.00 / 1M tokens) — já entregou ${totals.bestCostEffective.totalTokens.toLocaleString('pt-BR')} tokens sem custo.`
                        : `Taxa de referência $${totals.bestCostEffective.refRatePer1M.toFixed(2)} / 1M tokens — custo estimado $${totals.bestCostEffective.estimatedCostUsd.toFixed(4)}.`}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Reliability & Cost-Effectiveness Matrix Table */}
          <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-zinc-100">
                  Matriz de Confiabilidade &amp; Custo-Benefício
                </h2>
                <p className="text-xs text-zinc-400">
                  Valores em USD são estimativas de referência por 1M tokens para comparação entre APIs gratuitas e pagas.
                </p>
              </div>
              <span className="text-xs font-mono text-zinc-400 tabular-nums">
                {filteredRows.length} provedor(es)
              </span>
            </div>

            <div className="overflow-x-auto border-t border-zinc-800/70">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-zinc-800/70 text-xs text-zinc-400">
                    <th className="py-2.5 pr-4 font-medium">Provedor / Modelo</th>
                    <th className="py-2.5 pr-4 font-medium text-right">Reqs</th>
                    <th className="py-2.5 pr-4 font-medium text-right">Taxa Falha</th>
                    <th className="py-2.5 pr-4 font-medium text-right">Tokens (In/Out)</th>
                    <th className="py-2.5 pr-4 font-medium text-right">Latência</th>
                    <th className="py-2.5 pr-4 font-medium text-right">Ref. / 1M</th>
                    <th className="py-2.5 font-medium text-right">Custo Est.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60 text-xs sm:text-sm">
                  {filteredRows.map((row) => (
                    <tr key={row.id} className="hover:bg-zinc-900/40">
                      <td className="py-3 pr-4 min-w-[190px]">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-zinc-100">{row.name}</span>
                          {!row.enabled && (
                            <span className="text-[11px] text-zinc-500">Pausada</span>
                          )}
                        </div>
                        <div className="text-xs font-mono text-zinc-400 truncate max-w-[240px]">
                          {row.model}
                          {row.failoverSaves > 0 ? ` · ${row.failoverSaves} failover(s)` : ''}
                        </div>
                        {row.lastError && row.failures > 0 && (
                          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-amber-400 truncate max-w-[260px]">
                            <AlertTriangle className="w-3 h-3 shrink-0" />
                            <span className="truncate">{row.lastError}</span>
                          </div>
                        )}
                      </td>
                      <td className="py-3 pr-4 font-mono tabular-nums text-right text-zinc-200 whitespace-nowrap">
                        {row.successes}
                        {row.failures > 0 && (
                          <span className="text-rose-400"> / {row.failures} err</span>
                        )}
                      </td>
                      <td
                        className={`py-3 pr-4 font-mono tabular-nums text-right whitespace-nowrap ${
                          row.failureRatePct > 20
                            ? 'text-rose-400'
                            : row.failureRatePct > 0
                              ? 'text-amber-400'
                              : 'text-emerald-400'
                        }`}
                      >
                        {row.requests > 0 ? `${row.failureRatePct.toFixed(1)}%` : '—'}
                      </td>
                      <td className="py-3 pr-4 font-mono tabular-nums text-right text-zinc-200 whitespace-nowrap">
                        <div>{row.totalTokens.toLocaleString('pt-BR')}</div>
                        <div className="text-[11px] text-zinc-500">
                          {formatCompactTokens(row.promptTokens)} / {formatCompactTokens(row.completionTokens)}
                        </div>
                      </td>
                      <td className="py-3 pr-4 font-mono tabular-nums text-right text-zinc-300 whitespace-nowrap">
                        {row.avgLatencyMs > 0 ? `${row.avgLatencyMs} ms` : '—'}
                      </td>
                      <td className="py-3 pr-4 font-mono tabular-nums text-right whitespace-nowrap">
                        {row.isFreeTier ? (
                          <span className="text-emerald-400 font-medium">Grátis ($0)</span>
                        ) : (
                          <span className="text-zinc-300">${row.refRatePer1M.toFixed(2)}</span>
                        )}
                      </td>
                      <td className="py-3 font-mono tabular-nums text-right whitespace-nowrap">
                        {row.isFreeTier ? (
                          <span className="text-emerald-400">$0.0000</span>
                        ) : (
                          <span className="text-zinc-100">${row.estimatedCostUsd.toFixed(4)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
};
