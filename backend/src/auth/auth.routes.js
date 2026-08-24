const authService = require('./auth.service');
const { User } = require('../models');

/** Rotas publicas de autenticacao. Tudo o mais no painel exige token. */
async function authRoutes(fastify) {
  fastify.post('/api/auth/login', async (request, reply) => {
    const { email, password, remember } = request.body || {};
    const result = await authService.login({ email, password, remember: Boolean(remember) });

    if (!result.ok) return reply.code(result.status).send({ error: result.error });

    return { token: result.token, user: result.user, expiresIn: result.expiresIn };
  });

  /** Valida o token guardado no navegador e devolve o usuario. */
  fastify.get('/api/auth/me', async (request, reply) => {
    const payload = authService.verifyToken(authService.extractToken(request));
    if (!payload) return reply.code(401).send({ error: 'Sessao expirada' });

    const user = await User.findById(payload.sub);
    if (!user || !user.active) return reply.code(401).send({ error: 'Sessao invalida' });

    return { user: user.toPublic() };
  });

  /**
   * Diz ao front se ja existe algum usuario. Sem isto, uma instalacao nova
   * mostraria a tela de login sem que ninguem consiga entrar.
   */
  fastify.get('/api/auth/status', async () => {
    const total = await authService.countUsers();
    return { hasUsers: total > 0, total };
  });
}

module.exports = authRoutes;
