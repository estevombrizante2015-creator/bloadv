const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste';

const csv = require('../src/clientes/csv');
const imp = require('../src/clientes/importacao.service');
const pipeline = require('../src/clientes/pipeline.service');

/**
 * IMPORTACAO DA PLANILHA
 * ----------------------
 * Os casos aqui saem do arquivo real do escritorio. Planilha nao e formato de
 * dados: e o que sobrou de anos de digitacao, e cada defeito destes custou uma
 * descoberta.
 */

const CABECALHO =
  'DATA,AJUIZADO,PARTE CONTRÁRIA,CLIENTE,DOCUMENTOS ENTREGUES,DOCUMENTO FALTANTE,' +
  'FUNÇÃO,ORIGEM CONTRATO,PEDIDO,NATUREZA DA DEMANDA,PENDÊNCIAS,OBSERVAÇÕES (PENDÊNCIAS),' +
  'RESPONSÁVEL ,TELEFONE,Coluna 2,Coluna 3';

const PLANILHA = [
  "''1,,,,,,,,CHEGOU ATRAVÉS DO SITE,,,,,,,",
  CABECALHO,
  '17/07/2026,SIM,MUNICÍPIO DE PAULÍNIA-SP,NELMA MARIA DE JESUS BERTELI,' +
    '"CONTRATO, PROCURAÇÃO, DOC PESSOAL",,PROFESSORA,,DEFESA PAD,CÍVEL,NÃO,,LOLI,,,',
  '21/07/2026,NÃO,INSS,RODRIGO MARCOS DOS SANTOS,DOC PESSOAL,,,,AUXÍLIO DOENÇA,' +
    'PREVIDENCIÁRIO,SIM,PENDENTE LAUDO MÉDICO,MATHEUS,,,',
  ',NÃO,,ISMAEL MONTEIRO ,,,,,AFASTAMENTO,,,,,19999715178,,',
  ',,,IRAN FREITAS,,,,,,,,,,,,',
].join('\n');

const bytes = (texto, codificacao = 'utf-8') => Buffer.from(texto, codificacao);

const contexto = () => ({
  usuarios: [{ id: 'u1', nome: 'Larissa Lopes', email: 'larissa@escritorio.com' }],
  status: pipeline.padrao().status,
  etapas: pipeline.padrao().etapas,
});

// ------------------------------------------------------------- codificacao

test('le UTF-8, Windows-1252 e o mojibake classico com o mesmo resultado', () => {
  // Excel em portugues salva ANSI; Google Planilhas manda UTF-8; e quem abre um
  // UTF-8 como ANSI e salva de novo produz o terceiro caso. Quem exporta a
  // planilha nao sabe qual e o seu.
  const original = 'PARTE CONTRÁRIA,FUNÇÃO,PREVIDENCIÁRIO';
  const mojibake = Buffer.from(original, 'utf-8').toString('latin1');

  assert.equal(csv.decodificar(bytes(original, 'utf-8')).texto, original);
  assert.equal(csv.decodificar(bytes(original, 'latin1')).texto, original);
  assert.equal(csv.decodificar(bytes(mojibake, 'utf-8')).texto, original);
});

test('texto que ja esta correto nao e "reparado"', () => {
  // Um reparo agressivo estragaria nomes legitimos com Ã, que existem.
  const bom = 'JOÃO, MARIA, AÇÃO';
  assert.equal(csv.repararAcentos(bom), bom);
});

test('o BOM do Excel nao vira lixo na primeira coluna', () => {
  const comBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes('DATA,CLIENTE')]);
  const { texto, codificacao } = csv.decodificar(comBom);

  assert.ok(texto.startsWith('DATA'), 'sem o tratamento, a coluna vira "\\ufeffDATA"');
  assert.match(codificacao, /BOM/);
});

// ------------------------------------------------------------------ parser

test('campo entre aspas mantem as virgulas de dentro', () => {
  // "CONTRATO, PROCURAÇÃO, DOC PESSOAL" e UMA coluna, nao tres.
  const linhas = csv.parseLinhas('a,"um, dois, tres",c', ',');
  assert.deepEqual(linhas[0], ['a', 'um, dois, tres', 'c']);
});

test('aspas escapadas e quebra de linha dentro do campo', () => {
  const linhas = csv.parseLinhas('a,"diz ""oi""",c\nd,e,f', ',');
  assert.deepEqual(linhas[0], ['a', 'diz "oi"', 'c']);
  assert.deepEqual(linhas[1], ['d', 'e', 'f']);

  const comQuebra = csv.parseLinhas('a,"linha 1\nlinha 2",c', ',');
  assert.equal(comQuebra.length, 1, 'quebra dentro de aspas nao encerra a linha');
});

