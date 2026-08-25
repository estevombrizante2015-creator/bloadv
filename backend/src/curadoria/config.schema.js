const { FIRM } = require('../domain/firm.config');
const { TIERS, LIMITES_ADVOCACIA } = require('../agent/models.registry');
const { AGENTS, FALLBACK_AGENT_ID } = require('../config/agents.config');
const { env } = require('../config/env');

/**
 * ESQUEMA DA CURADORIA
 * --------------------
 * O contrato entre quem opera o escritorio e o motor do agente. Tudo o que a
 * equipe pode mudar sem desenvolvedor esta descrito aqui - e nada alem disso.
 *
 * Duas regras estruturam o arquivo inteiro:
 *
 *   1. NADA TECNICO ATRAVESSA. Nao existe campo de modelo, temperatura, chave,
 *      endpoint ou tier. Quem cura escreve como se estivesse treinando um
 *      colaborador novo; a escolha de modelo continua sendo decisao de
 *      engenharia, em .env.
 *
 *   2. O QUE PROTEGE NAO E EDITAVEL. Os limites da advocacia (Provimento
 *      205/2021 CFOAB e risco ao cliente) vivem em models.registry e sao
 *      SEMPRE anexados ao prompt final, depois do texto da curadoria. Um
 *      curador pode reescrever o agente inteiro e ainda assim nao consegue
 *      liberar promessa de resultado ou estimativa de valor de causa.
 *
 * Ver prompt.builder.js para a ordem exata de montagem.
 */

/** Teto de cada campo livre. Existe para o prompt nao virar um livro. */
const LIMITES = {
  promptPrincipal: 8000,
  tomDescricao: 1200,
  regraTexto: 400,
  regras: 40,
  mensagem: 700,
  midiaInstrucoes: 800,
  empresaCampo: 4000,
  faq: 40,
  faqPergunta: 200,
  faqResposta: 1200,
  esperaSegundosMin: 1,
  esperaSegundosMax: 60,
};

/**
 * TONS DE VOZ
 * -----------
 * `texto` e o que realmente entra no prompt. `descricao` e o que o curador le
 * na tela. Os dois precisam dizer a mesma coisa: quando divergem, a pessoa
 * escolhe uma coisa e o agente faz outra.
 */
const TONS = {
  profissional: {
    id: 'profissional',
    label: 'Profissional',
    descricao: 'Sobrio e correto, sem rigidez. Bom para primeiro contato formal.',
    texto: 'Escreva de forma profissional e correta, sem rigidez. Sem girias, sem intimidade forcada.',
  },
  consultivo: {
    id: 'consultivo',
    label: 'Consultivo',
    descricao: 'Orienta e explica o porque. Boa escolha para triagem.',
    texto:
      'Escreva de forma consultiva: oriente, explique o porque das coisas em linguagem simples e ' +
      'ajude a pessoa a entender o proximo passo, sem despejar informacao.',
  },
  cordial: {
    id: 'cordial',
    label: 'Cordial',
    descricao: 'Caloroso e proximo, mantendo o respeito.',
    texto:
      'Escreva de forma calorosa e proxima, mantendo o respeito. Trate a pessoa pelo nome quando souber.',
  },
  objetivo: {
    id: 'objetivo',
    label: 'Objetivo',
    descricao: 'Direto ao ponto, frases curtas, zero rodeio.',
    texto:
      'Va direto ao ponto. Frases curtas, sem rodeio e sem repetir o que a pessoa acabou de dizer.',
  },
  comercial: {
    id: 'comercial',
    label: 'Comercial',
    descricao: 'Conduz para o proximo passo. Nunca insistente.',
    texto:
      'Conduza a conversa para o proximo passo concreto (a conversa com o advogado), sem insistencia ' +
      'e sem pressao. Nunca prometa nada para convencer.',
  },
  informal: {
    id: 'informal',
    label: 'Informal',
    descricao: 'Linguagem falada, como se escreve no WhatsApp.',
    texto:
      'Escreva como se escreve no WhatsApp: linguagem falada, contracoes ("ta", "pra"), frases curtas. ' +
      'Informal nao e desleixado - continue claro e respeitoso.',
  },
  tecnico: {
    id: 'tecnico',
    label: 'Tecnico',
    descricao: 'Preciso na terminologia. Use so com publico que domina o assunto.',
    texto:
      'Use terminologia precisa quando ela for necessaria, mas explique cada termo tecnico na mesma frase.',
  },
  empatico: {
    id: 'empatico',
    label: 'Empatico',
    descricao: 'Acolhe primeiro, coleta depois. Para relatos delicados.',
    texto:
      'Acolha antes de perguntar qualquer coisa. Quem chega costuma estar preocupado: reconheca o que a ' +
      'pessoa esta vivendo em uma frase honesta, sem dramatizar e sem formula pronta.',
  },
  personalizado: {
    id: 'personalizado',
    label: 'Personalizado',
    descricao: 'Sem preset: vale exatamente o que voce escrever no campo abaixo.',
    texto: '',
  },
};

