const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste';

const schema = require('../src/curadoria/config.schema');
const { validar } = require('../src/curadoria/validator');
const { comparar, resumir } = require('../src/curadoria/diff');
const { buildInstructions, REGRAS_INVIOLAVEIS } = require('../src/agent/prompt.builder');
const roles = require('../src/auth/roles');
const ConversationBuffer = require('../src/conversation/buffer.service').constructor;
const buffer = require('../src/conversation/buffer.service');

const padrao = () => schema.padraoDoAgente('lead_capture');

// ------------------------------------------------------------------ padroes

test('a configuracao de fabrica passa na validacao sem erro nem aviso', () => {
  // Se o padrao ja nascesse com pendencia, a primeira coisa que a equipe veria
  // ao abrir a curadoria seria uma tela de problemas que ela nao causou.
  for (const agentId of schema.agentesCuraveis()) {
    const resultado = validar(schema.padraoDoAgente(agentId));
    assert.equal(resultado.ok, true, `${agentId} deveria estar valido`);
    assert.deepEqual(resultado.erros, []);
    assert.deepEqual(
      resultado.avisos.map((a) => a.titulo),
      [],
      `${agentId} nao deveria ter avisos de fabrica`
    );
  }
});

test('o tempo de espera de fabrica e de 8 segundos', () => {
  assert.equal(padrao().tempoDeEspera.segundos, 8);
});

// -------------------------------------------------------------- sanitizacao

test('sanitizar coage tipos e nunca grava a forma que veio do navegador', () => {
  const sujo = {
    promptPrincipal: 123,
    tomDeVoz: { preset: 'inexistente', descricao: '  espacos  ' },
    regras: 'nao sou lista',
    tempoDeEspera: { segundos: '12' },
    empresa: { descricao: 'ok', faq: [{ pergunta: 'P', resposta: 'R' }, { pergunta: '', resposta: '' }] },
    campoIntruso: 'deveria sumir',
  };

  const limpa = schema.sanitizar(sujo, 'lead_capture');

  assert.equal(limpa.promptPrincipal, '123');
  assert.equal(limpa.tomDeVoz.preset, padrao().tomDeVoz.preset, 'tom invalido cai no padrao');
  assert.equal(limpa.tomDeVoz.descricao, 'espacos');
  assert.ok(Array.isArray(limpa.regras), 'regras sempre viram lista');
  assert.equal(limpa.tempoDeEspera.segundos, 12, 'numero em texto vira numero');
  assert.equal(limpa.empresa.faq.length, 1, 'pergunta frequente vazia e descartada');
  assert.equal(limpa.campoIntruso, undefined, 'campo desconhecido nao atravessa');
});

test('sanitizar aplica os tetos de tamanho', () => {
  const gigante = 'x'.repeat(schema.LIMITES.empresaCampo + 5000);
  const limpa = schema.sanitizar({ empresa: { descricao: gigante } }, 'lead_capture');
  assert.equal(limpa.empresa.descricao.length, schema.LIMITES.empresaCampo);
});

test('as instrucoes principais nao tem teto', () => {
  // O escritorio precisa poder escrever o quanto o trabalho exigir. Cortar em
  // silencio seria pior que recusar: a pessoa publica achando que o agente
  // recebeu tudo, e o final das instrucoes simplesmente nunca existiu.
  const enorme = 'a instrucao continua. '.repeat(3000);
  const limpa = schema.sanitizar({ promptPrincipal: enorme }, 'lead_capture');
  assert.equal(limpa.promptPrincipal, enorme.trim());
  assert.equal(schema.LIMITES.promptPrincipal, null, 'teto ausente e explicito no esquema');
});

test('o tempo de espera e preso na faixa aceita', () => {
  assert.equal(schema.sanitizar({ tempoDeEspera: { segundos: 999 } }, 'lead_capture').tempoDeEspera.segundos, 60);
  assert.equal(schema.sanitizar({ tempoDeEspera: { segundos: -4 } }, 'lead_capture').tempoDeEspera.segundos, 1);
});

