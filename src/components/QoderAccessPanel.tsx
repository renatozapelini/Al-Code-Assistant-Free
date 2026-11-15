import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Plus, Trash2, UserRound } from 'lucide-react';
import { QoderReminderPanel } from './QoderReminderPanel';

type QoderRealm = 'intl' | 'cn';

interface QoderProfile {
  id: string;
  label: string;
  email?: string;
  realm: QoderRealm;
  createdAt: number;
  lastOpenedAt?: number;
}

const STORAGE_KEY = 'hub-qoder-profiles-v1';
const MAX_PROFILES = 20;

function loadProfiles(): QoderProfile[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is QoderProfile => Boolean(
      item && typeof item.id === 'string' && typeof item.label === 'string'
      && (item.realm === 'intl' || item.realm === 'cn') && typeof item.createdAt === 'number'
    )).slice(0, MAX_PROFILES);
  } catch {
    return [];
  }
}

export function QoderAccessPanel() {
  const [profiles, setProfiles] = useState<QoderProfile[]>(loadProfiles);
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [realm, setRealm] = useState<QoderRealm>('intl');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles)); } catch { /* Storage may be unavailable. */ }
  }, [profiles]);

  const normalizedEmail = email.trim().toLowerCase();
  const duplicate = useMemo(() => normalizedEmail && profiles.some((profile) => profile.email?.toLowerCase() === normalizedEmail), [normalizedEmail, profiles]);

  const addProfile = (event: React.FormEvent) => {
    event.preventDefault();
    const cleanLabel = label.trim();
    if (!cleanLabel || duplicate || profiles.length >= MAX_PROFILES) return;
    setProfiles((current) => [...current, {
      id: `qoder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      label: cleanLabel,
      email: normalizedEmail || undefined,
      realm,
      createdAt: Date.now(),
    }]);
    setLabel('');
    setEmail('');
    setRealm('intl');
    setNotice('Conta adicionada ao registro local. Use Abrir login oficial para entrar manualmente no navegador.');
  };

  const openLogin = (id?: string) => {
    if (id) setProfiles((current) => current.map((profile) => profile.id === id ? { ...profile, lastOpenedAt: Date.now() } : profile));
    setNotice('O site oficial foi aberto. CAPTCHA, e-mail e autenticação continuam sob seu controle; o app não cria contas nem captura a sessão.');
  };

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-zinc-800 bg-[#12151B] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <UserRound className="h-4 w-4 text-emerald-400" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-zinc-100">Qoder · login assistido e múltiplas contas</h1>
        </div>
        <p className="text-xs leading-relaxed text-zinc-400">Cadastre apelidos para organizar várias contas neste aparelho e abra o login oficial de cada uma. O Qoder não está configurado como API de inferência deste app, e o aplicativo não lê senha, cookie, CAPTCHA, créditos ou sessão do navegador.</p>
        <a href="https://qoder.com" target="_self" rel="noopener noreferrer" onClick={() => openLogin()} className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-emerald-700/60 px-3 text-xs font-semibold text-emerald-300">
          <ExternalLink className="h-4 w-4" aria-hidden="true" /> Abrir login oficial do Qoder
        </a>
      </section>

      {notice && <p role="status" className="rounded-xl border border-zinc-800 bg-[#12151B] p-3 text-xs text-zinc-300">{notice}</p>}

      <form onSubmit={addProfile} className="rounded-2xl border border-zinc-800 bg-[#12151B] p-4 space-y-3" aria-label="Adicionar conta Qoder ao registro local">
        <h2 className="text-sm font-semibold text-zinc-100">Adicionar conta ao registro local</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-xs text-zinc-300"><span>Apelido da conta</span><input required maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Ex.: Qoder pessoal" className="min-h-[44px] w-full rounded-xl border border-zinc-800 bg-[#090B0E] px-3 text-sm text-zinc-100" /></label>
          <label className="space-y-1 text-xs text-zinc-300"><span>E-mail (opcional)</span><input type="email" maxLength={160} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Somente identificação local" className="min-h-[44px] w-full rounded-xl border border-zinc-800 bg-[#090B0E] px-3 text-sm text-zinc-100" /></label>
          <label className="space-y-1 text-xs text-zinc-300"><span>Região de referência</span><select value={realm} onChange={(event) => setRealm(event.target.value === 'cn' ? 'cn' : 'intl')} className="min-h-[44px] w-full rounded-xl border border-zinc-800 bg-[#090B0E] px-3 text-sm text-zinc-100"><option value="intl">Internacional</option><option value="cn">China</option></select></label>
        </div>
        {duplicate && <p role="alert" className="text-xs text-amber-300">Este e-mail já está no registro local.</p>}
        {profiles.length >= MAX_PROFILES && <p role="alert" className="text-xs text-amber-300">Limite local de {MAX_PROFILES} contas atingido.</p>}
        <button type="submit" disabled={!label.trim() || Boolean(duplicate) || profiles.length >= MAX_PROFILES} className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-emerald-500 px-4 text-xs font-semibold text-zinc-950 disabled:opacity-40"><Plus className="h-4 w-4" aria-hidden="true" /> Adicionar conta</button>
      </form>

      <section className="space-y-3" aria-label="Contas Qoder registradas localmente">
        <h2 className="text-sm font-semibold text-zinc-100">Contas registradas neste aparelho ({profiles.length})</h2>
        {profiles.map((profile) => <article key={profile.id} className="rounded-2xl border border-zinc-800 bg-[#12151B] p-4 space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><h3 className="text-sm font-semibold text-zinc-100">{profile.label}</h3><p className="text-xs text-zinc-400">{profile.email || 'E-mail não informado'} · {profile.realm === 'cn' ? 'China' : 'Internacional'}</p></div>
            <button type="button" onClick={() => setProfiles((current) => current.filter((item) => item.id !== profile.id))} aria-label={`Remover ${profile.label}`} className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-zinc-800 text-zinc-400"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
          </div>
          <a href="https://qoder.com" target="_self" rel="noopener noreferrer" onClick={() => openLogin(profile.id)} className="inline-flex min-h-[44px] items-center gap-2 text-xs font-semibold text-emerald-300"><ExternalLink className="h-4 w-4" aria-hidden="true" /> Abrir login oficial para esta conta</a>
          <p className="text-[11px] text-zinc-500">{profile.lastOpenedAt ? `Login aberto em ${new Date(profile.lastOpenedAt).toLocaleString('pt-BR')}. O app não consegue confirmar se a sessão foi concluída.` : 'Login ainda não aberto por este registro.'}</p>
        </article>)}
        {!profiles.length && <p className="rounded-xl border border-zinc-800 bg-[#12151B] p-4 text-xs text-zinc-400">Nenhuma conta registrada. Adicione um apelido acima; credenciais não são necessárias.</p>}
      </section>

      <QoderReminderPanel />
    </div>
  );
}
