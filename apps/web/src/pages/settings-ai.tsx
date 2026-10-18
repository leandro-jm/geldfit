import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, HelpCircle, KeyRound, Loader2, PlugZap, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import {
  AI_SETTING_FIELDS,
  type AiSettingField,
  type AiSettingGroup,
  type AiSettingKey,
  type AiSettingValueDTO,
  type AiSettingsDTO,
  type AiSettingsPatch,
  type AiTestResult,
} from '@sf/shared';
import { api, ApiError } from '@/lib/api';
import { aiSettingsKey, meKey, useAiSettings } from '@/lib/queries';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { AI_HELP } from './settings-ai-help';

const GROUPS: Array<{ id: AiSettingGroup; title: string; description: string }> = [
  { id: 'llm', title: 'Assistente (LLM)', description: 'Chat, leitura de documentos, memória e avisos.' },
  {
    id: 'transcribe',
    title: 'Transcrição de áudio',
    description: 'Áudios enviados pelo WhatsApp e pelo chat.',
  },
  { id: 'voice', title: 'Conversa por voz', description: 'Falar com o assistente pelo navegador.' },
];

const SOURCE_LABEL = { db: 'salva aqui', env: 'do .env', default: 'padrão' } as const;

function errorMessage(err: unknown) {
  if (err instanceof ApiError && Array.isArray(err.details) && err.details.length) {
    const label = (key: string) => AI_SETTING_FIELDS.find((f) => f.key === key)?.label ?? key;
    return (err.details as Array<{ path: string; message: string }>)
      .map((d) => `${label(d.path)}: ${d.message}`)
      .join(' · ');
  }
  return err instanceof Error ? err.message : 'Falhou.';
}

function prefixWarning(field: AiSettingField, value: string) {
  const v = value.trim();
  if (!v || !field.keyPrefixes?.length || field.keyPrefixes.some((p) => v.startsWith(p))) return null;
  return `Essa chave não parece ser do provedor esperado (costuma começar com ${field.keyPrefixes.join(' ou ')}).`;
}