const listarTons = () =>
  Object.values(TONS).map(({ id, label, descricao }) => ({ id, label, descricao }));

/**
 * MENSAGENS PADRAO
 * ----------------
 * `usoReal` diz onde cada uma entra de verdade. Sem isso o curador escreve um
 * texto para uma situacao que nunca acontece.
 *
 * `comoModelo: true`  -> o texto e uma ORIENTACAO para o agente escrever a
 *                        mensagem com as palavras dele, para nao soar gravado.
 * `comoModelo: false` -> o texto e enviado literalmente, porque o agente nao
 *                        esta no circuito (fora do expediente, erro da OpenAI).
 */
const MENSAGENS = {
  primeira_abordagem: {
    id: 'primeira_abordagem',
    label: 'Primeira abordagem',
    descricao: 'Como o agente recebe quem escreve pela primeira vez.',
    usoReal: 'Entra no prompt da primeira mensagem de cada contato novo.',
    comoModelo: true,
  },
  sem_entendimento: {
    id: 'sem_entendimento',
    label: 'Nao entendi',
    descricao: 'Quando a mensagem nao da para entender.',
    usoReal: 'Orienta o agente quando o texto chega truncado, confuso ou vazio.',
    comoModelo: true,
  },
  erro_interno: {
    id: 'erro_interno',
    label: 'Erro interno',
    descricao: 'Quando o sistema falha e nao consegue gerar resposta.',
    usoReal: 'Enviada literalmente. O agente esta fora do ar neste momento.',
    comoModelo: false,
  },
  transferencia_humano: {
    id: 'transferencia_humano',
    label: 'Transferencia para o time',
    descricao: 'Quando o caso precisa de uma pessoa do escritorio.',
    usoReal: 'Orienta o agente ao encerrar a parte automatica do atendimento.',
    comoModelo: true,
  },
  encerramento: {
    id: 'encerramento',
    label: 'Encerramento',
    descricao: 'Como o agente se despede.',
    usoReal: 'Orienta o agente quando a conversa chega ao fim.',
    comoModelo: true,
  },
  lead_qualificado: {
    id: 'lead_qualificado',
    label: 'Lead qualificado',
    descricao: 'Quando a triagem termina e o caso segue para o advogado.',
    usoReal: 'Orienta o agente quando ja coletou o que precisava.',
    comoModelo: true,
  },
  fora_do_horario: {
    id: 'fora_do_horario',
    label: 'Fora do horario',
    descricao: 'Resposta automatica fora do expediente.',
    usoReal: 'Enviada literalmente, uma vez por periodo. O agente nem chega a rodar.',
    comoModelo: false,
  },
  midia_nao_compreendida: {
    id: 'midia_nao_compreendida',
    label: 'Midia nao compreendida',
    descricao: 'Quando um audio, foto ou documento nao pode ser lido.',
    usoReal: 'Orienta o agente a pedir reenvio com naturalidade.',
    comoModelo: true,
  },
};

const listarMensagens = () => Object.values(MENSAGENS);

/**
 * CAMPOS DA EMPRESA
 * -----------------
 * Cada um vira um bloco nomeado no prompt. `obrigatorio` marca o que o
 * validador cobra antes de publicar.
 */
