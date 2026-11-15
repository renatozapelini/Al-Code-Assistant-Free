import { CODE_ASSISTANT_TOOLS, type AssistantTransport, type CodeMessage } from './codeAssistant';
import type { HubOverview } from '../types/hub';

export function createAssistantTransport(apiFetch: (path: string, init?: RequestInit) => Promise<Response>): AssistantTransport {
  let autoFailover = true;
  return {
    autoFailoverEnabled: () => autoFailover,
    async available() {
      const response = await apiFetch('/api/app/overview');
      if (!response.ok) throw new Error(`Falha ao consultar as code assistants (${response.status}).`);
      const overview = await response.json() as HubOverview;
      if (!Array.isArray(overview.providers)) throw new Error('Servidor não informou as APIs configuradas.');
      autoFailover = overview.settings?.autoFailoverEnabled !== false;
      return overview.providers;
    },
    async complete(providerId: string, messages: CodeMessage[], signal: AbortSignal) {
      const controller = new AbortController();
      const cancel = () => controller.abort(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const timer = setTimeout(() => controller.abort(new Error('Tempo máximo da code assistant excedido.')), 190000);
      try {
        const response = await apiFetch('/api/app/assistant/complete', {
          method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: `provider:${providerId}`, assistant_provider_ids: [providerId],
            stream: false, messages, tools: CODE_ASSISTANT_TOOLS, max_tokens: 8192 }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || data?.error) throw new Error(data?.error?.message || `Code assistant indisponível (HTTP ${response.status}).`);
        const choice = data?.choices?.[0];
        if (!choice?.message || data.choices.length !== 1) throw new Error('Servidor não entregou uma resposta executável da code assistant.');
        // Identity is mandatory: a different runtime must not silently claim
        // continuity when it cannot honour the selected assistant queue.
        if (data.qoder_meta?.provider_id !== providerId) throw new Error('Motor desatualizado: não confirmou a identidade da code assistant. Atualize o aplicativo.');
        return { providerId, model: String(data.model || providerId),
          message: { role: choice.message.role, content: choice.message.content,
            ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}) },
          finishReason: choice.finish_reason };
      } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
    },
  };
}
