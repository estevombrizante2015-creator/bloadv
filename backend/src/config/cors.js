const { env } = require('./env');

/**
 * Politica de CORS.
 *
 * Producao: apenas a lista explicita de CORS_ORIGIN.
 *
 * Desenvolvimento: alem da lista, aceita localhost, 127.0.0.1 e enderecos de
 * rede privada em qualquer porta. Sem isso, abrir o painel por 127.0.0.1 ou
 * pelo IP da maquina - o que e comum para ler o QR pelo celular - falha com
 * um "Failed to fetch" que nao explica nada.
 */
const LOCAL_HOSTNAME = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

/** Faixas privadas da RFC 1918: a rede de casa ou do escritorio. */
const PRIVATE_IP =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

function isLocalOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return LOCAL_HOSTNAME.test(hostname) || PRIVATE_IP.test(hostname);
  } catch {
    return false;
  }
}

/**
 * Callback do @fastify/cors.
 * Origin ausente (curl, app nativo, same-origin) e liberado: CORS e uma
 * protecao do navegador, e nao ha navegador nesse caso.
 */
function corsOrigin(origin, callback) {
  if (!origin) return callback(null, true);
  if (env.corsOrigin.includes('*')) return callback(null, true);
  if (env.corsOrigin.includes(origin)) return callback(null, true);
  if (env.corsAllowLocalNetwork && isLocalOrigin(origin)) return callback(null, true);

  return callback(null, false);
}

module.exports = { corsOrigin, isLocalOrigin };