test('separador e detectado, inclusive o ponto e virgula do Excel', () => {
  assert.equal(csv.detectarSeparador('a,b,c'), ',');
  assert.equal(csv.detectarSeparador('a;b;c'), ';');
  // Virgula dentro de aspas nao pode votar como separador.
  assert.equal(csv.detectarSeparador('a;"um, dois";c'), ';');
});

// ---------------------------------------------------------------- estrutura

test('o cabecalho e achado mesmo quando nao esta na primeira linha', () => {
  // A planilha real comeca com um titulo solto: duas celulas preenchidas.
  const lido = csv.ler(bytes(PLANILHA));

  assert.equal(lido.linhaDoCabecalho, 2);
  assert.ok(lido.colunas.includes('CLIENTE'));
  assert.ok(!lido.colunas.includes("''1"), 'a linha de titulo nao virou cabecalho');
});

test('colunas vazias chamadas "Coluna N" sao descartadas', () => {
  // O Excel gera dezenas delas; sem isso, a tela de mapeamento fica ilegivel.
  const lido = csv.ler(bytes(PLANILHA));

  assert.equal(lido.colunasDescartadas, 2);
  assert.ok(!lido.colunas.some((c) => /^Coluna \d+$/.test(c)));
});

test('linha sem nenhum valor nao vira cliente', () => {
  const lido = csv.ler(bytes(`${PLANILHA}\n,,,,,,,,,,,,,,,`));
  assert.equal(lido.total, 4, 'as quatro linhas com conteudo, e so elas');
});

// --------------------------------------------------------------- mapeamento

test('as colunas conhecidas sao reconhecidas pelo titulo', () => {
  const mapa = imp.sugerirMapeamento(csv.ler(bytes(PLANILHA)).colunas);

  assert.equal(mapa.CLIENTE, 'nome');
  assert.equal(mapa.TELEFONE, 'telefone');
  assert.equal(mapa.DATA, 'entradaEm');
  assert.equal(mapa['NATUREZA DA DEMANDA'], 'tags');
  assert.equal(mapa['DOCUMENTO FALTANTE'], 'aguardando');
  // O espaco sobrando no fim do titulo nao pode atrapalhar.
  assert.equal(mapa['RESPONSÁVEL'], 'responsavel');
});

test('coluna desconhecida e GUARDADA, nunca descartada em silencio', () => {
  // "Parte contraria" e "pedido" sao a substancia do caso. Perde-las em
  // silencio so seria descoberto semanas depois, com a planilha arquivada.
  const mapa = imp.sugerirMapeamento(csv.ler(bytes(PLANILHA)).colunas);

  assert.equal(mapa['PARTE CONTRÁRIA'], 'extra');
  assert.equal(mapa.PEDIDO, 'extra');
  assert.ok(!Object.values(mapa).includes('ignorar'), 'nada e ignorado por conta propria');
});

test('duas colunas nao disputam o mesmo campo de valor unico', () => {
  const mapa = imp.sugerirMapeamento(['CLIENTE', 'NOME', 'TELEFONE', 'CELULAR']);

  assert.equal(Object.values(mapa).filter((d) => d === 'nome').length, 1);
  assert.equal(Object.values(mapa).filter((d) => d === 'telefone').length, 1);
});

// --------------------------------------------------------------- conversao

test('data em pt-BR e entendida; o que nao da para ter certeza, nao vira data', () => {
  assert.equal(imp.paraData('17/07/2026').toLocaleDateString('pt-BR'), '17/07/2026');
  assert.equal(imp.paraData('2026-07-17').getFullYear(), 2026);
  assert.equal(imp.paraData('17/07/26').getFullYear(), 2026);

  assert.equal(imp.paraData('A COMBINAR'), null);
  assert.equal(imp.paraData(''), null);
});

test('"SIM" e "NÃO" nao viram status nem pendencia', () => {
  // A coluna AJUIZADO tem SIM/NÃO/SEM VIABILIDADE. Nenhum e status do quadro,
  // e escolher um a esmo colocaria o cliente na coluna errada do kanban.
  const lido = csv.ler(bytes(PLANILHA));
  const mapa = imp.sugerirMapeamento(lido.colunas);
  const { cliente, avisos } = imp.converterLinha(lido.registros[0], mapa, contexto());

  assert.equal(cliente.status, undefined, 'sem status: a ficha usa o inicial');
  assert.ok(avisos.some((a) => /status "SIM"/.test(a)), 'e o motivo aparece na previa');

  const extras = Object.fromEntries(cliente.camposExtras.map((e) => [e.rotulo, e.valor]));
  assert.equal(extras.AJUIZADO, 'SIM', 'mas o valor original e preservado');

  assert.deepEqual(cliente.pendencias, [], '"NÃO" na coluna PENDÊNCIAS nao vira pendencia');
});

