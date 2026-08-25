const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste';

const lid = require('../src/whatsapp/lid.resolver');

/**
 * TELEFONE REAL POR TRAS DO LID
 * -----------------------------
 * O bug que estes testes travam: o painel exibia o identificador `@lid` como se
 * fosse telefone, produzindo numeros que nao existem ("+40351318433948").
 *
 * `aprender` grava em segundo plano e nao espera o banco - por isso estes
 * testes rodam sem conexao nenhuma e mesmo assim exercitam o caminho inteiro.
 * A persistencia de verdade e coberta contra um Mongo real.
 */

const mensagem = (remoteJid, extras = {}) => ({
  key: { remoteJid, id: 'ABC123', fromMe: false, ...extras },
});

// -------------------------------------------------------------- chat comum

test('chat comum: o telefone sai do proprio endereco', () => {
  const { phoneNumber, lid: identificador } = lid.doMensagem(
    mensagem('5519996383884@s.whatsapp.net')
  );

  assert.equal(phoneNumber, '5519996383884');
  assert.equal(identificador, null, 'nao ha LID envolvido');
});

test('sufixo de dispositivo no endereco nao entra no telefone', () => {
  const { phoneNumber } = lid.doMensagem(mensagem('5519996383884:12@s.whatsapp.net'));
  assert.equal(phoneNumber, '5519996383884');
});

// ---------------------------------------------------------------- chat LID

test('chat por LID: o telefone vem em senderPn, nao do identificador', () => {
  // Este e o caso do bug. O identificador (12036159274582) nao tem relacao
  // nenhuma com o telefone e nunca pode ser exibido como tal.
  const { phoneNumber, lid: identificador } = lid.doMensagem(
    mensagem('12036159274582@lid', { senderPn: '5511940061595@s.whatsapp.net' })
  );

  assert.equal(phoneNumber, '5511940061595');
  assert.equal(identificador, '12036159274582');
  assert.notEqual(phoneNumber, identificador);
});

test('em grupo, o telefone vem em participantPn', () => {
  const { phoneNumber, origem } = lid.doMensagem(
    mensagem('99999@lid', { participantPn: '5519987587782@s.whatsapp.net' })
  );

  assert.equal(phoneNumber, '5519987587782');
  assert.equal(origem, 'participantPn');
});

test('senderPn tem precedencia sobre participantPn', () => {
  const { phoneNumber, origem } = lid.doMensagem(
    mensagem('88888@lid', {
      senderPn: '5511111111111@s.whatsapp.net',
      participantPn: '5522222222222@s.whatsapp.net',
    })
  );

  assert.equal(phoneNumber, '5511111111111');
  assert.equal(origem, 'senderPn');
});

test('LID sem telefone e sem vinculo conhecido nao inventa numero', () => {
  const { phoneNumber, lid: identificador } = lid.doMensagem(mensagem('7777777777@lid'));

  assert.equal(phoneNumber, null, 'melhor sem numero do que com numero errado');
  assert.equal(identificador, '7777777777');
});

// ------------------------------------------------------------------ memoria

test('o telefone descoberto vale para as mensagens seguintes, sem senderPn', () => {
  // `senderPn` nao vem em toda mensagem. Sem memoria, o painel perderia o
  // telefone no turno seguinte e voltaria a mostrar o identificador.
  const chat = '5550001111@lid';

  lid.observarMensagem(mensagem(chat, { senderPn: '5519998887766@s.whatsapp.net' }));

  const seguinte = lid.doMensagem(mensagem(chat));
  assert.equal(seguinte.phoneNumber, '5519998887766');
});

test('resolver aceita o endereco completo ou so o identificador', () => {
  lid.aprender({ lid: '4440001@lid', phoneNumber: '5511912345678' });

  assert.equal(lid.resolver('4440001@lid'), '5511912345678');
  assert.equal(lid.resolver('4440001'), '5511912345678');
  assert.equal(lid.resolver('nao-existe'), null);
});

test('numero curto ou vazio nao vira vinculo', () => {
  // Gravar lixo aqui e pior que nao ter o vinculo: o painel passaria a exibir
  // com confianca um numero que nao e de ninguem.
  assert.equal(lid.aprender({ lid: '111@lid', phoneNumber: '123' }), null);
  assert.equal(lid.aprender({ lid: '111@lid', phoneNumber: '' }), null);
  assert.equal(lid.aprender({ lid: '', phoneNumber: '5519996383884' }), null);
  assert.equal(lid.resolver('111'), null);
});

