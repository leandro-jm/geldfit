import { z } from 'zod';
import type { ToolDef } from '@sf/llm';
import { draftBillTool } from './tools-bills.js';
import { DOC_TOOLS } from './tools-docs.js';
import { PLAN_TOOLS } from './tools-plan.js';
import { FINANCE_TOOLS } from './tools-finance.js';
import { PORTFOLIO_TOOLS } from './tools-portfolio.js';
import type { AgentTool } from './tool-kit.js';

/** Conjunto fechado de ferramentas do agente (ordem fixa para o cache de prompt). */
export const TOOLS: AgentTool[] = [
  ...FINANCE_TOOLS,
  ...DOC_TOOLS,
  ...PORTFOLIO_TOOLS,
  draftBillTool,
  ...PLAN_TOOLS,
] as AgentTool[];
export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function toolDefs(opts: { readOnly: boolean }): ToolDef[] {
  return TOOLS.filter((t) => !opts.readOnly || t.kind === 'read').map((t) => {
    const schema = z.toJSONSchema(t.schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, inputSchema: schema };
  });
}
