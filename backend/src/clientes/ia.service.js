const { Cliente } = require('../models');
const openaiService = require('../agent/openai.service');
const outputGuard = require('../guardrails/output.guard');
const { FIRM } = require('../domain/firm.config');
const contexto = require('./contexto.service');
const timeline = require('./timeline.service');
const pipeline = require('./pipeline.service');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

/**
 * A IA SOBRE A FICHA DO CLIENTE
 * -----------------------------
 * Tres usos, um principio: **a IA so pode dizer o que esta na ficha**. Ela nao
 * consulta base de conhecimento, nao busca na internet e nao deduz andamento.
 * Num escritorio de advocacia, um resumo que inventa uma fase processual nao e
 * um resumo ruim — e uma informacao errada dada a um cliente, com o nome do
 * escritorio em cima.
 *
 * O RESUMO PARA O CLIENTE E GERADO EM OUTRA CHAMADA, COM OUTRO DOSSIE.
 *
 * Seria mais barato pedir as duas versoes de uma vez e instruir o modelo a nao
 * copiar o que e interno. Mas ai a unica coisa separando a anotacao "cliente
 * complicado, cobrar antes" de uma mensagem enviada a essa pessoa seria uma
 * frase no prompt. Aqui o modelo que escreve para o cliente simplesmente NAO
 * RECEBE as observacoes internas, as tarefas nem o nome do responsavel. Nao ha
 * o que vazar, porque nao ha o que ler.
 */

const LIMITES_RESUMO = [
  'Use APENAS o que estiver no material acima. Nao complete lacuna com suposicao.',
  'Se algo nao estiver no material, nao mencione. Nao escreva "nao informado" nem liste o que falta.',
  'Nunca afirme prazo de processo, resultado, valor ou chance de exito.',
  'Nunca diga que a pessoa "tem direito" a algo.',
  'Portugues do Brasil.',
];

const semDados = {
  interno:
    'Ainda nao ha material suficiente nesta ficha para um resumo. Registre o status, ' +
    'a etapa ou uma observacao e gere novamente.',
  cliente: null,
};

// ------------------------------------------------------------------ resumo

/** O resumo interno pode ser franco: quem le trabalha no escritorio. */
async function resumoInterno(dossie) {
  const system = [
    `Voce prepara um resumo operacional para a equipe do escritorio ${FIRM.nome}.`,
    'Quem le e um colaborador que precisa entender o caso em 15 segundos, sem abrir o historico.',
    '',
    'Escreva um paragrafo corrido de 3 a 5 frases cobrindo, nesta ordem e so o que existir:',
    'onde o caso esta; o que ja aconteceu de relevante; o que estamos aguardando;',
    'qual e a proxima acao e ate quando.',
    '',
    'Seja direto. Sem saudacao, sem titulo, sem lista, sem despedida.',
    '',
    ...LIMITES_RESUMO.map((r) => `- ${r}`),
  ].join('\n');

  const { text, usage } = await openaiService.complete({
    tier: 'terra',
    purpose: 'cliente_resumo_interno',
    system,
    user: dossie.texto,
    maxTokens: 400,
  });

  return { texto: (text || '').trim(), usage };
}

/**
 * O resumo do cliente sai de um dossie SEM nada interno, e ainda passa pelo
 * guardrail de saida — e um texto destinado a sair do escritorio, entao vale a
 * mesma regra de qualquer mensagem enviada a um cliente.
 */
async function resumoParaCliente(dossieExterno) {
  const system = [
    `Voce escreve uma atualizacao para o proprio cliente do escritorio ${FIRM.nome}.`,
    'Ele vai ler isto no WhatsApp, enviado por uma pessoa do escritorio.',
    '',
    'De 2 a 4 frases, em tom claro, profissional e cordial. Comece com uma saudacao curta.',
    'Diga em que ponto o processo esta, o que ja foi feito e, se houver algo pendente do lado',
    'dele, peca com naturalidade.',
    '',
    'Nao use termo tecnico nem interno. Nao cite nome de colaborador, etapa interna,',
    'prioridade, etiqueta ou tarefa. Nao invente prazo.',
    '',
    ...LIMITES_RESUMO.map((r) => `- ${r}`),
  ].join('\n');

  const { text, usage } = await openaiService.complete({
    tier: 'terra',
    purpose: 'cliente_resumo_externo',
    system,
    user: dossieExterno.texto,
    maxTokens: 350,
  });

  // O mesmo guardrail das respostas do agente. Se o texto violar (promessa,
  // valor, dado pessoal vazando), nao vai para a tela como se estivesse pronto
  // para copiar e enviar.
  const violacoes = outputGuard.inspect(text || '');

  return { texto: (text || '').trim(), usage, violacoes };
}

