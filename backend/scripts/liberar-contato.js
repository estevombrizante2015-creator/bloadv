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
 *
 * Nao mexe em quem pediu para parar de receber mensagem (`optedOut`): isso e
 * decisao do contato, nao estado de atendimento.
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
  const alvo = soDigitos(argumentos[0]);

  const filtro = { humanHandoff: true, optedOut: { $ne: true } };
  if (alvo) filtro.phoneNumber = alvo;

  const contatos = await Contact.find(filtro).lean();
  const pausadas = await Conversation.find({
    status: { $in: ['PAUSED', 'BOT_LOOP_DETECTED'] },
  }).lean();

  if (!contatos.length && !pausadas.length) {
    console.log('Nenhum contato calado. Todos os numeros estao atendendo normalmente.');
    return;
  }

  console.log(`\nContatos em atendimento humano (agente calado): ${contatos.length}`);
  for (const c of contatos) {
    console.log(
      `  ${c.channelId} | ${formatNumber(c.phoneNumber) || c.jid} | motivo: ${c.handoffReason || '-'}`
    );
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

  const { modifiedCount: liberados } = await Contact.updateMany(filtro, {
    $set: { humanHandoff: false, handoffReason: null },
  });

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
