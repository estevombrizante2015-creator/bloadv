const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';

const ontology = require('../src/ontology/ontology.service');
const { extractionSchema, TIPOS_CASO } = require('../src/ontology/ontology.schema');

test('sanitize descarta slots fora da ontologia', () => {
  const out = ontology.sanitize('leads', {
    intent: 'relato_caso',
    slots: { nome: 'Ana', slot_inventado: 'x', tipo_caso: 'divorcio' },
  });

  assert.equal(out.intent, 'relato_caso');
  assert.equal(out.slots.nome, 'Ana');
  assert.equal(out.slots.slot_inventado, undefined, 'slot inventado deve sumir');
  assert.equal(out.slots.tipo_caso, undefined, 'caso fora do escopo trabalhista deve sumir');
});

test('sanitize aceita enum valido e trunca texto longo', () => {
  const out = ontology.sanitize('leads', {
    slots: { tipo_caso: 'horas_extras', resumo_relato: 'x'.repeat(400) },
  });
  assert.equal(out.slots.tipo_caso, 'horas_extras');
  assert.equal(out.slots.resumo_relato.length, 200);
});

test('merge acumula listas sem duplicar e sobrescreve escalares', () => {
  const base = ontology.merge({}, { slots: { documentos: ['ctps'], nome: 'Ana' } }, 'leads');
  const next = ontology.merge(
    base,
    { slots: { documentos: ['ctps', 'holerites'], nome: 'Ana Paula' } },
    'leads'
  );

  assert.deepEqual(next.slots.documentos, ['ctps', 'holerites']);
  assert.equal(next.slots.nome, 'Ana Paula');
});

test('render omite slots vazios e lista o que falta na triagem', () => {
  const snapshot = ontology.merge(
    {},
    { intent: 'relato_caso', slots: { nome: 'Ana', tipo_caso: 'sem_registro' } },
    'leads'
  );
  const text = ontology.render(snapshot, 'leads');

  assert.match(text, /intencao=relato_caso/);
  assert.match(text, /tipo_caso=sem_registro/);
  assert.match(text, /faltam=.*situacao_atual/);
  assert.doesNotMatch(text, /empregador=/);
});

test('missingSlots esvazia quando a triagem completa', () => {
  const full = ontology.merge(
    {},
    {
      slots: {
        nome: 'Ana',
        tipo_caso: 'demissao_sem_justa_causa',
        situacao_atual: 'ja_desligado',
        tempo_de_casa: '3 anos',
        cidade: 'Campinas',
      },
    },
    'leads'
  );

  assert.deepEqual(ontology.missingSlots(full, 'leads'), []);
  assert.equal(ontology.isComplete(full, 'leads'), true);
});

test('buildContext limita turnos e reporta economia de tokens', () => {
  const snapshot = ontology.merge(
    {},
    { slots: { nome: 'Ana', tipo_caso: 'horas_extras' } },
    'leads'
  );
  const history = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    text: `mensagem numero ${i} com um tamanho realista de conversa de whatsapp`,
  }));

  const ctx = ontology.buildContext({
    ontology: snapshot,
    role: 'leads',
    rollingSummary: 'Ana foi demitida em marco e nao recebeu o acerto.',
    recentMessages: history,
    allMessagesCount: 40,
  });

  assert.ok(ctx.turns.length <= 8, 'nao envia o historico inteiro');
  assert.ok(ctx.savedTokens > 0, 'deve reportar economia');
  assert.match(ctx.contextBlock, /ESTADO ESTRUTURADO/);
  assert.match(ctx.contextBlock, /HISTORICO COMPRIMIDO/);
});

test('contexto compactado e menor que o historico bruto', () => {
  const snapshot = ontology.merge(
    {},
    { slots: { nome: 'Ana', tipo_caso: 'horas_extras', tempo_de_casa: '3 anos' } },
    'leads'
  );
  const history = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    text: `mensagem numero ${i} com um tamanho realista de conversa de whatsapp`,
  }));

  const rawTokens = ontology.approxTokens(history.map((m) => m.text).join('\n'));
  const ctx = ontology.buildContext({
    ontology: snapshot,
    role: 'leads',
    rollingSummary: 'Ana foi demitida em marco e nao recebeu o acerto.',
    recentMessages: history,
    allMessagesCount: 40,
  });
  const compactTokens =
    ontology.approxTokens(ctx.contextBlock) +
    ontology.approxTokens(ctx.turns.map((m) => m.text).join('\n'));

  assert.ok(
    compactTokens < rawTokens * 0.5,
    `contexto compacto (${compactTokens}) deve custar menos da metade do bruto (${rawTokens})`
  );
});

test('extractionSchema so expoe slots declarados do papel', () => {
  const clientes = extractionSchema('clients');
  assert.equal(clientes.properties.slots.additionalProperties, false);
  assert.ok(clientes.properties.slots.properties.numero_processo);
  assert.equal(
    clientes.properties.slots.properties.risco_prescricao,
    undefined,
    'slot de triagem nao vaza para o papel de clientes'
  );

  const leads = extractionSchema('leads');
  assert.deepEqual(leads.properties.slots.properties.tipo_caso.enum, TIPOS_CASO);
});

test('todo tipo_caso tem verbete na base de conhecimento (exceto "outro")', () => {
  const { KNOWLEDGE } = require('../src/domain/knowledge.base');
  const semVerbete = TIPOS_CASO.filter((t) => t !== 'outro' && !KNOWLEDGE[t]);
  assert.deepEqual(semVerbete, [], `sem verbete: ${semVerbete.join(', ')}`);
});