/**
 * Gera (ou reaproveita) o resumo inteligente.
 *
 * Sem `forcar`, so chama a IA quando a assinatura do caso mudou. Abrir a ficha
 * de um cliente parado ha duas semanas nao deve custar duas chamadas de modelo.
 */
async function gerarResumo(clienteId, { forcar = false, usuario } = {}) {
  const cliente = await Cliente.findById(clienteId);
  if (!cliente) return null;

  const ultimoEvento = await timeline.ultimoRelevante(clienteId);
  const assinaturaAtual = contexto.assinatura(cliente, ultimoEvento);

  if (!forcar && cliente.resumo?.assinatura === assinaturaAtual && cliente.resumo?.geradoEm) {
    return {
      interno: cliente.resumo.interno,
      cliente: cliente.resumo.cliente,
      geradoEm: cliente.resumo.geradoEm,
      geradoPor: cliente.resumo.geradoPor,
      atualizado: true,
      reaproveitado: true,
    };
  }

  const [dossieInterno, dossieExterno] = await Promise.all([
    contexto.montar(clienteId, { interno: true }),
    contexto.montar(clienteId, { interno: false }),
  ]);

  if (!dossieInterno) return null;

  if (!contexto.temMaterial(dossieInterno.densidade)) {
    return { ...semDados, atualizado: true, semMaterial: true };
  }

  let interno;
  let externo;
  try {
    [interno, externo] = await Promise.all([
      resumoInterno(dossieInterno),
      resumoParaCliente(dossieExterno),
    ]);
  } catch (error) {
    logger.warn({ err: error.message, clienteId }, 'Falha ao gerar resumo do cliente');
    return { erro: 'Nao consegui gerar o resumo agora. Tente de novo em alguns segundos.' };
  }

  const tokens = (interno.usage?.total || 0) + (externo.usage?.total || 0);
  const geradoEm = new Date();

  await Cliente.updateOne(
    { _id: clienteId },
    {
      $set: {
        resumo: {
          interno: interno.texto,
          // Texto reprovado no guardrail nao e oferecido para copiar: seria
          // entregar ao colaborador uma mensagem pronta para errar com o
          // cliente, com a confianca de quem clicou num botao.
          cliente: externo.violacoes.length ? null : externo.texto,
          geradoEm,
          geradoPor: usuario?.nome || usuario?.email || 'sistema',
          assinatura: assinaturaAtual,
          tokens,
        },
      },
    }
  );

  await timeline.registrar({
    clienteId,
    tipo: timeline.TIPOS.RESUMO,
    titulo: 'Resumo inteligente atualizado',
    autor: usuario
      ? { tipo: 'usuario', id: usuario.id, nome: usuario.nome || usuario.email }
      : { tipo: 'sistema' },
    relevante: false,
  });

  logger.info(
    { ev: EV.RESUMO_GERADO, clienteId, tokens, violacoes: externo.violacoes, por: usuario?.email },
    'Resumo inteligente gerado'
  );

  return {
    interno: interno.texto,
    cliente: externo.violacoes.length ? null : externo.texto,
    bloqueado: externo.violacoes.length
      ? 'O texto gerado para o cliente nao passou na revisao automatica e foi descartado. ' +
        'Gere novamente ou escreva a mensagem manualmente.'
      : null,
    geradoEm,
    geradoPor: usuario?.nome || usuario?.email || 'sistema',
    tokens,
    atualizado: true,
  };
}

/** O resumo guardado esta velho? A tela usa para oferecer "gerar novamente". */
async function estaDesatualizado(cliente) {
  if (!cliente.resumo?.geradoEm) return true;
  const ultimoEvento = await timeline.ultimoRelevante(cliente._id);
  return contexto.assinatura(cliente, ultimoEvento) !== cliente.resumo.assinatura;
}