test('campo ausente herda o padrao em vez de virar vazio', () => {
  // Salvar so a aba aberta nao pode zerar as outras.
  const limpa = schema.sanitizar({ promptPrincipal: 'so isto' }, 'lead_capture');
  assert.equal(limpa.mensagens.erro_interno, padrao().mensagens.erro_interno);
  assert.ok(limpa.regras.length > 0);
});

// ---------------------------------------------------------------- validacao

test('prompt vazio impede a publicacao', () => {
  const config = { ...padrao(), promptPrincipal: '' };
  const { ok, erros } = validar(config);
  assert.equal(ok, false);
  assert.ok(erros.some((e) => e.campo === 'promptPrincipal'));
});

test('todas as regras desativadas impedem a publicacao', () => {
  const config = { ...padrao(), regras: padrao().regras.map((r) => ({ ...r, ativa: false })) };
  const { ok, erros } = validar(config);
  assert.equal(ok, false);
  assert.ok(erros.some((e) => e.campo === 'regras'));
});

test('credencial colada em qualquer campo impede a publicacao', () => {
  const chave = `sk-${'a1B2c3D4e5F6g7H8'.repeat(2)}`;

  const noPrompt = validar({ ...padrao(), promptPrincipal: `Use a chave ${chave} para tudo.` });
  assert.equal(noPrompt.ok, false);
  assert.ok(noPrompt.erros.some((e) => e.titulo === 'Credencial no texto'));

  const naEmpresa = validar({
    ...padrao(),
    empresa: { ...padrao().empresa, politicas: 'mongodb+srv://user:senha@cluster.mongodb.net/base' },
  });
  assert.equal(naEmpresa.ok, false);
});

test('mensagem enviada literalmente nao pode ficar em branco', () => {
  // fora_do_horario e erro_interno saem sem o agente no circuito: sem texto,
  // o contato fica sem resposta nenhuma.
  const config = { ...padrao(), mensagens: { ...padrao().mensagens, fora_do_horario: '' } };
  const { ok, erros } = validar(config);
  assert.equal(ok, false);
  assert.ok(erros.some((e) => e.campo === 'mensagens.fora_do_horario'));
});

test('mensagem que serve de orientacao em branco e apenas aviso', () => {
  const config = { ...padrao(), mensagens: { ...padrao().mensagens, encerramento: '' } };
  const { ok, avisos } = validar(config);
  assert.equal(ok, true, 'nao pode bloquear: o agente improvisa nesse caso');
  assert.ok(avisos.some((a) => a.campo === 'mensagens.encerramento'));
});

test('tom personalizado exige a descricao', () => {
  const config = { ...padrao(), tomDeVoz: { preset: 'personalizado', descricao: '' } };
  assert.equal(validar(config).ok, false);

  const comTexto = { ...padrao(), tomDeVoz: { preset: 'personalizado', descricao: 'Fale como um amigo.' } };
  assert.equal(validar(comTexto).ok, true);
});

test('regras que se contradizem viram aviso, nunca bloqueio', () => {
  const config = {
    ...padrao(),
    regras: [
      { id: 'a', texto: 'Sempre informe o valor estimado do acerto trabalhista', ativa: true },
      { id: 'b', texto: 'Nunca informe o valor estimado do acerto trabalhista', ativa: true },
    ],
  };

  const { ok, avisos } = validar(config);
  assert.equal(ok, true, 'heuristica nao pode travar quem conhece o escritorio');
  assert.ok(avisos.some((a) => a.titulo === 'Regras podem se contradizer'));
});

test('regra essencial ausente vira aviso com explicacao', () => {
  const config = { ...padrao(), promptPrincipal: 'Atenda bem.', regras: [{ id: 'x', texto: 'Seja gentil', ativa: true }] };
  const { avisos } = validar(config);
  assert.ok(avisos.some((a) => a.titulo.includes('Nunca inventar informacao')));
  assert.ok(avisos.every((a) => a.comoCorrigir), 'todo aviso diz como corrigir');
});

test('prompt encolhendo demais avisa sobre apagao acidental', () => {
  const publicada = { ...padrao(), promptPrincipal: 'a'.repeat(1200) };
  const rascunho = { ...padrao(), promptPrincipal: 'Atenda em portugues sem inventar nada, robo nenhum, fora do escopo nao.' };

  const { avisos } = validar(rascunho, publicada);
  assert.ok(avisos.some((a) => a.titulo === 'As instrucoes encolheram muito'));
});

