const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste';

const pipeline = require('../src/clientes/pipeline.service');
const consulta = require('../src/clientes/consulta.service');
const contexto = require('../src/clientes/contexto.service');
const clienteService = require('../src/clientes/cliente.service');

// ------------------------------------------------------------------ pipeline

test('o pipeline de fabrica traz o fluxo do escritorio ja desenhado', () => {
  // Planilha nenhuma comeca em branco; a tela tambem nao pode.
  const padrao = pipeline.padrao();

  assert.ok(padrao.status.length >= 8, 'os status do enunciado');
  assert.equal(padrao.status[0].id, 'novo', 'quem chega entra em "Novo"');
  assert.ok(padrao.status.some((s) => s.conclusivo), 'existe pelo menos um status final');
  assert.equal(padrao.colunas.length, 5, 'cinco colunas de kanban');
});

test('o kanban agrupa status, e nao repete um por coluna', () => {
  // Oito colunas nao cabem na tela. A distincao fina continua na ficha.
  const padrao = pipeline.padrao();
  const aguardando = padrao.colunas.find((c) => c.id === 'aguardando');

  assert.ok(aguardando.status.length > 1, 'a coluna de espera agrupa mais de um status');
  assert.ok(aguardando.status.includes('aguardando_cliente'));
  assert.ok(aguardando.status.includes('aguardando_documentos'));
});

test('todo status aparece em alguma coluna do quadro', () => {
  // Status fora de coluna vira cartao invisivel: a pior falha de um kanban,
  // porque o cliente some sem ninguem perceber.
  const padrao = pipeline.padrao();
  const nasColunas = new Set(padrao.colunas.flatMap((c) => c.status));

  for (const status of padrao.status) {
    assert.ok(nasColunas.has(status.id), `status "${status.id}" nao esta em coluna nenhuma`);
  }
});

test('cada coluna sabe qual status aplicar quando recebe um cartao', () => {
  for (const coluna of pipeline.padrao().colunas) {
    assert.ok(coluna.statusAoSoltar, `coluna "${coluna.id}" sem status de destino`);
    assert.ok(
      coluna.status.includes(coluna.statusAoSoltar),
      'o status de destino precisa pertencer a propria coluna'
    );
  }
});

test('status desconhecido nao derruba a tela: cai na primeira coluna', () => {
  const coluna = pipeline.colunaDoStatus('status_que_nao_existe');
  assert.ok(coluna, 'sempre ha uma coluna de destino');
});

test('o rotulo de um status orfao volta como o proprio id, nunca vazio', () => {
  assert.equal(pipeline.rotuloStatus('novo'), 'Novo');
  assert.equal(pipeline.rotuloStatus('id_orfao'), 'id_orfao');
  assert.equal(pipeline.rotuloStatus(null), null);
});

// ------------------------------------------------ "como esta meu processo?"

test('reconhece as formas comuns de perguntar pelo andamento', () => {
  const perguntas = [
    'Como está meu processo?',
    'como ta o meu caso',
    'Tem alguma novidade?',
    'alguma novidade?',
    'Qual o status do meu processo',
    'em que pé está',
    'voces ja analisaram?',
    'Teve alguma atualização?',
  ];

  for (const pergunta of perguntas) {
    assert.equal(consulta.perguntaSobreAndamento(pergunta), true, `nao reconheceu: "${pergunta}"`);
  }
});

test('acento no fim da palavra nao quebra a deteccao', () => {
  // `\b` em JavaScript e ASCII: entre "á" e um espaco nao ha borda, entao
  // /está\b/ nunca casaria com "está meu processo" — que e justamente a frase
  // mais comum. Em portugues isso deixaria a funcao quase inutil.
  assert.equal(consulta.perguntaSobreAndamento('Como está meu processo?'), true);
  assert.equal(consulta.perguntaSobreAndamento('em que pé está'), true);
  assert.equal(consulta.perguntaSobreAndamento('teve alguma atualização'), true);

  // E a versao sem acento, que e como muita gente digita no celular.
  assert.equal(consulta.perguntaSobreAndamento('como esta meu processo'), true);
  assert.equal(consulta.perguntaSobreAndamento('em que pe esta'), true);
});

test('conversa comum nao dispara a consulta de status', () => {
  // Falso positivo aqui custa uma ida ao banco em toda mensagem e, pior,
  // enche o prompt com um bloco de situacao que ninguem pediu.
  const comuns = [
    'Bom dia',
    'Fui demitido e nao recebi nada',
    'Quanto voces cobram?',
    'Vou mandar os documentos amanha',
    'obrigado!',
    'meu nome e Joao',
    '',
  ];

  for (const texto of comuns) {
    assert.equal(consulta.perguntaSobreAndamento(texto), false, `falso positivo: "${texto}"`);
  }
});

// ------------------------------------------------------ material suficiente

