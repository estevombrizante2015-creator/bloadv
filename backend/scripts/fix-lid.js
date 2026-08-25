#!/usr/bin/env node
/**
 * Preenche o telefone real das conversas enderecadas por LID.
 *
 * O WhatsApp usa `1234@lid` no lugar do telefone em muitos chats. O numero
 * real vem por fora (ver src/whatsapp/lid.resolver.js), mas conversas gravadas
 * antes desse tratamento ficaram sem ele — e o painel mostrava o identificador.
 *
 *   npm run fix:lid            preenche o que ja da para resolver
 *   npm run fix:lid -- --lista mostra o que falta, sem gravar nada
 *
 * O que nao for resolvido aqui se resolve sozinho: a proxima mensagem daquele
 * contato traz o telefone e o vinculo e gravado na hora.
 */
const mongoose = require('mongoose');
const { assertEnv } = require('../src/config/env');
const connectDB = require('../src/config/database');
const { Conversation } = require('../src/models');
const { isLidJid, jidToIdentifier, formatNumber } = require('../src/config/agents.config');
const lidResolver = require('../src/whatsapp/lid.resolver');

async function main() {
  assertEnv();
  await connectDB();
  await lidResolver.carregar();

  const soListar = process.argv.includes('--lista');

  const todas = await Conversation.find(
    {},
    { chatId: 1, phoneNumber: 1, isLid: 1, lid: 1, pushName: 1 }
  ).lean();

  const porLid = todas.filter((c) => isLidJid(c.chatId));
  const resolvidas = [];
  const pendentes = [];

  for (const conversa of porLid) {
    const lid = jidToIdentifier(conversa.chatId);
    const telefone = conversa.phoneNumber || lidResolver.resolver(lid);

    if (!telefone) {
      pendentes.push({ ...conversa, lid });
      continue;
    }
    if (conversa.phoneNumber === telefone && conversa.lid === lid) continue;

    resolvidas.push({ ...conversa, lid, telefone });

    if (!soListar) {
      await Conversation.updateOne(
        { _id: conversa._id },
        { $set: { isLid: true, lid, phoneNumber: telefone } }
      );
    }
  }

  console.log(`\n  ${todas.length} conversa(s), ${porLid.length} endereçada(s) por LID.`);
  console.log(
    `  ${resolvidas.length} com telefone ${soListar ? 'resolvivel' : 'preenchido'}, ` +
      `${pendentes.length} ainda sem.\n`
  );

  for (const c of resolvidas.slice(0, 20)) {
    console.log(`   ${c.pushName || 'sem nome'} — ${formatNumber(c.telefone)}`);
  }
  if (resolvidas.length > 20) console.log(`   ... e mais ${resolvidas.length - 20}`);

  if (pendentes.length) {
    console.log(
      `\n  As ${pendentes.length} pendentes se resolvem sozinhas na proxima mensagem` +
        ' de cada contato.\n'
    );
  }

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(`\n  Falhou: ${error.message}\n`);
  process.exit(1);
});
