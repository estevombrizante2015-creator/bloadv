'use client';

import React, { useState } from 'react';
import {
  ArrowRight,
  Check,
  CircleAlert,
  FileSpreadsheet,
  Loader2,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { Botao, Interruptor, Modal, Selo, Seletor } from '@/components/ui/base';
import {
  clientesApi,
  type AnaliseCsv,
  type PreviaImportacao,
  type ResultadoImportacao,
} from '@/lib/clientes';

/**
 * IMPORTAR A PLANILHA
 * -------------------
 * Tres passos, e os dois primeiros NAO GRAVAM NADA: escolher o arquivo, conferir
 * o que cada coluna vira, e so entao importar.
 *
 * A conferencia existe porque uma importacao errada e cara de desfazer — sao
 * centenas de fichas criadas de uma vez. Ver antes custa trinta segundos;
 * limpar depois custa a tarde.
 *
 * O arquivo vai para o servidor em BASE64, com os bytes originais. Se o
 * navegador lesse como texto, ele escolheria a codificacao por conta propria e
 * os acentos de uma planilha do Excel chegariam estragados — e quem exporta a
 * planilha nao tem como saber em que codificacao ela esta.
 */

type Passo = 'arquivo' | 'mapear' | 'conferir' | 'pronto';

/** ArrayBuffer -> base64, em pedacos para nao estourar a pilha em arquivo grande. */
function paraBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const pedaco = 8192;
  let binario = '';

  for (let i = 0; i < bytes.length; i += pedaco) {
    binario += String.fromCharCode(...bytes.subarray(i, i + pedaco));
  }

  return btoa(binario);
}

export default function Importar({
  aoFechar,
  aoConcluir,
}: {
  aoFechar: () => void;
  aoConcluir: () => void;
}) {
  const [passo, setPasso] = useState<Passo>('arquivo');
  const [nomeArquivo, setNomeArquivo] = useState('');
  const [conteudo, setConteudo] = useState('');
  const [analise, setAnalise] = useState<AnaliseCsv | null>(null);
  const [mapeamento, setMapeamento] = useState<Record<string, string>>({});
  const [previa, setPrevia] = useState<PreviaImportacao | null>(null);
  const [resultado, setResultado] = useState<ResultadoImportacao | null>(null);
  const [atualizarExistentes, setAtualizarExistentes] = useState(false);

  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const escolherArquivo = async (arquivo: File) => {
    setOcupado(true);
    setErro(null);
    try {
      const base64 = paraBase64(await arquivo.arrayBuffer());
      const dados = await clientesApi.analisarCsv(base64);

      setConteudo(base64);
      setNomeArquivo(arquivo.name);
      setAnalise(dados);
      setMapeamento(dados.mapeamentoSugerido);
      setPasso('mapear');
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao consegui ler este arquivo.');
    } finally {
      setOcupado(false);
    }
  };

  const conferir = async () => {
    setOcupado(true);
    setErro(null);
    try {
      setPrevia(await clientesApi.preverImportacao(conteudo, mapeamento, atualizarExistentes));
      setPasso('conferir');
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao consegui simular a importacao.');
    } finally {
      setOcupado(false);
    }
  };

  const importar = async () => {
    setOcupado(true);
    setErro(null);
    try {
      setResultado(await clientesApi.importar(conteudo, mapeamento, atualizarExistentes));
      setPasso('pronto');
      aoConcluir();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'A importacao falhou.');
    } finally {
      setOcupado(false);
    }
  };

  const temNome = Object.values(mapeamento).includes('nome');

  return (
    <Modal
      titulo="Importar planilha de clientes"
      subtitulo={
        passo === 'arquivo'
          ? 'Um arquivo CSV, do jeito que sai do Excel ou do Google Planilhas.'
          : nomeArquivo
      }
      largura="max-w-4xl"
      aoFechar={aoFechar}
      rodape={
        <Rodape
          passo={passo}
          ocupado={ocupado}
          temNome={temNome}
          previa={previa}
          aoVoltar={() => setPasso(passo === 'conferir' ? 'mapear' : 'arquivo')}
          aoConferir={conferir}
          aoImportar={importar}
          aoFechar={aoFechar}
        />
      }
    >
      {erro && (
        <p className="mb-5 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-200">
          <CircleAlert size={15} className="mt-0.5 shrink-0" />
          {erro}
        </p>
      )}

      {passo === 'arquivo' && <PassoArquivo ocupado={ocupado} aoEscolher={escolherArquivo} />}

      {passo === 'mapear' && analise && (
        <PassoMapear
          analise={analise}
          mapeamento={mapeamento}
          aoMudar={setMapeamento}
          atualizarExistentes={atualizarExistentes}
          aoMudarAtualizar={setAtualizarExistentes}
        />
      )}

      {passo === 'conferir' && previa && <PassoConferir previa={previa} />}

      {passo === 'pronto' && resultado && <PassoPronto resultado={resultado} />}
    </Modal>
  );
}