test('ficha vazia nao autoriza o agente a falar de andamento', () => {
  // A regra do enunciado: nunca inventar um status. Sem material, o bloco de
  // situacao vira uma instrucao para dizer que nao sabe.
  assert.equal(contexto.temMaterial({ temStatus: false, temEtapa: false, eventos: 0, mensagens: 0 }), false);
  assert.equal(contexto.temMaterial({ temStatus: true, temEtapa: false, eventos: 1, mensagens: 0 }), false);
  assert.equal(contexto.temMaterial(null), false);
});

test('ficha com status e historico autoriza responder', () => {
  assert.equal(contexto.temMaterial({ temStatus: true, temEtapa: true, eventos: 3, mensagens: 5 }), true);
});

test('a assinatura muda quando o caso muda, e so quando ele muda', () => {
  // E o que impede a IA de rodar a cada abertura da ficha.
  const base = {
    status: 'em_analise',
    etapa: 'analise',
    aguardando: 'comprovante de residencia',
    proximaAcao: 'cobrar documento',
    proximaAcaoEm: null,
    pendencias: [{ resolvida: false }],
  };
  const evento = { _id: 'abc123' };

  const original = contexto.assinatura(base, evento);

  assert.equal(contexto.assinatura({ ...base }, evento), original, 'nada mudou, assinatura igual');
  assert.notEqual(
    contexto.assinatura({ ...base, status: 'concluido' }, evento),
    original,
    'mudar o status envelhece o resumo'
  );
  assert.notEqual(
    contexto.assinatura(base, { _id: 'novo_evento' }),
    original,
    'um evento relevante novo envelhece o resumo'
  );
});

// -------------------------------------------------- fronteira interno x cliente

test('a timeline publica exclui os tipos que carregam texto interno', () => {
  // Um vazamento real, encontrado em teste: o dossie externo ja excluia o
  // campo `observacoesInternas`, mas o mesmo texto voltava pela linha do tempo,
  // como descricao de um evento de observacao. Dali chegaria a uma mensagem
  // enviada ao proprio cliente.
  const publicos = require('../src/clientes/timeline.service').TIPOS_PUBLICOS;

  for (const tipo of ['observacao', 'tarefa', 'campo', 'responsavel', 'resumo']) {
    assert.equal(publicos.has(tipo), false, `"${tipo}" nao pode ser lido por quem escreve ao cliente`);
  }

  // O que sobra ainda precisa contar a historia do caso.
  for (const tipo of ['status', 'etapa', 'entrada', 'pendencia']) {
    assert.equal(publicos.has(tipo), true, `"${tipo}" precisa estar no resumo do cliente`);
  }
});

// ------------------------------------------------------------------ filtros

test('o filtro padrao esconde arquivados', () => {
  assert.equal(clienteService.montarFiltro({}).arquivado, false);
  assert.equal(clienteService.montarFiltro({ arquivados: 'true' }).arquivado, true);
});

test('"parado ha N dias" alcanca tambem quem nunca teve contato', () => {
  // Sao justamente os mais esquecidos; deixa-los de fora esvaziaria o
  // indicador mais util do painel.
  const filtro = clienteService.montarFiltro({ paradoHaDias: '7' });
  const semContato = filtro.$or.find((c) => c.ultimoContatoEm === null);

  assert.ok(semContato, 'quem nunca teve contato precisa aparecer');
  assert.ok(filtro.$or.some((c) => c.ultimoContatoEm?.$lt instanceof Date));
});

test('busca por texto e por telefone convivem com os outros filtros', () => {
  // A busca usa $and porque o $or ja pode estar ocupado pelo filtro de parado.
  const filtro = clienteService.montarFiltro({ q: '19 99638-3884', paradoHaDias: '3' });

  assert.ok(filtro.$or, 'o filtro de parado continua de pe');
  assert.ok(filtro.$and?.length, 'a busca entrou sem sobrescrever');

  const porTelefone = filtro.$and[0].$or.find((c) => c.telefone);
  assert.ok(porTelefone, 'busca por telefone');
  assert.equal(porTelefone.telefone.$regex, '5519996383884'.slice(2), 'mascara ignorada');
});

test('busca curta nao vira busca por telefone', () => {
  // "ana" tem digitos zero; "19" tem dois. Buscar telefone por dois digitos
  // devolveria a carteira inteira.
  const filtro = clienteService.montarFiltro({ q: '19' });
  assert.ok(!filtro.$and[0].$or.some((c) => c.telefone));
});

test('filtros de lista aceitam varios valores', () => {
  const filtro = clienteService.montarFiltro({ status: 'novo,pendencia', prioridade: 'alta,urgente' });
  assert.deepEqual(filtro.status.$in, ['novo', 'pendencia']);
  assert.deepEqual(filtro.prioridade.$in, ['alta', 'urgente']);
});

test('"acao vencida" ignora quem nao tem data marcada', () => {
  const filtro = clienteService.montarFiltro({ acaoVencida: 'true' });
  assert.equal(filtro.proximaAcaoEm.$ne, null, 'sem data nao e vencido, e indefinido');
  assert.ok(filtro.proximaAcaoEm.$lt instanceof Date);
});

// --------------------------------------------------------------- projecao

