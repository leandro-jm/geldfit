// Todo o texto da landing num lugar só. Base: docs/ANALISE-MERCADO.md e docs/PRD.md.
// Regra: diferenciais primeiro; o que todo concorrente tem fica em "O básico, bem feito".

const trim = (u: string) => u.replace(/\/$/, '');

export const APP_URL = trim(import.meta.env.PUBLIC_APP_URL || 'http://localhost:5173');
export const SIGNUP_URL = `${APP_URL}/cadastro`;
export const LOGIN_URL = `${APP_URL}/login`;
export const MCP_URL = `${APP_URL}/api/mcp`;

export const site = {
  name: 'Saúde Financeira',
  title: 'Saúde Financeira: projeção de 24 meses e controle pelo WhatsApp',
  description:
    'Planejamento financeiro por chat: veja quanto sobra nos próximos 24 meses, com parcelas, IPVA e 13º. Mande foto ou PDF da fatura pelo WhatsApp e confirme antes de gravar.',
};

export const nav = [
  { href: '#diferenciais', label: 'Diferenciais' },
  { href: '#como-funciona', label: 'Como funciona' },
  { href: '#comparativo', label: 'Comparativo' },
  { href: '#mcp', label: 'Claude e ChatGPT' },
  { href: '#perguntas', label: 'Perguntas' },
];

export const stats = [
  { value: 82, suffix: '%', label: 'das famílias brasileiras estão endividadas' },
  { value: 85, suffix: '%', label: 'delas têm o cartão de crédito como principal dívida' },
  { value: 53, suffix: '%', label: 'dos trabalhadores terminam o mês sem sobra' },
];

export const statsSource =
  'Fontes: CNC/Peic e pesquisas de mercado citadas na análise de mercado do produto (2025–2026).';

/** Tags que rolam no hero: o que o calendário e a projeção já entendem. */
export const ticker = [
  'IPVA em 3 parcelas',
  'IPTU cota única',
  '13º salário',
  'Material escolar',
  'Matrícula',
  'IRPF a pagar',
  'Restituição do IR',
  'Parcelas do cartão',
  'Financiamento',
  'Consórcio',
  'Carnê',
  'Previdência fechada',
  'Nota de corretagem',
  'Fatura em PDF',
];

export type Feature = { icon: string; title: string; text: string; tag?: string };

export const differentiators: Feature[] = [
  {
    icon: 'chart',
    tag: 'Exclusivo',
    title: 'Projeção de 24 meses, de verdade',
    text: 'Mês a mês, quanto entra, sai e sobra pelos próximos dois anos, já com parcelas futuras do cartão, recorrências, metas e gasto variável estimado. Com faixa otimista e pessimista e alerta antes do saldo ficar negativo.',
  },
  {
    icon: 'gauge',
    tag: 'Ninguém mostra',
    title: 'Renda comprometida',
    text: 'Parcelas, carnês, financiamentos e consórcios divididos pela sua renda recorrente, com faixas de atenção em 20% e 30% e o mês em que cada parcela termina.',
  },
  {
    icon: 'shield-check',
    tag: 'Dor nº 1 resolvida',
    title: 'Prévia, confirmação e desfazer',
    text: 'Mande a fatura em PDF, o extrato ou a nota de corretagem. Você vê a prévia com duplicados marcados, itens de baixa confiança e a soma conferida contra o total da fatura. Nada é gravado sem o seu “confirmar” e tudo pode ser desfeito.',
  },
  {
    icon: 'calendar',
    tag: 'Calendário brasileiro',
    title: 'IPVA, IPTU, 13º e material escolar',
    text: 'O app aprende com o seu histórico e avisa de 45 a 60 dias antes. Responda “sim” e o gasto entra na projeção, sem inflar a média do mês.',
  },
  {
    icon: 'sparkles',
    title: 'Um assistente que avisa antes',
    text: 'Meta atrasada, sobra sem destino, reserva de emergência curta, 13º para dividir. Ele sugere com opções de um toque, no máximo um aviso por dia e respeitando o seu horário.',
  },
  {
    icon: 'piggy',
    title: 'Previdência fechada e investimentos',
    text: 'Importe o extrato do fundo de pensão (como a Previsc) e as notas de corretagem com taxas e preço médio. Diagnóstico da carteira sem recomendar ativos, conforme a CVM 19.',
  },
  {
    icon: 'users',
    title: 'Família com papéis de verdade',
    text: 'Dono, membro e leitor no mesmo espaço, cada lançamento com autor e contas privadas que só você vê. Isolamento garantido no banco de dados, não só na tela.',
  },
  {
    icon: 'lock',
    title: 'Privacidade levada a sério',
    text: 'Anexos criptografados (AES-256), cartão e CPF mascarados antes de qualquer IA, exportação e exclusão dos seus dados em um clique (LGPD).',
  },
];

