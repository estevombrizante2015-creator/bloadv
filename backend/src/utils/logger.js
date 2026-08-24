const pino = require('pino');
const { env } = require('../config/env');

const logger = pino({
  level: env.logLevel,
  transport:
    env.nodeEnv === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
  redact: {
    paths: [
      'req.headers.authorization',
      'apiKey',
      'OPENAI_API_KEY',
      'creds',
      '*.creds',
      'auth',
      '*.auth',
    ],
    censor: '[redacted]',
  },
});

module.exports = logger;