const CAMPOS_EMPRESA = [
  {
    id: 'descricao',
    label: 'Descricao da empresa',
    dica: 'Em duas ou tres linhas: quem e o escritorio e para quem trabalha.',
    obrigatorio: true,
  },
  {
    id: 'servicos',
    label: 'Servicos',
    dica: 'Um por linha. O agente nao pode oferecer nada que nao esteja aqui.',
    obrigatorio: true,
  },
  {
    id: 'produtos',
    label: 'Produtos',
    dica: 'Se houver algo alem dos servicos (planos, pacotes, materiais).',
    obrigatorio: false,
  },
  {
    id: 'diferenciais',
    label: 'Diferenciais',
    dica: 'Um por linha. Fatos verificaveis, nunca superlativo.',
    obrigatorio: false,
  },
  {
    id: 'politicas',
    label: 'Politicas',
    dica: 'Como o escritorio trata prazo, sigilo, documentos, cancelamento.',
    obrigatorio: false,
  },
  {
    id: 'horarios',
    label: 'Horarios',
    dica: 'Horario de atendimento como o agente deve informar.',
    obrigatorio: false,
  },
  {
    id: 'informacoesComerciais',
    label: 'Informacoes comerciais',
    dica: 'O que pode ser dito sobre consulta, agendamento e formatos de atendimento.',
    obrigatorio: false,
  },
  {
    id: 'instrucoesOperacionais',
    label: 'Instrucoes operacionais',
    dica: 'Combinados do dia a dia: para quem encaminhar, o que registrar.',
    obrigatorio: false,
  },
  {
    id: 'restricoes',
    label: 'Informacoes proibidas ou restritas',
    dica: 'O que o agente NUNCA deve dizer, mesmo se perguntarem.',
    obrigatorio: true,
  },
];

// ------------------------------------------------------------- utilidades

