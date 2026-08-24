#!/usr/bin/env node
/**
 * Cria (ou atualiza a senha de) um usuario do painel.
 *
 *   npm run create:user -- email@escritorio.com "senha-forte"
 *   npm run create:user -- email@escritorio.com "senha-forte" --nome "Dra. Fulana" --admin
 *
 * Rodar sem argumentos lista os usuarios existentes.
 */
const mongoose = require('mongoose');
const { assertEnv } = require('../src/config/env');
const connectDB = require('../src/config/database');
const authService = require('../src/auth/auth.service');
const { User } = require('../src/models');

async function main() {
  assertEnv();
  await connectDB();

  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const nomeIdx = args.indexOf('--nome');

  if (!positional.length) {
    const users = await User.find().lean();
    if (!users.length) {
      console.log('\n  Nenhum usuario cadastrado. Crie o primeiro:');
      console.log('  npm run create:user -- voce@escritorio.com "sua-senha-forte"\n');
    } else {
      console.log(`\n  ${users.length} usuario(s):`);
      for (const u of users) {
        console.log(`   - ${u.email} (${u.role})${u.active ? '' : ' [inativo]'}`);
      }
      console.log();
    }
    process.exit(0);
  }

  const [email, password] = positional;
  if (!password) {
    console.error('\n  Informe a senha: npm run create:user -- email "senha"\n');
    process.exit(1);
  }

  const user = await authService.createUser({
    email,
    password,
    name: nomeIdx > -1 ? args[nomeIdx + 1] : undefined,
    role: args.includes('--admin') ? 'admin' : 'operador',
  });

  console.log(`\n  Usuario pronto: ${user.email} (${user.role})`);
  console.log('  Entre em http://localhost:3000\n');

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(`\n  Falhou: ${error.message}\n`);
  process.exit(1);
});
