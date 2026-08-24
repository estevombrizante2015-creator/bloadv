const { env } = require('../config/env');
const rules = require('./rules');
const { GuardrailEvent } = require('../models');
const logger = require('../utils/logger');

/** Rate limit em memoria: janela deslizante por (canal, contato). */
const windows = new Map();

function rateLimited(key) {
  const now = Date.now();
  const windowMs = env.guard.rateLimitWindowMs;
  const hits = (windows.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  windows.set(key, hits);
  return hits.length > env.guard.rateLimitMsgs;
}

// Limpeza periodica para o Map nao crescer sem limite.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of windows) {
    const alive = hits.filter((t) => now - t < env.guard.rateLimitWindowMs);
    if (alive.length) windows.set(key, alive);
    else windows.delete(key);
  }
}, 60_000);
cleanupTimer.unref?.();

const todayKey = () => new Date().toISOString().slice(0, 10);

/** Contador global de tokens do dia (reiniciado na virada). */
let globalUsage = { day: todayKey(), tokens: 0 };

function addGlobalTokens(tokens) {
  const day = todayKey();
  if (globalUsage.day !== day) globalUsage = { day, tokens: 0 };
  globalUsage.tokens += tokens || 0;
}

function globalBudgetExceeded() {
  const limit = env.guard.globalDailyTokenBudget;
  if (!limit) return false;
  if (globalUsage.day !== todayKey()) globalUsage = { day: todayKey(), tokens: 0 };
  return globalUsage.tokens >= limit;
}

const getGlobalUsage = () => ({ ...globalUsage, limit: env.guard.globalDailyTokenBudget });

async function record({ channelId, jid, rule, severity, action, excerpt }) {
  try {
    await GuardrailEvent.create({
      channelId,
      jid,
      stage: 'input',
      rule,
      severity,
      action,
      excerpt: (excerpt || '').slice(0, 200),
    });
  } catch (error) {
    logger.warn({ err: error.message }, 'Falha ao registrar evento de guardrail');
  }
}

/**
 * Avalia a mensagem recebida ANTES de gastar qualquer token.
 * Retorna { allow, reply, flags, text, handoff, optOut }.
 */
async function check({ channelId, jid, text, type, contact }) {
  const flags = [];
  const ctx = { channelId, jid };

  if (contact?.blocked) {
    await record({ ...ctx, rule: 'contato_bloqueado', severity: 'block', action: 'ignorar' });
    return { allow: false, flags: ['contato_bloqueado'], silent: true };
  }

  if (contact?.optedOut) {
    return { allow: false, flags: ['opt_out_ativo'], silent: true };
  }

  if (contact?.humanHandoff) {
    return { allow: false, flags: ['handoff_humano_ativo'], silent: true };
  }

  if (type !== 'text' || !text || !text.trim()) {
    await record({ ...ctx, rule: 'tipo_nao_suportado', severity: 'info', action: 'resposta_padrao' });
    return {
      allow: false,
      flags: ['tipo_nao_suportado'],
      reply: 'Consigo ler apenas mensagens de texto por aqui. Pode me escrever o que precisa?',
    };
  }

  if (rules.isOptOut(text)) {
    await record({ ...ctx, rule: 'opt_out', severity: 'block', action: 'encerrar', excerpt: text });
    return {
      allow: false,
      optOut: true,
      flags: ['opt_out'],
      reply: 'Tudo bem, nao vou mais enviar mensagens por aqui. Se mudar de ideia, e so escrever.',
    };
  }

  if (rules.wantsHuman(text)) {
    await record({ ...ctx, rule: 'pedido_humano', severity: 'warn', action: 'handoff', excerpt: text });
    return {
      allow: false,
      handoff: 'pedido_do_contato',
      flags: ['pedido_humano'],
      reply: 'Claro. Ja estou passando para o advogado responsavel falar com voce por aqui.',
    };
  }

  // Conflito de interesses: quem escreve pode estar do outro lado do caso.
  if (rules.isParteContraria(text)) {
    await record({
      ...ctx,
      rule: 'possivel_parte_contraria',
      severity: 'block',
      action: 'handoff',
      excerpt: text,
    });
    return {
      allow: false,
      handoff: 'possivel_conflito_de_interesses',
      flags: ['possivel_parte_contraria'],
      reply:
        'Obrigado pelo contato. Para seguir com esse assunto preciso passar para um advogado do escritorio, ' +
        'que retorna para voce por aqui.',
    };
  }

  if (text.length > env.guard.maxInboundChars) {
    await record({ ...ctx, rule: 'mensagem_muito_longa', severity: 'warn', action: 'truncar' });
    flags.push('mensagem_truncada');
    text = text.slice(0, env.guard.maxInboundChars);
  }

  if (rateLimited(`${channelId}:${jid}`)) {
    await record({ ...ctx, rule: 'rate_limit', severity: 'block', action: 'silenciar' });
    return { allow: false, flags: ['rate_limit'], silent: true };
  }

  if (globalBudgetExceeded()) {
    await record({ ...ctx, rule: 'orcamento_global', severity: 'block', action: 'handoff' });
    return {
      allow: false,
      handoff: 'orcamento_global_excedido',
      flags: ['orcamento_global'],
      reply: 'Recebi sua mensagem. Alguem do time vai te responder em instantes.',
    };
  }

  const day = todayKey();
  const usage = contact?.tokenUsage?.day === day ? contact.tokenUsage.tokens : 0;
  if (env.guard.dailyTokenBudget && usage >= env.guard.dailyTokenBudget) {
    await record({ ...ctx, rule: 'orcamento_contato', severity: 'block', action: 'handoff' });
    return {
      allow: false,
      handoff: 'orcamento_contato_excedido',
      flags: ['orcamento_contato'],
      reply: 'Recebi sua mensagem. Vou pedir para alguem do time continuar com voce por aqui.',
    };
  }

  if (rules.hasInjection(text)) {
    await record({ ...ctx, rule: 'prompt_injection', severity: 'warn', action: 'isolar', excerpt: text });
    flags.push('prompt_injection');
  }

  const { text: redacted, found } = rules.redactPII(text);
  if (found.length) {
    await record({ ...ctx, rule: `pii:${found.join(',')}`, severity: 'warn', action: 'mascarar' });
    flags.push(...found.map((f) => `pii_${f}`));
  }

  return { allow: true, text: redacted, flags, injection: flags.includes('prompt_injection') };
}

module.exports = { check, addGlobalTokens, globalBudgetExceeded, getGlobalUsage, todayKey };