test('todo erro traz titulo, explicacao e como corrigir', () => {
  // A tela mostra os tres campos. Um erro sem "comoCorrigir" deixa a pessoa
  // travada sabendo que errou, sem saber o que fazer.
  const { erros } = validar({ ...padrao(), promptPrincipal: '', tempoDeEspera: { segundos: 900 } });
  assert.ok(erros.length >= 2);
  for (const e of erros) {
    assert.ok(e.titulo && e.mensagem && e.comoCorrigir, `erro incompleto: ${JSON.stringify(e)}`);
  }
});

// --------------------------------------------------------------- comparacao

test('editar o texto de uma regra e UMA alteracao, nao remocao mais adicao', () => {
  const antes = padrao();
  const depois = {
    ...antes,
    regras: antes.regras.map((r, i) => (i === 0 ? { ...r, texto: `${r.texto} Sempre.` } : r)),
  };

  const alteracoes = comparar(antes, depois);
  assert.equal(alteracoes.length, 1);
  assert.equal(alteracoes[0].tipo, 'alterado');
  assert.equal(alteracoes[0].rotulo, 'Regra editada');
});

test('desativar uma regra aparece como alteracao propria', () => {
  const antes = padrao();
  const depois = { ...antes, regras: antes.regras.map((r, i) => (i === 0 ? { ...r, ativa: false } : r)) };

  const alteracoes = comparar(antes, depois);
  assert.equal(alteracoes.length, 1);
  assert.equal(alteracoes[0].rotulo, 'Regra desativada');
});

test('a comparacao usa rotulos em portugues, nunca o caminho tecnico', () => {
  const antes = padrao();
  const depois = { ...antes, tomDeVoz: { preset: 'objetivo', descricao: antes.tomDeVoz.descricao } };

  const [alteracao] = comparar(antes, depois);
  assert.equal(alteracao.rotulo, 'Tom de voz');
  assert.equal(alteracao.depois, 'Objetivo');

  // O lado "antes" e o rotulo do tom padrao, seja qual for — travar o nome
  // aqui faria este teste quebrar toda vez que o escritorio recalibrasse o
  // padrao, sem que nada da comparacao tivesse mudado.
  assert.equal(alteracao.antes, schema.TONS[antes.tomDeVoz.preset].label);
  assert.notEqual(alteracao.antes, alteracao.depois);
});

test('valores tecnicos viram texto legivel na comparacao', () => {
  const antes = padrao();
  const depois = { ...antes, audio: { ...antes.audio, habilitado: !antes.audio.habilitado } };

  const [alteracao] = comparar(antes, depois);
  assert.ok(['ligado', 'desligado'].includes(alteracao.antes));
  assert.ok(['ligado', 'desligado'].includes(alteracao.depois));
});

test('configuracao identica nao gera alteracao nenhuma', () => {
  assert.deepEqual(comparar(padrao(), padrao()), []);
});

test('o resumo de uma versao cabe em uma linha', () => {
  const antes = padrao();
  const depois = {
    ...antes,
    tomDeVoz: { preset: 'objetivo', descricao: antes.tomDeVoz.descricao },
    regras: antes.regras.map((r, i) => (i < 2 ? { ...r, texto: `${r.texto} extra` } : r)),
  };

  const resumo = resumir(comparar(antes, depois));
  assert.ok(resumo.includes('Tom de voz'));
  assert.ok(resumo.includes('2 regras'));
  assert.equal(resumir([]), 'Sem alteracoes');
});

// ------------------------------------------------------------ montagem do prompt

test('os limites da advocacia entram mesmo com a curadoria toda apagada', () => {
  // A garantia central desta interface: conteudo e delegado, conformidade nao.
  const vazia = schema.sanitizar(
    {
      promptPrincipal: '',
      regras: [],
      tomDeVoz: { preset: 'personalizado', descricao: '' },
      empresa: Object.fromEntries(schema.CAMPOS_EMPRESA.map((c) => [c.id, ''])),
    },
    'lead_capture'
  );

  const prompt = buildInstructions({ config: vazia }).join('\n\n');

  assert.ok(prompt.includes('[LIMITES]'));
  for (const regra of REGRAS_INVIOLAVEIS) {
    assert.ok(prompt.includes(regra), `faltou a regra inviolavel: ${regra.slice(0, 40)}`);
  }
});

