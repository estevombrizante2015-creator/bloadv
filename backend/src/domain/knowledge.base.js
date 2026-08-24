/**
 * BASE DE CONHECIMENTO - Direito do Trabalho
 * ------------------------------------------
 * Conteudo institucional do escritorio, transcrito do material publico.
 * Serve para o agente responder duvida frequente SEM inventar (e sem virar consulta).
 *
 * Economia de tokens: nada disto vai inteiro no prompt. O agente recebe apenas
 * a entrada correspondente ao `tipo_caso` da ontologia, ou no maximo duas
 * quando o assunto e ambiguo. Ver knowledge.service.js.
 *
 * Cada `resumo` e escrito ja no registro que o agente deve usar: informacao geral
 * da lei, sempre hedgeada ("em regra", "normalmente"), nunca conclusao sobre o caso
 * da pessoa. A conclusao e do advogado, na consulta.
 */

const KNOWLEDGE = {
  demissao_sem_justa_causa: {
    titulo: 'Demissao sem justa causa',
    gatilhos: ['fui demitido', 'demissao', 'mandaram embora', 'dispensa', 'rescisao', 'demitiram'],
    resumo:
      'Na dispensa sem justa causa a lei em regra preve: saldo de salario, aviso previo (trabalhado ou indenizado), ' +
      '13o proporcional, ferias vencidas e proporcionais + 1/3, saque do FGTS com multa de 40% e as guias do seguro-desemprego ' +
      'para quem cumpre os requisitos. Vale conferir tambem horas extras e eventual estabilidade. ' +
      'Mesmo apos assinar a rescisao, ainda e possivel revisar o calculo.',
    perguntaChave: 'Ha quanto tempo foi o desligamento e voce chegou a receber o acerto?',
  },

  pedido_demissao: {
    titulo: 'Pedido de demissao',
    gatilhos: ['pedi demissao', 'pedi as contas', 'sai da empresa', 'me demiti'],
    resumo:
      'Quem pede demissao em regra perde o saque do FGTS, a multa de 40% e o seguro-desemprego, ' +
      'mas continua tendo direito a saldo de salario, 13o proporcional e ferias vencidas e proporcionais + 1/3. ' +
      'Se o aviso previo de 30 dias nao for cumprido, a empresa pode descontar esse valor das verbas.',
    perguntaChave: 'O que te levou a pedir demissao?',
  },

  justa_causa: {
    titulo: 'Demissao por justa causa',
    gatilhos: ['justa causa', 'me mandaram por justa causa', 'falta grave'],
    resumo:
      'A justa causa e a penalidade maxima e exige falta grave comprovada, alem de proporcionalidade e imediatidade na punicao. ' +
      'Mesmo nela, em regra permanecem devidos saldo de salario e ferias vencidas + 1/3. ' +
      'Justa causa aplicada sem prova ou de forma desproporcional pode ser revertida na Justica.',
    perguntaChave: 'Qual motivo a empresa registrou para a justa causa?',
  },

  sem_registro: {
    titulo: 'Carteira nao assinada',
    gatilhos: ['sem carteira', 'nao assinou', 'sem registro', 'informal', 'nao registrou'],
    resumo:
      'A falta de registro e irregularidade da empresa, nao do trabalhador. ' +
      'Comprovada a prestacao de servico com habitualidade, subordinacao, remuneracao e pessoalidade, ' +
      'e possivel buscar o reconhecimento do vinculo e os direitos do periodo trabalhado.',
    perguntaChave: 'Por quanto tempo voce trabalhou assim e guardou algo que comprove (mensagens, holerite, testemunhas)?',
  },

  vinculo_pj: {
    titulo: 'PJ mascarado / prestador x empregado',
    gatilhos: ['pj', 'pejotizacao', 'cnpj', 'autonomo', 'freelancer', 'prestador'],
    resumo:
      'Contratar como PJ, autonomo ou freelancer nao afasta o vinculo por si so. ' +
      'O que vale sao os quatro requisitos: pessoalidade, habitualidade, onerosidade e subordinacao. ' +
      'Presentes todos, e possivel pedir o reconhecimento do vinculo com registro retroativo, FGTS, ferias e 13o.',
    perguntaChave: 'Voce tinha horario definido e alguem a quem se reportava no dia a dia?',
  },

  horas_extras: {
    titulo: 'Horas extras',
    gatilhos: ['hora extra', 'horas extras', 'banco de horas', 'trabalhei alem', 'extrapolava'],
    resumo:
      'Hora extra em dia util deve ser paga com no minimo 50% de acrescimo sobre a hora normal. ' +
      'Domingo e feriado sem folga compensatoria normalmente sao remunerados com 100% de acrescimo, ' +
      'conforme a legislacao e as normas aplicaveis a categoria.',
    perguntaChave: 'Qual era seu horario contratado e quanto costumava trabalhar de fato?',
  },

  verbas_incorretas: {
    titulo: 'Recebeu menos que devia',
    gatilhos: ['recebi menos', 'calculo errado', 'valor errado', 'nao bateu', 'faltou pagar'],
    resumo:
      'Erros de calculo em rescisao e em folha sao comuns: base de calculo sem as medias de horas extras, ' +
      'adicionais e comissoes; ferias e 13o proporcionais a menor; FGTS recolhido de forma incompleta. ' +
      'Com os holerites e o termo de rescisao em maos e possivel conferir cada verba.',
    perguntaChave: 'Voce tem os holerites e o termo de rescisao para conferirmos?',
  },

  salario_por_fora: {
    titulo: 'Salario por fora',
    gatilhos: ['por fora', 'parte em dinheiro', 'pix por fora', 'nao registrado no holerite'],
    resumo:
      'Salario pago por fora e a parcela da remuneracao sem registro na folha. ' +
      'Isso reduz ferias, 13o, FGTS e a contribuicao ao INSS, refletindo ate na aposentadoria. ' +
      'Havendo prova do pagamento, e possivel buscar o reconhecimento desses valores e as diferencas.',
    perguntaChave: 'Como essa parte era paga e sobrou algum registro (pix, recibo, mensagem)?',
  },

  ferias: {
    titulo: 'Ferias',
    gatilhos: ['ferias', 'vender ferias', 'abono pecuniario', 'ferias vencidas'],
    resumo:
      'Em regra quem define o periodo de ferias e o empregador, mas elas devem ser concedidas nos 12 meses ' +
      'seguintes ao periodo aquisitivo, sob pena de pagamento em dobro. ' +
      'O trabalhador pode converter em dinheiro ate 10 dias (abono pecuniario) e a empresa nao pode obrigar essa venda.',
    perguntaChave: 'Suas ferias estao vencidas ou a duvida e sobre o periodo de gozo?',
  },

  estabilidade: {
    titulo: 'Demissao em periodo de estabilidade',
    gatilhos: ['estabilidade', 'cipa', 'acidente de trabalho', 'afastado pelo inss', 'auxilio doenca'],
    resumo:
      'Ha situacoes em que o contrato tem protecao contra a dispensa, como gestacao, acidente de trabalho com afastamento ' +
      'e mandato na CIPA. Demissao dentro da estabilidade pode gerar reintegracao ou indenizacao do periodo, ' +
      'a depender do caso concreto.',
    perguntaChave: 'Qual era a sua situacao na data da demissao?',
  },

  estabilidade_gestante: {
    titulo: 'Gestante',
    gatilhos: ['gravida', 'gestante', 'gravidez', 'licenca maternidade'],
    resumo:
      'A empregada gestante em regra tem estabilidade desde a confirmacao da gravidez ate cinco meses apos o parto. ' +
      'Essa protecao pode alcancar tambem a gravidez iniciada no aviso previo ou em contrato de experiencia. ' +
      'Havendo demissao nesse periodo, e possivel buscar reintegracao ou indenizacao.',
    perguntaChave: 'Voce ja tinha a confirmacao da gravidez quando foi desligada?',
  },

  assedio: {
    titulo: 'Assedio no trabalho',
    gatilhos: [
      'assedio', 'assedio moral', 'assedio sexual', 'humilhacao', 'humilha', 'humilhando',
      'constrangimento', 'perseguicao', 'perseguindo', 'xinga', 'xingando', 'grita comigo', 'gritando comigo',
    ],
    resumo:
      'Assedio moral ou sexual no ambiente de trabalho pode gerar reparacao por dano moral e, conforme o caso, ' +
      'fundamentar a rescisao indireta. O atendimento e confidencial. ' +
      'Provas como mensagens, e-mails, audios e testemunhas ajudam muito.',
    perguntaChave: 'Voce se sente a vontade para me contar, em linhas gerais, o que vem acontecendo?',
  },

  insalubridade: {
    titulo: 'Insalubridade e periculosidade',
    gatilhos: ['insalubridade', 'insalubre', 'periculosidade', 'perigoso', 'produto quimico', 'ruido', 'epi'],
    resumo:
      'Atividades insalubres ou perigosas podem gerar adicional na remuneracao. ' +
      'O reconhecimento normalmente depende de pericia tecnica que avalia o agente, a exposicao e o uso efetivo de EPI. ' +
      'Adicional nao pago no curso do contrato pode ser cobrado com reflexos nas demais verbas.',
    perguntaChave: 'Qual era a sua funcao e a que voce ficava exposto no dia a dia?',
  },

  rescisao_indireta: {
    titulo: 'Rescisao indireta',
    gatilhos: [
      'rescisao indireta', 'nao aguento mais', 'empresa nao paga', 'nao paga o salario',
      'atraso de salario', 'salario atrasado', 'atrasando salario', 'atrasando o salario',
      'atrasada', 'quero sair mas',
    ],
    resumo:
      'Quando a empresa comete falta grave (salario atrasado, FGTS nao recolhido, assedio, exigencia de servico alheio ao contrato), ' +
      'em regra cabe pedir a rescisao indireta e receber as verbas como se tivesse sido dispensado sem justa causa. ' +
      'E uma medida que depende de analise tecnica antes de qualquer atitude no emprego.',
    perguntaChave: 'Voce ainda esta trabalhando la?',
  },

  prazo_pagamento: {
    titulo: 'Prazo do acerto',
    gatilhos: ['prazo', 'quando recebo', 'nao pagaram', 'atrasou o acerto', 'quantos dias'],
    resumo:
      'A empresa deve pagar as verbas rescisorias e entregar os documentos em ate 10 dias corridos do termino do contrato. ' +
      'Descumprido o prazo, em regra e devida multa equivalente a um salario do trabalhador.',
    perguntaChave: 'Qual foi a data do seu ultimo dia de trabalho?',
  },

  fgts: {
    titulo: 'FGTS',
    gatilhos: ['fgts', 'multa de 40', 'nao depositou', 'saque'],
    resumo:
      'Na dispensa sem justa causa o trabalhador em regra saca o FGTS com multa de 40%. ' +
      'Depositos nao realizados durante o contrato podem ser cobrados, com reflexo na multa rescisoria. ' +
      'O extrato da conta vinculada mostra os meses efetivamente recolhidos.',
    perguntaChave: 'Voce chegou a olhar o extrato do FGTS para ver se ha meses faltando?',
  },

  seguro_desemprego: {
    titulo: 'Seguro-desemprego',
    gatilhos: ['seguro desemprego', 'guias', 'parcelas do seguro'],
    resumo:
      'O seguro-desemprego cabe em regra na dispensa sem justa causa, desde que cumpridos os requisitos de tempo de trabalho ' +
      'e de recebimentos anteriores. A empresa deve entregar as guias junto com a documentacao da rescisao.',
    perguntaChave: 'A empresa chegou a te entregar as guias?',
  },
};

const TOPICS = Object.keys(KNOWLEDGE);

module.exports = { KNOWLEDGE, TOPICS };
