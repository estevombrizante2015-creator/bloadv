const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';

const ontologyService = require('../src/ontology/ontology.service');

/**
 * Regressao de um bug que passou silencioso:
 * `Contact.ontology.slots` e Schema.Types.Mixed, e o Mongoose NAO detecta
 * mutacao nesse tipo. Sem `markModified('ontology')` os slots simplesmente
 * nao eram gravados - os fatos (array tipado) iam, os slots nao - e toda a
 * economia de tokens parava de funcionar sem erro nenhum.
 *
 * Precisa de MongoDB. Sem conexao, o teste e pulado em vez de falhar.
 */

const URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
const JID = 'teste-persistencia@teste';
const CHANNEL = 'leads-1';

let connected = false;

test.before(async () => {
  try {
    await mongoose.connect(URI, { serverSelectionTimeoutMS: 5000 });
    connected = true;
  } catch {
    connected = false;
  }
});

test.after(async () => {
  if (connected) {
    const { Contact } = require('../src/models');
    await Contact.deleteMany({ jid: JID }).catch(() => {});
    await mongoose.connection.close();
  }
});

test('slots da ontologia sobrevivem ao save (Mixed exige markModified)', async (t) => {
  if (!connected) return t.skip('MongoDB indisponivel');

  const { Contact } = require('../src/models');
  await Contact.deleteMany({ jid: JID });

  const contact = await Contact.create({
    channelId: CHANNEL,
    jid: JID,
    role: 'leads',
    ontology: { version: 1, slots: {}, facts: [] },
  });

  const delta = ontologyService.sanitize('leads', {
    intent: 'relato_caso',
    stage: 'coletando_relato',
    slots: { tipo_caso: 'horas_extras', situacao_atual: 'ja_desligado', nome: 'Ana' },
    facts: ['Trabalhou 3 anos na empresa'],
  });

  contact.ontology = ontologyService.merge(contact.ontology, delta, 'leads');
  contact.markModified('ontology'); // <- sem isto, os slots somem
  await contact.save();

  const relido = await Contact.findOne({ channelId: CHANNEL, jid: JID }).lean();

  assert.equal(relido.ontology.slots?.tipo_caso, 'horas_extras', 'slot Mixed precisa persistir');
  assert.equal(relido.ontology.slots?.situacao_atual, 'ja_desligado');
  assert.equal(relido.ontology.slots?.nome, 'Ana');
  assert.equal(relido.ontology.intent, 'relato_caso');
  assert.equal(relido.ontology.stage, 'coletando_relato');
  assert.deepEqual(relido.ontology.facts, ['Trabalhou 3 anos na empresa']);
});

test('slots acumulam entre turnos, e nao se sobrescrevem', async (t) => {
  if (!connected) return t.skip('MongoDB indisponivel');

  const { Contact } = require('../src/models');
  await Contact.deleteMany({ jid: JID });

  const contact = await Contact.create({
    channelId: CHANNEL,
    jid: JID,
    role: 'leads',
    ontology: { version: 1, slots: {}, facts: [] },
  });

  // turno 1: descobre o tipo de caso
  contact.ontology = ontologyService.merge(
    contact.ontology,
    ontologyService.sanitize('leads', { slots: { tipo_caso: 'sem_registro' } }),
    'leads'
  );
  contact.markModified('ontology');
  await contact.save();

  // turno 2: descobre nome e cidade
  const turno2 = await Contact.findOne({ channelId: CHANNEL, jid: JID });
  turno2.ontology = ontologyService.merge(
    turno2.ontology,
    ontologyService.sanitize('leads', { slots: { nome: 'Ana', cidade: 'Campinas' } }),
    'leads'
  );
  turno2.markModified('ontology');
  await turno2.save();

  const final = await Contact.findOne({ channelId: CHANNEL, jid: JID }).lean();

  assert.equal(final.ontology.slots.tipo_caso, 'sem_registro', 'o turno 2 nao pode apagar o turno 1');
  assert.equal(final.ontology.slots.nome, 'Ana');
  assert.equal(final.ontology.slots.cidade, 'Campinas');

  // e o efeito pratico: a triagem avanca
  const faltam = ontologyService.missingSlots(final.ontology, 'leads');
  assert.ok(!faltam.includes('nome'), 'nome ja preenchido nao pode voltar para "faltam"');
  assert.ok(!faltam.includes('tipo_caso'));
});

test('o pipeline chama markModified apos fundir a ontologia', async () => {
  // Guarda contra alguem remover a linha num refactor futuro.
  const fs = require('fs');
  const source = fs.readFileSync(require.resolve('../src/agent/agent.service.js'), 'utf8');

  const mergeAt = source.indexOf('ontologyService.merge(contact.ontology');
  const markAt = source.indexOf("contact.markModified('ontology')");

  assert.ok(mergeAt > -1, 'o merge da ontologia deveria existir no pipeline');
  assert.ok(markAt > mergeAt, 'markModified precisa vir depois do merge, antes do save');
});
