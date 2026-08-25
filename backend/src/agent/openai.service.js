const OpenAI = require('openai');
const { env } = require('../config/env');
const { getTier } = require('./models.registry');
const logger = require('../utils/logger');

let client = null;

function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: env.openai.apiKey,
      baseURL: env.openai.baseURL,
      timeout: env.openai.timeout,
      maxRetries: env.openai.maxRetries,
    });
  }
  return client;
}

const emptyUsage = () => ({ prompt: 0, completion: 0, total: 0 });

function readUsage(response) {
  const u = response?.usage;
  if (!u) return emptyUsage();
  return {
    prompt: u.prompt_tokens || 0,
    completion: u.completion_tokens || 0,
    total: u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0),
  };
}

/**
 * Chamada de texto em um tier.
 * `messages` opcional permite passar os turnos recentes ja formatados.
 */
async function complete({
  tier = 'mini',
  system,
  user,
  messages = [],
  temperature,
  maxTokens,
  purpose = 'generic',
}) {
  const spec = getTier(tier);
  if (!spec) throw new Error(`Tier desconhecido: ${tier}`);

  const payload = {
    model: spec.model,
    temperature: temperature ?? spec.temperature,
    max_tokens: maxTokens ?? spec.maxOutputTokens,
    messages: [
      { role: 'system', content: system || '' },
      ...messages,
      ...(user ? [{ role: 'user', content: user }] : []),
    ].filter((m) => m.content),
  };

  const startedAt = Date.now();
  const response = await getClient().chat.completions.create(payload);
  const usage = readUsage(response);
  const latencyMs = Date.now() - startedAt;

  logger.debug({ tier, model: spec.model, purpose, usage, latencyMs }, 'chamada openai');

  return {
    text: response.choices?.[0]?.message?.content || '',
    finishReason: response.choices?.[0]?.finish_reason,
    usage,
    model: spec.model,
    tier,
    latencyMs,
  };
}

/** Mesma chamada, forcando JSON valido. Usada pela extracao de ontologia e pelos guardrails. */
async function completeJSON(options) {
  const spec = getTier(options.tier || 'mini');
  const payload = {
    model: spec.model,
    temperature: options.temperature ?? 0,
    max_tokens: options.maxTokens ?? spec.maxOutputTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: options.system },
      { role: 'user', content: options.user },
    ],
  };

  const startedAt = Date.now();
  const response = await getClient().chat.completions.create(payload);
  const raw = response.choices?.[0]?.message?.content || '{}';

  let json = {};
  try {
    json = JSON.parse(raw);
  } catch (error) {
    logger.warn({ raw: raw.slice(0, 200), purpose: options.purpose }, 'JSON invalido do modelo');
  }

  return {
    json,
    raw,
    usage: readUsage(response),
    model: spec.model,
    tier: spec.key,
    latencyMs: Date.now() - startedAt,
  };
}

module.exports = { complete, completeJSON, getClient, emptyUsage };
