const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste-longo-o-suficiente';

const Fastify = require('fastify');
const authService = require('../src/auth/auth.service');
const { registerAuthHook, PUBLIC_PATHS } = require('../src/auth/auth.hook');
const channelsRoutes = require('../src/routes/channels.routes');

// ------------------------------------------------------------------ senha

test('hash nunca guarda a senha em claro', async () => {
  const hash = await authService.hashPassword('minha-senha-secreta');
  assert.doesNotMatch(hash, /minha-senha-secreta/);
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
});

test('o mesmo texto gera hashes diferentes (salt por usuario)', async () => {
  const a = await authService.hashPassword('senha-igual-123');
  const b = await authService.hashPassword('senha-igual-123');
  assert.notEqual(a, b, 'sem salt unico, dois usuarios com a mesma senha teriam o mesmo hash');
});

test('verifica a senha certa e rejeita a errada', async () => {
  const hash = await authService.hashPassword('senha-correta-123');
  assert.equal(await authService.verifyPassword('senha-correta-123', hash), true);
  assert.equal(await authService.verifyPassword('senha-errada-123', hash), false);
  assert.equal(await authService.verifyPassword('', hash), false);
});

test('senha curta e recusada na origem', async () => {
  await assert.rejects(() => authService.hashPassword('curta'), /ao menos 8/);
});

test('hash corrompido nao derruba a verificacao', async () => {
  assert.equal(await authService.verifyPassword('qualquer', 'lixo'), false);
  assert.equal(await authService.verifyPassword('qualquer', ''), false);
  assert.equal(await authService.verifyPassword('qualquer', 'scrypt$x$y$z'), false);
});

// ------------------------------------------------------------------ token

test('token carrega o usuario e volta ao ser verificado', () => {
  const user = { _id: { toString: () => 'abc123' }, email: 'a@b.com', role: 'admin' };
  const payload = authService.verifyToken(authService.signToken(user));

  assert.equal(payload.sub, 'abc123');
  assert.equal(payload.email, 'a@b.com');
  assert.equal(payload.role, 'admin');
  assert.equal(payload.iss, 'whatsagent');
});

test('token adulterado, vazio ou lixo e recusado', () => {
  const user = { _id: { toString: () => 'abc' }, email: 'a@b.com', role: 'operador' };
  const valido = authService.signToken(user);

  assert.equal(authService.verifyToken(`${valido}x`), null);
  assert.equal(authService.verifyToken('nao.e.um.jwt'), null);
  assert.equal(authService.verifyToken(''), null);
  assert.equal(authService.verifyToken(null), null);
});

test('token assinado com outro segredo e recusado', () => {
  const jwt = require('jsonwebtoken');
  const forjado = jwt.sign({ sub: 'invasor', role: 'admin' }, 'outro-segredo', {
    issuer: 'whatsagent',
  });
  assert.equal(authService.verifyToken(forjado), null);
});

test('extractToken aceita header Bearer e handshake do socket', () => {
  assert.equal(
    authService.extractToken({ headers: { authorization: 'Bearer abc.def.ghi' } }),
    'abc.def.ghi'
  );
  assert.equal(authService.extractToken({ handshake: { auth: { token: 'do-socket' } } }), 'do-socket');
  assert.equal(authService.extractToken({ headers: { authorization: 'Basic xyz' } }), null);
  assert.equal(authService.extractToken({}), null);
});

// ------------------------------------------------------------------ rotas

async function buildApp() {
  const app = Fastify();
  registerAuthHook(app);
  await app.register(channelsRoutes);
  return app;
}

const bearer = () => {
  const user = { _id: { toString: () => 'u1' }, email: 'painel@teste.com', role: 'admin' };
  return `Bearer ${authService.signToken(user)}`;
};

test('rotas do painel exigem token', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  for (const url of ['/api/channels', '/api/agents', '/api/config', '/api/agent/tiers']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 401, `${url} deveria exigir autenticacao`);
  }
});

test('acoes destrutivas tambem exigem token', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  for (const url of ['/api/channels/leads-1/connect', '/api/channels/leads-1/logout']) {
    const res = await app.inject({ method: 'POST', url });
    assert.equal(res.statusCode, 401, `${url} nao pode ser publica`);
  }
});

test('lista de rotas publicas e minima e nao expoe o painel', () => {
  for (const path of PUBLIC_PATHS) {
    assert.ok(
      path === '/health' || path.startsWith('/api/auth/'),
      `rota publica inesperada: ${path}`
    );
  }
  assert.ok(!PUBLIC_PATHS.has('/api/channels'));
  assert.ok(!PUBLIC_PATHS.has('/api/config'));
});

test('token com sub forjado e recusado com 401, nao com 500', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  // Assinatura legitima, mas `sub` que nao e um ObjectId: o Mongoose lanca
  // CastError. Isso e problema de credencial, e precisa sair como 401 limpo -
  // um 500 aqui vazaria stack e confundiria o diagnostico.
  const res = await app.inject({
    method: 'GET',
    url: '/api/config',
    headers: { authorization: bearer() },
  });

  assert.equal(res.statusCode, 401, 'sub invalido deve virar 401, nunca 500');
  assert.equal(res.json().error, 'Sessao invalida');
});

// ---------------------------------------------------- manter conectado

test('"manter conectado" gera token de duracao maior', () => {
  const user = { _id: { toString: () => 'u1' }, email: 'a@b.com', role: 'admin' };

  const curto = authService.verifyToken(authService.signToken(user, false));
  const longo = authService.verifyToken(authService.signToken(user, true));

  const duracaoCurta = curto.exp - curto.iat;
  const duracaoLonga = longo.exp - longo.iat;

  assert.equal(duracaoCurta, 12 * 60 * 60, 'sessao normal: 12h');
  assert.ok(duracaoLonga > duracaoCurta * 10, 'manter conectado precisa durar bem mais');
  assert.equal(longo.rem, true, 'o token registra a escolha');
});

test('sessao normal nao carrega a marca de "manter conectado"', () => {
  const user = { _id: { toString: () => 'u1' }, email: 'a@b.com', role: 'operador' };
  const payload = authService.verifyToken(authService.signToken(user));
  assert.equal(payload.rem, undefined);
});

test('token expirado e recusado', () => {
  const jwt = require('jsonwebtoken');
  const { env } = require('../src/config/env');
  const expirado = jwt.sign({ sub: 'u1' }, env.auth.jwtSecret, {
    issuer: 'whatsagent',
    expiresIn: -10,
  });
  assert.equal(authService.verifyToken(expirado), null);
});
