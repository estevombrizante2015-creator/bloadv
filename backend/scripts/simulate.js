#!/usr/bin/env node
/**
 * SIMULADOR DE CONVERSA
 * ---------------------
 * Exercita o pipeline inteiro - guardrails, ontologia, roteador, base de
 * conhecimento, agente e guardrail de saida - SEM precisar de WhatsApp pareado.
 *
 * Usa OpenAI e MongoDB de verdade: consome tokens e grava dados (num contato
 * de teste isolado, jid `simulador@teste`).
 *
 *   npm run simulate                                  # modo conversa (interativo)
 *   npm run simulate -- "fui demitido ontem"          # uma mensagem
 *   npm run simulate -- --audio "queria saber os valores"
 *   npm run simulate -- --image "holerite com desconto de 300 reais"
 *   npm run simulate -- "vou mandar uma foto" --image "print de conversa" "e esse aqui"
 *   npm run simulate -- --agent customer_agent "qual o andamento do processo?"
 *   npm run simulate -- --reset                       # zera a conversa de teste
 */
const readline = require('readline');
const mongoose = require('mongoose');

const { assertEnv } = require('../src/config/env');
const connectDB = require('../src/config/database');
const { getAgent } = require('../src/config/agents.config');
const { getChannel } = require('../src/config/channels');
const agentService = require('../src/agent/agent.service');
const { Contact, Message, Conversation, AgentRun, GuardrailEvent } = require('../src/models');

const TEST_JID = 'simulador@teste';
const CHANNEL_ID = 'leads-1';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/**
 * Converte os argumentos em partes normalizadas, na ordem em que foram escritos.
 * E exatamente o formato que o buffer entrega ao agente depois dos 8 segundos.
 */
function parseParts(args) {
  const parts = [];
  let agentId = 'lead_capture';
  let reset = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--reset') {
      reset = true;
    } else if (arg === '--agent') {
      agentId = args[++i];
    } else if (arg === '--audio') {
      parts.push({
        type: 'audio',
        transcription: args[++i],
        waMessageId: `sim-${parts.length}`,
        timestamp: Date.now() + parts.length,
      });
    } else if (arg === '--image') {
      parts.push({
        type: 'image',
        description: args[++i],
        caption: args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : null,
        waMessageId: `sim-${parts.length}`,
        timestamp: Date.now() + parts.length,
      });
    } else if (arg === '--audio-falhou') {
      parts.push({ type: 'audio', transcription: null, failed: true, error: 'whisper indisponivel' });
    } else {
      parts.push({
        type: 'text',
        content: arg,
        waMessageId: `sim-${parts.length}`,
        timestamp: Date.now() + parts.length,
      });
    }
  }

  return { parts, agentId, reset };
}

function printResult(result, parts) {
  const { meta } = result;

  console.log();
  console.log(c.dim('  lote enviado: ') + parts.map((p) => p.type).join(' + '));

  if (meta?.blocked) {
    console.log(c.red('  BLOQUEADO NA ENTRADA') + c.dim(` (${(meta.flags || []).join(', ')})`));
    if (meta.handoff) console.log(c.yellow(`  handoff: ${meta.handoff}`));
  }

  console.log();
  console.log(c.green(c.bold('  Agente: ')) + (result.reply ?? c.dim('(silencio proposital)')));
  console.log();

  if (meta && !meta.blocked) {
    console.log(c.dim(`  tier          ${result.tier} (${meta.model})`));
    console.log(c.dim(`  motivo        ${meta.reason}`));
    console.log(c.dim(`  base          ${(meta.knowledgeTopics || []).join(', ') || '-'} [${meta.knowledgeBackend}]`));
    console.log(c.dim(`  tokens        ${meta.usage?.total} (poupados ~${meta.savedTokens})`));
    console.log(c.dim(`  latencia      ${meta.latencyMs}ms`));

    const gIn = meta.guardrails?.input || [];
    const gOut = meta.guardrails?.output || [];
    if (gIn.length) console.log(c.yellow(`  guard entrada ${gIn.join(', ')}`));
    if (gOut.length) console.log(c.red(`  guard saida   ${gOut.join(', ')} (resposta reescrita)`));
    if (meta.handoff) console.log(c.yellow(`  handoff       ${meta.handoff}`));
  }
}