/** Chaves e modelos de IA da instância. Só aparece para admins (ADMIN_EMAILS). */
export function AiSettingsSection() {
  const q = useAiSettings();
  return (
    <Card id="ia" className="scroll-mt-24">
      <CardHeader
        title="Inteligência artificial"
        description="Chaves e modelos usados por todo o servidor. O que você salvar aqui substitui o .env e vale em até 30 segundos, sem reiniciar."
      />
      <CardBody>
        {q.isPending ? (
          <Skeleton className="h-48" />
        ) : q.isError ? (
          <p className="text-[13.5px] text-negative">{errorMessage(q.error)}</p>
        ) : (
          <div className="space-y-6">
            {GROUPS.map((g) => (
              <GroupBlock key={g.id} group={g} data={q.data} />
            ))}
            <p className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
              <KeyRound className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              As chaves ficam cifradas no banco. Nem os administradores voltam a ver a chave inteira, só os 4
              últimos caracteres.
            </p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function GroupBlock({ group, data }: { group: (typeof GROUPS)[number]; data: AiSettingsDTO }) {
  const qc = useQueryClient();
  const fields = AI_SETTING_FIELDS.filter((f) => f.group === group.id);
  const byKey = new Map(data.fields.map((v) => [v.key, v]));
  const [drafts, setDrafts] = useState<Partial<Record<AiSettingKey, string>>>({});
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<AiTestResult | null>(null);

  const secretMissing = fields.some((f) => f.secret && !byKey.get(f.key)?.isSet);
  const dirty = Object.entries(drafts).filter(([key, v]) => {
    const cur = byKey.get(key as AiSettingKey);
    return v !== undefined && (FIELD_SECRET.has(key) ? v.trim() !== '' : v.trim() !== (cur?.value ?? ''));
  });

  const put = async (patch: AiSettingsPatch, ok: string) => {
    setBusy('save');
    try {
      const next = await api<AiSettingsDTO>('/api/admin/ai-settings', { method: 'PUT', body: patch });
      qc.setQueryData(aiSettingsKey, next);
      await qc.invalidateQueries({ queryKey: meKey });
      setDrafts((d) => {
        const rest = { ...d };
        for (const k of Object.keys(patch)) delete rest[k as AiSettingKey];
        return rest;
      });
      setTest(null);
      toast.success(ok);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    void put(
      Object.fromEntries(dirty.map(([k, v]) => [k, v!.trim() || null])) as AiSettingsPatch,
      'Configuração salva.',
    );

  const runTest = async () => {
    setBusy('test');
    try {
      const r = await api<AiTestResult>('/api/admin/ai-settings/test', {
        method: 'POST',
        body: { group: 'llm' },
      });
      setTest(r);
    } catch (err) {
      setTest({ ok: false, provider: '', error: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const help = AI_HELP[group.id];
  return (
    <section
      aria-labelledby={`ia-${group.id}`}
      className="space-y-3 border-t border-border pt-5 first:border-t-0 first:pt-0"
    >
      <div>
        <h3 id={`ia-${group.id}`} className="text-[15px] font-semibold">
          {group.title}
        </h3>
        <p className="text-[13px] text-muted-foreground">{group.description}</p>
      </div>

      <details
        open={secretMissing || undefined}
        className="group rounded-xl border border-border bg-subtle px-4 py-3 text-[13px] leading-relaxed text-muted-foreground"
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-foreground [&::-webkit-details-marker]:hidden">
          <HelpCircle className="size-4 text-primary" aria-hidden />
          {help.title}
        </summary>
        <div className="mt-3 space-y-3">{help.body}</div>
      </details>

      {group.id === 'voice' ? <VoiceKeyNote byKey={byKey} /> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <SettingInput
            key={f.key}
            field={f}
            current={byKey.get(f.key)}
            draft={drafts[f.key]}
            disabled={busy !== null}
            onDraft={(v) => setDrafts((d) => ({ ...d, [f.key]: v }))}
            onCancel={() =>
              setDrafts((d) => {
                const rest = { ...d };
                delete rest[f.key];
                return rest;
              })
            }
            onReset={() => void put({ [f.key]: null }, 'Voltou para o valor do .env/padrão.')}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={save} disabled={!dirty.length || busy !== null}>
          {busy === 'save' ? <Loader2 className="animate-spin" aria-hidden /> : null}
          Salvar
        </Button>
        {group.id === 'llm' ? (
          <Button
            variant="outline"
            onClick={() => void runTest()}
            disabled={busy !== null || dirty.length > 0}
          >
            {busy === 'test' ? <Loader2 className="animate-spin" aria-hidden /> : <PlugZap aria-hidden />}
            Testar conexão
          </Button>
        ) : null}
        {group.id === 'llm' && dirty.length > 0 ? (
          <span className="text-[12px] text-muted-foreground">Salve antes de testar.</span>
        ) : null}
      </div>
      {test ? (
        <p
          role="status"
          className={`flex items-start gap-2 text-[13px] ${test.ok ? 'text-positive' : 'text-negative'}`}
        >
          {test.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : null}
          {test.ok ? `Conexão ok: ${test.models?.join(' e ')} responderam.` : test.error}
        </p>
      ) : null}
    </section>
  );
}

const FIELD_SECRET = new Set(AI_SETTING_FIELDS.filter((f) => f.secret).map((f) => f.key as string));

function SourceBadge({ source }: { source: AiSettingValueDTO['source'] }) {
  return <Badge tone={source === 'db' ? 'accent' : 'outline'}>{SOURCE_LABEL[source]}</Badge>;
}

function SettingInput({
  field,
  current,
  draft,
  disabled,
  onDraft,
  onCancel,
  onReset,
}: {
  field: AiSettingField;
  current: AiSettingValueDTO | undefined;
  draft: string | undefined;
  disabled: boolean;
  onDraft: (v: string) => void;
  onCancel: () => void;
  onReset: () => void;
}) {
  const id = `ai-${field.key}`;
  const source = current?.source ?? 'default';
  const label = (
    <span className="flex flex-wrap items-center gap-1.5">
      {field.label}
      {current?.isSet || source === 'db' ? <SourceBadge source={source} /> : null}
    </span>
  );

  if (field.secret) {
    const editing = draft !== undefined || !current?.isSet;
    const warning = draft ? prefixWarning(field, draft) : null;
    return (
      <Field label={label} htmlFor={id} hint={warning ? undefined : field.hint} className="sm:col-span-2">
        {editing ? (
          <div className="flex gap-2">
            <Input
              id={id}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Cole a chave aqui"
              value={draft ?? ''}
              onChange={(e) => onDraft(e.target.value)}
              disabled={disabled}
            />
            {current?.isSet ? (
              <Button variant="ghost" onClick={onCancel} disabled={disabled}>
                Cancelar
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span
              id={id}
              className="tnum rounded-[10px] border border-input bg-muted px-3 py-2 font-mono text-[13px]"
            >
              ••••••••{current?.last4}
            </span>
            <Button variant="outline" size="sm" onClick={() => onDraft('')} disabled={disabled}>
              Trocar
            </Button>
            {source === 'db' ? (
              <Button variant="ghost" size="sm" onClick={onReset} disabled={disabled}>
                Remover
              </Button>
            ) : null}
          </div>
        )}
        {warning ? (
          <p className="text-[12px] text-warning" role="status">
            {warning}
          </p>
        ) : null}
      </Field>
    );
  }

  const reset =
    source === 'db' ? (
      <Button variant="link" size="sm" onClick={onReset} disabled={disabled} className="text-[12px]">
        <RotateCcw aria-hidden /> Restaurar {field.default ? 'padrão' : '.env'}
      </Button>
    ) : null;

  if (field.kind === 'select') {
    return (
      <Field label={label} htmlFor={id} hint={field.hint}>
        <Select
          id={id}
          value={draft ?? current?.value ?? field.default ?? ''}
          onChange={(e) => onDraft(e.target.value)}
          disabled={disabled}
        >
          {field.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
        {reset}
      </Field>
    );
  }

  const listId = field.suggestions?.length ? `${id}-list` : undefined;
  return (
    <Field label={label} htmlFor={id} hint={field.hint}>
      <Input
        id={id}
        type={field.kind === 'url' ? 'url' : 'text'}
        list={listId}
        spellCheck={false}
        autoComplete="off"
        placeholder={field.default ?? ''}
        value={draft ?? current?.value ?? ''}
        onChange={(e) => onDraft(e.target.value)}
        disabled={disabled}
      />
      {listId ? (
        <datalist id={listId}>
          {field.suggestions!.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
      {reset}
    </Field>
  );
}

/** Sem chave própria de voz, a API reaproveita a da transcrição se ela for da OpenAI. */
function VoiceKeyNote({ byKey }: { byKey: Map<AiSettingKey, AiSettingValueDTO> }) {
  if (byKey.get('REALTIME_API_KEY')?.isSet) return null;
  const url = byKey.get('TRANSCRIBE_URL')?.value;
  const reuses = byKey.get('TRANSCRIBE_API_KEY')?.isSet && (!url || url.includes('api.openai.com'));
  return (
    <p className="text-[13px] text-muted-foreground">
      {reuses
        ? 'Sem chave própria: a voz está usando a chave da transcrição (OpenAI).'
        : 'A conversa por voz está desligada: falta uma chave da OpenAI aqui ou na transcrição.'}
    </p>
  );
}
