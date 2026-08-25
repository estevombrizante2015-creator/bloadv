const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste';

// A pasta de sessoes vai para um temporario: `clearCredentials` apaga o
// diretorio, e um teste jamais pode encostar em backend/sessions.
process.env.WA_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-teste-'));

const { BaileysManager } = require('../src/whatsapp/baileys.manager');
const authStore = require('../src/whatsapp/auth.store');

/**
 * O PAREAMENTO NAO PODE SE PERDER
 * -------------------------------
 * O sintoma que originou estes testes: "sempre que reinicio o servidor preciso
 * ler o QR de novo".
 *
 * Sao duas causas possiveis, e as duas tem teste aqui:
 *   1. as credenciais nao sobreviverem ao restart (resolvido guardando-as no
 *      banco — coberto pelo teste de ida e volta do auth.store);
 *   2. o proprio codigo destruir a sessao ao encerrar.
 *
 * A (2) e a mais traicoeira: `sock.logout()` derruba a sessao NO APARELHO e
 * exige QR novo, enquanto `sock.end()` apenas fecha o socket. Trocar um pelo
 * outro no caminho de shutdown produz exatamente o sintoma relatado, e nada no
 * log denuncia.
 */

/** Socket falso que registra o que foi chamado nele. */
function socketFalso() {
  const chamadas = [];
  return {
    chamadas,
    end: (...args) => chamadas.push(['end', args]),
    logout: (...args) => chamadas.push(['logout', args]),
    ev: { removeAllListeners: () => chamadas.push(['removeAllListeners']) },
  };
}

/** Manager isolado, com a gravacao no banco neutralizada. */
function managerDeTeste() {
  const m = new BaileysManager();
  m.patch = async function patchFake(channelId, changes) {
    Object.assign(this.getState(channelId), changes);
  };
  return m;
}

test('encerrar o servidor NAO desloga o WhatsApp', async () => {
  // `logout()` aqui significaria pedir QR novo a cada deploy.
  const m = managerDeTeste();
  const sock = socketFalso();
  m.initState('leads-1').sock = sock;

  await m.shutdown();

  const metodos = sock.chamadas.map(([nome]) => nome);
  assert.ok(metodos.includes('end'), 'o socket precisa ser fechado');
  assert.ok(!metodos.includes('logout'), 'shutdown jamais pode deslogar a conta');
});

test('desconectar pelo painel mantem as credenciais', async () => {
  // "Desconectar" e para parar de atender, nao para desparear. Quem quer
  // desparear clica em sair, que e outra acao.
  const m = managerDeTeste();
  const sock = socketFalso();
  m.initState('leads-1').sock = sock;

  let apagou = false;
  m.clearCredentials = async () => {
    apagou = true;
  };

  await m.disconnect('leads-1');

  assert.equal(apagou, false, 'desconectar nao pode apagar credencial');
  assert.ok(!sock.chamadas.some(([nome]) => nome === 'logout'));
});

test('fechar o socket para reconectar nao apaga credencial', async () => {
  const m = managerDeTeste();
  m.initState('leads-1').sock = socketFalso();

  let apagou = false;
  m.clearCredentials = async () => {
    apagou = true;
  };

  await m.teardown('leads-1');
  assert.equal(apagou, false, 'teardown roda antes de toda reconexao');
});

test('sair de verdade desloga no aparelho e apaga a credencial', async () => {
  // O outro lado da moeda: quando a pessoa PEDE para sair, tem de sair mesmo.
  const m = managerDeTeste();
  const sock = socketFalso();
  m.initState('leads-1').sock = sock;

  let apagou = false;
  m.clearCredentials = async () => {
    apagou = true;
  };

  await m.logout('leads-1');

  assert.ok(sock.chamadas.some(([nome]) => nome === 'logout'), 'derruba a sessao no aparelho');
  assert.equal(apagou, true, 'e apaga o que estava guardado');
});

test('o painel sabe se precisa de QR pelo que esta guardado, nao pelo disco', () => {
  // A pergunta "preciso ler o QR?" passou a ser respondida pelo banco. Se ela
  // voltasse a olhar o sistema de arquivos, o sintoma reapareceria em silencio
  // no primeiro deploy.
  const m = managerDeTeste();
  m.initState('leads-1');

  assert.equal(m.hasCredentials('leads-1'), authStore.temCredenciais('leads-1'));
  assert.equal(m.publicState('leads-1').hasCredentials, authStore.temCredenciais('leads-1'));
});

test('o estado publico nunca carrega credencial nem socket', () => {
  const m = managerDeTeste();
  const state = m.initState('leads-1');
  state.sock = socketFalso();

  const publico = m.publicState('leads-1');

  assert.equal(publico.sock, undefined, 'o socket nunca vai para o navegador');
  assert.equal(publico.creds, undefined);
  assert.ok(!JSON.stringify(publico).includes('logout'));
});
