#!/usr/bin/env node
/**
 * Devolve o agente a contatos que ficaram mudos.
 *
 * O silencio do agente mora em dois documentos: `Conversation.status`
 * (conversa pausada) e `Contact.humanHandoff` (contato entregue a uma pessoa).
 * O guardrail de entrada le o segundo antes de tudo e descarta a mensagem sem
 * responder nada — nem para o contato, nem no log.
 *
 * Nenhum dos dois expira sozinho. Quando um limite tecnico marcou o handoff
 * (orcamento de tokens estourado, por exemplo), a conversa morre ali e so volta
 * por acao humana. O painel ja tem o botao Retomar; este script existe para o
 * caso em que a conversa nem aparece como pausada, e para desfazer em lote o
 * estrago de um limite mal calibrado.
 *
 *   npm run liberar                     lista quem esta calado, sem gravar
 *   npm run liberar -- --todos          libera todos os listados
 *   npm run liberar -- 5511999998888    libera um numero
 *   npm run liberar -- 5511999998888 --desfazer-optout
 *
 * Opt-out (`optedOut`) e decisao do contato, nao estado de atendimento, e por
 * isso fica de fora do lote. Mas a regra de descadastro ja marcou gente por
 * engano — ela procurava as palavras por substring, e "decidi sair" no meio de
 * um relato bastava — e um contato assim nao aparece nem como conversa
 * pausada. `--desfazer-optout` existe para esses casos: exige um numero
 * explicito, um de cada vez, para nunca virar um "reativar todo mundo".
 */
const mongoose = require('mongoose');
const { assertEnv } = require('../src/config/env');
const connectDB = require('../src/config/database');
const { Contact, Conversation } = require('../src/models');
const { formatNumber } = require('../src/config/agents.config');

const soDigitos = (v) => String(v || '').replace(/\D/g, '');

async function main() {
  assertEnv();
  await connectDB();

  const argumentos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const todos = process.argv.includes('--todos');
  const desfazerOptOut = process.argv.includes('--desfazer-optout');
  const alvo = soDigitos(argumentos[0]);

  if (desfazerOptOut && !alvo) {
    console.log('--desfazer-optout precisa do numero (ou do jid) de quem sera reativado.');
    return;
  }

  /**
   * O alvo pode vir como telefone ou como LID. Muitos chats do WhatsApp sao
   * enderecados por `1234@lid` e o telefone real pode nem estar gravado —
   * exigir o numero deixaria de fora justamente os contatos mais dificeis de
   * achar no painel.
   */
  const bruto = argumentos[0] || '';

  /**
   * Quem foi marcado como descadastrado tem `humanHandoff` em false: o filtro
   * padrao nem o encontraria. Por isso o alvo do `--desfazer-optout` e outro.
   */
  const condicoes = [
    desfazerOptOut
      ? { $or: [{ humanHandoff: true }, { optedOut: true }] }
      : { humanHandoff: true, optedOut: { $ne: true } },
  ];

  if (alvo && bruto.includes('@')) condicoes.push({ jid: bruto });
  else if (alvo) condicoes.push({ $or: [{ phoneNumber: alvo }, { jid: new RegExp(`^${alvo}@`) }] });

  const filtro = condicoes.length > 1 ? { $and: condicoes } : condicoes[0];

  const contatos = await Contact.find(filtro).lean();
  const pausadas = await Conversation.find({
    status: { $in: ['PAUSED', 'BOT_LOOP_DETECTED'] },
  }).lean();

  if (!contatos.length && !pausadas.length) {
    console.log('Nenhum contato calado. Todos os numeros estao atendendo normalmente.');
    return;
  }

  console.log(`\nContatos com o agente calado: ${contatos.length}`);
  for (const c of contatos) {
    const motivo = c.optedOut ? 'descadastrado (opt-out)' : c.handoffReason || 'atendimento humano';
    console.log(`  ${c.channelId} | ${formatNumber(c.phoneNumber) || c.jid} | motivo: ${motivo}`);
  }

  console.log(`\nConversas pausadas: ${pausadas.length}`);
  for (const c of pausadas) {
    console.log(`  ${c.sessionId} | ${c.chatId} | motivo: ${c.pausedReason || c.status}`);
  }

  if (!todos && !alvo) {
    console.log('\nNada foi alterado. Use --todos, ou passe um numero, para liberar.');
    return;
  }

  const jids = contatos.map((c) => c.jid);

  const mudancas = { humanHandoff: false, handoffReason: null };
  if (desfazerOptOut) mudancas.optedOut = false;

  const { modifiedCount: liberados } = await Contact.updateMany(filtro, { $set: mudancas });

  const filtroConversa = alvo
    ? { chatId: { $in: jids }, status: { $in: ['PAUSED', 'BOT_LOOP_DETECTED'] } }
    : { status: { $in: ['PAUSED', 'BOT_LOOP_DETECTED'] } };

  const { modifiedCount: retomadas } = await Conversation.updateMany(filtroConversa, {
    $set: {
      status: 'WAITING_USER',
      pausedReason: null,
      pausedAt: null,
      loopCounter: 0,
      repeatCounter: 0,
      fastReplyStreak: 0,
      possibleBot: false,
      processing: false,
    },
  });

  console.log(`\n${liberados} contato(s) liberado(s), ${retomadas} conversa(s) retomada(s).`);
  console.log('O agente volta a responder na proxima mensagem de cada um.');
}

main()
  .catch((error) => {
    console.error('Falhou:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect().catch(() => {}));
