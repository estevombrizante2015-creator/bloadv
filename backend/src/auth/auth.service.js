const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { User } = require('../models');
const logger = require('../utils/logger');

const scrypt = promisify(crypto.scrypt);

/**
 * Autenticacao do painel.
 *
 * Hash de senha com scrypt do proprio Node: memory-hard, sem dependencia
 * nativa (bcrypt quebra com frequencia no Windows) e sem lib de terceiros
 * no caminho mais sensivel do sistema.
 *
 * Formato guardado: scrypt$N$r$p$saltHex$hashHex
 */

const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 64 };

async function hashPassword(plain) {
  if (!plain || plain.length < 8) {
    throw new Error('A senha precisa ter ao menos 8 caracteres');
  }
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(plain, salt, SCRYPT.keyLen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$');
}

/** Comparacao em tempo constante: nao vaza informacao pelo tempo de resposta. */
async function verifyPassword(plain, stored) {
  if (!plain || !stored) return false;

  const [algo, N, r, p, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;

  try {
    const derived = await scrypt(plain, Buffer.from(saltHex, 'hex'), hashHex.length / 2, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(derived, Buffer.from(hashHex, 'hex'));
  } catch (error) {
    logger.warn({ err: error.message }, 'Falha ao verificar senha');
    return false;
  }
}

// ------------------------------------------------------------------ token

/**
 * @param {boolean} remember true = "manter conectado", token de longa duracao.
 */
const signToken = (user, remember = false) =>
  jwt.sign(
    { sub: user._id.toString(), email: user.email, role: user.role, rem: remember || undefined },
    env.auth.jwtSecret,
    {
      expiresIn: remember ? env.auth.jwtRememberExpiresIn : env.auth.jwtExpiresIn,
      issuer: 'whatsagent',
    }
  );

function verifyToken(token) {
  try {
    return jwt.verify(token, env.auth.jwtSecret, { issuer: 'whatsagent' });
  } catch {
    return null;
  }
}

/** Extrai o token do header Authorization ou do handshake do socket. */
function extractToken(source) {
  const header = source?.headers?.authorization || source?.handshake?.headers?.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return source?.handshake?.auth?.token || null;
}

// ------------------------------------------------------------------ login

const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;

/**
 * Valida credenciais. Erros sao deliberadamente genericos: dizer "email nao
 * existe" entrega quais contas sao validas para quem esta tentando adivinhar.
 *
 * @returns {{ok: true, user, token} | {ok: false, error: string, status: number}}
 */
async function login({ email, password, remember = false }) {
  const normalized = String(email || '').toLowerCase().trim();

  if (!normalized || !password) {
    return { ok: false, status: 400, error: 'Informe email e senha' };
  }

  const user = await User.findOne({ email: normalized }).select('+passwordHash');

  if (!user || !user.active) {
    // Mesmo sem usuario, gasta tempo comparavel para nao entregar a diferenca.
    await verifyPassword(password, 'scrypt$16384$8$1$00$00');
    return { ok: false, status: 401, error: 'Email ou senha invalidos' };
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutos = Math.ceil((user.lockedUntil - Date.now()) / 60000);
    return { ok: false, status: 429, error: `Conta bloqueada. Tente em ${minutos} min.` };
  }

  const valid = await verifyPassword(password, user.passwordHash);

  if (!valid) {
    user.failedAttempts = (user.failedAttempts || 0) + 1;
    if (user.failedAttempts >= LOCK_AFTER) {
      user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
      user.failedAttempts = 0;
      logger.warn({ email: normalized }, 'Conta bloqueada por tentativas seguidas');
    }
    await user.save();
    return { ok: false, status: 401, error: 'Email ou senha invalidos' };
  }

  user.failedAttempts = 0;
  user.lockedUntil = null;
  user.lastLoginAt = new Date();
  await user.save();

  logger.info({ email: normalized, role: user.role }, 'Login no painel');

  return {
    ok: true,
    user: user.toPublic(),
    token: signToken(user, remember),
    expiresIn: remember ? env.auth.jwtRememberExpiresIn : env.auth.jwtExpiresIn,
  };
}

async function createUser({ email, password, name, role = 'curador' }) {
  const normalized = String(email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Email invalido');
  }

  const passwordHash = await hashPassword(password);

  const user = await User.findOneAndUpdate(
    { email: normalized },
    { $set: { passwordHash, name, role, active: true, failedAttempts: 0, lockedUntil: null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return user.toPublic();
}

const countUsers = () => User.countDocuments({ active: true });

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  extractToken,
  login,
  createUser,
  countUsers,
};