async function showOntology() {
  const contact = await Contact.findOne({ channelId: CHANNEL_ID, jid: TEST_JID }).lean();
  if (!contact) return;

  const ontology = require('../src/ontology/ontology.service');
  const snapshot = ontology.render(contact.ontology, contact.role);

  console.log(c.cyan('\n  --- ontologia acumulada ---'));
  console.log(
    snapshot
      ? snapshot.split('\n').map((l) => `  ${c.dim(l)}`).join('\n')
      : c.dim('  (vazia)')
  );
  if (contact.rollingSummary) console.log(c.dim(`  resumo: ${contact.rollingSummary}`));
  console.log();
}

async function reset() {
  const filtro = { channelId: CHANNEL_ID, jid: TEST_JID };
  await Promise.all([
    Contact.deleteMany(filtro),
    Message.deleteMany(filtro),
    AgentRun.deleteMany({ channelId: CHANNEL_ID, jid: TEST_JID }),
    GuardrailEvent.deleteMany({ channelId: CHANNEL_ID, jid: TEST_JID }),
    Conversation.deleteMany({ sessionId: CHANNEL_ID, chatId: TEST_JID }),
  ]);
  console.log(c.dim('  conversa de teste zerada'));
}

async function run(parts, agent) {
  const channel = getChannel(CHANNEL_ID);
  try {
    const result = await agentService.handleBatch({
      channel,
      agent,
      jid: TEST_JID,
      parts,
      pushName: 'Simulador',
    });
    printResult(result, parts);
  } catch (error) {
    console.log(c.red(`\n  ERRO: ${error.message}`));
    if (process.env.LOG_LEVEL === 'debug') console.log(error.stack);
  }
}

/** Modo conversa: cada linha vira um lote. Serve para ver a ontologia evoluindo. */
async function interactive(agent) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(c.dim('\n  Comandos: /ontologia  /reset  /sair'));
  console.log(c.dim('  Prefixos: audio: <texto>   imagem: <descricao>'));
  console.log(c.dim('  Varias mensagens de uma vez: separe com  ||\n'));

  const ask = () =>
    new Promise((resolve) => rl.question(c.bold('  Voce: '), (answer) => resolve(answer)));

  for (;;) {
    const line = (await ask()).trim();
    if (!line) continue;

    if (line === '/sair' || line === '/quit') break;
    if (line === '/reset') {
      await reset();
      continue;
    }
    if (line === '/ontologia') {
      await showOntology();
      continue;
    }

    // "oi || audio: fui demitido || imagem: um holerite" vira um lote de 3 partes
    const parts = line.split('||').map((chunk, i) => {
      const piece = chunk.trim();
      const base = { waMessageId: `sim-${Date.now()}-${i}`, timestamp: Date.now() + i };

      if (piece.startsWith('audio:')) {
        return { ...base, type: 'audio', transcription: piece.slice(6).trim() };
      }
      if (piece.startsWith('imagem:')) {
        return { ...base, type: 'image', description: piece.slice(7).trim(), caption: null };
      }
      return { ...base, type: 'text', content: piece };
    });

    await run(parts, agent);
  }

  rl.close();
}

async function main() {
  assertEnv();
  await connectDB();

  const args = process.argv.slice(2);
  const { parts, agentId, reset: shouldReset } = parseParts(args);

  const agent = getAgent(agentId);
  if (!agent) {
    console.log(c.red(`  Agente desconhecido: ${agentId}`));
    process.exit(1);
  }

  console.log(
    c.dim(`\n  canal ${CHANNEL_ID} | agente ${agent.label} (${agent.status}) | tier base ${agent.tier}`)
  );
  if (agent.status !== 'active') {
    console.log(
      c.yellow(`  aviso: ${agent.label} esta em ${agent.status}; no WhatsApp real nao responderia.`)
    );
  }

  if (shouldReset) await reset();

  if (parts.length) {
    await run(parts, agent);
    await showOntology();
  } else {
    await interactive(agent);
  }

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(c.red(`\n  Falhou: ${error.message}`));
  console.error(error.stack);
  process.exit(1);
});
