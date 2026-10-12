/** Erro de domínio com status HTTP e mensagem amigável em pt-BR. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'error',
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Registro') => new AppError(404, `${what} não encontrado.`, 'not_found');
export const forbidden = (msg = 'Você não tem permissão para esta ação.') =>
  new AppError(403, msg, 'forbidden');
export const badRequest = (msg: string, details?: unknown) => new AppError(400, msg, 'bad_request', details);
