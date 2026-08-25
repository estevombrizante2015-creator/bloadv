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

test('mensagem sem resposta por orcamento do contato aparece como critico', () => {
  // O modo de falha mais caro do sistema por ser silencioso: o contato recebe
  // "vou pedir para alguem do time continuar com voce", a conversa morre, e o
  // painel segue verde porque o numero esta conectado e o agente ligado.
  const sinais = saude.diagnosticar(cenario({ calados: { orcamento_contato: 3 } }));
  const achado = sinais.find((s) => /orcamento do contato/i.test(s.titulo));

  assert.equal(achado?.nivel, 'critico');
  assert.match(achado.comoResolver, /GUARD_DAILY_TOKEN_BUDGET/);
});

test('teto global do dia e excesso de envios tambem ficam visiveis', () => {
  const global = saude.diagnosticar(cenario({ calados: { orcamento_global: 1 } }));
  assert.equal(global.find((s) => /orcamento do dia/i.test(s.titulo))?.nivel, 'critico');

  const rajada = saude.diagnosticar(cenario({ calados: { rate_limit: 2 } }));
  assert.equal(rajada.find((s) => /excesso de envios/i.test(s.titulo))?.nivel, 'atencao');
});