export const steps = [
  {
    n: '1',
    title: 'Mande do jeito que for mais fácil',
    text: '“Paguei 230 de luz no BB ontem”, um áudio, a foto do cupom ou o PDF da fatura. No WhatsApp ou na web.',
  },
  {
    n: '2',
    title: 'Confira a prévia',
    text: 'O assistente mostra o que entendeu, marca duplicados e confere o total. Você confirma, edita ou cancela.',
  },
  {
    n: '3',
    title: 'Veja o impacto no futuro',
    text: 'Cada lançamento mostra quanto muda o saldo projetado. Pergunte “cabe no bolso?” antes de parcelar.',
  },
];

/** Comparativo honesto: inclui linhas em que todos empatam. */
export const comparison: Array<{ feature: string; us: boolean | string; them: boolean | string }> = [
  { feature: 'Projeção de 24 meses com parcelas e recorrências', us: true, them: 'Só o mês atual' },
  { feature: 'Renda comprometida mês a mês', us: true, them: false },
  { feature: 'Prévia, confirmação e desfazer para PDF e extrato', us: true, them: false },
  { feature: 'Soma conferida contra o total da fatura', us: true, them: false },
  { feature: 'Calendário de IPVA, IPTU, 13º e escola', us: true, them: false },
  { feature: 'Previdência fechada e nota de corretagem', us: true, them: 'Raro' },
  { feature: 'Papéis na família e conta privada', us: true, them: 'Compartilhamento simples' },
  { feature: 'Conectar ao Claude e ao ChatGPT (MCP)', us: true, them: 'Poucos' },
  { feature: 'Lançar por texto, áudio e foto no WhatsApp', us: true, them: true },
  { feature: 'Lembrete de vencimento', us: true, them: true },
];

export const basics: Feature[] = [
  { icon: 'message', title: 'WhatsApp com texto, áudio e foto', text: 'Lance gastos sem abrir app.' },
  { icon: 'bell', title: 'Lembrete com “já paguei”', text: 'Responda e o pagamento é registrado.' },
  { icon: 'mic', title: 'Conversa por voz', text: 'Fale com suas finanças em tempo real.' },
  { icon: 'target', title: 'Metas e orçamentos', text: 'Quanto guardar por mês para chegar lá.' },
  { icon: 'file', title: 'Extrato CSV, OFX e PDF', text: 'Importação de qualquer banco.' },
  { icon: 'calendar-check', title: 'Resumos semanais', text: 'O que mudou e o que vem por aí.' },
  { icon: 'smartphone', title: 'App instalável (PWA)', text: 'Na tela inicial, com notificações.' },
  { icon: 'eye-off', title: 'Modo privacidade', text: 'Esconde valores com um toque.' },
];

export const personas = [
  {
    photo: 'jovem',
    title: 'Quem tem várias contas',
    text: 'Duas ou três contas, um cartão, talvez previdência fechada. Quer ver tudo junto e saber se o mês fecha.',
    alt: 'Jovem profissional consultando o celular no sofá de casa',
  },
  {
    photo: 'familia',
    title: 'Casal e família',
    text: 'Cada um lança do seu celular, todos veem a mesma projeção e cada conta pode ser privada.',
    alt: 'Família no sofá: pai e mãe com celulares e o filho com um tablet',
  },
  {
    photo: 'homem',
    title: 'Quem só quer o WhatsApp',
    text: 'Sem paciência para app. Manda a mensagem, confirma com “sim” e recebe o aviso antes do vencimento.',
    alt: 'Homem sorrindo enquanto troca mensagens no celular',
  },
];

export const faq = [
  {
    q: 'O app se conecta ao meu banco?',
    a: 'Não. Não usamos Open Finance de propósito: nenhuma senha ou permissão bancária é necessária. Você manda extratos, faturas e notas (PDF, foto, CSV ou OFX) ou digita. Funciona com qualquer banco, incluindo cooperativas como Cresol, Sicoob e Sicredi.',
  },
  {
    q: 'A IA pode gravar algo errado nas minhas finanças?',
    a: 'Nada é gravado sem a sua confirmação. Cada importação vira uma prévia com duplicados e itens duvidosos marcados, e a soma é conferida contra o total do documento. Se algo passar, “desfazer” volta tudo.',
  },
  {
    q: 'Meus dados ficam seguros?',
    a: 'Os anexos são criptografados, números de cartão e CPF são mascarados antes de qualquer IA e você pode exportar ou apagar tudo quando quiser (LGPD).',
  },
  {
    q: 'Quanto custa?',
    a: 'É grátis para começar, sem cartão de crédito.',
  },
  {
    q: 'Vocês recomendam investimentos?',
    a: 'Não. Seguindo a Resolução CVM 19, o app faz diagnóstico da carteira (alocação, concentração, desempenho contra CDI e IPCA) mas não recomenda comprar ou vender ativos.',
  },
  {
    q: 'Posso usar com o Claude ou o ChatGPT?',
    a: 'Sim. O app tem conexão via MCP: você conecta o seu assistente favorito com o seu login, autoriza o acesso e pergunta sobre projeção, saldo e parcelas direto na conversa. O acesso é só de leitura e pode ser revogado a qualquer momento.',
  },
  {
    q: 'Preciso usar o WhatsApp?',
    a: 'Não. Tudo funciona na web e no app instalável. O WhatsApp é um atalho: você vincula o número com um código de 6 dígitos e pode desligar quando quiser.',
  },
];
