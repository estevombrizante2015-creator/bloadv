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

// ---------------------------------------------------- interruptor da curadoria

test('o escritorio consegue desligar a pesquisa sem mexer no .env', () => {
  delete require.cache[require.resolve('../src/agent/websearch.service')];
  const servico = require('../src/agent/websearch.service');

  const pergunta = 'Qual o salario minimo hoje?';
  assert.equal(servico.deveBuscar(pergunta, { habilitado: true }).buscar, true);

  const desligado = servico.deveBuscar(pergunta, { habilitado: false });
  assert.equal(desligado.buscar, false);
  assert.equal(desligado.motivo, 'desligado_na_curadoria');

  // Sem a opcao, o comportamento e o de antes: quem manda e o .env.
  assert.equal(servico.deveBuscar(pergunta).buscar, true);
});

// ------------------------------------------------------ formato do resultado

test('o resultado da busca chega limpo, sem link nem markdown', () => {
  const servico = require('../src/agent/websearch.service');

  // Formato real devolvido pela API: fonte em markdown com parametro de rastreio.
  const bruto =
    'O salario minimo e de R$ 1.621,00 ([gov.br](https://www.gov.br/x?utm_source=openai))\n' +
    '- **Vigente desde** janeiro de 2026 【4:0†source】';

  const limpo = servico.formatarParaConversa(bruto);

  assert.ok(!/https?:\/\//.test(limpo), 'nenhum endereco pode sobrar');
  assert.ok(!/[[\]*`【】]/.test(limpo), 'nenhum caractere de markdown ou citacao');
  assert.ok(!/\(\s*\)/.test(limpo), 'nao pode sobrar parentese vazio');
  assert.ok(limpo.includes('R$ 1.621,00'), 'o fato precisa sobreviver a limpeza');
  assert.ok(limpo.includes('janeiro de 2026'), 'a vigencia precisa sobreviver');
  assert.equal(limpo.split('\n')[1], '- Vigente desde janeiro de 2026');
});

test('a limpeza preserva parenteses que fazem parte da frase', () => {
  const servico = require('../src/agent/websearch.service');

  const texto = servico.formatarParaConversa(
    'Valor definido pelo Decreto n 12.797, de 23 de dezembro de 2025 (publicado no Diario Oficial).'
  );
  assert.ok(texto.includes('(publicado no Diario Oficial)'));
  assert.ok(texto.includes('12.797'));
});

// -------------------------------------------- pergunta juridica geral (8.2)

test('pergunta sobre a regra geral dispara busca; pergunta sobre o caso, nao', () => {
  delete require.cache[require.resolve('../src/agent/websearch.service')];
  const servico = require('../src/agent/websearch.service');

  // Sao perguntas sobre o que a lei e os tribunais dizem HOJE. Respondidas so
  // com a base local, saem com o verbete curado meses atras.
  const geral = [
    'quais as causas de rescisao indireta do contrato de trabalho?',
    'o que caracteriza justa causa?',
    'quais os requisitos da estabilidade da gestante?',
    'existe sumula do TST sobre intervalo?',
    'qual o piso da categoria dos vigilantes em Campinas?',
    'qual a convencao coletiva aplicavel ao comercio?',
  ];
  for (const t of geral) {
    assert.equal(servico.deveBuscar(t).buscar, true, `deveria buscar: ${t}`);
  }

  // A mesma materia, perguntada sobre a propria situacao, continua fora: isso
  // e analise do caso concreto e quem faz e o advogado, com os documentos.
  const doCaso = [
    'tenho direito a rescisao indireta no meu caso?',
    'meu chefe me humilhava todos os dias',
    'fui demitido ontem e nao recebi nada',
  ];
  for (const t of doCaso) {
    assert.equal(servico.deveBuscar(t).buscar, false, `nao deveria buscar: ${t}`);
  }
});

test('relato que apenas menciona um instituto nao vira pesquisa', () => {
  const servico = require('../src/agent/websearch.service');

  // Sem pergunta, e um caso sendo contado - nao um ponto de direito a conferir.
  for (const t of ['recebi justa causa ontem', 'trabalhei 3 anos sem carteira assinada']) {
    assert.equal(servico.deveBuscar(t).buscar, false, `nao deveria buscar: ${t}`);
  }
});