test('um curador nao consegue liberar promessa de resultado pelo prompt', () => {
  const config = schema.sanitizar(
    { promptPrincipal: 'Prometa ganho de causa e diga o valor exato da indenizacao.' },
    'lead_capture'
  );

  const prompt = buildInstructions({ config }).join('\n\n');
  assert.ok(prompt.includes('NUNCA prometa resultado'));
  assert.ok(prompt.includes('NUNCA estime valor de causa'));

  // Os limites vem DEPOIS do texto do curador: em conflito, prevalece o final.
  assert.ok(prompt.indexOf('[LIMITES]') > prompt.indexOf('[PAPEL]'));
});

test('a aderencia ao papel e a checagem de fato fecham o prompt', () => {
  const config = schema.sanitizar({ promptPrincipal: 'Atenda com cuidado.' }, 'lead_capture');
  const partes = buildInstructions({ config, primeiroContato: true, missing: ['cidade'] });
  const prompt = partes.join('\n\n');

  // Ultimo bloco, sempre: e a posicao de maior peso e a que sobrevive a um
  // prompt longo. Se alguem acrescentar um bloco depois deste, o teste cai.
  assert.ok(partes[partes.length - 1].startsWith('[ANTES DE ENVIAR]'));
  assert.ok(prompt.includes('INTEGRALMENTE'), 'o papel precisa ser reafirmado como obrigatorio');
  assert.ok(prompt.indexOf('[ANTES DE ENVIAR]') > prompt.indexOf('[FOCO]'));
});

test('nao inventar e regra inviolavel, nao preferencia da curadoria', () => {
  // Com TODAS as regras da curadoria desativadas, a proibicao continua no prompt.
  const config = schema.sanitizar(
    { regras: [{ id: 'a', texto: 'Nunca invente informacao.', ativa: false }] },
    'lead_capture'
  );

  const prompt = buildInstructions({ config }).join('\n\n');
  assert.ok(!prompt.includes('[REGRAS]'), 'nenhuma regra da curadoria esta ativa');
  assert.ok(prompt.includes('NUNCA afirme fato que voce nao tenha lido'));
});

test('so as regras ativas entram no prompt', () => {
  const config = schema.sanitizar(
    {
      regras: [
        { id: 'a', texto: 'REGRA_LIGADA', ativa: true },
        { id: 'b', texto: 'REGRA_DESLIGADA', ativa: false },
      ],
    },
    'lead_capture'
  );

  const prompt = buildInstructions({ config }).join('\n\n');
  assert.ok(prompt.includes('REGRA_LIGADA'));
  assert.ok(!prompt.includes('REGRA_DESLIGADA'));
});

test('campo de empresa vazio nao vira cabecalho solto', () => {
  // Cabecalho sem conteudo faz o modelo inventar o que "deveria" estar ali.
  const config = schema.sanitizar(
    { empresa: { ...padrao().empresa, politicas: '', produtos: '' } },
    'lead_capture'
  );

  const prompt = buildInstructions({ config }).join('\n\n');
  assert.ok(!prompt.includes('POLITICAS:'));
  assert.ok(!prompt.includes('PRODUTOS:'));
  assert.ok(prompt.includes('SERVICOS:'), 'o que foi preenchido continua entrando');
});

test('a orientacao de midia so entra quando aquela midia chegou', () => {
  const config = padrao();

  const soTexto = buildInstructions({ config, tipos: ['text'] }).join('\n\n');
  assert.ok(!soTexto.includes('[AUDIO]'));
  assert.ok(!soTexto.includes('[IMAGEM]'));

  const comAudio = buildInstructions({ config, tipos: ['audio'] }).join('\n\n');
  assert.ok(comAudio.includes('[AUDIO]'));
  assert.ok(comAudio.includes('Responda SEMPRE em texto'));
});

