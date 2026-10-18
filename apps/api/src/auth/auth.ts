import { betterAuth } from 'better-auth';
import type pg from 'pg';
import { sql, withUserContext, type Db } from '@sf/db';
import type { Config } from '../config.js';
import type { Mailer } from '../lib/mailer.js';

export function createAuth(opts: { config: Config; pool: pg.Pool; db: Db; mailer: Mailer }) {
  const { config, pool, db, mailer } = opts;
  const google =
    config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
      ? { google: { clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET } }
      : {};

  return betterAuth({
    appName: 'Saúde Financeira',
    baseURL: config.PUBLIC_API_URL,
    basePath: '/api/auth',
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.PUBLIC_WEB_URL],
    database: pool,
    user: {
      modelName: 'auth_user',
      fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' },
      // Troca de e-mail em Configurações. E-mail já verificado: confirmação pelo endereço atual antes de
      // mudar. Ainda não verificado: muda na hora e o novo endereço recebe o link de verificação.
      changeEmail: {
        enabled: true,
        updateEmailWithoutVerification: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          await mailer.send(
            user.email,
            'Confirme a troca de e-mail',
            `Olá, ${user.name}! Recebemos um pedido para trocar o e-mail da sua conta para ${newEmail}. Para confirmar, acesse: ${url}\n\nSe não foi você, ignore esta mensagem.`,
          );
        },
      },
    },
    session: {
      modelName: 'auth_session',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    account: {
      modelName: 'auth_account',
      fields: {
        userId: 'user_id',
        accountId: 'account_id',
        providerId: 'provider_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      modelName: 'auth_verification',
      fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      requireEmailVerification: false,
      sendResetPassword: async ({ user, url }) => {
        await mailer.send(user.email, 'Redefinir sua senha', `Para redefinir sua senha, acesse: ${url}`);
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await mailer.send(
          user.email,
          'Confirme seu e-mail',
          `Olá, ${user.name}! Confirme seu e-mail acessando: ${url}`,
        );
      },
    },
    socialProviders: google,
    advanced: { database: { generateId: () => crypto.randomUUID() } },
    databaseHooks: {
      user: {
        create: {
          // Todo usuário novo ganha um workspace pessoal (com categorias padrão)
          after: async (user) => {
            await withUserContext(db, user.id, async (tx) => {
              await sql`select create_workspace(${'Pessoal'})`.execute(tx);
            });
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