test('mascara e sufixo sao limpos antes de gravar', () => {
  lid.aprender({ lid: '3330001@lid', phoneNumber: '+55 (19) 99638-3884@s.whatsapp.net' });
  assert.equal(lid.resolver('3330001'), '5519996383884');
});

// ------------------------------------------------------------ outras fontes

test('o evento de compartilhamento de telefone tambem ensina o vinculo', () => {
  lid.observarCompartilhamento({ lid: '6660001@lid', jid: '5511999990000@s.whatsapp.net' });
  assert.equal(lid.resolver('6660001'), '5511999990000');
});

test('a agenda resolve conversas antigas, que nunca trouxeram senderPn', () => {
  const aprendidos = lid.observarContatos([
    { id: '5550002@lid', lid: '5550002@lid', jid: '5519911112222@s.whatsapp.net' },
    { id: '5519933334444@s.whatsapp.net', name: 'sem lid, ignorado' },
    { lid: '5550003@lid', jid: '5519955556666@s.whatsapp.net' },
  ]);

  assert.equal(aprendidos, 2);
  assert.equal(lid.resolver('5550002'), '5519911112222');
  assert.equal(lid.resolver('5550003'), '5519955556666');
});

test('contato sem par completo nao gera vinculo', () => {
  assert.equal(lid.observarContatos([{ id: '9990001@lid' }, {}, null]), 0);
});

// ------------------------------------------------- sincronizacao inicial

test('a sincronizacao inicial ensina os vinculos da agenda inteira', () => {
  // `messaging-history.set` traz os contatos no formato do history sync:
  // `id` e o endereco do chat, `jid` o telefone e `lid` o identificador. E a
  // fonte mais rica, e a unica que resolve conversas antigas sem esperar
  // mensagem nova.
  const aprendidos = lid.observarContatos([
    { id: '5519996383884@s.whatsapp.net', jid: '5519996383884@s.whatsapp.net', lid: '77770001@lid' },
    { id: '5511940061595@s.whatsapp.net', jid: '5511940061595@s.whatsapp.net', lid: '77770002@lid' },
    // Contato sem LID: nao ha vinculo a aprender, e nao pode quebrar o resto.
    { id: '5519987587782@s.whatsapp.net', jid: '5519987587782@s.whatsapp.net' },
  ]);

  assert.equal(aprendidos, 2);
  assert.equal(lid.resolver('77770001'), '5519996383884');
  assert.equal(lid.resolver('77770002'), '5511940061595');
});

test('um LID jamais e gravado no lugar do telefone', () => {
  // A protecao mais importante: gravar o identificador como se fosse numero e
  // exatamente o bug original, so que agora com a confianca de estar no banco.
  assert.equal(lid.aprender({ lid: '88880001@lid', phoneNumber: '12036159274582@lid' }), null);
  assert.equal(lid.resolver('88880001'), null);

  // Nem pela agenda, onde `jid` poderia vir preenchido com outro LID.
  assert.equal(lid.observarContatos([{ id: '88880002@lid', lid: '88880002@lid', jid: '999@lid' }]), 0);
  assert.equal(lid.resolver('88880002'), null);
});

// -------------------------------------------------------- numero digitado

const { comDdiBrasil } = require('../src/config/agents.config');

test('numero digitado a mao ganha o DDI, sem estragar o DDD 55', () => {
  // Testar so `startsWith('55')` corromperia Santa Maria/RS: "55 99999-9999"
  // viraria um numero com DDI e sem DDD.
  assert.equal(comDdiBrasil('(19) 99638-3884'), '5519996383884', 'celular sem DDI');
  assert.equal(comDdiBrasil('1933334444'), '551933334444', 'fixo sem DDI');
  assert.equal(comDdiBrasil('55 99999-9999'), '5555999999999', 'DDD 55 nao e confundido com DDI');
  assert.equal(comDdiBrasil('5533334444'), '555533334444', 'fixo no DDD 55');

  // Ja com DDI, nada muda.
  assert.equal(comDdiBrasil('+55 19 99638-3884'), '5519996383884');
  assert.equal(comDdiBrasil('5519996383884'), '5519996383884');
  assert.equal(comDdiBrasil('551933334444'), '551933334444');

  assert.equal(comDdiBrasil(''), null);
});
