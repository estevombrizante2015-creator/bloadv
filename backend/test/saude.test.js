const test = require('node:test');
const assert = require('node:assert/strict');

const saude = require('../src/whatsapp/saude.service');

/**
 * O diagnostico e puro de proposito: recebe o estado ja coletado e devolve os
 * sinais. Testar aqui e testar exatamente o julgamento que aparece na tela,
 * sem banco e sem WhatsApp no circuito.
 */

const cenario = (over = {}) => ({
  estado: {
    id: 'leads-1',
    status: 'connected',
    hasCredentials: true,
    phoneNumber: '5511999990000',
    lastError: null,
    agent: { id: 'lead_capture', label: 'Novos Casos', status: 'active', matchedByNumber: true },
    ...(over.estado || {}),
  },
  doc: { channelId: 'leads-1', phoneNumber: '5511999990000', agentEnabled: true, ...(over.doc || {}) },
  volume: { recebidas24h: 12, enviadas24h: 12, ultimaRecebidaEm: new Date(), ...(over.volume || {}) },
  corrida: { execucoes: 12, falhas: 0, latenciaMediaMs: 3200, ...(over.corrida || {}) },
  pausadas: over.pausadas ?? 0,
  calados: over.calados ?? {},
  descartes: over.descartes ?? {},
  bloqueios: over.bloqueios ?? 0,
  erro: over.erro ?? null,
});

const niveis = (sinais) => sinais.map((s) => s.nivel);
const titulos = (sinais) => sinais.map((s) => s.titulo).join(' | ');

test('numero conectado, atribuido e respondendo nao gera alarme', () => {
  const sinais = saude.diagnosticar(cenario());
  assert.ok(!niveis(sinais).includes('critico'), titulos(sinais));
  assert.ok(!niveis(sinais).includes('atencao'), titulos(sinais));
});

test('conectado sem agente responsavel e critico', () => {
  // O caso que o cartao verde escondia: conecta, recebe e nao responde ninguem.
  const sinais = saude.diagnosticar(
    cenario({ estado: { agent: { id: 'lead_capture', label: 'X', matchedByNumber: false } } })
  );
  assert.ok(sinais.some((s) => s.nivel === 'critico' && /sem agente/i.test(s.titulo)));
});

test('interruptor do agente desligado e critico, nao detalhe', () => {
  const sinais = saude.diagnosticar(cenario({ doc: { agentEnabled: false } }));
  const achado = sinais.find((s) => /desligado/i.test(s.titulo));
  assert.equal(achado?.nivel, 'critico');
  assert.ok(achado.comoResolver, 'todo sinal precisa dizer o que fazer');
});

test('recebeu e nao respondeu nenhuma vez em 24h e critico', () => {
  const sinais = saude.diagnosticar(cenario({ volume: { recebidas24h: 7, enviadas24h: 0 } }));
  assert.ok(sinais.some((s) => s.nivel === 'critico' && /nao responde/i.test(s.titulo)));
});

test('falha isolada avisa; falha recorrente e critico', () => {
  const isolada = saude.diagnosticar(cenario({ corrida: { execucoes: 40, falhas: 1 } }));
  assert.equal(isolada.find((s) => /falha/i.test(s.titulo))?.nivel, 'atencao');

  const recorrente = saude.diagnosticar(cenario({ corrida: { execucoes: 10, falhas: 4 } }));
  assert.equal(recorrente.find((s) => /falha/i.test(s.titulo))?.nivel, 'critico');
});

test('sessao encerrada no celular aparece como critico', () => {
  const sinais = saude.diagnosticar(
    cenario({ estado: { status: 'logged_out', hasCredentials: false } })
  );
  assert.ok(sinais.some((s) => s.nivel === 'critico' && /encerrada/i.test(s.titulo)));
});

test('canal ja pareado sem credencial denuncia perda de credenciais', () => {
  const sinais = saude.diagnosticar(
    cenario({ estado: { status: 'disconnected', hasCredentials: false } })
  );
  assert.ok(sinais.some((s) => s.nivel === 'critico' && /credenciais/i.test(s.titulo)));
});

test('canal nunca pareado e inativo, nao problema', () => {
  const sinais = saude.diagnosticar(
    cenario({
      estado: { status: 'disconnected', hasCredentials: false, phoneNumber: null, agent: null },
      doc: { phoneNumber: null },
      volume: { recebidas24h: 0, enviadas24h: 0, ultimaRecebidaEm: null },
      corrida: { execucoes: 0, falhas: 0, latenciaMediaMs: null },
    })
  );

  assert.ok(sinais.some((s) => s.nivel === 'inativo'));
  assert.ok(!sinais.some((s) => s.nivel === 'critico'), titulos(sinais));
});