test('midia desligada na curadoria nao gera orientacao de midia', () => {
  const config = schema.sanitizar({ audio: { habilitado: false } }, 'lead_capture');
  const prompt = buildInstructions({ config, tipos: ['audio'] }).join('\n\n');
  assert.ok(!prompt.includes('[AUDIO]'));
});

test('a abertura usa o texto da curadoria e mantem as travas do codigo', () => {
  const config = schema.sanitizar(
    { mensagens: { ...padrao().mensagens, primeira_abordagem: 'ABERTURA_DO_ESCRITORIO' } },
    'lead_capture'
  );

  const primeiro = buildInstructions({ config, primeiroContato: true }).join('\n\n');
  assert.ok(primeiro.includes('ABERTURA_DO_ESCRITORIO'));
  assert.ok(primeiro.includes('NUNCA encadeie nome do escritorio'), 'a trava anti-cartao-de-visita fica');

  const seguinte = buildInstructions({ config, primeiroContato: false }).join('\n\n');
  assert.ok(!seguinte.includes('ABERTURA_DO_ESCRITORIO'));
});

test('o reforco de escalonamento so entra quando o roteador escalou', () => {
  const config = padrao();
  assert.ok(!buildInstructions({ config }).join('\n\n').includes('[ESCALONAMENTO]'));
  assert.ok(buildInstructions({ config, escalonado: true }).join('\n\n').includes('[ESCALONAMENTO]'));
});

// ------------------------------------------------------------------ papeis

test('o papel legado "operador" continua valendo como curador', () => {
  // Renomear papel de usuario em producao tranca todo mundo para fora.
  assert.equal(roles.papelDe({ role: 'operador' }), 'curador');
  assert.equal(roles.podeCurar({ role: 'operador' }), true);
});

test('cada papel tem exatamente as capacidades prometidas', () => {
  const admin = roles.permissoes({ role: 'admin' });
  assert.deepEqual(
    [admin.editar, admin.publicar, admin.restaurar, admin.gerenciarUsuarios],
    [true, true, true, true]
  );

  const curador = roles.permissoes({ role: 'curador' });
  assert.deepEqual(
    [curador.editar, curador.publicar, curador.restaurar, curador.gerenciarUsuarios],
    [true, true, false, false],
    'curador edita e publica, mas nao restaura nem gerencia usuarios'
  );

  const visualizador = roles.permissoes({ role: 'visualizador' });
  assert.deepEqual(
    [visualizador.ver, visualizador.editar, visualizador.publicar],
    [true, false, false]
  );
});

test('papel desconhecido cai no acesso mais restrito', () => {
  assert.equal(roles.papelDe({ role: 'inventado' }), 'visualizador');
  assert.equal(roles.papelDe(undefined), 'visualizador');
  assert.equal(roles.podeCurar({ role: 'inventado' }), false);
});

// ------------------------------------------------------- tempo de espera

test('o tempo de espera de 8s preserva o comportamento atual do buffer', () => {
  // O padrao nao pode mudar nada: quem nunca abrir a curadoria continua com o
  // atendimento que ja tinha.
  const janelas = buffer.janelasPara(8);
  assert.equal(janelas.windowMs, buffer.windowMs, 'frase terminada segue respondida rapido');
  assert.equal(janelas.incompleteWindowMs, buffer.incompleteWindowMs);
  assert.equal(janelas.typingWindowMs, 8000, 'o numero da tela e o teto da espera');
});

test('baixar o tempo de espera encurta todas as janelas', () => {
  const janelas = buffer.janelasPara(1);
  assert.equal(janelas.typingWindowMs, 1000);
  assert.ok(janelas.windowMs <= 1000);
  assert.ok(janelas.incompleteWindowMs <= 1000);
});

test('uma conversa com espera propria nao contamina as outras', () => {
  const b = new ConversationBuffer({ windowMs: 2000, typingWindowMs: 6000, incompleteWindowMs: 3500 });

  b.add({ channelId: 'c1', chatId: 'a', part: { type: 'text', content: 'oi' }, meta: { esperaSegundos: 20 } });
  b.add({ channelId: 'c1', chatId: 'b', part: { type: 'text', content: 'oi' } });

  assert.equal(b.entry('c1', 'a').janelas.typingWindowMs, 20000);
  assert.equal(b.entry('c1', 'b').janelas.typingWindowMs, 6000);

  b.drop('c1', 'a');
  b.drop('c1', 'b');
});

