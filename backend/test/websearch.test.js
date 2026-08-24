const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste';
process.env.WEBSEARCH_ENABLED = 'true';

const websearch = require('../src/agent/websearch.service');

/**
 * A decisao de buscar importa mais que a busca em si. Num escritorio de
 * advocacia, sair repetindo "o que a internet diz" sobre o caso de alguem e
 * pior do que nao responder - e ainda custa segundos de latencia.
 */

test('busca quando a pergunta e sobre dado que muda com o tempo', () => {
  const devem = [
    'Qual o salario minimo hoje?',
    'Qual a tabela do INSS de 2026?',
    'O teto do INSS mudou este ano?',
    'Qual o valor das parcelas do seguro-desemprego?',
    'Mudou alguma regra trabalhista este ano?',
    'Qual o endereco do INSS em Campinas?',
    'Qual o horario de atendimento da Caixa para FGTS?',
  ];
  for (const t of devem) {
    assert.equal(websearch.deveBuscar(t).buscar, true, `deveria buscar: ${t}`);
  }
});

test('NAO busca em pergunta sobre o caso da pessoa', () => {
  const naoDevem = [
    'Fui demitido ontem, e agora?',
    'Quanto vou receber no meu caso?',
    'Eu tenho direito a alguma coisa?',
    'Minha situacao tem chance?',
    'Trabalhei 3 anos sem carteira assinada',
    'Meu chefe me humilhava todos os dias',
  ];
  for (const t of naoDevem) {
    const r = websearch.deveBuscar(t);
    assert.equal(r.buscar, false, `NAO deveria buscar: ${t} (motivo: ${r.motivo})`);
  }
});

test('bloqueio tem precedencia sobre gatilho', () => {
  // Tem "valor" e "hoje" (gatilho), mas e sobre o caso da pessoa (bloqueio).
  const r = websearch.deveBuscar('Qual o valor atualizado que eu vou receber no meu caso hoje?');
  assert.equal(r.buscar, false);
  assert.equal(r.motivo, 'pergunta_sobre_o_caso');
});

test('honorarios nunca vao para a internet', () => {
  const r = websearch.deveBuscar('Qual a tabela de honorarios vigente hoje?');
  assert.equal(r.buscar, false, 'honorario e tratado pelo advogado, nao pesquisado');
});

test('mensagem curta nao dispara busca', () => {
  for (const t of ['oi', 'bom dia', '?', '']) {
    assert.equal(websearch.deveBuscar(t).buscar, false);
  }
});

test('desligar por configuracao impede qualquer busca', () => {
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/agent/websearch.service')];
  const anterior = process.env.WEBSEARCH_ENABLED;
  process.env.WEBSEARCH_ENABLED = 'false';

  const desligado = require('../src/agent/websearch.service');
  assert.equal(desligado.deveBuscar('Qual o salario minimo hoje?').buscar, false);
  assert.equal(desligado.deveBuscar('Qual o salario minimo hoje?').motivo, 'desabilitado');

  process.env.WEBSEARCH_ENABLED = anterior;
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/agent/websearch.service')];
});

test('falha ou timeout da busca nao lanca: o atendimento segue', async () => {
  delete require.cache[require.resolve('../src/agent/websearch.service')];
  const servico = require('../src/agent/websearch.service');

  // Sem credencial valida, a chamada falha - e precisa falhar em silencio.
  const r = await servico.buscar({ pergunta: 'salario minimo', channelId: 'c', chatId: 'a' });
  assert.equal(r.ok, false);
  assert.ok(r.motivo, 'a falha precisa vir com motivo, nao com excecao');
});
