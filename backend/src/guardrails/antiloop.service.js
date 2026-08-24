const crypto = require('crypto');
const { env } = require('../config/env');
const { Conversation } = require('../models');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

/**
 * PROTECAO BOT x BOT
 * ------------------
 * Nenhum sinal isolado prova que do outro lado ha um robo. Conta Business nao
 * prova nada - muita empresa legitima usa Business, e bloquear por isso custaria
 * leads reais. Por isso aqui se acumula EVIDENCIA de varias camadas e so a
 * combinacao pausa o agente.
 *
 * Camadas:
 *  1. fromMe                     -> tratado antes, no manager (nunca chega aqui)
 *  2. texto com cara de automatico (ausencia, boas-vindas, menu)
 *  3. resposta rapida demais, repetidas vezes (humano nao responde em 300ms sempre)
 *  4. repeticao: mesma entrada ou mesma saida se repetindo (A->B->A->B)
 *  5. contador de interacoes consecutivas sem evidencia humana
 */

const normalize = (text) =>
  (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const hash = (text) => crypto.createHash('sha1').update(normalize(text)).digest('hex').slice(0, 16);

/** Frases tipicas de resposta automatica de WhatsApp Business e afins. */
const AUTO_REPLY_PATTERNS = [
  /\b(mensagem|resposta) autom[aá]tica\b/i,
  /\bestamos (fora do|ausentes|indispon[ií]veis)/i,
  /\b(fora do )?hor[aá]rio de (atendimento|funcionamento)\b/i,
  /\bnosso (hor[aá]rio|atendimento) (e|é|funciona)\b.{0,40}\d{1,2}h/i,
  /\bretornaremos (o seu contato|assim que|em breve)\b/i,
  /\bobrigado por entrar em contato\b.{0,60}\b(em breve|assim que)\b/i,
  /\bdigite (o n[uú]mero|uma op[cç][aã]o|\d)\b/i,
  /\bescolha uma (das )?op[cç][oõ]es\b/i,
  /\bpara falar com \w+, digite\b/i,
  /^\s*\d\s*[-)]\s*\w+/m, // menu numerado: "1 - Vendas"
  /\bn[aã]o responda a esta mensagem\b/i,
  /\besta e uma mensagem autom[aá]tica\b/i,
  /\bassistente virtual\b/i,
  /\bbot\b.{0,20}\batendimento\b/i,
];

/** Sinal isolado e fraco: registra, mas sozinho nao pausa nada. */
function looksAutomatic(text) {
  const content = text || '';
  if (!content.trim()) return { automatic: false, signals: [] };

  const signals = [];
  for (const pattern of AUTO_REPLY_PATTERNS) {
    if (pattern.test(content)) {
      signals.push('texto_automatico');
      break;
    }
  }

  // Menu longo com muitas linhas numeradas.
  const numbered = (content.match(/^\s*\d+\s*[-).]/gm) || []).length;
  if (numbered >= 3) signals.push('menu_numerado');

  return { automatic: signals.length > 0, signals };
}

/**
 * Avalia a mensagem recebida contra o estado da conversa.
 * Nao grava nada - quem decide e o chamador, que ja tem o documento em maos.
 *
 * @returns {{block: boolean, reason?: string, signals: string[], patch: object}}
 */
function evaluateInbound({ conversation, text, receivedAt = Date.now() }) {
  const signals = [];
  const patch = {};
  const cfg = env.antiloop;

  const inboundHash = hash(text);
  const { automatic, signals: textSignals } = looksAutomatic(text);
  signals.push(...textSignals);

  // --- camada 3: cadencia sobre-humana ---
  const lastAgentAt = conversation?.lastAgentMessageAt?.getTime?.();
  const gap = lastAgentAt ? receivedAt - lastAgentAt : null;
  let fastStreak = conversation?.fastReplyStreak || 0;

  if (gap !== null && gap >= 0 && gap < cfg.minHumanGapMs) {
    fastStreak += 1;
    signals.push('resposta_instantanea');
  } else if (gap !== null) {
    fastStreak = 0;
  }
  patch.fastReplyStreak = fastStreak;

  if (fastStreak >= cfg.fastReplyStreak) signals.push('cadencia_automatica');

  // --- camada 4: mesma entrada se repetindo ---
  if (conversation?.lastInboundHash && conversation.lastInboundHash === inboundHash) {
    signals.push('entrada_repetida');
  }
  patch.lastInboundHash = inboundHash;

  // --- camada 5: interacoes consecutivas sem evidencia humana ---
  let loopCounter = conversation?.loopCounter || 0;
  if (signals.length > 0) loopCounter += 1;
  else loopCounter = 0; // uma mensagem claramente humana zera a suspeita
  patch.loopCounter = loopCounter;

  const possibleBot = signals.length > 0 || Boolean(conversation?.possibleBot);
  patch.possibleBot = possibleBot;
  if (signals.length) {
    patch.botSignals = [...new Set([...(conversation?.botSignals || []), ...signals])].slice(-10);
  }

  // Decisao: so pausa com evidencia acumulada, nunca com um sinal solto.
  if (loopCounter >= cfg.maxAutoInteractions) {
    return {
      block: true,
      reason: 'possible_bot_loop',
      signals,
      automatic,
      patch: {
        ...patch,
        status: Conversation.STATUS.BOT_LOOP_DETECTED,
        pausedReason: 'possible_bot_loop',
        pausedAt: new Date(),
      },
    };
  }

  return { block: false, signals, automatic, patch };
}

/**
 * Avalia a resposta ANTES de enviar (segunda checagem do pipeline).
 * Se estamos repetindo a mesma coisa, o outro lado nao esta evoluindo a conversa.
 */
function evaluateOutbound({ conversation, text }) {
  const cfg = env.antiloop;
  const outboundHash = hash(text);
  const patch = { lastOutboundHash: outboundHash };

  let repeatCounter = conversation?.lastOutboundHash === outboundHash
    ? (conversation?.repeatCounter || 0) + 1
    : 0;
  patch.repeatCounter = repeatCounter;

  if (repeatCounter >= cfg.maxRepeats) {
    return {
      block: true,
      reason: 'resposta_repetida',
      patch: {
        ...patch,
        status: Conversation.STATUS.BOT_LOOP_DETECTED,
        possibleBot: true,
        pausedReason: 'resposta_repetida',
        pausedAt: new Date(),
      },
    };
  }

  return { block: false, patch };
}

/** Log padronizado dos sinais, para diagnosticar sem reproduzir o caso. */
function logSignals({ channelId, chatId, signals, loopCounter, blocked, reason }) {
  if (blocked) {
    logger.warn(
      { ev: EV.BOT_LOOP_DETECTED, channelId, chatId, signals, loopCounter, reason },
      'Loop bot x bot detectado, agente pausado nesta conversa'
    );
  } else if (signals?.length) {
    logger.info(
      { ev: EV.POSSIBLE_BOT_DETECTED, channelId, chatId, signals, loopCounter },
      'Sinais de automacao no contato'
    );
  }
}

module.exports = {
  evaluateInbound,
  evaluateOutbound,
  looksAutomatic,
  logSignals,
  hash,
  AUTO_REPLY_PATTERNS,
};
