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

/**
 * Consumo do dia, para o painel. `limit: null` e explicito: a tela precisa
 * dizer "sem teto", nao deixar em branco e parecer dado faltando.
 */
const getGlobalUsage = () => ({ ...globalUsage, limit: null });

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

  /**
   * O contato foi entregue a uma pessoa do escritorio: o agente cala.
   *
   * O descarte e registrado — antes nao era. Sem registro, uma conversa que
   * caiu aqui por acidente (um limite tecnico, um handoff automatico) ficava
   * muda para sempre e nao aparecia em lugar nenhum: nem log, nem painel, nem
   * metrica. E o handoff nao expira sozinho; so sai daqui por "Retomar".
   */
  if (contact?.humanHandoff) {
    await record({
      ...ctx,
      rule: 'handoff_humano_ativo',
      severity: 'info',
      action: 'silenciar',
      excerpt: text,
    });
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

  /**
   * NAO EXISTE TETO DE TOKENS. Nem por contato, nem por dia, nem por variavel
   * de ambiente — o codigo nao tem mais onde ligar isso.
   *
   * O teto anterior interrompia a triagem no meio: um print de conversa custou
   * 58 mil tokens de leitura de imagem e derrubou o limite diario de uma pessoa
   * em UM turno. As oito mensagens seguintes dela ficaram sem resposta nenhuma,
   * e a conversa terminou com um "muito obrigado" para um atendimento que nunca
   * respondeu. Um lead perdido custa muito mais que a diferenca de tokens.
   *
   * O consumo continua contado e visivel (getGlobalUsage, tokenUsage do
   * contato, painel de custo da OpenAI) — o que nao existe mais e algo que
   * transforme consumo em silencio. Contra rajada e loop continua valendo o
   * rate limit por minuto, que e protecao de comportamento, nao de gasto.
   */

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

module.exports = { check, addGlobalTokens, getGlobalUsage, todayKey };
