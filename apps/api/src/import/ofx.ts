/** Parser de OFX 1.x (SGML) e 2.x (XML). Não precisa de LLM. */
export interface OfxTransaction {
  date: string;
  amountCents: number; // positivo
  direction: 'in' | 'out';
  description: string;
  fitId: string | null;
}

export interface OfxStatement {
  kind: 'bank' | 'card';
  bankId: string | null;
  accountId: string | null;
  currency: string | null;
  ledgerBalanceCents: number | null;
  ledgerBalanceDate: string | null;
  transactions: OfxTransaction[];
}

function tag(block: string, name: string): string | null {
  // SGML sem fechamento (<TAG>valor) ou XML (<TAG>valor</TAG>)
  const m = block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i'));
  return m ? m[1]!.trim() : null;
}

function ofxDate(v: string | null): string | null {
  if (!v) return null;
  const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function ofxAmount(v: string | null): number | null {
  if (!v) return null;
  let s = v.trim();
  // alguns bancos brasileiros usam vírgula decimal
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function parseOfx(text: string): OfxStatement {
  if (!/<OFX>/i.test(text)) throw new Error('Arquivo não parece ser OFX.');
  const kind = /<CCSTMTRS>/i.test(text) ? 'card' : 'bank';
  const transactions: OfxTransaction[] = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<\/STMTTRN>/i)[0]!;
    const amount = ofxAmount(tag(block, 'TRNAMT'));
    const date = ofxDate(tag(block, 'DTPOSTED'));
    if (amount === null || !date || amount === 0) continue;
    const name = tag(block, 'NAME');
    const memo = tag(block, 'MEMO');
    const description =
      [name, memo && memo !== name ? memo : null].filter(Boolean).join(' - ') || 'Sem descrição';
    transactions.push({
      date,
      amountCents: Math.abs(amount),
      direction: amount > 0 ? 'in' : 'out',
      description,
      fitId: tag(block, 'FITID'),
    });
  }
  const bal = text.match(/<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|$)/i)?.[1] ?? '';
  return {
    kind,
    bankId: tag(text, 'BANKID'),
    accountId: tag(text, 'ACCTID'),
    currency: tag(text, 'CURDEF'),
    ledgerBalanceCents: ofxAmount(tag(bal, 'BALAMT')),
    ledgerBalanceDate: ofxDate(tag(bal, 'DTASOF')),
    transactions,
  };
}
