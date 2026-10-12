import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Me, Role } from '@sf/shared';
import { setApiWorkspace } from './api';
import { readStorage, writeStorage } from './storage';

interface WorkspaceCtx {
  workspaceId: string | null;
  workspace: Me['workspaces'][number] | null;
  role: Role | null;
  canWrite: boolean;
  workspaces: Me['workspaces'];
  setWorkspace: (id: string) => void;
}

const Ctx = createContext<WorkspaceCtx>({
  workspaceId: null,
  workspace: null,
  role: null,
  canWrite: false,
  workspaces: [],
  setWorkspace: () => {},
});

const KEY = 'sf.workspace';

export function WorkspaceProvider({ me, children }: { me: Me; children: ReactNode }) {
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<string | null>(() => readStorage(KEY));
  const workspace = me.workspaces.find((w) => w.id === chosen) ?? me.workspaces[0] ?? null;
  // o cabeçalho precisa estar definido antes das queries filhas rodarem
  setApiWorkspace(workspace?.id ?? null);

  const value = useMemo<WorkspaceCtx>(
    () => ({
      workspaceId: workspace?.id ?? null,
      workspace,
      role: workspace?.role ?? null,
      canWrite: workspace ? workspace.role !== 'viewer' : false,
      workspaces: me.workspaces,
      setWorkspace: (id: string) => {
        writeStorage(KEY, id);
        setApiWorkspace(id);
        setChosen(id);
        qc.removeQueries({ queryKey: ['ws'] });
      },
    }),
    [workspace, me.workspaces, qc],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceCtx {
  return useContext(Ctx);
}
