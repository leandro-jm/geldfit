import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

/** Filtros globais da barra superior (escopo: projeção, painel e lançamentos). */
interface FiltersCtx {
  accountId: string | null;
  setAccountId: (id: string | null) => void;
}

const Ctx = createContext<FiltersCtx>({ accountId: null, setAccountId: () => {} });

export function FiltersProvider({ children }: { children: ReactNode }) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const value = useMemo(() => ({ accountId, setAccountId }), [accountId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useFilters = () => useContext(Ctx);