test('a observacao de pendencia vira uma pendencia em aberto', () => {
  const lido = csv.ler(bytes(PLANILHA));
  const mapa = imp.sugerirMapeamento(lido.colunas);
  const { cliente } = imp.converterLinha(lido.registros[1], mapa, contexto());

  assert.equal(cliente.pendencias.length, 1);
  assert.equal(cliente.pendencias[0].texto, 'PENDENTE LAUDO MÉDICO');
  assert.equal(cliente.pendencias[0].resolvida, false);
});

test('telefone sem DDI ganha o 55; o que nao e telefone e recusado', () => {
  const lido = csv.ler(bytes(PLANILHA));
  const mapa = imp.sugerirMapeamento(lido.colunas);
  const { cliente } = imp.converterLinha(lido.registros[2], mapa, contexto());

  assert.equal(cliente.telefone, '5519999715178');
  assert.equal(cliente.nome, 'ISMAEL MONTEIRO', 'o espaco sobrando no nome e aparado');

  const ruim = imp.converterLinha({ TELEFONE: 'A CONFIRMAR', CLIENTE: 'X' }, { TELEFONE: 'telefone', CLIENTE: 'nome' }, contexto());
  assert.equal(ruim.cliente.telefone, undefined, 'telefone invalido nao cria identidade falsa');
  assert.ok(ruim.avisos.some((a) => /telefone ignorado/.test(a)));
});

test('responsavel que nao e usuario do painel nao e inventado', () => {
  const mapa = { 'RESPONSÁVEL': 'responsavel', CLIENTE: 'nome' };

  const conhecido = imp.converterLinha({ CLIENTE: 'X', 'RESPONSÁVEL': 'LARISSA LOPES' }, mapa, contexto());
  assert.equal(conhecido.cliente.responsavel.id, 'u1');

  const desconhecido = imp.converterLinha({ CLIENTE: 'Y', 'RESPONSÁVEL': 'MATHEUS' }, mapa, contexto());
  assert.equal(desconhecido.cliente.responsavel, undefined);
  // Mas o nome nao se perde: e informacao real da planilha.
  assert.ok(desconhecido.cliente.camposExtras.some((e) => e.valor === 'MATHEUS'));
});

test('status e etapa so casam quando a correspondencia e clara', () => {
  const { status, etapas } = contexto();

  assert.equal(imp.casarComPipeline('Aguardando cliente', status), 'aguardando_cliente');
  assert.equal(imp.casarComPipeline('aguardando_cliente', status), 'aguardando_cliente');
  assert.equal(imp.casarComPipeline('EM ANALISE', status), 'em_analise', 'acento nao atrapalha');
  assert.equal(imp.casarComPipeline('Triagem inicial', etapas), 'triagem');

  assert.equal(imp.casarComPipeline('SIM', status), null);
  assert.equal(imp.casarComPipeline('qualquer coisa', status), null);
});

test('etiquetas saem de uma celula com varios valores', () => {
  const { cliente } = imp.converterLinha(
    { TIPO: 'TRABALHISTA, CÍVEL; PREVIDENCIÁRIO', CLIENTE: 'X' },
    { TIPO: 'tags', CLIENTE: 'nome' },
    contexto()
  );

  assert.deepEqual(cliente.tags, ['trabalhista', 'cível', 'previdenciário']);
});

test('linha sem nome do cliente nao produz ficha', () => {
  // Sem nome nao ha o que mostrar na carteira; a previa conta essas linhas.
  const { cliente } = imp.converterLinha({ TELEFONE: '19999715178' }, { TELEFONE: 'telefone' }, contexto());
  assert.equal(cliente.nome, undefined);
});

test('a planilha inteira sobrevive: nada e descartado sem destino', () => {
  const lido = csv.ler(bytes(PLANILHA));
  const mapa = imp.sugerirMapeamento(lido.colunas);
  const { cliente } = imp.converterLinha(lido.registros[0], mapa, contexto());

  const preservados = new Set([
    ...cliente.camposExtras.map((e) => e.rotulo),
    ...Object.entries(mapa)
      .filter(([, destino]) => destino !== 'extra' && destino !== 'ignorar')
      .map(([coluna]) => coluna),
  ]);

  for (const [coluna, valor] of Object.entries(lido.registros[0])) {
    if (!valor) continue;
    assert.ok(preservados.has(coluna), `a coluna "${coluna}" sumiu na conversao`);
  }
});
