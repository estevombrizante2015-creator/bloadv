const authService = require('./auth.service');
const { User } = require('../models');
const logger = require('../utils/logger');

/**
 * Protege tudo sob /api, menos o que estiver em PUBLIC_PATHS.
 *
 * O painel expoe QR de pareamento: quem chega nele assume as contas de
 * WhatsApp do escritorio e le as conversas dos clientes. Por isso nao existe
 * modo aberto nem bypass por variavel de ambiente.
 */
const PUBLIC_PATHS = new Set([
  '/health',
  '/api/auth/login',
  '/api/auth/status',
  '/api/auth/me', // responde 401 por conta propria
]);

function registerAuthHook(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    const path = request.routeOptions?.url || request.url.split('?')[0];

    if (!path.startsWith('/api') || PUBLIC_PATHS.has(path)) return;

    const payload = authService.verifyToken(authService.extractToken(request));
    if (!payload) {
      return reply.code(401).send({ error: 'Nao autenticado' });
    }

    // Assinatura valida nao basta: o usuario precisa existir e estar ativo,
    // para que revogar um acesso tenha efeito imediato mesmo com token vigente.
    let user;
    try {
      user = await User.findById(payload.sub).lean();
    } catch (error) {
      // `sub` malformado (token forjado a mao) e problema de credencial: 401.
      if (error.name === 'CastError') {
        return reply.code(401).send({ error: 'Sessao invalida' });
      }
      // Banco fora e problema nosso: 401 aqui faria o usuario achar que
      // errou a senha e ficar tentando de novo.
      logger.error({ err: error.message }, 'Falha ao validar sessao no banco');
      return reply.code(503).send({ error: 'Servico indisponivel. Tente novamente.' });
    }

    if (!user || !user.active) {
      return reply.code(401).send({ error: 'Sessao invalida' });
    }

    request.user = { id: user._id.toString(), email: user.email, role: user.role };
  });

  logger.info({ publicas: [...PUBLIC_PATHS] }, 'Autenticacao do painel ativa');
}

/** Mesma checagem para o Socket.IO: sem token, sem conexao. */
function socketAuthMiddleware(socket, next) {
  const payload = authService.verifyToken(authService.extractToken(socket));
  if (!payload) return next(new Error('nao autenticado'));

  socket.user = { id: payload.sub, email: payload.email, role: payload.role };
  next();
}

module.exports = { registerAuthHook, socketAuthMiddleware, PUBLIC_PATHS };
