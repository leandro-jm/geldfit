/** Mascara números de cartão (PAN) e CPF/CNPJ de pessoas antes de armazenar ou enviar ao LLM. */
export function maskSensitive(text: string): string {
  return (
    text
      // PAN: 13–19 dígitos, com espaços/hífens opcionais → mantém os 4 últimos
      .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (match) => {
        const digits = match.replace(/\D/g, '');
        if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return match;
        return `**** **** **** ${digits.slice(-4)}`;
      })
      // CPF formatado ou não
      .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, (match) => {
        const digits = match.replace(/\D/g, '');
        return isCPF(digits) ? `***.***.***-${digits.slice(-2)}` : match;
      })
  );
}

export function maskDeep<T>(value: T): T {
  if (typeof value === 'string') return maskSensitive(value) as T;
  if (Array.isArray(value)) return value.map(maskDeep) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)])) as T;
  }
  return value;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function isCPF(d: string): boolean {
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len: number) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(d[i]) * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}
