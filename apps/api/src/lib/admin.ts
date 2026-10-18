import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { AppError, forbidden } from './errors.js';

/** Admin da instância: e-mail listado em ADMIN_EMAILS (não há papel de admin no banco). */
export function isAdmin(config: Config, email: string | null | undefined): boolean {
  return Boolean(email) && config.ADMIN_EMAILS.includes(email!.toLowerCase());
}

/** Roda depois do guard de sessão. */
export function adminGuard(config: Config) {
  return async function requireAdmin(req: FastifyRequest) {
    if (!req.user) throw new AppError(401, 'Faça login para continuar.', 'unauthenticated');
    if (!isAdmin(config, req.user.email))
      throw forbidden('Só administradores podem alterar esta configuração.');
  };
}
