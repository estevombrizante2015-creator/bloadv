const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';

const agents = require('../src/config/agents.config');

const LEADS_1 = '5519996383884';
const LEADS_2 = '5511940061595';

test('os dois numeros de captacao resolvem para o mesmo agente, ativo', () => {
  for (const numero of [LEADS_1, LEADS_2]) {
    const { agent, matched } = agents.resolveAgentByNumber(numero);
    assert.equal(matched, true, `${numero} deveria estar cadastrado`);
    assert.equal(agent.id, 'lead_capture');
    assert.equal(agent.status, 'active');
    assert.equal(agent.role, 'leads');
    assert.equal(agent.tier, 'sol');
    assert.equal(agents.isAgentActive(agent), true);
  }
});

test('resolve a partir do JID do WhatsApp, nao so do numero cru', () => {
  const jid = `${LEADS_1}@s.whatsapp.net`;
  const { agent, matched } = agents.resolveAgentByNumber(agents.jidToNumber(jid));
  assert.equal(matched, true);
  assert.equal(agent.id, 'lead_capture');
});

test('formato de cadastro nao importa: com mascara, sem mascara ou com JID', () => {
  const formatos = [
    '+55 19 99638-3884',
    '5519996383884',
    '+5519996383884',
    '5519996383884@s.whatsapp.net:12',
  ];
  for (const f of formatos) {
    const numero = f.includes('@') ? agents.jidToNumber(f) : f;
    assert.equal(agents.resolveAgentByNumber(numero).agent.id, 'lead_capture', `falhou: ${f}`);
  }
});

test('conta antiga sem o nono digito ainda casa com o cadastro', () => {
  const semNono = '551996383884'; // 55 + 19 + 96383884
  const { agent, matched } = agents.resolveAgentByNumber(semNono);
  assert.equal(matched, true, 'variante sem o nono digito deveria casar');
  assert.equal(agent.id, 'lead_capture');
});

const CLIENTES = '5519987587782';

test('agente de clientes atende o proprio numero', () => {
  const cliente = agents.getAgent('customer_agent');
  assert.ok(cliente);
  assert.equal(cliente.status, 'active');
  assert.equal(cliente.role, 'clients', 'usa a ontologia de quem ja e cliente');
  assert.equal(cliente.tier, 'luna');
  assert.equal(agents.isAgentActive(cliente), true);

  const { agent, matched } = agents.resolveAgentByNumber(CLIENTES);
  assert.equal(matched, true);
  assert.equal(agent.id, 'customer_agent');
});

test('os dois contextos nao se misturam: cada numero vai ao seu agente', () => {
  assert.equal(agents.resolveAgentByNumber(LEADS_1).agent.id, 'lead_capture');
  assert.equal(agents.resolveAgentByNumber(LEADS_2).agent.id, 'lead_capture');
  assert.equal(agents.resolveAgentByNumber(CLIENTES).agent.id, 'customer_agent');

  const leads = agents.resolveAgentByNumber(LEADS_1).agent;
  const clientes = agents.resolveAgentByNumber(CLIENTES).agent;
  assert.notEqual(leads.role, clientes.role, 'papeis diferentes = ontologias diferentes');
  assert.notEqual(leads.tier, clientes.tier, 'personas diferentes');
});

test('numero desconhecido cai num agente INERTE, nunca num agente real', () => {
  const { agent, matched } = agents.resolveAgentByNumber('5511988887777');

  assert.equal(matched, false);
  assert.equal(agent.id, 'unassigned');
  assert.equal(
    agents.isAgentActive(agent),
    false,
    'numero nao cadastrado nao pode comecar a responder sozinho'
  );

  // A invariante que importa: o fallback nao pode ser um agente de verdade.
  // Enquanto apontava para o customer_agent, bastou ele virar `active` para
  // que qualquer numero pareado por engano passasse a atender cliente.
  const reais = agents.listAgents().map((a) => a.id);
  assert.ok(!reais.includes(agent.id), 'o fallback precisa ser separado dos agentes reais');
});

test('adicionar numero e so editar a lista: nenhuma regra espalhada no codigo', () => {
  const registro = agents.registeredNumbers();
  assert.equal(registro.length, 3);
  assert.deepEqual(
    registro.map((r) => r.number).sort(),
    ['+55 (11) 94006-1595', '+55 (19) 98758-7782', '+55 (19) 99638-3884']
  );
  assert.equal(registro.filter((r) => r.agentId === 'lead_capture').length, 2);
  assert.equal(registro.filter((r) => r.agentId === 'customer_agent').length, 1);
});

test('listAgents expoe os dois contextos para o painel', () => {
  const lista = agents.listAgents();
  assert.deepEqual(lista.map((a) => a.id).sort(), ['customer_agent', 'lead_capture']);

  const captacao = lista.find((a) => a.id === 'lead_capture');
  assert.equal(captacao.numbers.length, 2);
  assert.equal(captacao.status, 'active');

  assert.ok(
    !lista.some((a) => a.id === 'unassigned'),
    'o agente inerte e mecanismo interno; nao aparece como configuracao'
  );
});

test('formatNumber e jidToNumber sao inversos praticos', () => {
  assert.equal(agents.formatNumber(LEADS_2), '+55 (11) 94006-1595');
  assert.equal(agents.jidToNumber(`${LEADS_2}@s.whatsapp.net`), LEADS_2);
  assert.equal(agents.jidToNumber('120363000000000000@g.us'), '120363000000000000');
});
