import { MessageCircleQuestion } from 'lucide-react';
import { useChat } from '@/components/chat/chat-context';
import { Tip } from '@/components/ui/menu';

/** "Perguntar sobre isto": abre o chat com o contexto do painel pré-preenchido. */
export function AskButton({ panel, detail, question }: { panel: string; detail?: string; question: string }) {
  const chat = useChat();
  return (
    <Tip label="Perguntar sobre isto">
      <button
        type="button"
        aria-label={`Perguntar sobre isto: ${panel}`}
        onClick={() => chat.openChat({ text: question, context: { panel, detail } })}
        className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <MessageCircleQuestion className="size-[18px]" aria-hidden />
      </button>
    </Tip>
  );
}
