const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste';

const bh = require('../src/conversation/business-hours');

/**
 * Segunda a sexta, 08:00-18:30, horario de Brasilia.
 *
 * Os horarios abaixo estao em UTC de proposito: e assim que o servidor recebe
 * a hora, e o ponto do teste e justamente provar que a conversao para
 * America/Sao_Paulo acontece - o servidor pode rodar em qualquer fuso.
 */
const brt = (utc) => new Date(utc);

test('abre as 08:00 em ponto, nao as 07:59', () => {
  assert.equal(bh.estaNoExpediente(brt('2026-08-24T10:59:00Z')).dentro, false, '07:59 BRT');
  assert.equal(bh.estaNoExpediente(brt('2026-08-24T11:00:00Z')).dentro, true, '08:00 BRT');
});

test('fecha as 18:30: 18:29 ainda atende, 18:30 nao', () => {
  assert.equal(bh.estaNoExpediente(brt('2026-08-24T21:29:00Z')).dentro, true, '18:29 BRT');
  assert.equal(bh.estaNoExpediente(brt('2026-08-24T21:30:00Z')).dentro, false, '18:30 BRT');
});

test('sabado e domingo nao atendem, em nenhum horario', () => {
  const sabado = bh.estaNoExpediente(brt('2026-08-22T15:00:00Z')); // sabado 12:00 BRT
  const domingo = bh.estaNoExpediente(brt('2026-08-23T15:00:00Z')); // domingo 12:00 BRT

  assert.equal(sabado.dentro, false);
  assert.equal(sabado.motivo, 'fim_de_semana');
  assert.equal(domingo.dentro, false);
  assert.equal(domingo.motivo, 'fim_de_semana');
});

test('meio da semana em horario comercial atende', () => {
  for (const dia of ['25', '26', '27', '28']) {
    const r = bh.estaNoExpediente(brt(`2026-08-${dia}T17:00:00Z`)); // 14:00 BRT
    assert.equal(r.dentro, true, `dia ${dia} deveria atender`);
  }
});

test('converte para o fuso de Brasilia, nao usa o fuso do servidor', () => {
  // 03:00 UTC de terca = 00:00 BRT de terca: madrugada, fechado.
  const madrugada = bh.estaNoExpediente(brt('2026-08-25T03:00:00Z'));
  assert.equal(madrugada.dentro, false);
  assert.equal(madrugada.hora, '00:00');

  // 23:00 UTC de segunda = 20:00 BRT de segunda: ja fechou.
  const noite = bh.estaNoExpediente(brt('2026-08-24T23:00:00Z'));
  assert.equal(noite.dentro, false);
  assert.equal(noite.hora, '20:00');
  assert.equal(noite.motivo, 'apos_o_fechamento');
});

test('virada do dia em UTC nao vira o dia em Brasilia', () => {
  // 02:00 UTC de sabado ainda e sexta 23:00 em Brasilia.
  const r = bh.estaNoExpediente(brt('2026-08-22T02:00:00Z'));
  assert.equal(r.hora, '23:00');
  assert.equal(
    r.motivo,
    'apos_o_fechamento',
    'e sexta a noite em Brasilia, nao sabado - o motivo precisa refletir isso'
  );
});

test('mensagem de ausencia diz quando volta e nao promete atendimento imediato', () => {
  const fimDeSemana = bh.mensagemAusencia({ motivo: 'fim_de_semana' });
  assert.match(fimDeSemana, /segunda a sexta/i);
  assert.match(fimDeSemana, /08:00/);
  assert.match(fimDeSemana, /18:30/);

  const aposFechar = bh.mensagemAusencia({ motivo: 'apos_o_fechamento', abreEm: 'amanha as 08:00' });
  assert.match(aposFechar, /amanha as 08:00/);

  // Nao pode soar como promessa de resposta agora.
  for (const texto of [fimDeSemana, aposFechar]) {
    assert.doesNotMatch(texto, /\bja vou (responder|verificar)\b/i);
  }
});

test('desligar o controle faz o agente atender sempre', () => {
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/conversation/business-hours')];
  const anterior = process.env.EXPEDIENTE_ENABLED;
  process.env.EXPEDIENTE_ENABLED = 'false';

  const semControle = require('../src/conversation/business-hours');
  const domingoDeMadrugada = semControle.estaNoExpediente(new Date('2026-08-23T05:00:00Z'));
  assert.equal(domingoDeMadrugada.dentro, true);
  assert.equal(domingoDeMadrugada.motivo, 'controle_desligado');

  if (anterior === undefined) delete process.env.EXPEDIENTE_ENABLED;
  else process.env.EXPEDIENTE_ENABLED = anterior;
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/conversation/business-hours')];
});

test('descricao legivel do expediente', () => {
  const texto = bh.descricao();
  assert.match(texto, /08:00/);
  assert.match(texto, /18:30/);
  assert.match(texto, /Brasilia/i);
});

// ------------------------------------------------- saudacao pelo relogio real

test('o periodo do dia segue o uso brasileiro, nao o fim do expediente', () => {
  const em = (iso) => bh.periodoDoDia(new Date(iso));

  // Horarios em UTC; Brasilia e -03:00.
  assert.equal(em('2026-08-25T11:00:00Z'), 'manha', '08:00 e manha');
  assert.equal(em('2026-08-25T14:59:00Z'), 'manha', '11:59 ainda e manha');
  assert.equal(em('2026-08-25T15:00:00Z'), 'tarde', '12:00 vira tarde');
  assert.equal(em('2026-08-25T20:59:00Z'), 'tarde', '17:59 ainda e tarde');
  // Quem escreve as 18h05 diz "boa noite", ainda que o expediente va ate 18h30.
  assert.equal(em('2026-08-25T21:00:00Z'), 'noite', '18:00 ja e noite');
  assert.equal(em('2026-08-25T21:21:00Z'), 'noite');
});

test('a data e a saudacao chegam prontas para o prompt', () => {
  const agora = bh.agoraPorExtenso(new Date("2026-08-25T21:21:00Z"));

  assert.equal(agora.saudacao, 'Boa noite');
  assert.equal(agora.hora, '18:21');
  assert.match(agora.texto, /ter.a-feira/i);
  assert.match(agora.texto, /25 de agosto de 2026/);
  assert.match(agora.texto, /Brasilia/);
});
