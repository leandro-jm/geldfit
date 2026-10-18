import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AiSettingsDTO, AiSettingsPatch, AiTestResult } from '@sf/shared';
import type { AppContext } from '../context.js';
import { adminGuard } from '../lib/admin.js';
import {
  AI_SETTINGS_PATCH_SCHEMA,
  describeAiSettings,
  loadAiSettings,
  saveAiSettings,
  testLlm,
} from '../lib/ai-settings.js';

/** Configurações globais da instância (só ADMIN_EMAILS). */
export async function adminRoutes(f: FastifyInstance, app: AppContext, guards: { user: any; ws: any }) {
  const pre = { preHandler: [guards.user, adminGuard(app.config)] };

  f.get('/api/admin/ai-settings', pre, async (): Promise<AiSettingsDTO> => {
    // relê o banco: outra réplica pode ter alterado desde o último poll
    await loadAiSettings(app);
    return describeAiSettings(app);
  });

  f.put('/api/admin/ai-settings', pre, async (req): Promise<AiSettingsDTO> => {
    const patch = AI_SETTINGS_PATCH_SCHEMA.parse(req.body) as AiSettingsPatch;
    await saveAiSettings(app, req.user!.id, patch);
    return describeAiSettings(app);
  });

  f.post(
    '/api/admin/ai-settings/test',
    { ...pre, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req): Promise<AiTestResult> => {
      z.object({ group: z.literal('llm') }).parse(req.body);
      return testLlm(app);
    },
  );
}
