const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';

const normalizer = require('../src/whatsapp/message.normalizer');

const waText = (text) => ({
  key: { id: 'm1', remoteJid: 'lead@s.whatsapp.net' },
  messageTimestamp: 1700000000,
  message: { conversation: text },
});

test('identifica o tipo pelo no do protocolo', () => {
  assert.equal(normalizer.messageType({ conversation: 'oi' }), 'text');
  assert.equal(normalizer.messageType({ extendedTextMessage: { text: 'oi' } }), 'text');
  assert.equal(normalizer.messageType({ audioMessage: {} }), 'audio');
  assert.equal(normalizer.messageType({ imageMessage: {} }), 'image');
  assert.equal(normalizer.messageType({ documentMessage: {} }), 'document');
  assert.equal(normalizer.messageType({ reactionMessage: {} }), 'reaction');
});

test('desembrulha mensagem efemera e view-once', () => {
  const efemera = { ephemeralMessage: { message: { conversation: 'segredo' } } };
  assert.equal(normalizer.unwrap(efemera).conversation, 'segredo');

  const viewOnce = { viewOnceMessageV2: { message: { imageMessage: { caption: 'olha' } } } };
  assert.ok(normalizer.unwrap(viewOnce).imageMessage);
});

test('legenda de imagem e extraida como texto', () => {
  assert.equal(normalizer.extractText({ imageMessage: { caption: 'e esse aqui?' } }), 'e esse aqui?');
});

test('normaliza texto simples', async () => {
  const part = await normalizer.normalize({
    msg: waText('  Bom dia  '),
    channelId: 'leads-1',
    chatId: 'lead@s.whatsapp.net',
  });

  assert.equal(part.type, 'text');
  assert.equal(part.content, 'Bom dia');
  assert.equal(part.waMessageId, 'm1');
});

test('texto vazio e evento de protocolo sao descartados', async () => {
  const vazio = await normalizer.normalize({ msg: waText('   '), channelId: 'c', chatId: 'a' });
  assert.equal(vazio, null);

  const protocolo = await normalizer.normalize({
    msg: { key: { id: 'p1' }, message: { protocolMessage: {} } },
    channelId: 'c',
    chatId: 'a',
  });
  assert.equal(protocolo, null);
});

test('renderBatch consolida preservando a ordem de envio', () => {
  const parts = [
    { type: 'text', content: 'Vou mandar uma foto' },
    { type: 'image', description: 'Holerite com desconto de vale-transporte', caption: 'e esse aqui' },
    { type: 'text', content: 'e sobre isso que estou falando' },
    { type: 'audio', transcription: 'Queria entender se esse desconto esta certo' },
  ];

  const rendered = normalizer.renderBatch(parts);
  const linhas = rendered.split('\n');

  assert.ok(linhas[0].includes('Vou mandar uma foto'));
  assert.ok(rendered.indexOf('Holerite') > rendered.indexOf('Vou mandar'));
  assert.ok(rendered.indexOf('e sobre isso') > rendered.indexOf('Holerite'));
  assert.ok(rendered.indexOf('Queria entender') > rendered.indexOf('e sobre isso'));

  assert.match(rendered, /\[imagem\]/);
  assert.match(rendered, /\[legenda da imagem\] e esse aqui/);
  assert.match(rendered, /\[audio transcrito\]/);
});

test('midia que falhou aparece marcada, sem sumir do contexto', () => {
  const parts = [
    { type: 'audio', transcription: null, failed: true, error: 'whisper fora' },
    { type: 'image', description: null, caption: 'olha isso', failed: true },
  ];

  const rendered = normalizer.renderBatch(parts);
  assert.match(rendered, /nao foi possivel transcrever/);
  assert.match(rendered, /nao foi possivel analisar/);
  assert.match(rendered, /olha isso/, 'a legenda sobrevive mesmo sem a analise da imagem');
  assert.equal(normalizer.hasFailure(parts), true);
});

test('tipo sem suporte vira marcador legivel', () => {
  const rendered = normalizer.renderBatch([
    { type: 'unsupported', label: 'documento', caption: 'meu contrato' },
  ]);
  assert.equal(rendered, '[documento recebido] meu contrato');
});

test('plainText devolve so o que o contato disse, sem marcadores', () => {
  const parts = [
    { type: 'text', content: 'oi' },
    { type: 'audio', transcription: 'fui demitido' },
    { type: 'image', description: 'um holerite', caption: 'olha' },
  ];
  const plain = normalizer.plainText(parts);

  assert.equal(plain, 'oi fui demitido olha');
  assert.doesNotMatch(plain, /\[audio/, 'o anti-loop compara o texto real, nao os marcadores');
});

test('batchTypes reporta a composicao do lote', () => {
  const parts = [{ type: 'text' }, { type: 'audio' }, { type: 'image' }, { type: 'text' }];
  assert.deepEqual(normalizer.batchTypes(parts), ['text', 'audio', 'image', 'text']);
});

test('lote so de texto continua simples', () => {
  const rendered = normalizer.renderBatch([
    { type: 'text', content: 'Oi' },
    { type: 'text', content: 'vi o anuncio' },
    { type: 'text', content: 'como funciona' },
  ]);
  assert.equal(rendered, 'Oi\nvi o anuncio\ncomo funciona');
  assert.equal(normalizer.hasFailure([{ type: 'text' }]), false);
});
