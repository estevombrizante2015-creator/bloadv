const mongoose = require('mongoose');
const { env } = require('./env');
const logger = require('../utils/logger');

mongoose.set('strictQuery', true);

async function connectDB() {
  try {
    const conn = await mongoose.connect(env.mongoUri, {
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 10,
    });
    logger.info({ host: conn.connection.host, db: conn.connection.name }, 'MongoDB conectado');
    return conn;
  } catch (error) {
    // Erros de DNS no Atlas sao os mais comuns e os mais confusos:
    // vale dizer o que costuma ser, em vez de so repassar o ENOTFOUND.
    const dica = error.message.includes('querySrv')
      ? 'O host do Atlas nao resolveu. Verifique se o cluster terminou de ser criado, ' +
        'se o hostname na MONGO_URI esta correto e se o seu IP esta liberado em Network Access.'
      : error.message.includes('Authentication failed')
        ? 'Usuario ou senha invalidos na MONGO_URI. Senha com caracter especial precisa vir URL-encoded.'
        : null;

    logger.error({ err: error.message, dica }, 'Falha ao conectar no MongoDB');
    throw error;
  }
}

module.exports = connectDB;
