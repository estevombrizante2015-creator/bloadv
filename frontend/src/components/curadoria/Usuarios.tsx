'use client';

import React, { useEffect, useState } from 'react';
import { Loader2, ShieldCheck, UserPlus } from 'lucide-react';
import { Botao, Campo, EntradaTexto, Modal, Secao, Selo, Seletor } from '@/components/ui/base';
import { curadoriaApi, formatarData, type Opcoes, type UsuarioPainel } from '@/lib/curadoria';

/**
 * QUEM PODE O QUE
 * ---------------
 * Visivel apenas para administradores. Os tres niveis existem porque curadoria
 * e trabalho de mais de uma pessoa: quem escreve o texto raramente e quem
 * responde pela conta, e quem so precisa consultar nao deveria conseguir
 * publicar sem querer.
 */
export default function Usuarios({
  opcoes,
  meuId,
}: {
  opcoes: Opcoes;
  meuId: string | undefined;
}) {
  const [usuarios, setUsuarios] = useState<UsuarioPainel[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [novo, setNovo] = useState({ nome: '', email: '', senha: '', papel: 'curador' });

  // Contador de recarga: o efeito nao pode alterar estado de forma sincrona,
  // entao quem recarrega e o evento (criou, alterou), nao o efeito.
  const [recarga, setRecarga] = useState(0);
  const recarregar = () => setRecarga((n) => n + 1);

  useEffect(() => {
    let vivo = true;

    curadoriaApi
      .usuarios()
      .then((r) => vivo && setUsuarios(r.usuarios))
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : 'Falha ao carregar os acessos'))
      .finally(() => vivo && setCarregando(false));

    return () => {
      vivo = false;
    };
  }, [recarga]);

  const criar = async () => {
    setSalvando(true);
    setErro(null);
    try {
      await curadoriaApi.criarUsuario({
        email: novo.email.trim(),
        senha: novo.senha,
        nome: novo.nome.trim() || undefined,
        papel: novo.papel,
      });
      setCriando(false);
      setNovo({ nome: '', email: '', senha: '', papel: 'curador' });
      recarregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao foi possivel criar o acesso.');
    } finally {
      setSalvando(false);
    }
  };

  const alterar = async (id: string, dados: { papel?: string; ativo?: boolean }) => {
    setErro(null);
    try {
      await curadoriaApi.alterarUsuario(id, dados);
      recarregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao foi possivel alterar o acesso.');
    }
  };

  return (
    <Secao
      titulo="Acessos ao painel"
      descricao="Quem entra no painel e o que cada pessoa pode fazer."
    >
      {erro && (
        <p className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-200">
          {erro}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        {opcoes.papeis.map((papel) => (
          <div key={papel.id} className="rounded-xl border border-navy-800 bg-navy-900/40 p-4">
            <p className="font-display text-sm tracking-wide text-cream">{papel.label}</p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">{papel.descricao}</p>
          </div>
        ))}
      </div>

      {carregando ? (
        <div className="flex items-center gap-2 py-8 text-muted">
          <Loader2 size={16} className="animate-spin text-gold-400" />
          Carregando…
        </div>
      ) : (
        <ul className="space-y-2">
          {usuarios.map((usuario) => {
            const euMesmo = usuario.id === meuId;

            return (
              <li
                key={usuario.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-navy-800 bg-navy-900/40 p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-display text-sm tracking-wide text-cream">
                    {usuario.nome || usuario.email}
                    {euMesmo && <Selo>voce</Selo>}
                    {!usuario.ativo && <Selo cor="atencao">acesso suspenso</Selo>}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {usuario.nome ? `${usuario.email} · ` : ''}
                    ultimo acesso: {formatarData(usuario.ultimoAcesso)}
                  </p>
                </div>

                <div className="w-44">
                  <Seletor
                    valor={usuario.papel}
                    desabilitado={euMesmo}
                    aoMudar={(papel) => alterar(usuario.id, { papel })}
                    opcoes={opcoes.papeis.map((papel) => ({
                      valor: papel.id,
                      label: papel.label,
                      descricao: papel.descricao,
                    }))}
                  />
                </div>

                <Botao
                  aparencia={usuario.ativo ? 'discreto' : 'secundario'}
                  desabilitado={euMesmo}
                  titulo={euMesmo ? 'Voce nao pode remover o proprio acesso' : undefined}
                  aoClicar={() => alterar(usuario.id, { ativo: !usuario.ativo })}
                >
                  {usuario.ativo ? 'Suspender' : 'Reativar'}
                </Botao>
              </li>
            );
          })}
        </ul>
      )}

      <Botao aparencia="secundario" aoClicar={() => setCriando(true)}>
        <UserPlus size={15} />
        Novo acesso
      </Botao>

      {criando && (
        <Modal
          titulo="Novo acesso ao painel"
          aoFechar={() => setCriando(false)}
          rodape={
            <>
              <Botao aoClicar={() => setCriando(false)} desabilitado={salvando}>
                Cancelar
              </Botao>
              <Botao
                aparencia="principal"
                aoClicar={criar}
                desabilitado={salvando || !novo.email.trim() || novo.senha.length < 10}
              >
                {salvando ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                Criar acesso
              </Botao>
            </>
          }
        >
          <div className="space-y-5">
            <Campo titulo="Nome" explicacao="Como esta pessoa aparece no historico de publicacoes.">
              <EntradaTexto valor={novo.nome} aoMudar={(nome) => setNovo({ ...novo, nome })} />
            </Campo>

            <Campo titulo="Email" obrigatorio>
              <EntradaTexto
                tipo="email"
                valor={novo.email}
                aoMudar={(email) => setNovo({ ...novo, email })}
                placeholder="pessoa@escritorio.com.br"
              />
            </Campo>

            <Campo
              titulo="Senha"
              obrigatorio
              explicacao="Pelo menos 10 caracteres. Combine com a pessoa e peca que ela troque depois."
            >
              <EntradaTexto
                tipo="password"
                valor={novo.senha}
                aoMudar={(senha) => setNovo({ ...novo, senha })}
              />
            </Campo>

            <Campo titulo="Nivel de acesso" obrigatorio>
              <div className="space-y-2">
                {opcoes.papeis.map((papel) => (
                  <button
                    key={papel.id}
                    type="button"
                    onClick={() => setNovo({ ...novo, papel: papel.id })}
                    className={`w-full rounded-xl border p-3.5 text-left transition-colors ${
                      novo.papel === papel.id
                        ? 'border-gold-500/60 bg-gold-500/10'
                        : 'border-navy-800 hover:border-gold-500/30'
                    }`}
                  >
                    <span className="block font-display text-sm tracking-wide text-cream">
                      {papel.label}
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted">
                      {papel.descricao}
                    </span>
                  </button>
                ))}
              </div>
            </Campo>
          </div>
        </Modal>
      )}
    </Secao>
  );
}