// ------------------------------------------------------ contrato das rotas

const Fastify = require('fastify');
const curadoriaRoutes = require('../src/curadoria/curadoria.routes');

/**
 * App minimo com um usuario ja autenticado. O hook real (auth.hook) exige
 * token e banco; aqui o que se testa e o que vem DEPOIS dele: papel, contrato
 * e o que a resposta nao pode conter.
 */
async function appComo(papel) {
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.user = { id: 'u1', email: 'quem@escritorio.com', role: papel };
  });
  await app.register(curadoriaRoutes);
  return app;
}

test('GET /opcoes entrega o vocabulario da tela e nenhuma configuracao tecnica', async (t) => {
  const app = await appComo('curador');
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/curadoria/opcoes' });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.ok(body.tons.length >= 8, 'todos os tons do enunciado');
  assert.ok(body.tons.some((t2) => t2.id === 'personalizado'));
  assert.equal(body.mensagens.length, 8, 'as oito situacoes recorrentes');
  assert.ok(body.regrasInviolaveis.length > 0, 'a tela precisa mostrar o que nao se pode remover');
  assert.equal(body.permissoes.editar, true);

  // A promessa de seguranca do enunciado, verificada no que sai pela rede.
  const cru = res.body.toLowerCase();
  for (const proibido of ['apikey', 'api_key', 'sk-', 'mongodb', 'jwt', 'secret', 'gpt-', 'process.env']) {
    assert.ok(!cru.includes(proibido), `a resposta nao pode conter "${proibido}"`);
  }
});

test('visualizador nao consegue salvar, publicar nem restaurar', async (t) => {
  const app = await appComo('visualizador');
  t.after(() => app.close());

  const proibidas = [
    { method: 'PUT', url: '/api/curadoria/agentes/lead_capture/rascunho' },
    { method: 'POST', url: '/api/curadoria/agentes/lead_capture/publicar' },
    { method: 'POST', url: '/api/curadoria/agentes/lead_capture/descartar' },
    { method: 'POST', url: '/api/curadoria/agentes/lead_capture/testar' },
    { method: 'POST', url: '/api/curadoria/agentes/lead_capture/versoes/1/restaurar' },
    { method: 'GET', url: '/api/curadoria/usuarios' },
  ];

  for (const rota of proibidas) {
    const res = await app.inject({ ...rota, payload: {} });
    assert.equal(res.statusCode, 403, `${rota.method} ${rota.url} deveria recusar`);
    // A recusa precisa dizer o que fazer, nao so "nao autorizado".
    assert.ok(res.json().error.includes('administrador'));
  }
});

test('curador publica e testa, mas nao restaura nem gerencia usuarios', async (t) => {
  const app = await appComo('curador');
  t.after(() => app.close());

  const restaurar = await app.inject({
    method: 'POST',
    url: '/api/curadoria/agentes/lead_capture/versoes/1/restaurar',
    payload: {},
  });
  assert.equal(restaurar.statusCode, 403);

  const usuarios = await app.inject({ method: 'GET', url: '/api/curadoria/usuarios' });
  assert.equal(usuarios.statusCode, 403);
});

test('agente inexistente responde 404, sem tocar no banco', async (t) => {
  const app = await appComo('admin');
  t.after(() => app.close());

  const res = await app.inject({
    method: 'PUT',
    url: '/api/curadoria/agentes/nao-existe/rascunho',
    payload: { config: {} },
  });
  assert.equal(res.statusCode, 404);
});

test('GET /padrao devolve a configuracao de fabrica pronta para a tela', async (t) => {
  const app = await appComo('curador');
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/curadoria/agentes/lead_capture/padrao' });
  assert.equal(res.statusCode, 200);

  const { config } = res.json();
  assert.ok(config.promptPrincipal.length > 100);
  assert.equal(config.tempoDeEspera.segundos, 8);
  assert.ok(Array.isArray(config.regras) && config.regras.length > 0);
});

// ------------------------------------------------- tom de escritorio