// -------------------------------------------------------------- assistente

const PERGUNTAS_SUGERIDAS = [
  'Qual e o status atual deste cliente?',
  'O que estamos aguardando?',
  'Qual foi o ultimo contato?',
  'Faca um resumo do caso.',
  'Qual deveria ser o proximo passo?',
  'Crie uma mensagem para eu enviar ao cliente explicando o andamento.',
];

/**
 * Copiloto do colaborador, dentro da ficha.
 *
 * Trabalha sobre o dossie interno — quem pergunta e do escritorio. Mas quando
 * a pergunta e "escreva uma mensagem para o cliente", o texto produzido sai do
 * escritorio, e ai o guardrail de saida entra igual.
 */
async function perguntar(clienteId, pergunta, usuario) {
  const texto = String(pergunta || '').trim().slice(0, 500);
  if (!texto) return { erro: 'Escreva a pergunta.' };

  const dossie = await contexto.montar(clienteId, { interno: true, mensagens: 40, eventos: 60 });
  if (!dossie) return { erro: 'Cliente nao encontrado.' };

  const system = [
    `Voce e o assistente operacional da equipe do escritorio ${FIRM.nome}.`,
    'Responde perguntas de um colaborador sobre UM cliente especifico.',
    '',
    'Regras:',
    '- Use exclusivamente o material do cliente fornecido. Nada de conhecimento geral.',
    '- Se a resposta nao estiver no material, diga isso em uma frase e sugira onde registrar o dado.',
    '- Seja curto: o colaborador esta com o cliente esperando do outro lado.',
    '- Se pedirem uma mensagem para enviar ao cliente, escreva o texto pronto, ' +
      'em tom cordial e sem qualquer informacao interna (observacoes, responsavel, prioridade, tarefas).',
    '- Nunca afirme prazo, resultado ou valor. Nunca diga que a pessoa tem direito a algo.',
  ].join('\n');

  let resposta;
  try {
    resposta = await openaiService.complete({
      tier: 'terra',
      purpose: 'cliente_assistente',
      system,
      messages: [{ role: 'user', content: dossie.texto }],
      user: texto,
      maxTokens: 600,
    });
  } catch (error) {
    logger.warn({ err: error.message, clienteId }, 'Falha no assistente do cliente');
    return { erro: 'Nao consegui responder agora. Tente de novo em alguns segundos.' };
  }

  const violacoes = outputGuard.inspect(resposta.text || '');

  logger.info(
    { ev: EV.ASSISTENTE_CONSULTADO, clienteId, por: usuario?.email, violacoes },
    'Assistente do cliente consultado'
  );

  return {
    resposta: (resposta.text || '').trim(),
    // Aviso, nao bloqueio: aqui quem le e do escritorio e sabe julgar. O que
    // nao pode e a pessoa copiar e enviar sem reparar.
    aviso: violacoes.length
      ? 'Revise antes de enviar: o texto tem trechos que o escritorio normalmente nao afirma.'
      : null,
    tokens: resposta.usage?.total || 0,
  };
}

// --------------------------------------------------------------- sugestoes

/**
 * Le a conversa recente e propoe o preenchimento da ficha.
 *
 * Nada e aplicado sozinho. A IA erra, e uma ficha que muda de status por conta
 * propria e pior que uma desatualizada: ninguem confia mais em nenhum campo.
 * O colaborador confirma, edita ou descarta.
 */
