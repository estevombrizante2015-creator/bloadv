const { env, assertEnv } = require('./src/config/env');
const logger = require('./src/utils/logger');
const connectDB = require('./src/config/database');
const manager = require('./src/whatsapp/baileys.manager');
const { registerBridge } = require('./src/whatsapp/bridge');
const channelsRoutes = require('./src/routes/channels.routes');
const conversationsRoutes = require('./src/routes/conversations.routes');
const curadoriaRoutes = require('./src/curadoria/curadoria.routes');
const clientesRoutes = require('./src/clientes/clientes.routes');
const authRoutes = require('./src/auth/auth.routes');
const { registerAuthHook, socketAuthMiddleware } = require('./src/auth/auth.hook');
const authService = require('./src/auth/auth.service');
const socketHandler = require('./src/socket/socket.handler');
const { listTiers } = require('./src/agent/models.registry');
const { corsOrigin } = require('./src/config/cors');
const agentResolver = require('./src/config/agent.resolver');
const curadoria = require('./src/curadoria/config.service');
const lidResolver = require('./src/whatsapp/lid.resolver');
const authStore = require('./src/whatsapp/auth.store');
const clientePipeline = require('./src/clientes/pipeline.service');
const clienteService = require('./src/clientes/cliente.service');
const realtime = require('./src/utils/realtime');

async function start() {
  assertEnv();

  // Fastify 5: `logger` aceita apenas objeto de configuracao;
  // para injetar uma instancia pronta de pino, a opcao e `loggerInstance`.
  const fastify = require('fastify')({ loggerInstance: logger });

  // Rede de seguranca: POST sem corpo anunciando JSON e comum em cliente HTTP.
  // Sem isto o Fastify devolve 400, e a acao (conectar, cancelar) morre sem
  // explicacao util para quem esta no painel.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body, done) => {
      if (!body || !String(body).trim()) return done(null, {});
      try {
        done(null, JSON.parse(body));
      } catch (error) {
        error.statusCode = 400;
        done(error, undefined);
      }
    }
  );

  await fastify.register(require('@fastify/cors'), {
    origin: corsOrigin,
    credentials: true,
    // O padrao do @fastify/cors e GET,HEAD,POST. Sem declarar PATCH e DELETE,
    // o navegador bloqueia renomear canal, excluir conversa e desatribuir
    // numero - o curl passava porque nao faz preflight.
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Sai no boot de proposito: CORS mal configurado nao produz erro em lugar
  // nenhum - o servidor responde 200, o navegador descarta a resposta e o
  // painel so consegue dizer "nao foi possivel falar com o servidor". Ter as
  // origens efetivas no log e a diferenca entre ler a causa e adivinhar.
  logger.info(
    { origens: env.corsOrigin, redeLocalLiberada: env.corsAllowLocalNetwork },
    'CORS configurado'
  );

  await connectDB();

  // A ordem importa: o hook precisa existir antes das rotas que ele protege.
  registerAuthHook(fastify);
  await fastify.register(authRoutes);
  await fastify.register(channelsRoutes);
  await fastify.register(conversationsRoutes);
  await fastify.register(curadoriaRoutes);
  await fastify.register(clientesRoutes);

  fastify.get('/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    channels: manager.listPublicStates().map((c) => ({ id: c.id, status: c.status })),
  }));

  // Dual-stack: alguns ambientes nao tem IPv6, entao cai para IPv4 se preciso.
  try {
    await fastify.listen({ port: env.port, host: env.host });
  } catch (error) {
    if (env.host === '::' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL'].includes(error.code)) {
      logger.warn({ err: error.code }, 'IPv6 indisponivel; escutando apenas em IPv4');
      await fastify.listen({ port: env.port, host: '0.0.0.0' });
    } else {
      throw error;
    }
  }

  const io = new (require('socket.io').Server)(fastify.server, {
    cors: { origin: corsOrigin, credentials: true },
  });

  // O socket carrega QR de pareamento: exige o mesmo token do HTTP.
  io.use(socketAuthMiddleware);

  realtime.setIo(io);
  socketHandler(io);
  registerBridge(io);

  // Atribuicoes feitas no painel precisam estar em memoria ANTES de qualquer
  // canal reconectar, senao o vinculo sairia errado nos primeiros segundos.
  await agentResolver.load();

  // Pelo mesmo motivo: um canal que reconecte antes disso atenderia com a
  // configuracao de fabrica, ignorando o que a equipe publicou na curadoria.
  await curadoria.carregar();

  // Vinculos LID -> telefone. Antes dos canais subirem, senao as primeiras
  // mensagens de um chat por LID entram sem numero e a ficha do contato nasce
  // sem o dado que a identifica.
  await lidResolver.carregar();

  // Status e etapas configurados pela equipe. Antes das rotas atenderem: sem
  // eles, a lista de clientes sairia com status sem rotulo e o kanban sem
  // colunas.
  await clientePipeline.carregar();

  // O telefone deixou de ser obrigatorio; o indice antigo precisa acompanhar,
  // senao a segunda ficha sem numero falha no meio de uma importacao.
  await clienteService.garantirIndices();

  // Quais canais tem credenciais. Precisa vir antes do autoStart: e por este
  // conjunto que ele decide reconectar em vez de pedir QR.
  await authStore.carregar();

  if (env.wa.autoStart) {
    await manager.autoStart();
  } else {
    manager.listPublicStates();
  }

  const totalUsuarios = await authService.countUsers();
  if (totalUsuarios === 0) {
    logger.warn(
      'Nenhum usuario cadastrado: ninguem consegue entrar no painel. ' +
        'Crie o primeiro com  npm run create:user -- email@escritorio.com "senha-forte"'
    );
  }

  logger.info(
    {
      port: env.port,
      usuarios: totalUsuarios,
      tiers: listTiers().map((t) => `${t.key}=${t.model}`),
    },
    'whatsAgent no ar'
  );

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Encerrando');
    try {
      await manager.shutdown();
      await fastify.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((error) => {
  logger.error({ err: error.message, stack: error.stack }, 'Falha ao iniciar');
  process.exit(1);
});