test('silencio de 24h com tudo no ar nao vira alarme', () => {
  // Fim de semana e numero novo tambem ficam calados. Marcar como problema
  // ensinaria a equipe a ignorar o painel.
  const sinais = saude.diagnosticar(
    cenario({
      volume: { recebidas24h: 0, enviadas24h: 0, ultimaRecebidaEm: null },
      corrida: { execucoes: 0, falhas: 0, latenciaMediaMs: null },
    })
  );

  assert.ok(!niveis(sinais).includes('critico'), titulos(sinais));
  assert.ok(sinais.some((s) => /sem mensagens/i.test(s.titulo)));
});

test('agente em standby e ressalva, nao falha', () => {
  const sinais = saude.diagnosticar(
    cenario({
      estado: {
        agent: { id: 'lead_capture', label: 'Novos Casos', status: 'standby', matchedByNumber: true },
      },
    })
  );
  assert.equal(sinais.find((s) => /standby/i.test(s.titulo))?.nivel, 'atencao');
});

test('conversas pausadas e respostas bloqueadas entram como ressalva', () => {
  const sinais = saude.diagnosticar(cenario({ pausadas: 3, bloqueios: 2 }));
  assert.ok(sinais.some((s) => s.nivel === 'atencao' && /pausada/i.test(s.titulo)));
  assert.ok(sinais.some((s) => s.nivel === 'atencao' && /bloqueada/i.test(s.titulo)));
});

test('latencia alta e sinalizada com o numero medido', () => {
  const sinais = saude.diagnosticar(
    cenario({ corrida: { execucoes: 10, falhas: 0, latenciaMediaMs: saude.LATENCIA_ALTA_MS + 5000 } })
  );
  const achado = sinais.find((s) => /lentas/i.test(s.titulo));
  assert.equal(achado?.nivel, 'atencao');
  assert.match(achado.detalhe, /\d+(\.\d+)?s por resposta/);
});

test('todo sinal traz titulo e explicacao legiveis', () => {
  const sinais = saude.diagnosticar(cenario({ doc: { agentEnabled: false }, pausadas: 1 }));
  for (const s of sinais) {
    assert.ok(saude.PESO[s.nivel] !== undefined, `nivel desconhecido: ${s.nivel}`);
    assert.ok(s.titulo && s.detalhe, `sinal incompleto: ${JSON.stringify(s)}`);
  }
});

// ------------------------------------------- agente calado por limite interno

test("mensagem calada por teto de tokens continua explicada no painel", () => {
  // O teto foi removido do codigo, mas os eventos das ultimas 24h sao reais: o
  // painel precisa explicar o silencio de ontem, nao so o de hoje. E a acao e
  // retomar a conversa — o handoff que o teto deixou nao sai sozinho.
  const sinais = saude.diagnosticar(cenario({ calados: { orcamento_contato: 3, orcamento_global: 1 } }));
  const achado = sinais.find((s) => /teto de tokens/i.test(s.titulo));

  // Amarelo, nao vermelho: o teto ja foi removido do sistema, entao isto e
  // historico. Alarme sobre coisa resolvida ensina a equipe a ignorar o painel.
  assert.equal(achado?.nivel, "atencao");
  assert.match(achado.titulo, /^4 /, "soma o teto do contato e o do dia");
  assert.match(achado.titulo, /ja removido/i, "o titulo diz que nao vale mais");
  assert.match(achado.comoResolver, /Retome/i);
  assert.ok(!/GUARD_/.test(achado.comoResolver), "nao pode mandar mexer em variavel que nao existe");
});

test('contato em handoff sem ninguem respondendo e critico', () => {
  // O agente calado por handoff e correto — desde que alguem tenha assumido.
  const ninguem = saude.diagnosticar(
    cenario({ calados: { handoff_humano_ativo: 4 }, volume: { enviadasPorPessoa24h: 0 } })
  );
  assert.ok(ninguem.some((s) => s.nivel === 'critico' && /sem resposta de ninguem/i.test(s.titulo)));

  // Com o escritorio atendendo a mao, nao ha o que alarmar.
  const comAtendimento = saude.diagnosticar(
    cenario({ calados: { handoff_humano_ativo: 4 }, volume: { enviadasPorPessoa24h: 6 } })
  );
  assert.ok(!comAtendimento.some((s) => /sem resposta de ninguem/i.test(s.titulo)));
});

