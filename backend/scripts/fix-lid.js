#!/usr/bin/env node
/**
 * Corrige conversas gravadas antes do tratamento de LID.
 *
 * O WhatsApp usa `1234@lid` no lugar do telefone em muitos chats. Antes,
 * o identificador era guardado como se fosse numero e o painel exibia coisas
 * como "+40351318433948".
 */
const mongoose = require('mongoose');
const { assertEnv } = require('../src/config/env');
const connectDB = require('../src/config/database');
const { Conversation } = require('../src/models');
const { isLidJid, jidToIdentifier } = require('../src/config/agents.config');

async function main() {
  assertEnv();
  await connectDB();

  const todas = await Conversation.find({}, { chatId: 1, phoneNumber: 1, isLid: 1 }).lean();
  let corrigidas = 0;

  for (const c of todas) {
    if (!isLidJid(c.chatId)) continue;
    if (c.isLid && !c.phoneNumber) continue;

    await Conversation.updateOne(
      { _id: c._id },
      { $set: { isLid: true, lid: jidToIdentifier(c.chatId), phoneNumber: null } }
    );
    corrigidas += 1;
  }

  console.log(`\n  ${todas.length} conversa(s) verificada(s), ${corrigidas} corrigida(s).\n`);
  await mongoose.connection.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(`\n  Falhou: ${error.message}\n`);
  process.exit(1);
});