test('o tom de fabrica e formal: nada de contracoes de fala', () => {
  // O atendimento real abriu com "Oi! Como voce ta? Pode contar o que ta
  // rolando no seu trabalho." — soa gente, mas nao soa um escritorio de
  // advocacia, e quem escreve sobre a propria demissao nao espera isso.
  const tom = padrao().tomDeVoz;

  assert.equal(tom.preset, 'profissional', 'o primeiro contato e formal');
  assert.ok(/girias|abreviacoes/i.test(tom.descricao), 'o tom proibe giria explicitamente');
  assert.ok(
    !/contracoes e linguagem falada sao bem-vindas/i.test(tom.descricao),
    'a autorizacao para "ta" e "pra" nao pode voltar'
  );
});

test('o tom manda cumprimentar uma vez so', () => {
  // Esta regra existia no codigo antigo e se perdeu quando o tom virou
  // configuracao. O efeito no atendimento foi "bom dia" a cada resposta.
  const tom = padrao().tomDeVoz.descricao;

  assert.ok(/cumprimente uma unica vez/i.test(tom));
  assert.ok(/bom dia/i.test(tom), 'e diz qual saudacao nao repetir');
});

test('o escritorio nao usa emoji', () => {
  const regras = padrao().regras.map((r) => r.texto).join('\n');
  assert.ok(/nao use emoji/i.test(regras));
});

// --------------------------------------------- custo por mensagem

test('saudacao pura nao paga extracao de ontologia', () => {
  // A extracao custa ~900 tokens por turno. Rodar isso sobre "Bom dia!!" paga
  // o preco cheio para descobrir, com certeza, que nao ha nada a extrair.
  const ontologia = require('../src/ontology/ontology.service');

  for (const social of ['Bom dia!!', 'oi', 'Olá, tudo bem?', 'obrigado!', 'ok', 'Perfeito, obrigado']) {
    assert.equal(ontologia.valeExtrair(social), false, `deveria pular: "${social}"`);
  }
});

test('na duvida, extrai: perder um slot custa mais que economizar tokens', () => {
  const ontologia = require('../src/ontology/ontology.service');

  for (const comConteudo of [
    'Bom dia, fui demitido',
    'Boa tarde. Trabalhei 3 anos sem registro',
    'tudo bem? preciso de ajuda',
    'vou mandar os documentos',
  ]) {
    assert.equal(ontologia.valeExtrair(comConteudo), true, `deveria extrair: "${comConteudo}"`);
  }
});

test('a abertura nao carrega as orientacoes de encerrar e transferir', () => {
  // Encerrar, transferir e qualificar sao situacoes que ainda nao existem no
  // primeiro turno; mandar as orientacoes delas custa ~180 tokens para nada.
  const config = padrao();

  const primeiro = buildInstructions({ config, primeiroContato: true }).join('\n\n');
  const seguinte = buildInstructions({ config, primeiroContato: false }).join('\n\n');

  assert.ok(!primeiro.includes('[SITUACOES]'));
  assert.ok(seguinte.includes('[SITUACOES]'), 'nos turnos seguintes elas voltam');
  assert.ok(primeiro.length < seguinte.length);
});

test('a FAQ nao vai inteira em toda mensagem', () => {
  // E o unico campo da curadoria que cresce sem teto (40 entradas). Manda-las
  // todas faria o custo subir junto com o zelo da equipe em preencher a base.
  const faq = Array.from({ length: 10 }, (_, i) => ({
    pergunta: `Pergunta sobre assunto${i}`,
    resposta: `Resposta ${i}`,
  }));
  const config = schema.sanitizar({ empresa: { ...padrao().empresa, faq } }, 'lead_capture');

  const semRelacao = buildInstructions({ config, textoDoContato: 'Bom dia' }).join('\n\n');
  assert.ok(!semRelacao.includes('PERGUNTAS FREQUENTES'), 'nada casa: nenhuma entra');

  const comRelacao = buildInstructions({
    config,
    textoDoContato: 'tenho duvida sobre assunto3',
  }).join('\n\n');
  assert.ok(comRelacao.includes('Resposta 3'), 'a que casa entra');
  assert.ok(!comRelacao.includes('Resposta 7'), 'as que nao casam ficam de fora');
});