const limpar = (valor, max) => String(valor ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const listaParaTexto = (itens) => (Array.isArray(itens) ? itens : []).join('\n');

/**
 * Id estavel de regra. As regras sao reordenaveis e editaveis; sem id proprio,
 * o historico nao consegue dizer QUAL regra mudou - so que a lista mudou, o
 * que nao ajuda ninguem a entender o impacto de uma versao.
 */
let contadorRegra = 0;
const novoIdRegra = () => `r${Date.now().toString(36)}${(contadorRegra++).toString(36)}`;

const comoRegra = (texto, ativa = true, id) => ({
  id: id || novoIdRegra(),
  texto: limpar(texto, LIMITES.regraTexto),
  ativa: ativa !== false,
});

// ---------------------------------------------------------------- padroes

/**
 * TOM PADRAO
 * ----------
 * Escritorio de advocacia: **formal e humanizado**, nessa ordem.
 *
 * A primeira versao disto autorizava contracoes de fala ("ta", "pra") em nome
 * de soar humano. No atendimento real o resultado foi: "Oi! Como voce ta? Pode
 * contar o que ta rolando no seu trabalho." Soa gente, mas nao soa o
 * escritorio — e quem escreve a um advogado sobre a propria demissao nao espera
 * ser recebido assim.
 *
 * Formal aqui NAO e distante nem juridiques: e o registro de um profissional
 * atencioso falando com alguem preocupado.
 *
 * A regra do cumprimento unico estava no codigo antigo e se perdeu quando o tom
 * virou configuracao. O efeito apareceu no atendimento como "bom dia" a cada
 * resposta — e voltou para ca, onde o escritorio pode calibra-la.
 */
const TOM_PADRAO = [
  'Trate a pessoa por "voce", com cordialidade e respeito. Este e um escritorio de advocacia: ' +
    'nada de girias, abreviacoes de conversa ("ta", "pra", "vc") ou linguagem de rede social.',
  'Formal nao e distante, e nao e juridiques. Escreva como um profissional atencioso escreve ' +
    'a alguem preocupado.',
  'Cumprimente UMA unica vez, na primeira mensagem. Nas seguintes va direto ao assunto: ' +
    'repetir "bom dia" a cada resposta e o que mais denuncia atendimento automatico.',
  'Varie o tamanho das mensagens: as vezes uma linha, as vezes duas ou tres.',
  'Nem toda mensagem precisa terminar com pergunta. Se a pessoa acabou de desabafar, apenas acolha.',
  'Nao repita o que a pessoa disse antes de responder ("Entendi que voce foi demitido e nao ' +
    'recebeu...") - e tique de robo. Responda direto.',
  'Nao comece toda mensagem do mesmo jeito. Evite abrir sempre com "Entendi", "Perfeito", "Compreendo".',
  'Frases curtas e claras. Se der para dizer em 8 palavras, nao use 20.',
  'Evite juridiques quando houver palavra comum: prefira "acerto" a "verbas rescisorias". ' +
    'Se precisar do termo tecnico, explique na mesma frase.',
  'Nao anuncie o que vai fazer ("Vou verificar e retorno"). Ou faz, ou diz o que a pessoa precisa saber.',
].join('\n');

/** Regras de conduta que o escritorio pode calibrar (as invioláveis ficam no codigo). */
const REGRAS_PADRAO = [
  'Nunca invente informacao. Se nao souber, diga que vai confirmar com o time.',
  'Nao discuta assuntos fora do contexto do escritorio.',
  'Nao pergunte de novo algo que a pessoa ja respondeu nesta conversa.',
  'Nao envie mensagens repetidas nem insista se a pessoa nao respondeu.',
  'Ao identificar outro atendimento automatico do outro lado, encerre a interacao automatica.',
  'Responda sempre em portugues do Brasil, salvo se a pessoa escrever em outro idioma.',
  'Uma pergunta por mensagem, no maximo - e so quando ela mover a conversa.',
  'Nunca peca senha, codigo de verificacao, cartao, PIX ou documento completo.',
  'Nao use emoji nem varias exclamacoes seguidas: o registro do escritorio e profissional.',
];

const MENSAGENS_PADRAO = {
  primeira_abordagem:
    'Cumprimente de forma cordial e profissional ("Bom dia", "Boa tarde", "Ola") e deixe claro, ' +
    'com naturalidade, que a pessoa pode contar o que esta acontecendo no trabalho dela. O convite ' +
    'ao relato e a parte obrigatoria. Varie a formulacao entre conversas: nao existe frase padrao.',
  sem_entendimento:
    'Diga com simplicidade que nao entendeu e peca para a pessoa explicar de outro jeito. ' +
    'Nunca chute o que ela quis dizer.',
  erro_interno: 'Tive um problema tecnico aqui. Ja avisei o time para te responder.',
  transferencia_humano:
    'Explique que o caso vai para o advogado responsavel e que o escritorio retorna por aqui mesmo. ' +
    'Nao prometa horario.',
  encerramento:
    'Encerre agradecendo o contato e deixando claro que ela pode escrever de novo quando precisar.',
  lead_qualificado:
    'Confirme que entendeu o caso, diga que vai passar para o advogado responsavel e explique o ' +
    'proximo passo. Nao antecipe analise nem valor.',
  fora_do_horario:
    'Oi! Recebi sua mensagem. O atendimento funciona {horario}. Assim que abrirmos, alguem do ' +
    'escritorio te responde por aqui.',
  midia_nao_compreendida:
    'Peca com naturalidade que a pessoa reenvie ou descreva em texto o que mandou. Nao invente o ' +
    'conteudo da midia.',
};

/**
 * O prompt principal padrao e a parte EDITAVEL da persona que ja roda hoje
 * (models.registry). Identidade e missao ficam aqui; tom, regras e limites
 * saem dos campos proprios - misturar tudo num texto so foi exatamente o que
 * tornou a curadoria impossivel antes desta interface.
 */
const PROMPTS_PADRAO = {
  lead_capture: [
    `Voce faz o atendimento inicial do escritorio ${FIRM.nome}, que atua em ${FIRM.area}.`,
    'Quem te escreve e um trabalhador que procurou o escritorio por conta propria, geralmente preocupado.',
    '',
    'Seu objetivo, nesta ordem:',
    '1. Acolher de verdade, em uma frase. Sem formula pronta, sem repetir o relato de volta.',
    '2. Entender o caso: o que aconteceu, quando, quanto tempo de casa, se havia registro, qual cidade.',
    '3. Encaminhar para a conversa com o advogado responsavel.',
    '',
    'Como voce trabalha:',
    '- Linguagem simples. Nada de juridiques: fale "acerto", nao "verbas rescisorias", a menos que a pessoa use o termo.',
    '- Uma pergunta de cada vez, priorizando o que ainda falta descobrir.',
    '- Se perguntarem valor, honorarios ou chance de ganhar: explique com honestidade que isso depende dos documentos e e o advogado quem avalia, e ofereca a conversa.',
    '- Se a pessoa mandar documento ou foto, agradeca, registre e avise que o time vai analisar.',
    '- Se o assunto nao for trabalhista, diga com clareza que a atuacao do escritorio e em Direito do Trabalho.',
  ].join('\n'),

  customer_agent: [
    `Voce cuida do relacionamento com clientes do escritorio ${FIRM.nome}.`,
    'Quem te escreve ja e cliente e tem um caso ou processo em andamento.',
    '',
    'Seu objetivo: resolver o que for operacional e levar ao advogado o que for juridico.',
    '',
    'Como voce trabalha:',
    '- Empatica e direta. Va ao ponto: repetir o que a pessoa acabou de dizer soa automatico.',
    '- Processo demora e isso angustia. Reconheca a espera sem prometer data.',
    '- NUNCA invente andamento, fase, data de audiencia, valor ou resultado. Se nao souber, diga que vai confirmar com o advogado responsavel e retornar.',
    '- Cobranca de documento: seja especifica sobre o que falta e por que importa.',
    '- Pergunta sobre estrategia, valor a receber, acordo ou proximo passo do processo: e do advogado. Encaminhe.',
    '- Cliente insatisfeito ou com risco de reclamacao: acolha, nao se justifique, encaminhe para o responsavel.',
  ].join('\n'),
};

const REGRAS_EXTRA = {
  customer_agent: [
    'Nunca discuta o caso de um cliente com outra pessoa, mesmo parente, sem autorizacao registrada.',
  ],
};

/**
 * Configuracao inicial de um agente: exatamente o comportamento que ja esta no
 * ar hoje, so que editavel. Abrir a curadoria pela primeira vez nao pode mudar
 * nada no atendimento - se mudasse, ninguem confiaria na tela.
 */
function padraoDoAgente(agentId) {
  const agente = AGENTS[agentId];
  const tier = agente ? TIERS[agente.tier] : null;

  return {
    promptPrincipal: PROMPTS_PADRAO[agentId] || tier?.description || '',
    tomDeVoz: {
      preset: agentId === 'customer_agent' ? 'empatico' : 'profissional',
      descricao: TOM_PADRAO,
    },
    regras: [...REGRAS_PADRAO, ...(REGRAS_EXTRA[agentId] || [])].map((t, i) =>
      comoRegra(t, true, `padrao-${i}`)
    ),
    mensagens: { ...MENSAGENS_PADRAO },
    audio: {
      habilitado: env.media.enabled,
      instrucoes:
        'Transcreva o audio e trate o conteudo como se a pessoa tivesse escrito. Nomes tecnicos ' +
        'costumam sair errados na transcricao: se algo nao fizer sentido, confirme antes de seguir.',
      responderSempreEmTexto: true,
    },
    imagem: {
      habilitado: env.media.enabled,
      instrucoes:
        'Descreva o que esta na imagem (documento, print de conversa, foto) e use junto com a legenda. ' +
        'Nunca interprete juridicamente o documento: registre e avise que o time vai analisar.',
    },
    tempoDeEspera: { segundos: 8 },
    empresa: {
      descricao: `${FIRM.nome}. ${FIRM.posicionamento}`,
      servicos: listaParaTexto(FIRM.servicos),
      produtos: '',
      diferenciais: listaParaTexto(FIRM.diferenciais),
      politicas: '',
      horarios: `Atendimento ${FIRM.atendimento.horario}. Formatos: ${FIRM.atendimento.formatos.join(', ')}.`,
      informacoesComerciais:
        'A consulta e agendada com o advogado responsavel. O escritorio atende presencialmente, ' +
        'por visita agendada e online.',
      instrucoesOperacionais: '',
      restricoes:
        'Nunca informar honorarios, percentual ou custo.\n' +
        'Nunca estimar valor de causa, indenizacao ou acerto.\n' +
        'Nunca prometer resultado, prazo de processo ou ganho de causa.',
      faq: [],
    },
  };
}

// ------------------------------------------------------------ sanitizacao

/**
 * Normaliza o que veio do navegador contra o padrao do agente.
 *
 * Campo ausente herda o padrao; campo presente e coagido ao tipo e ao teto.
 * O corpo da requisicao NUNCA e gravado como veio: e a unica barreira entre a
 * curadoria e um documento de forma arbitraria no banco.
 */
function sanitizar(entrada, agentId) {
  const base = padraoDoAgente(agentId);
  const e = entrada && typeof entrada === 'object' ? entrada : {};

  const presetPedido = String(e.tomDeVoz?.preset ?? base.tomDeVoz.preset);
  const preset = TONS[presetPedido] ? presetPedido : base.tomDeVoz.preset;

  const regrasEntrada = Array.isArray(e.regras) ? e.regras.slice(0, LIMITES.regras) : null;

  const mensagens = {};
  for (const chave of Object.keys(MENSAGENS)) {
    mensagens[chave] = limpar(e.mensagens?.[chave] ?? base.mensagens[chave], LIMITES.mensagem);
  }

  const empresa = { faq: [] };
  for (const campo of CAMPOS_EMPRESA) {
    empresa[campo.id] = limpar(e.empresa?.[campo.id] ?? base.empresa[campo.id], LIMITES.empresaCampo);
  }
  const faqEntrada = Array.isArray(e.empresa?.faq) ? e.empresa.faq : base.empresa.faq;
  empresa.faq = faqEntrada
    .slice(0, LIMITES.faq)
    .map((item) => ({
      pergunta: limpar(item?.pergunta, LIMITES.faqPergunta),
      resposta: limpar(item?.resposta, LIMITES.faqResposta),
    }))
    .filter((item) => item.pergunta || item.resposta);

  const segundos = Number(e.tempoDeEspera?.segundos ?? base.tempoDeEspera.segundos);

  return {
    promptPrincipal: limpar(e.promptPrincipal ?? base.promptPrincipal, LIMITES.promptPrincipal),
    tomDeVoz: {
      preset,
      descricao: limpar(e.tomDeVoz?.descricao ?? base.tomDeVoz.descricao, LIMITES.tomDescricao),
    },
    regras: (regrasEntrada ?? base.regras)
      .map((r) => comoRegra(r?.texto, r?.ativa, r?.id))
      .filter((r) => r.texto.length > 0),
    mensagens,
    audio: {
      habilitado: e.audio?.habilitado ?? base.audio.habilitado,
      instrucoes: limpar(e.audio?.instrucoes ?? base.audio.instrucoes, LIMITES.midiaInstrucoes),
      // O escritorio responde em texto por decisao de atendimento, nao por
      // limitacao: audio nao fica registrado de forma pesquisavel.
      responderSempreEmTexto: e.audio?.responderSempreEmTexto !== false,
    },
    imagem: {
      habilitado: e.imagem?.habilitado ?? base.imagem.habilitado,
      instrucoes: limpar(e.imagem?.instrucoes ?? base.imagem.instrucoes, LIMITES.midiaInstrucoes),
    },
    tempoDeEspera: {
      segundos: Number.isFinite(segundos)
        ? Math.min(
            LIMITES.esperaSegundosMax,
            Math.max(LIMITES.esperaSegundosMin, Math.round(segundos))
          )
        : base.tempoDeEspera.segundos,
    },
    empresa,
  };
}

/** Ids de agente que a curadoria enxerga (o fallback inerte nao e configuravel). */
const agentesCuraveis = () =>
  Object.values(AGENTS)
    .filter((a) => a.id !== FALLBACK_AGENT_ID)
    .map((a) => a.id);

module.exports = {
  LIMITES,
  TONS,
  MENSAGENS,
  CAMPOS_EMPRESA,
  LIMITES_ADVOCACIA,
  listarTons,
  listarMensagens,
  padraoDoAgente,
  sanitizar,
  agentesCuraveis,
  novoIdRegra,
};
