const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';

const knowledge = require('../src/domain/knowledge.service');
const { KNOWLEDGE } = require('../src/domain/knowledge.base');
const { FIRM } = require('../src/domain/firm.config');
const ontology = require('../src/ontology/ontology.service');

test('classifica o tema pelo relato, sem chamar modelo', () => {
  const casos = [
    ['trabalhei 3 anos sem carteira assinada', 'sem_registro'],
    ['me contrataram como PJ mas tinha horario fixo', 'vinculo_pj'],
    ['meu chefe me humilha na frente de todo mundo', 'assedio'],
    ['a empresa esta atrasando salario ha 4 meses', 'rescisao_indireta'],
    ['estou gravida e me demitiram', 'estabilidade_gestante'],
    ['posso vender minhas ferias?', 'ferias'],
  ];

  for (const [texto, esperado] of casos) {
    assert.ok(
      knowledge.matchByKeywords(texto).includes(esperado),
      `"${texto}" deveria casar com ${esperado}, veio ${knowledge.matchByKeywords(texto)}`
    );
  }
});

test('nao confunde "me demitiram" com "me demiti"', () => {
  const topicos = knowledge.matchByKeywords('me demitiram ontem');
  assert.ok(!topicos.includes('pedido_demissao'));
  assert.ok(topicos.includes('demissao_sem_justa_causa'));
});

test('injeta no maximo 2 verbetes, priorizando o tipo_caso da ontologia', () => {
  const { topics, block } = knowledge.select({
    tipoCaso: 'horas_extras',
    text: 'fui demitido e tambem tinha hora extra e trabalhei sem carteira',
  });

  assert.equal(topics[0], 'horas_extras', 'tipo_caso da ontologia vem primeiro');
  assert.ok(topics.length <= 2);
  assert.ok(block.includes('Horas extras'));
});

test('injetar a base inteira custaria muito mais que os verbetes selecionados', () => {
  const baseInteira = Object.values(KNOWLEDGE)
    .map((e) => `${e.titulo}: ${e.resumo}`)
    .join('\n');
  const selecionado = knowledge.select({ tipoCaso: 'assedio', text: 'sofri assedio' }).block;

  const tokensBase = ontology.approxTokens(baseInteira);
  const tokensSelecionado = ontology.approxTokens(selecionado);

  assert.ok(tokensBase > 800, `base tem ${tokensBase} tokens`);
  assert.ok(
    tokensSelecionado < tokensBase * 0.15,
    `selecao (${tokensSelecionado}) deve custar menos de 15% da base (${tokensBase})`
  );
});

test('sem tema identificado nao injeta nada', () => {
  const { topics, block } = knowledge.select({ tipoCaso: null, text: 'oi, bom dia' });
  assert.deepEqual(topics, []);
  assert.equal(block, '');
});

test('cada verbete traz uma pergunta de aprofundamento', () => {
  for (const [topico, entrada] of Object.entries(KNOWLEDGE)) {
    assert.ok(entrada.perguntaChave, `${topico} sem perguntaChave`);
    assert.equal(knowledge.suggestedQuestion(topico), entrada.perguntaChave);
  }
});

test('verbetes usam linguagem hedgeada, nunca conclusiva', () => {
  // mesma lista que o guardrail usa para julgar "parecer conclusivo"
  const { HEDGES } = require('../src/guardrails/rules');
  for (const [topico, entrada] of Object.entries(KNOWLEDGE)) {
    assert.match(entrada.resumo, HEDGES, `verbete "${topico}" precisa de linguagem hedgeada`);
  }
});

test('pergunta sobre local dispara o bloco de unidades', () => {
  assert.equal(knowledge.asksLocation('voces atendem em Cuiaba?'), true);
  assert.equal(knowledge.asksLocation('qual o endereco de voces?'), true);
  assert.equal(knowledge.asksLocation('da pra ser online?'), true);
  assert.equal(knowledge.asksLocation('fui demitido ontem'), false);

  const bloco = knowledge.locationBlock();
  for (const unidade of FIRM.unidades) {
    assert.ok(bloco.includes(unidade.cidade), `${unidade.cidade} deveria estar no bloco`);
  }
});

test('escritorio tem as 4 unidades e o contato principal', () => {
  assert.equal(FIRM.unidades.length, 4);
  assert.deepEqual(
    FIRM.unidades.map((u) => u.uf).sort(),
    ['CE', 'MT', 'SP', 'SP']
  );
  assert.match(FIRM.contato.telefone, /^\(\d{2}\) \d{5}-\d{4}$/);
  assert.match(FIRM.contato.email, /@bloadv\.com\.br$/);
});