async function sugerir(clienteId, usuario) {
  const dossie = await contexto.montar(clienteId, { interno: true, mensagens: 25, eventos: 20 });
  if (!dossie) return { erro: 'Cliente nao encontrado.' };

  if (!dossie.densidade.mensagens && !dossie.densidade.eventos) {
    return { sugestoes: [], motivo: 'Ainda nao ha conversa nem historico para analisar.' };
  }

  const status = pipeline.atual().status.map((s) => `${s.id} (${s.label})`).join(', ');
  const etapas = pipeline.atual().etapas.map((e) => `${e.id} (${e.label})`).join(', ');

  const system = [
    'Voce analisa o material de um cliente e propoe como preencher a ficha operacional.',
    '',
    `Status possiveis: ${status}`,
    `Etapas possiveis: ${etapas}`,
    '',
    'Responda em JSON com estas chaves (omita a chave quando nao houver base clara):',
    '{',
    '  "status": "<id de status>",',
    '  "etapa": "<id de etapa>",',
    '  "aguardando": "<o que trava o andamento, em ate 8 palavras>",',
    '  "pendencia": "<pendencia a registrar>",',
    '  "proximaAcao": "<o que o escritorio deve fazer em seguida>",',
    '  "prazoEmDias": <numero inteiro de dias a partir de hoje>,',
    '  "prioridade": "baixa|normal|alta|urgente",',
    '  "justificativa": "<uma frase citando o que na conversa levou a isso>"',
    '}',
    '',
    'Regras:',
    '- Use somente ids das listas acima.',
    '- Proponha apenas o que o material sustenta. Chute nao ajuda: o colaborador ' +
      'perde mais tempo corrigindo do que preencheria a mao.',
    '- A justificativa e obrigatoria e precisa citar o fato concreto.',
  ].join('\n');

  let saida;
  try {
    saida = await openaiService.completeJSON({
      tier: 'mini',
      purpose: 'cliente_sugestoes',
      system,
      user: dossie.texto,
      maxTokens: 400,
    });
  } catch (error) {
    logger.warn({ err: error.message, clienteId }, 'Falha ao sugerir preenchimento');
    return { erro: 'Nao consegui analisar agora. Tente de novo em alguns segundos.' };
  }

  const json = saida.json || {};
  const cliente = dossie.cliente;
  const sugestoes = [];

  const proporCampo = (campo, rotulo, valor, valorAtual, exibir) => {
    if (!valor || valor === valorAtual) return;
    sugestoes.push({ campo, rotulo, valor, exibicao: exibir || String(valor) });
  };

  // Status e etapa so entram se o id existir de verdade no pipeline. Um id
  // inventado viraria uma ficha com status fantasma, invisivel no kanban.
  if (json.status && pipeline.statusPorId(json.status)) {
    proporCampo('status', 'Status', json.status, cliente.status, pipeline.rotuloStatus(json.status));
  }
  if (json.etapa && pipeline.etapaPorId(json.etapa)) {
    proporCampo('etapa', 'Etapa', json.etapa, cliente.etapa, pipeline.rotuloEtapa(json.etapa));
  }

  proporCampo('aguardando', 'Aguardando', String(json.aguardando || '').slice(0, 200), cliente.aguardando);
  proporCampo('proximaAcao', 'Proxima acao', String(json.proximaAcao || '').slice(0, 200), cliente.proximaAcao);

  if (['baixa', 'normal', 'alta', 'urgente'].includes(json.prioridade)) {
    proporCampo('prioridade', 'Prioridade', json.prioridade, cliente.prioridade);
  }

  const dias = Number(json.prazoEmDias);
  if (Number.isFinite(dias) && dias >= 0 && dias <= 180) {
    const prazo = new Date(Date.now() + dias * 86400000);
    sugestoes.push({
      campo: 'proximaAcaoEm',
      rotulo: 'Data da proxima acao',
      valor: prazo.toISOString(),
      exibicao: prazo.toLocaleDateString('pt-BR'),
    });
  }

  const pendencia = String(json.pendencia || '').slice(0, 200);
  const jaExiste = (cliente.pendencias || []).some(
    (p) => !p.resolvida && p.texto.toLowerCase() === pendencia.toLowerCase()
  );
  if (pendencia && !jaExiste) {
    sugestoes.push({ campo: 'pendencia', rotulo: 'Registrar pendencia', valor: pendencia, exibicao: pendencia });
  }

  logger.info(
    { ev: EV.SUGESTAO_GERADA, clienteId, sugestoes: sugestoes.length, por: usuario?.email },
    'Sugestoes de preenchimento geradas'
  );

  return {
    sugestoes,
    justificativa: String(json.justificativa || '').slice(0, 300) || null,
    tokens: saida.usage?.total || 0,
  };
}

module.exports = {
  gerarResumo,
  estaDesatualizado,
  perguntar,
  sugerir,
  PERGUNTAS_SUGERIDAS,
};
