const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste';

const ontologia = require('../src/ontology/ontology.service');
const schema = require('../src/curadoria/config.schema');
const { buildInstructions } = require('../src/agent/prompt.builder');

/**
 * "JA HAVIA INFORMADO O MEU NOME"
 * -------------------------------
 * A conversa que originou estes testes terminou com o agente perguntando
 * "poderia me informar seu nome completo?" a um contato chamado Estevao — que
 * ja tinha se apresentado, e cujo nome o WhatsApp exibia no topo da tela
 * desde a primeira mensagem.
 *
 * O nome estava em `faltam`, `faltam` vira "Ainda falta descobrir" no prompt,
 * e o agente cumpriu a ordem. Nao adianta pedir ao modelo que preste atencao:
 * o dado precisa chegar preenchido.
 */

test('o nome do perfil do WhatsApp e lido, sem o enfeite que as pessoas poem nele', () => {
  assert.equal(ontologia.nomeDoPushName("Estevão.'."), 'Estevão');
  assert.equal(ontologia.nomeDoPushName('🔥 JR 🔥'), 'JR');
  assert.equal(ontologia.nomeDoPushName('  Maria Clara  '), 'Maria Clara');
  assert.equal(ontologia.nomeDoPushName('Ana-Beatriz'), 'Ana-Beatriz');
});

test('apelido que nao identifica ninguem devolve null: ai perguntar e legitimo', () => {
  // Numero de telefone como nome de exibicao e comum e nao e nome.
  assert.equal(ontologia.nomeDoPushName('+55 11 94006-1595'), null);
  assert.equal(ontologia.nomeDoPushName('19996383884'), null);
  assert.equal(ontologia.nomeDoPushName('😀😀'), null);
  assert.equal(ontologia.nomeDoPushName('A'), null);
  assert.equal(ontologia.nomeDoPushName(''), null);
  assert.equal(ontologia.nomeDoPushName(null), null);
});

test('com o nome preenchido, ele sai da lista do que falta descobrir', () => {
  const semNome = { slots: { tipo_caso: 'rescisao_indireta' } };
  const comNome = { slots: { tipo_caso: 'rescisao_indireta', nome: 'Estevão' } };

  assert.ok(
    ontologia.missingSlots(semNome, 'leads').includes('nome'),
    'era este o estado real do contato: o nome na tela e o slot vazio'
  );
  assert.ok(!ontologia.missingSlots(comNome, 'leads').includes('nome'));
});

test('sabendo o nome, o prompt proibe a pergunta em vez de esperar bom senso', () => {
  const config = schema.padraoDoAgente('lead_capture');
  const prompt = buildInstructions({ config, nomeConhecido: 'Estevão' }).join('\n\n');

  assert.ok(prompt.includes('[NOME]'));
  assert.ok(prompt.includes('Estevão'));
  assert.ok(
    /NUNCA pergunte/.test(prompt),
    'sem proibicao explicita o modelo repete a pergunta ao fim da triagem'
  );
});

test('sem nome sabido o bloco nao existe: nada e afirmado sem lastro', () => {
  const config = schema.padraoDoAgente('lead_capture');
  const prompt = buildInstructions({ config, nomeConhecido: null }).join('\n\n');

  assert.ok(!prompt.includes('[NOME]'));
});

test('o agente recebe UM dado por vez, nao a lista inteira', () => {
  // O modelo perguntou "seu nome completo e a situacao" — duas coisas de uma
  // vez, apesar do prompt pedir uma. Entregar so o proximo slot resolve por
  // construcao: nao ha lista para ele varrer.
  const config = schema.padraoDoAgente('lead_capture');
  const partes = buildInstructions({
    config,
    missing: ['tipo_caso', 'situacao_atual', 'tempo_de_casa', 'cidade'],
  });

  // So o bloco de foco: "cidade" aparece no prompt principal curado como
  // descricao do papel, e isso e legitimo. O que nao pode e o agente receber
  // um cardapio de perguntas para fazer agora.
  const foco = partes.find((b) => b.startsWith('[FOCO]'));
  assert.ok(foco, 'o bloco de foco precisa existir enquanto houver o que descobrir');
  assert.ok(foco.includes('tipo_caso'));
  for (const outro of ['situacao_atual', 'tempo_de_casa', 'cidade']) {
    assert.ok(!foco.includes(outro), `o foco nao pode oferecer ${outro} como alternativa`);
  }
});

test('saudacao esticada continua sendo saudacao e nao paga extracao', () => {
  // "bom diaaa" abriu a conversa e disparou uma chamada ao extrator para nao
  // dizer nada. A lista social so conhecia a forma sem alongamento.
  for (const social of ['bom diaaa', 'oieee', 'boa noiteee', 'obrigadoooo']) {
    assert.equal(ontologia.valeExtrair(social), false, `deveria pular: "${social}"`);
  }

  // E o alongamento nao pode calar mensagem com conteudo.
  assert.equal(ontologia.valeExtrair('naaao recebi a multa dos 40%'), true);
});
