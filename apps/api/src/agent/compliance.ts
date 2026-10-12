import { fold } from '@sf/shared';

// Ticker B3 (PETR4, ITUB4, TAEE11, IVVB11), BDR (AAPL34) ou ticker americano entre aspas/maiúsculo
const TICKER = /\b[A-Z]{4}\d{1,2}\b/;
const ACTION =
  /\b(compre|comprar|recomendo comprar|vale a pena comprar|venda|vender|recomendo vender|mantenha|manter|aumente|aumentar posicao|reduza|reduzir posicao|zere|zerar|aporte em|invista em|investir em|aloque em|troque por|migre para|sugiro (?:comprar|vender|investir|aplicar|trocar))\b/;

/**
 * Detecta recomendação individualizada de ativo específico (vedada pela Resolução CVM 19).
 * Considera recomendação a combinação de um ticker/fundo nomeado com um verbo imperativo de
 * compra/venda/manutenção na mesma frase, fora de negação explícita.
 */
export function looksLikeRecommendation(text: string): boolean {
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  for (const s of sentences) {
    if (!TICKER.test(s) && !/\bfundo [A-Z]/.test(s)) continue;
    const f = fold(s);
    if (!ACTION.test(f)) continue;
    if (
      /\b(nao (posso|faco|recomendo|indico)|nao e recomendacao|sem recomendar|nao fazemos recomendacao)\b/.test(
        f,
      )
    )
      continue;
    // relato de operação passada do próprio usuário ("você comprou 100 ITUB4") não é recomendação
    if (
      /\b(voce comprou|voce vendeu|comprou|vendeu|registrei|registrada|registrado|operacao de)\b/.test(f) &&
      !/\b(compre|venda|mantenha|aumente|reduza|zere)\b/.test(f)
    )
      continue;
    return true;
  }
  return false;
}

export const SAFE_INVESTMENT_REPLY =
  'Não posso recomendar a compra ou a venda de ativos específicos: isso é consultoria de valores mobiliários, atividade de consultor registrado na CVM. Posso mostrar os fatos da sua carteira — posição, preço médio, peso, custos e como ela se compara às metas que você definiu. Quer que eu traga esses números?';