test('o painel diz por que cada mensagem ficou sem resposta', () => {
  // "mandei mensagem e ninguem respondeu" so tinha resposta no log do servidor.
  const misto = saude.diagnosticar(
    cenario({ descartes: { fora_expediente: 2, atendimento_humano: 4, loop_de_bot: 1 } })
  );
  const achado = misto.find((s) => /sem resposta do agente/i.test(s.titulo));

  assert.equal(achado?.nivel, 'atencao');
  assert.match(achado.titulo, /^7 /, 'soma os motivos');
  assert.match(achado.detalhe, /atendimento humano: 4/);
  assert.match(achado.detalhe, /fora do expediente: 2/);
  assert.ok(!/loop_de_bot/.test(achado.detalhe), 'nome tecnico nao vai para a tela');

  // So fora do expediente e operacao normal: informa, mas nao alarma.
  const expediente = saude.diagnosticar(cenario({ descartes: { fora_expediente: 5 } }));
  const noturno = expediente.find((s) => /sem resposta do agente/i.test(s.titulo));
  assert.equal(noturno?.nivel, 'saudavel');
  assert.match(noturno.detalhe, /UMA vez por periodo/, 'explica o silencio das seguintes');
});

test('rajada de mensagens silenciadas aparece como ressalva', () => {
  // Rate limit e protecao de comportamento, nao de gasto: ocasional e normal,
  // repetido e alguem escrevendo muitas linhas seguidas e ficando sem resposta.
  const sinais = saude.diagnosticar(cenario({ calados: { rate_limit: 2 } }));
  assert.equal(sinais.find((s) => /excesso de envios/i.test(s.titulo))?.nivel, 'atencao');
});

// -------------------------------------------- risco de perder o numero

const risco = (over = {}) =>
  saude.avaliarRisco({
    estado: { status: 'connected', ...(over.estado || {}) },
    doc: { createdAt: new Date(Date.now() - 45 * 86400000), ...(over.doc || {}) },
    volume: { recebidas24h: 100, enviadas24h: 20, ...(over.volume || {}) },
    conversas: { total: 40, iniciadasPorNos: 0, ...(over.conversas || {}) },
  });

test('numero que so responde tem risco baixo, por mais volume que tenha', () => {
  // E o caso real do escritorio: 103 recebidas, 20 respondidas, nada iniciado
  // por nos. Volume nao derruba numero; iniciativa derruba.
  const r = risco({ volume: { recebidas24h: 1000, enviadas24h: 400 } });
  assert.equal(r.nivel, 'baixo');
  assert.equal(r.pontos, 0);
  assert.ok(r.fatores.some((f) => /padrao mais seguro/i.test(f.texto)));
});

test('disparo para quem nunca escreveu leva o risco para alto', () => {
  const r = risco({
    volume: { recebidas24h: 10, enviadas24h: 120 },
    conversas: { total: 60, iniciadasPorNos: 35 },
  });
  assert.equal(r.nivel, 'alto');
  assert.ok(r.fatores.some((f) => f.peso >= 3 && /iniciativa do escritorio/i.test(f.texto)));
});

test('numero novo com volume alto pesa mais que numero maduro igual', () => {
  const volume = { recebidas24h: 40, enviadas24h: 150 };
  const conversas = { total: 50, iniciadasPorNos: 12 };

  const novo = risco({ doc: { createdAt: new Date(Date.now() - 3 * 86400000) }, volume, conversas });
  const maduro = risco({ volume, conversas });

  assert.ok(novo.pontos > maduro.pontos, 'idade do numero muda a leitura do mesmo volume');
  assert.ok(novo.fatores.some((f) => /conta descartavel/i.test(f.texto)));
});

test('sessao encerrada de fora e o sinal mais concreto de restricao', () => {
  const r = risco({ estado: { status: 'logged_out' } });
  assert.notEqual(r.nivel, 'baixo');
  assert.ok(r.fatores.some((f) => f.peso >= 4 && /encerrada de fora/i.test(f.texto)));
});

test('todo fator explica o porque, mesmo quando nao pontua', () => {
  for (const f of risco().fatores) {
    assert.ok(f.texto.length > 20, `fator sem explicacao: ${JSON.stringify(f)}`);
    assert.equal(typeof f.peso, 'number');
  }
});
