import type { ReactNode } from 'react';
import type { AiSettingGroup } from '@sf/shared';

/** Textos de ajuda da seção de IA: como criar a chave em cada provedor. Só conteúdo, sem lógica. */

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-primary underline-offset-4 hover:underline"
    >
      {children}
    </a>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">{children}</code>;
}

function Provider({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="font-medium text-foreground">{title}</p>
      {children}
    </div>
  );
}

const Steps = ({ children }: { children: ReactNode }) => (
  <ol className="list-decimal space-y-1 pl-5">{children}</ol>
);

export const AI_HELP: Record<AiSettingGroup, { title: string; body: ReactNode }> = {
  llm: {
    title: 'Como obter a chave da Anthropic',
    body: (
      <>
        <Steps>
          <li>
            Crie uma conta (ou entre) em <Ext href="https://console.anthropic.com">console.anthropic.com</Ext>
            .
          </li>
          <li>
            Em <Ext href="https://console.anthropic.com/settings/billing">Billing</Ext>, adicione crédito. Sem
            crédito, a chave é recusada.
          </li>
          <li>
            Em <Ext href="https://console.anthropic.com/settings/keys">Settings → API Keys</Ext>, clique em{' '}
            <strong>Create Key</strong>, dê um nome (ex.: <Code>saude-financeira</Code>) e copie a chave. Ela
            começa com <Code>sk-ant-</Code> e só aparece uma vez.
          </li>
          <li>
            Cole no campo abaixo, salve e use <strong>Testar conexão</strong>.
          </li>
        </Steps>
        <p>
          <strong>Modelos:</strong> o pequeno (<Code>claude-haiku-5-5</Code>) é barato e cuida do que roda em
          segundo plano. O grande (<Code>claude-opus-5-5</Code> ou <Code>claude-sonnet-5-5</Code>, mais em
          conta) responde perguntas complexas e lê PDFs e imagens.
        </p>
        <p>
          Dica: defina um teto de gasto mensal em{' '}
          <Ext href="https://console.anthropic.com/settings/limits">Settings → Limits</Ext>.
        </p>
      </>
    ),
  },
  transcribe: {
    title: 'Como configurar a transcrição de áudio',
    body: (
      <>
        <p>Transforma os áudios do WhatsApp e do chat em texto. Escolha uma opção:</p>
        <Provider title="OpenAI">
          <p>
            Em <Ext href="https://platform.openai.com/api-keys">platform.openai.com/api-keys</Ext>, clique em{' '}
            <strong>Create new secret key</strong>. A chave começa com <Code>sk-</Code>. Precisa de crédito em{' '}
            <Ext href="https://platform.openai.com/settings/organization/billing">Billing</Ext>. Deixe a URL
            padrão e use o modelo <Code>whisper-1</Code> ou <Code>gpt-4o-mini-transcribe</Code>.
          </p>
        </Provider>
        <Provider title="Groq (mais barato e rápido)">
          <p>
            Crie a chave em <Ext href="https://console.groq.com/keys">console.groq.com/keys</Ext>; ela começa
            com <Code>gsk_</Code>. Use a URL <Code>https://api.groq.com/openai/v1</Code> e o modelo{' '}
            <Code>whisper-large-v3-turbo</Code>.
          </p>
        </Provider>
        <Provider title="Whisper próprio (speaches, faster-whisper-server)">
          <p>
            Não precisa de chave: informe só a URL do servidor, por exemplo{' '}
            <Code>http://whisper:8000/v1</Code>.
          </p>
        </Provider>
        <p>
          Os provedores cobram por minuto de áudio; confira o preço atual na página de cada um. O áudio sai
          deste servidor para o provedor escolhido. Com um Whisper próprio, ele não sai da sua infraestrutura.
        </p>
      </>
    ),
  },
  voice: {
    title: 'Como configurar a conversa por voz',
    body: (
      <>
        <p>
          A conversa por voz usa os modelos de voz da OpenAI. Crie uma chave em{' '}
          <Ext href="https://platform.openai.com/api-keys">platform.openai.com/api-keys</Ext>; ela começa com{' '}
          <Code>sk-</Code>. A conta precisa ter crédito em{' '}
          <Ext href="https://platform.openai.com/settings/organization/billing">Billing</Ext>. Se você deixar
          a chave em branco, o app reaproveita a chave da transcrição quando ela for da OpenAI.
        </p>
        <Provider title="Qual motor escolher">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>realtime</strong> (<Code>gpt-realtime</Code>): o próprio modelo de voz consulta e
              registra os dados. Responde mais rápido e custa mais por minuto.
            </li>
            <li>
              <strong>live</strong> (<Code>gpt-live-1</Code>): a voz só conversa e repassa cada pedido ao
              assistente do chat (Claude). O minuto de voz sai mais barato.
            </li>
          </ul>
        </Provider>
      </>
    ),
  },
};