test('a lista entrega tudo resolvido: rotulo, coluna, vencimento e dias parado', () => {
  // A tela nao pode ter de traduzir id de status nem recalcular "vencido" —
  // cada componente faria com um fuso diferente.
  const ontem = new Date(Date.now() - 86400000);
  const dezDiasAtras = new Date(Date.now() - 10 * 86400000);

  const resumo = clienteService.resumo({
    _id: { toString: () => 'c1' },
    nome: 'Maria Souza',
    telefone: '5519996383884',
    status: 'aguardando_cliente',
    prioridade: 'alta',
    proximaAcaoEm: ontem,
    ultimoContatoEm: dezDiasAtras,
    pendencias: [
      { _id: { toString: () => 'p1' }, texto: 'Comprovante', resolvida: false, criadaEm: ontem },
      { _id: { toString: () => 'p2' }, texto: 'Resolvida', resolvida: true },
    ],
  });

  assert.equal(resumo.statusLabel, 'Aguardando cliente');
  assert.equal(resumo.coluna, 'aguardando');
  assert.equal(resumo.telefoneFormatado, '+55 (19) 99638-3884');
  assert.equal(resumo.proximaAcaoVencida, true);
  assert.equal(resumo.diasSemContato, 10);
  assert.equal(resumo.totalPendencias, 1, 'so as pendencias em aberto contam');
});

test('cliente sem contato registrado nao vira "0 dias parado"', () => {
  // Zero diria "falamos hoje", que e o oposto da verdade.
  const resumo = clienteService.resumo({
    _id: { toString: () => 'c2' },
    telefone: '5519996383884',
    status: 'novo',
    ultimoContatoEm: null,
    pendencias: [],
  });

  assert.equal(resumo.diasSemContato, null);
  assert.equal(resumo.proximaAcaoVencida, false);
});

test('a projecao da lista nunca carrega observacoes internas', () => {
  // A lista e a tela mais exposta do painel; nota interna nao tem o que fazer
  // trafegando nela.
  const resumo = clienteService.resumo({
    _id: { toString: () => 'c3' },
    telefone: '5519996383884',
    status: 'novo',
    pendencias: [],
    observacoesInternas: 'cliente complicado, cobrar antes',
  });

  assert.equal(resumo.observacoesInternas, undefined);
  assert.ok(!JSON.stringify(resumo).includes('complicado'));
});

// ------------------------------------------------------ contrato das rotas

const Fastify = require('fastify');
const clientesRoutes = require('../src/clientes/clientes.routes');

async function appComo(papel) {
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.user = { id: 'u1', email: 'quem@escritorio.com', role: papel };
  });
  await app.register(clientesRoutes);
  return app;
}

test('GET /pipeline entrega o desenho da operacao sem exigir banco', async (t) => {
  const app = await appComo('curador');
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/clientes/pipeline' });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.ok(body.status.length >= 8);
  assert.ok(body.colunas.length >= 3);
  assert.equal(body.podeConfigurar, false, 'so administrador configura o pipeline');
});

test('visualizador nao edita ficha, nao move cartao e nao usa a IA', async (t) => {
  const app = await appComo('visualizador');
  t.after(() => app.close());

  const proibidas = [
    { method: 'POST', url: '/api/clientes' },
    { method: 'PATCH', url: '/api/clientes/507f1f77bcf86cd799439011' },
    { method: 'POST', url: '/api/clientes/507f1f77bcf86cd799439011/mover' },
    { method: 'POST', url: '/api/clientes/507f1f77bcf86cd799439011/observacao' },
    { method: 'POST', url: '/api/clientes/507f1f77bcf86cd799439011/tarefas' },
    { method: 'POST', url: '/api/clientes/507f1f77bcf86cd799439011/resumo' },
    { method: 'POST', url: '/api/clientes/507f1f77bcf86cd799439011/assistente' },
    { method: 'DELETE', url: '/api/clientes/507f1f77bcf86cd799439011' },
    { method: 'PUT', url: '/api/clientes/pipeline' },
  ];

  for (const rota of proibidas) {
    const res = await app.inject({ ...rota, payload: {} });
    assert.equal(res.statusCode, 403, `${rota.method} ${rota.url} deveria recusar`);
  }
});

test('curador edita e usa a IA, mas nao exclui ficha nem configura o pipeline', async (t) => {
  const app = await appComo('curador');
  t.after(() => app.close());

  // Excluir apaga a ficha, a timeline e as tarefas: e a unica acao daqui que
  // perde informacao de verdade.
  const excluir = await app.inject({
    method: 'DELETE',
    url: '/api/clientes/507f1f77bcf86cd799439011',
  });
  assert.equal(excluir.statusCode, 403);

  const pipelineRes = await app.inject({
    method: 'PUT',
    url: '/api/clientes/pipeline',
    payload: {},
  });
  assert.equal(pipelineRes.statusCode, 403);
});

test('administrador ve que pode configurar o pipeline', async (t) => {
  const app = await appComo('admin');
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/clientes/pipeline' });
  assert.equal(res.json().podeConfigurar, true);
});
