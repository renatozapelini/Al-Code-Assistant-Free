import { useEffect, useState } from 'react';
import { Bell, ExternalLink } from 'lucide-react';
import { androidBridge, readReminder, setReminder, type ReminderSettings } from '../utils/androidBridge';

const officialRules = 'https://docs.qoder.com/events/100credits';
const dateLabel = (at?: number) => at ? new Date(at).toLocaleString('pt-BR') : 'Nenhum registro';

export function QoderReminderPanel() {
  const [settings, setSettings] = useState<ReminderSettings>();
  const [error, setError] = useState('');
  const native = Boolean(androidBridge());
  useEffect(() => {
    const refresh = () => {
      try { setSettings(readReminder()); } catch (e) { setError(e instanceof Error ? e.message : 'Falha ao ler lembrete.'); }
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, []);
  const toggle = () => {
    try { setSettings(setReminder(!settings?.enabled)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Falha ao alterar lembrete.'); }
  };

  return (
    <section className="max-w-2xl mx-auto space-y-5 rounded-2xl border border-zinc-800 bg-[#12151B] p-5">
      <div className="flex items-center gap-3">
        <Bell className="h-5 w-5 shrink-0 text-zinc-300" />
        <div>
          <h1 className="text-xl font-semibold">Qoder · opção secundária</h1>
          <p className="text-xs text-zinc-400">As APIs configuradas continuam sendo a fila das suas assistentes.</p>
        </div>
      </div>
      <p className="text-sm text-zinc-300 leading-relaxed">
        Entrar diariamente não recebe créditos automaticamente. A campanha oficial exige que você resgate manualmente no Qoder Desktop, em Painel de uso → ícone de presente. O APK não substitui esse resgate e não confirma saldo da sua conta.
      </p>
      <div className="space-y-2 border-y border-zinc-800 py-4 text-xs text-zinc-400">
        <p>Campanha: 100 créditos por janela para contas individuais Qoder International elegíveis. Contas Teams e Enterprise não participam. A campanha pode mudar ou terminar.</p>
        <p>A janela começa às 10h em UTC+8 (23h do dia anterior em Brasília). O lembrete usa essa janela, não a meia-noite do telefone.</p>
        <p>Você faz o primeiro login e eventuais verificações diretamente no serviço oficial. Este recurso não guarda senha, não cria contas e não automatiza cliques de resgate.</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={toggle} disabled={!native} aria-pressed={settings?.enabled ?? false}
          className="min-h-[44px] rounded-lg border border-zinc-700 bg-zinc-800 px-4 text-sm font-medium text-zinc-100 hover:bg-zinc-700 disabled:opacity-50">
          {settings?.enabled ? 'Desativar lembrete diário' : 'Ativar lembrete diário no Android'}
        </button>
        <a href={officialRules} target="_blank" rel="noopener noreferrer" className="min-h-[44px] inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 text-xs hover:bg-zinc-800">
          Regras oficiais <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <a href="https://qoder.com" target="_blank" rel="noopener noreferrer" className="min-h-[44px] inline-flex items-center rounded-lg border border-zinc-700 px-4 text-xs hover:bg-zinc-800">Abrir site do Qoder</a>
      </div>
      {!native ? <p className="text-xs text-zinc-400">O agendamento nativo é exclusivo do APK.</p> : (
        <div className="space-y-2 text-xs" role="status" aria-live="polite">
          <dl className="grid grid-cols-[1fr_1fr] gap-x-4 gap-y-2">
            <dt className="text-zinc-400">Lembrete</dt><dd>{settings?.enabled ? 'Ativado' : 'Desativado'}</dd>
            <dt className="text-zinc-400">Permissão de notificação</dt><dd>{settings?.notificationPermission ? 'Permitida' : 'Não permitida'}</dd>
            <dt className="text-zinc-400">Agendamento Android</dt><dd>{settings?.scheduled ? 'Registrado' : 'Não registrado'}</dd>
            <dt className="text-zinc-400">Próxima janela</dt><dd>{dateLabel(settings?.nextWindowAt)}</dd>
            <dt className="text-zinc-400">Último lembrete</dt><dd>{dateLabel(settings?.lastNotifiedAt)}</dd>
          </dl>
          {settings?.message && <p className="text-zinc-400">{settings.message}</p>}
        </div>
      )}
      <p className="text-xs text-zinc-400">O Android pode atrasar o lembrete por economia de bateria. Forçar a parada impede notificações até você reabrir o app; não há garantia de horário exato.</p>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    </section>
  );
}