// ------------------------------------------------------------------ rodape

function Rodape({
  passo,
  ocupado,
  temNome,
  previa,
  aoVoltar,
  aoConferir,
  aoImportar,
  aoFechar,
}: {
  passo: Passo;
  ocupado: boolean;
  temNome: boolean;
  previa: PreviaImportacao | null;
  aoVoltar: () => void;
  aoConferir: () => void;
  aoImportar: () => void;
  aoFechar: () => void;
}) {
  if (passo === 'arquivo') return <Botao aoClicar={aoFechar}>Cancelar</Botao>;

  if (passo === 'pronto') {
    return (
      <Botao aparencia="principal" aoClicar={aoFechar}>
        <Check size={15} />
        Concluir
      </Botao>
    );
  }

  if (passo === 'mapear') {
    return (
      <>
        <Botao aoClicar={aoVoltar} desabilitado={ocupado}>
          Trocar arquivo
        </Botao>
        <Botao
          aparencia="principal"
          aoClicar={aoConferir}
          desabilitado={ocupado || !temNome}
          titulo={temNome ? undefined : 'Escolha qual coluna e o nome do cliente'}
        >
          {ocupado ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
          Conferir antes de importar
        </Botao>
      </>
    );
  }

  const vaiCriar = (previa?.resumo.novos || 0) + (previa?.resumo.seraoAtualizados || 0);

  return (
    <>
      <Botao aoClicar={aoVoltar} desabilitado={ocupado}>
        Voltar ao mapeamento
      </Botao>
      <Botao aparencia="principal" aoClicar={aoImportar} desabilitado={ocupado || vaiCriar === 0}>
        {ocupado ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
        Importar {vaiCriar} {vaiCriar === 1 ? 'cliente' : 'clientes'}
      </Botao>
    </>
  );
}

// ---------------------------------------------------------------- passo 1

function PassoArquivo({
  ocupado,
  aoEscolher,
}: {
  ocupado: boolean;
  aoEscolher: (arquivo: File) => void;
}) {
  const [arrastando, setArrastando] = useState(false);

  return (
    <div>
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setArrastando(true);
        }}
        onDragLeave={() => setArrastando(false)}
        onDrop={(e) => {
          e.preventDefault();
          setArrastando(false);
          const arquivo = e.dataTransfer.files?.[0];
          if (arquivo) aoEscolher(arquivo);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors ${
          arrastando ? 'border-gold-500/60 bg-gold-500/5' : 'border-navy-700 hover:border-gold-500/40'
        }`}
      >
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          className="hidden"
          onChange={(e) => {
            const arquivo = e.target.files?.[0];
            if (arquivo) aoEscolher(arquivo);
          }}
        />

        {ocupado ? (
          <Loader2 size={28} className="mb-4 animate-spin text-gold-400" />
        ) : (
          <FileSpreadsheet size={28} className="mb-4 text-navy-600" />
        )}

        <p className="font-display text-base tracking-wide text-cream">
          {ocupado ? 'Lendo o arquivo…' : 'Arraste o CSV aqui, ou clique para escolher'}
        </p>
        <p className="mt-2 max-w-md text-xs leading-relaxed text-muted">
          No Excel: Arquivo → Salvar como → CSV. No Google Planilhas: Arquivo → Fazer download →
          CSV. Acentos e ponto e vírgula são resolvidos sozinhos.
        </p>
      </label>

      <p className="mt-5 text-xs leading-relaxed text-muted">
        Nada é gravado até você conferir. O próximo passo mostra o que cada coluna vai virar, e o
        seguinte mostra os clientes que serão criados.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- passo 2

function PassoMapear({
  analise,
  mapeamento,
  aoMudar,
  atualizarExistentes,
  aoMudarAtualizar,
}: {
  analise: AnaliseCsv;
  mapeamento: Record<string, string>;
  aoMudar: (m: Record<string, string>) => void;
  atualizarExistentes: boolean;
  aoMudarAtualizar: (v: boolean) => void;
}) {
  const opcoes = analise.destinos.map((d) => ({
    valor: d.id,
    label: d.label,
    descricao: d.descricao,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Selo cor="ativo">{analise.total} linhas</Selo>
        <Selo>{analise.colunas.length} colunas</Selo>
        <Selo>cabeçalho na linha {analise.linhaDoCabecalho}</Selo>
        <Selo>{analise.codificacao}</Selo>
        {analise.colunasDescartadas > 0 && (
          <Selo cor="espera">{analise.colunasDescartadas} colunas vazias ignoradas</Selo>
        )}
      </div>

      <p className="text-sm leading-relaxed text-muted">
        Confira o que cada coluna da planilha vira na ficha. O que o sistema não modela — parte
        contrária, número do processo, documentos — fica guardado na ficha com o título original,
        em <span className="text-parchment/80">Dados da planilha</span>.
      </p>

      <div className="space-y-2">
        {analise.colunas.map((coluna) => {
          const exemplo = analise.amostra.map((l) => l[coluna]).find((v) => v);
          const destino = mapeamento[coluna] || 'extra';

          return (
            <div
              key={coluna}
              className={`grid items-center gap-3 rounded-xl border p-3 sm:grid-cols-2 ${
                destino === 'ignorar' ? 'border-navy-800/60 opacity-50' : 'border-navy-800'
              }`}
            >
              <div className="min-w-0">
                <p className="truncate font-display text-sm tracking-wide text-cream">{coluna}</p>
                <p className="mt-0.5 truncate text-xs text-muted">
                  {exemplo ? `ex.: ${exemplo}` : 'sem valores nesta amostra'}
                </p>
              </div>

              <Seletor
                valor={destino}
                opcoes={opcoes}
                aoMudar={(v) => aoMudar({ ...mapeamento, [coluna]: v })}
              />
            </div>
          );
        })}
      </div>

      <Interruptor
        ligado={atualizarExistentes}
        aoMudar={aoMudarAtualizar}
        titulo="Completar fichas que já existem"
        explicacao="Preenche apenas os campos VAZIOS de quem já está cadastrado. A planilha costuma ser mais antiga que o sistema, então nada do que foi feito no painel é sobrescrito."
      />
    </div>
  );
}

// ---------------------------------------------------------------- passo 3

function PassoConferir({ previa }: { previa: PreviaImportacao }) {
  const { resumo, problemas } = previa;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Numero valor={resumo.novos} label="clientes novos" tom="bom" />
        <Numero valor={resumo.seraoAtualizados} label="fichas completadas" />
        <Numero
          valor={resumo.jaExistem - resumo.seraoAtualizados}
          label="já existem, sem mudança"
        />
        <Numero
          valor={resumo.semNome + resumo.duplicadosNoArquivo}
          label="linhas ignoradas"
          tom={resumo.semNome + resumo.duplicadosNoArquivo > 0 ? 'atencao' : 'neutro'}
        />
      </div>

      {previa.exemplos.length > 0 && (
        <div>
          <h3 className="mb-3 font-display text-sm tracking-wide text-cream">
            Como as fichas vão ficar
          </h3>
          <div className="space-y-2">
            {previa.exemplos.map((ex) => (
              <div key={ex.linha} className="rounded-xl border border-navy-800 bg-navy-900/40 p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-sm tracking-wide text-cream">{ex.nome}</span>
                  <Selo cor="ativo">{ex.status}</Selo>
                  {ex.telefone && <Selo>{ex.telefone}</Selo>}
                  {ex.responsavel && <Selo>{ex.responsavel}</Selo>}
                  {ex.tags.map((t) => (
                    <Selo key={t} cor="espera">
                      {t}
                    </Selo>
                  ))}
                </div>

                {ex.pendencias.length > 0 && (
                  <p className="mt-2 text-xs text-amber-200/85">
                    Pendência: {ex.pendencias.join('; ')}
                  </p>
                )}

                {ex.camposExtras.length > 0 && (
                  <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted">
                    <span className="text-parchment/60">Dados da planilha: </span>
                    {ex.camposExtras.map((c) => `${c.rotulo}: ${c.valor}`).join(' · ')}
                  </p>
                )}
              </div>
            ))}
          </div>
          {resumo.novos > previa.exemplos.length && (
            <p className="mt-2 text-xs text-muted">
              … e mais {resumo.novos - previa.exemplos.length}.
            </p>
          )}
        </div>
      )}

      {problemas.avisos.length > 0 && (
        <div>
          <h3 className="mb-2 flex items-center gap-2 font-display text-sm tracking-wide text-amber-200">
            <TriangleAlert size={14} />
            Vale conferir ({resumo.comAviso}{' '}
            {resumo.comAviso === 1 ? 'linha' : 'linhas'})
          </h3>
          <p className="mb-2 text-xs leading-relaxed text-muted">
            Nada aqui impede a importação. São valores que o sistema não soube traduzir e preferiu
            preservar como dado da planilha, em vez de escolher um por conta própria.
          </p>
          <ul className="scrollbar-thin max-h-40 space-y-1 overflow-y-auto">
            {problemas.avisos.map((a, i) => (
              <li key={i} className="text-xs text-muted">
                <span className="text-parchment/70">linha {a.linha}</span> · {a.nome}: {a.aviso}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(problemas.semNome.length > 0 || problemas.duplicadosNoArquivo.length > 0) && (
        <div className="rounded-xl border border-navy-800 p-4">
          <h3 className="mb-2 font-display text-sm tracking-wide text-cream">Linhas ignoradas</h3>
          <ul className="space-y-1 text-xs text-muted">
            {problemas.semNome.slice(0, 6).map((p) => (
              <li key={`n${p.linha}`}>linha {p.linha} · {p.motivo}</li>
            ))}
            {problemas.duplicadosNoArquivo.slice(0, 6).map((p) => (
              <li key={`d${p.linha}`}>
                linha {p.linha} · {p.nome} aparece mais de uma vez no arquivo
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Numero({
  valor,
  label,
  tom = 'neutro',
}: {
  valor: number;
  label: string;
  tom?: 'bom' | 'atencao' | 'neutro';
}) {
  const cores = {
    bom: 'text-emerald-200 border-emerald-400/25',
    atencao: 'text-amber-200 border-amber-400/25',
    neutro: 'text-cream border-navy-800',
  };

  return (
    <div className={`rounded-xl border bg-navy-900/40 p-4 ${cores[tom]}`}>
      <p className="font-display text-2xl tabular-nums">{valor}</p>
      <p className="mt-1 text-xs leading-snug text-muted">{label}</p>
    </div>
  );
}

// ---------------------------------------------------------------- passo 4

function PassoPronto({ resultado }: { resultado: ResultadoImportacao }) {
  return (
    <div className="space-y-5 py-4 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-emerald-400/25 bg-emerald-400/10">
        <Check className="h-6 w-6 text-emerald-300" />
      </div>

      <div>
        <h3 className="font-display text-xl tracking-wide text-cream">Importação concluída</h3>
        <p className="mt-2 text-sm text-muted">
          {resultado.criados} {resultado.criados === 1 ? 'cliente criado' : 'clientes criados'}
          {resultado.atualizados > 0 && `, ${resultado.atualizados} fichas completadas`}
          {resultado.ignorados > 0 && `, ${resultado.ignorados} ignoradas`}.
        </p>
      </div>

      {resultado.erros.length > 0 && (
        <div className="mx-auto max-w-md rounded-xl border border-amber-400/25 bg-amber-400/5 p-4 text-left">
          <p className="mb-2 text-sm text-amber-200">
            {resultado.erros.length} {resultado.erros.length === 1 ? 'linha falhou' : 'linhas falharam'}.
            As demais foram importadas normalmente.
          </p>
          <ul className="space-y-1 text-xs text-amber-100/70">
            {resultado.erros.slice(0, 5).map((e, i) => (
              <li key={i}>
                linha {e.linha}: {e.erro}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-muted">
        Cada ficha importada guarda a linha de origem na própria linha do tempo.
      </p>
    </div>
  );
}
