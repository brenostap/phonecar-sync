// ══════════════════════════════════════════════════════════════
// PHONE CART — Sync v3.1 (com re-sync 7 dias)
// ══════════════════════════════════════════════════════════════
const { createClient } = require('@supabase/supabase-js');

const FONENINJA_TOKEN = process.env.FONENINJA_TOKEN;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const BASE            = 'https://api.fone.ninja/erp/api/lojas/phone_cart';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function fnHeaders() {
  return { 'Authorization': `Bearer ${FONENINJA_TOKEN}`, 'Accept': 'application/json' };
}
async function fnGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers: fnHeaders() });
  if (!res.ok) throw new Error(`FoneNinja ${path}: ${res.status}`);
  return res.json();
}

function isAcessorio(p) {
  return !p.imei_1 && !p.apple_id && parseFloat(p.valor_estoque || 0) < 200;
}
function isPrincipal(p) { return !isAcessorio(p); }

function parseObs(obs) {
  if (!obs) return {};
  let raw = obs.toLowerCase().trim();
  raw = raw.replace(/\.\s+(?=(?:loja|vend|atend))/g, ', ');
  raw = raw.replace(/venb?d[aeiou]?d[aeiou]?r[ao]?/g, 'vendedor');
  const lines = [];
  raw.split('\n').forEach(seg => {
    seg = seg.trim();
    if (!seg) return;
    seg.split(/[,.]+\s*(?=(?:loja|vend|atend))/).forEach(s => { s = s.trim(); if (s) lines.push(s); });
  });
  let loja = null, vendedor = null, atendente = null;
  lines.forEach(l => {
    const isVend = l.includes('vend');
    const isAtend = l.includes('atend');
    if (!isVend && !isAtend) {
      if (l.includes('urban')) loja = 'urban';
      else if (l.includes('cart')) loja = 'cart';
    }
    if (l.includes('loja') || l.startsWith('venda ')) {
      if (l.includes('urban')) loja = 'urban';
      else if (l.includes('cart')) loja = 'cart';
    }
    if (isVend && !isAtend) {
      const mv = l.match(/vend(?:edor[ao]?|a)?\s*[-:]+\s*(.+)/) || l.match(/vend(?:edor[ao]?|a)\s+(.+)/);
      if (mv) {
        const tokens = mv[1].trim().split(/[\s,]+/);
        const nome = tokens.map(t => t.replace(/[-:,.]/g, '').trim()).find(t => t.length > 1);
        if (nome) vendedor = nome;
      }
    }
    if (isAtend) {
      const ma = l.match(/atend(?:ente[s]?)?\s*[-:]+\s*(.+)/) || l.match(/atend(?:ente[s]?)\s+(.+)/);
      if (ma) {
        const tokens = ma[1].trim().split(/[\s,]+/);
        const nome = tokens.map(t => t.replace(/[-:,.]/g, '').trim()).find(t => t.length > 1);
        if (nome) atendente = nome;
      }
    }
  });
  return { loja, vendedor, atendente };
}

async function getLastSync(tabela) {
  const { data } = await supabase.from('sync_log').select('last_sync').eq('tabela', tabela).single();
  return data?.last_sync || null;
}
async function logSync(tabela, total, status, erro = null) {
  await supabase.from('sync_log').upsert({ tabela, last_sync: new Date().toISOString(), total_rows: total, status, erro });
  console.log(` [${tabela}] ${status} — ${total} registros`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── SYNC FUNCIONÁRIOS ─────────────────────────────────────────
async function syncFuncionarios() {
  const data = await fnGet('/refactored-funcionarios');
  const funcs = data.payload || data.data || [];
  if (!funcs.length) return;
  const rows = funcs.map(f => ({
    id: f.id, nome: f.nome, email: f.email, telefone: f.telefone,
    cargo: f.cargo, ativo: !!f.ativo, created_at: f.created_at,
    synced_at: new Date().toISOString()
  }));
  await supabase.from('funcionarios').upsert(rows);
  await logSync('funcionarios', rows.length, 'ok');
}

// ── SYNC ESTOQUE ──────────────────────────────────────────────
const ESTOQUE_LIMITE = 1000;

async function syncEstoque() {
  const dp = encodeURIComponent(JSON.stringify({ first: 0, rows: ESTOQUE_LIMITE, sortField: 'id', sortOrder: -1, filters: { status: { value: 'available', matchMode: 'equals' } } }));
  const data = await fnGet(`/apples?dt_params=${dp}`);
  const apples = data.payload?.data || data.data || [];
  if (!apples.length) { console.log(' [estoque] Nenhum item disponível'); return; }
  const agora = new Date().toISOString();
  const rows = apples.map(i => ({
    id: i.id, loja_id: i.loja_id, produto_id: i.produto_id,
    titulo: i.produto?.titulo || i.titulo, serial: i.serial,
    imei_1: i.imei_1, imei_2: i.imei_2, bateria: parseInt(i.bateria || 0),
    valor_estoque: parseFloat(i.valor_estoque || 0), preco_varejo: parseFloat(i.preco_varejo || 0),
    status: i.status, ultimo_fornecedor: i.ultimo_fornecedor?.nome || i.ultimo_fornecedor,
    ultimo_fornecedor_id: i.ultimo_fornecedor_id, observacoes: i.observacoes,
    created_at: i.created_at, updated_at: i.updated_at, synced_at: agora
  }));
  const { error: erroUpsert } = await supabase.from('estoque').upsert(rows);
  if (erroUpsert) throw erroUpsert;

  // BAIXA — a FoneNinja devolve apenas o que esta disponivel agora. Sem este
  // passo o aparelho vendido continua 'available' para sempre e a tabela so
  // cresce: chegou a 1.329 registros para 72 aparelhos reais em jul/2026.
  // Como todo item do snapshot acabou de receber synced_at = agora, quem
  // continua 'available' com synced_at anterior nao veio mais da FoneNinja.
  if (apples.length >= ESTOQUE_LIMITE) {
    // resposta possivelmente truncada: dar baixa aqui marcaria item real como vendido
    console.log(' [estoque] resposta no limite da API — baixa NAO aplicada por seguranca');
  } else {
    const { error: erroBaixa, count } = await supabase.from('estoque')
      .update({ status: 'sold' }, { count: 'exact' })
      .eq('status', 'available')
      .lt('synced_at', agora);
    if (erroBaixa) throw erroBaixa;
    if (count) console.log(` [estoque] ${count} item(ns) sairam do estoque — marcados como sold`);
  }

  await logSync('estoque', rows.length, 'ok');
}

// ── SYNC CLIENTES ─────────────────────────────────────────────
async function syncClientes() {
  let page = 1, total = 0;
  while (true) {
    const data = await fnGet(`/clientes?perPage=200&sort=id:asc&page=${page}`);
    const clientes = data.data || [];
    if (!clientes.length) break;
    const rows = clientes.map(c => ({
      id: c.id, nome: c.nome, telefone: c.telefone, email: c.email,
      instagram: c.instagram, cidade: c.cidade, estado: c.estado, cep: c.cep,
      origem_id: c.origem_cliente_id, data_nascimento: c.data_nascimento?.slice(0, 10) || null,
      created_at: c.created_at, updated_at: c.updated_at, synced_at: new Date().toISOString()
    }));
    await supabase.from('clientes').upsert(rows);
    total += rows.length;
    console.log(` [clientes] página ${page}: ${rows.length} (total: ${total})`);
    if (clientes.length < 200) break;
    page++;
    await sleep(200);
  }
  await logSync('clientes', total, 'ok');
}

// ── SYNC COMPRAS ──────────────────────────────────────────────
async function syncCompras() {
  const lastSync = await getLastSync('compras');
  let page = 1, total = 0;
  while (true) {
    const data = await fnGet(`/compras?sort=data_entrada:desc&page=${page}&perPage=100`);
    const compras = data.payload?.data || data.data || [];
    if (!compras.length) break;
    if (lastSync) {
      const novos = compras.filter(c => new Date(c.data_entrada) > new Date(lastSync));
      if (novos.length === 0) break;
    }
    for (const compra of compras) {
      await supabase.from('compras').upsert({
        id: compra.id, fornecedor_id: compra.entidade_id, fornecedor_nome: compra.entidade_nome,
        data_entrada: compra.data_entrada, valor_total: parseFloat(compra.valor_total || 0),
        qtd_produtos: parseInt(compra.qtd_produtos || 0), status: compra.status,
        observacoes: compra.observacoes, synced_at: new Date().toISOString()
      });
      // Itens da compra — só das novas (não re-busca detalhe das antigas toda hora)
      if (!lastSync || new Date(compra.data_entrada) > new Date(lastSync)) {
        try {
          const det = await fnGet(`/compras/${compra.id}`);
          const dd = det.payload?.data || det.data || det;
          await salvarProdutosCompra(compra.id, dd.produtos || []);
        } catch (e) { console.warn(` Erro detalhe compra ${compra.id}:`, e.message); }
        await sleep(150);
      }
      total++;
    }
    if (compras.length < 100) break;
    page++;
    await sleep(200);
  }
  await logSync('compras', total, 'ok');
}

// ── SALVAR PRODUTOS DE UMA VENDA ──────────────────────────────
async function salvarProdutosVenda(vendaId, produtos) {
  if (!produtos || !produtos.length) return;
  const prods = produtos.map(p => ({
    id: p.id, venda_id: vendaId,
    apple_id: p.apple_id || null, produto_id: p.produto_id || null,
    titulo: p.titulo || p.produto?.titulo || null,
    serial: p.serial || p.apple?.serial || null,
    imei_1: p.imei_1 || p.apple?.imei_1 || null,
    preco: parseFloat(p.preco || 0), valor_estoque: parseFloat(p.valor_estoque || 0),
    lucro: parseFloat(p.preco || 0) - parseFloat(p.valor_estoque || 0),
    desconto: parseFloat(p.desconto || 0), quantidade: parseInt(p.quantidade || 1),
    is_principal: isPrincipal(p), synced_at: new Date().toISOString()
  }));
  await supabase.from('venda_produtos').upsert(prods);
}

// ── SALVAR ITENS DE UMA COMPRA ────────────────────────────────
// Espelha salvarProdutosVenda para o lado da entrada. O detalhe /compras/:id
// traz produtos[] com titulo/serial/imei_1/valor_estoque/preco/quantidade.
async function salvarProdutosCompra(compraId, produtos) {
  if (!produtos || !produtos.length) return;
  const vistos = new Set();
  const rows = [];
  for (const p of produtos) {
    if (!p || p.id == null || vistos.has(p.id)) continue;
    vistos.add(p.id);
    rows.push({
      id: p.id, compra_id: compraId,
      apple_id: p.apple_id || null,
      titulo: p.titulo || p.produto?.titulo || null,
      serial: p.serial || p.apple?.serial || null,
      imei_1: p.imei_1 || p.apple?.imei_1 || null,
      valor_estoque: numOrNull(p.valor_estoque),
      preco: numOrNull(p.preco),
      quantidade: parseInt(p.quantidade || 1),
      synced_at: new Date().toISOString()
    });
  }
  if (rows.length) await supabase.from('compra_produtos').upsert(rows);
}

// ── SALVAR PAGAMENTOS DE UMA VENDA ────────────────────────────
// A API repete o mesmo pagamento em alguns payloads -> dedupe por id.
async function salvarPagamentosVenda(vendaId, pagamentos) {
  if (!pagamentos || !pagamentos.length) return;
  const vistos = new Set();
  const rows = [];
  for (const pg of pagamentos) {
    if (!pg || pg.id == null || vistos.has(pg.id)) continue;
    vistos.add(pg.id);
    rows.push({
      id: pg.id, venda_id: vendaId,
      forma_pagamento_id: pg.forma_pagamento_id ?? null,
      forma_pagamento: pg.forma_pagamento?.nome ?? null,
      conta_bancaria_id: pg.conta_bancaria_id ?? null,
      conta_bancaria: pg.conta_bancaria?.nome ?? null,
      valor: numOrNull(pg.valor), taxa: numOrNull(pg.taxa),
      taxa_extra: numOrNull(pg.taxa_extra), liquido: numOrNull(pg.liquido),
      numero_parcelas: pg.numero_parcelas == null ? null : parseInt(pg.numero_parcelas),
      status: pg.status ?? null,
      data_pagamento: pg.data_pagamento ?? null,
      data_compensacao: pg.data_compensacao ?? null,
      confirmed_at: pg.confirmed_at ?? null,
      canceled_at: pg.canceled_at ?? null,
      synced_at: new Date().toISOString()
    });
  }
  if (rows.length) await supabase.from('pagamentos').upsert(rows);
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function dateOrNull(v) {
  if (!v || typeof v !== 'string') return null;
  const s = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ── SALVAR CONTAS A RECEBER DE UMA VENDA ──────────────────────
// contas[] = contas-a-receber da venda. Campos confirmados no payload real
// (jul/2026): valor, valor_pago, valor_pendente, status (paid/canceled/...),
// tipo (receber), data_vencimento, parent_id (== id da venda). Guardamos o
// objeto cru em `raw` (jsonb) pra nao perder o resto (pagamentos aninhados,
// plano_conta, cadastrador). Insumo pra futura aba Caixa; nao alimenta calculo.
async function salvarContasVenda(vendaId, contas) {
  if (!contas || !contas.length) return;
  const vistos = new Set();
  const rows = [];
  for (const c of contas) {
    if (!c || c.id == null || vistos.has(c.id)) continue;
    vistos.add(c.id);
    rows.push({
      id: c.id, venda_id: vendaId,
      tipo: c.tipo ?? null,
      status: c.status ?? null,
      valor: numOrNull(c.valor),
      valor_pago: numOrNull(c.valor_pago),
      valor_pendente: numOrNull(c.valor_pendente),
      vencimento: dateOrNull(c.data_vencimento ?? c.vencimento),
      raw: c,
      synced_at: new Date().toISOString()
    });
  }
  if (rows.length) await supabase.from('contas').upsert(rows);
}

// ── SALVAR TROCAS (aparelhos de entrada do upgrade) ───────────
// A venda traz upgrade.produtos[] = os aparelhos que o cliente entregou na
// troca. Antes só guardávamos o total (upgrade_valor/qtd) e descartávamos o
// resto. Guardamos cada aparelho + o objeto cru em raw (jsonb) p/ não perder
// bateria/garantia/etc. Campos best-effort — validar pelo raw na 1ª rodada.
async function salvarTrocasVenda(vendaId, produtos) {
  if (!produtos || !produtos.length) return;
  const vistos = new Set();
  const rows = [];
  for (const p of produtos) {
    if (!p) continue;
    const id = p.id ?? p.apple_id ?? p.produto_id;
    if (id == null || vistos.has(id)) continue;
    vistos.add(id);
    rows.push({
      id, venda_id: vendaId,
      apple_id: p.apple_id ?? null,
      produto_id: p.produto_id ?? null,
      titulo: p.titulo || p.produto?.titulo || null,
      serial: p.serial || p.apple?.serial || null,
      imei_1: p.imei_1 || p.apple?.imei_1 || null,
      valor: numOrNull(p.valor ?? p.valor_total ?? p.preco),
      raw: p,
      synced_at: new Date().toISOString()
    });
  }
  if (rows.length) await supabase.from('venda_trocas').upsert(rows);
}

// ── HELPER: upsert uma venda com seus produtos ────────────────
async function upsertVenda(venda) {
  let produtos = [], pagamentos = [], upgrade = null, contas = [];
  try {
    const detail = (await fnGet(`/vendas/${venda.id}`));
    const d = detail.data || detail;
    produtos   = d.produtos   || [];
    pagamentos = d.pagamentos || [];
    upgrade    = d.upgrade    || null;
    contas     = d.contas     || [];
  } catch (e) { console.warn(` Erro detalhe venda ${venda.id}:`, e.message); }

  const { loja, vendedor, atendente } = parseObs(venda.observacoes);
  const cli = venda.cliente || {};
  await supabase.from('vendas').upsert({
    upgrade_valor: upgrade ? numOrNull(upgrade.valor_total) : null,
    upgrade_qtd: upgrade && Array.isArray(upgrade.produtos) ? upgrade.produtos.length : null,
    id: venda.id, loja_id: venda.loja_id, loja,
    cliente_id: venda.cliente_id,
    cliente_nome: cli.nome || null, cliente_tel: cli.telefone || null,
    cliente_insta: cli.instagram || null, cliente_cidade: cli.cidade || null,
    data_saida: venda.data_saida, status: venda.status,
    valor_total: parseFloat(venda.valor_total || 0),
    custo_total: parseFloat(venda.custo_total || 0),
    lucro: parseFloat(venda.lucro || 0),
    desconto: parseFloat(venda.desconto || 0),
    observacoes: venda.observacoes,
    vendedor_obs: vendedor, atendente_obs: atendente,
    vendedor_id: venda.vendedor_id,
    qtd_produtos: parseInt(venda.qtd_produtos || 0),
    synced_at: new Date().toISOString()
  });
  await salvarProdutosVenda(venda.id, produtos);
  await salvarPagamentosVenda(venda.id, pagamentos);
  await salvarContasVenda(venda.id, contas);
  await salvarTrocasVenda(venda.id, (upgrade && Array.isArray(upgrade.produtos)) ? upgrade.produtos : []);
}

// ── SYNC VENDAS (novas + re-sync 7 dias para capturar edições) ──
async function syncVendas() {
  const lastSync = await getLastSync('vendas');
  let totalNovas = 0;

  // PARTE 1: Vendas novas (incremental)
  let page = 1, parar = false;
  const cutoff = new Date();
  if (!lastSync) cutoff.setMonth(cutoff.getMonth() - 6);

  while (!parar) {
    const data = await fnGet(`/vendas?sort=data_saida:desc&page=${page}&perPage=50`);
    const vendas = data.data || [];
    if (!vendas.length) break;

    for (const venda of vendas) {
      const dataVenda = new Date(venda.data_saida);
      if (lastSync && dataVenda <= new Date(lastSync)) { parar = true; break; }
      if (!lastSync && dataVenda < cutoff) { parar = true; break; }
      await upsertVenda(venda);
      totalNovas++;
    }

    console.log(` Página ${page}: ${vendas.length} vendas (novas: ${totalNovas})`);
    if (vendas.length < 50) break;
    page++;
    await sleep(300);
  }

  // PARTE 2: Re-sync dos últimos 7 dias (captura edições em vendas antigas)
  console.log(' Re-sincronizando últimos 7 dias para capturar edições...');
  const seteDiasAtras = new Date();
  seteDiasAtras.setDate(seteDiasAtras.getDate() - 7);
  const dataFiltro = seteDiasAtras.toISOString().slice(0, 10);

  let pageR = 1, totalResync = 0;
  while (true) {
    const data = await fnGet(`/vendas?sort=data_saida:desc&page=${pageR}&perPage=50&filters[data_saida_from]=${dataFiltro}`);
    const vendas = data.data || [];
    if (!vendas.length) break;

    for (const venda of vendas) {
      // Pular vendas que já foram processadas como novas neste run
      if (lastSync && new Date(venda.data_saida) > new Date(lastSync)) continue;
      await upsertVenda(venda);
      totalResync++;
    }

    console.log(` Re-sync página ${pageR}: ${vendas.length} vendas (editadas: ${totalResync})`);
    if (vendas.length < 50) break;
    pageR++;
    await sleep(300);
  }

  console.log(` Resumo: ${totalNovas} novas + ${totalResync} re-sincronizadas`);
  await logSync('vendas', totalNovas + totalResync, 'ok');
}

// ── RESYNC PRODUTOS (sob demanda via RESYNC_PRODUTOS=true) ────
async function resyncProdutos() {
  console.log(' Buscando vendas com produtos incompletos...');
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 6);
  const { data: vendasBanco } = await supabase.from('vendas').select('id, qtd_produtos').gte('data_saida', cutoff.toISOString()).order('data_saida', { ascending: false });
  if (!vendasBanco?.length) { console.log(' Nenhuma venda encontrada'); return; }
  const { data: contagens } = await supabase.from('venda_produtos').select('venda_id').in('venda_id', vendasBanco.map(v => v.id));
  const contagemMap = {};
  (contagens || []).forEach(r => { contagemMap[r.venda_id] = (contagemMap[r.venda_id] || 0) + 1; });
  const vendasFaltando = vendasBanco.filter(v => parseInt(v.qtd_produtos || 0) > (contagemMap[v.id] || 0));
  console.log(` ${vendasFaltando.length} vendas com produtos incompletos`);
  let total = 0;
  for (const venda of vendasFaltando) {
    try {
      const detail = await fnGet(`/vendas/${venda.id}`);
      const produtos = (detail.data || detail).produtos || [];
      if (produtos.length > 0) { await salvarProdutosVenda(venda.id, produtos); total++; }
    } catch (e) { console.warn(` Erro venda ${venda.id}:`, e.message); }
    await sleep(200);
  }
  console.log(` [resync_produtos] ${total} vendas atualizadas`);
  await logSync('resync_produtos', total, 'ok');
}

// ── BACKFILL PAGAMENTOS+CONTAS (sob demanda via BACKFILL_FROM/TO) ──
// Preenche pagamentos e contas de vendas historicas que cairam fora da janela
// de 7 dias do sync incremental. Range de datas inclusivo (YYYY-MM-DD). Pula
// quem ja tem pagamento (idempotente/barato). Reusa salvar* -> zero logica nova.
async function backfillDetalhes(from, to) {
  console.log(` Backfill pagamentos+contas de ${from} a ${to}...`);
  const { data: vendas, error } = await supabase
    .from('vendas')
    .select('id, data_saida')
    .gte('data_saida', from)
    .lte('data_saida', `${to} 23:59:59`)
    .order('data_saida', { ascending: true });
  if (error) throw error;
  if (!vendas?.length) { console.log(' Nenhuma venda no range'); return; }

  // Descobrir quem ja tem pagamento (em lotes p/ nao estourar a URL do PostgREST)
  const cobertos = new Set();
  for (let i = 0; i < vendas.length; i += 300) {
    const lote = vendas.slice(i, i + 300).map(v => v.id);
    const { data: jaTem } = await supabase.from('pagamentos').select('venda_id').in('venda_id', lote);
    (jaTem || []).forEach(r => cobertos.add(r.venda_id));
  }
  const alvo = vendas.filter(v => !cobertos.has(v.id));
  console.log(` ${vendas.length} vendas no range, ${alvo.length} sem pagamento -> backfill`);

  let ok = 0, erro = 0;
  for (const v of alvo) {
    try {
      const detail = await fnGet(`/vendas/${v.id}`);
      const d = detail.data || detail;
      await salvarPagamentosVenda(v.id, d.pagamentos || []);
      await salvarContasVenda(v.id, d.contas || []);
      ok++;
      if (ok % 50 === 0) console.log(`  ...${ok}/${alvo.length}`);
    } catch (e) { erro++; console.warn(` Erro venda ${v.id}:`, e.message); }
    await sleep(300);
  }
  console.log(` [backfill] ${ok} vendas processadas, ${erro} erros`);
  await logSync('backfill_pagamentos', ok, erro ? 'ok_com_erros' : 'ok');
}

// ── BACKFILL TROCAS (sob demanda via BACKFILL_TROCAS=true) ────
// Preenche venda_trocas das vendas históricas que têm upgrade mas ainda não
// têm troca detalhada. Idempotente: pula quem já tem linha em venda_trocas.
async function backfillTrocas() {
  console.log(' Backfill trocas (upgrade.produtos) de vendas históricas...');
  const { data: vendas, error } = await supabase
    .from('vendas').select('id').gt('upgrade_qtd', 0)
    .order('data_saida', { ascending: false });
  if (error) throw error;
  if (!vendas?.length) { console.log(' Nenhuma venda com upgrade'); return; }

  const jaTem = new Set();
  for (let i = 0; i < vendas.length; i += 300) {
    const lote = vendas.slice(i, i + 300).map(v => v.id);
    const { data: t } = await supabase.from('venda_trocas').select('venda_id').in('venda_id', lote);
    (t || []).forEach(r => jaTem.add(r.venda_id));
  }
  const alvo = vendas.filter(v => !jaTem.has(v.id));
  console.log(` ${vendas.length} vendas c/ upgrade, ${alvo.length} sem troca detalhada -> backfill`);

  let ok = 0, erro = 0;
  for (const v of alvo) {
    try {
      const detail = await fnGet(`/vendas/${v.id}`);
      const up = (detail.data || detail).upgrade;
      const prods = up && Array.isArray(up.produtos) ? up.produtos : [];
      if (prods.length) { await salvarTrocasVenda(v.id, prods); ok++; }
      if (ok % 50 === 0 && ok) console.log(`  ...${ok}/${alvo.length}`);
    } catch (e) { erro++; console.warn(` Erro venda ${v.id}:`, e.message); }
    await sleep(250);
  }
  console.log(` [backfill_trocas] ${ok} vendas com troca salva, ${erro} erros`);
  await logSync('backfill_trocas', ok, erro ? 'ok_com_erros' : 'ok');
}

// ── BACKFILL ITENS DE COMPRA (via BACKFILL_COMPRAS=true) ──────
// Preenche compra_produtos das compras que ainda não têm itens. Range opcional
// por data (COMPRAS_FROM/TO, YYYY-MM-DD). Idempotente: pula quem já tem item.
async function backfillCompraItens(from, to) {
  console.log(` Backfill itens de compra${from ? ` de ${from} a ${to || 'hoje'}` : ' (todas)'}...`);
  let q = supabase.from('compras').select('id, data_entrada').order('data_entrada', { ascending: true });
  if (from) q = q.gte('data_entrada', from);
  if (to)   q = q.lte('data_entrada', `${to} 23:59:59`);
  const { data: compras, error } = await q;
  if (error) throw error;
  if (!compras?.length) { console.log(' Nenhuma compra no range'); return; }

  const comItens = new Set();
  for (let i = 0; i < compras.length; i += 300) {
    const lote = compras.slice(i, i + 300).map(c => c.id);
    const { data: jaTem } = await supabase.from('compra_produtos').select('compra_id').in('compra_id', lote);
    (jaTem || []).forEach(r => comItens.add(r.compra_id));
  }
  const alvo = compras.filter(c => !comItens.has(c.id));
  console.log(` ${compras.length} compras no range, ${alvo.length} sem itens -> backfill`);

  let ok = 0, erro = 0;
  for (const c of alvo) {
    try {
      const detail = await fnGet(`/compras/${c.id}`);
      const dd = detail.payload?.data || detail.data || detail;
      const produtos = dd.produtos || [];
      if (produtos.length) { await salvarProdutosCompra(c.id, produtos); ok++; }
      if (ok % 50 === 0 && ok) console.log(`  ...${ok}/${alvo.length}`);
    } catch (e) { erro++; console.warn(` Erro compra ${c.id}:`, e.message); }
    await sleep(250);
  }
  console.log(` [backfill_compras] ${ok} compras com itens salvos, ${erro} erros`);
  await logSync('backfill_compras', ok, erro ? 'ok_com_erros' : 'ok');
}

// ── AUTO-BACKFILL (roda junto do cron, em lotes, até zerar) ───
// Sem depender de flag manual nem de mexer no workflow: cada rodada preenche
// até LIMITE itens de compra e LIMITE trocas que ainda faltam. Idempotente
// (pula quem já tem) e barato quando não há pendência. Some sozinho ao zerar.
const AUTO_BACKFILL_LIMITE = 150;

async function autoBackfillCompras(limite = AUTO_BACKFILL_LIMITE) {
  const desde = new Date(); desde.setDate(desde.getDate() - 180);
  const { data: compras } = await supabase.from('compras')
    .select('id').gte('data_entrada', desde.toISOString())
    .order('data_entrada', { ascending: false });
  if (!compras?.length) return;
  const comItens = new Set();
  for (let i = 0; i < compras.length; i += 300) {
    const lote = compras.slice(i, i + 300).map(c => c.id);
    const { data } = await supabase.from('compra_produtos').select('compra_id').in('compra_id', lote);
    (data || []).forEach(r => comItens.add(r.compra_id));
  }
  const alvo = compras.filter(c => !comItens.has(c.id)).slice(0, limite);
  if (!alvo.length) { console.log(' [auto-backfill compras] nada pendente'); return; }
  console.log(` [auto-backfill compras] ${alvo.length} sem itens nesta rodada`);
  let ok = 0;
  for (const c of alvo) {
    try {
      const det = await fnGet(`/compras/${c.id}`);
      const dd = det.payload?.data || det.data || det;
      if ((dd.produtos || []).length) { await salvarProdutosCompra(c.id, dd.produtos); ok++; }
    } catch (e) { console.warn(` Erro compra ${c.id}:`, e.message); }
    await sleep(200);
  }
  console.log(` [auto-backfill compras] ${ok} preenchidas`);
  await logSync('auto_backfill_compras', ok, 'ok');
}

async function autoBackfillTrocas(limite = AUTO_BACKFILL_LIMITE) {
  const { data: vendas } = await supabase.from('vendas')
    .select('id').gt('upgrade_qtd', 0).order('data_saida', { ascending: false });
  if (!vendas?.length) return;
  const jaTem = new Set();
  for (let i = 0; i < vendas.length; i += 300) {
    const lote = vendas.slice(i, i + 300).map(v => v.id);
    const { data } = await supabase.from('venda_trocas').select('venda_id').in('venda_id', lote);
    (data || []).forEach(r => jaTem.add(r.venda_id));
  }
  const alvo = vendas.filter(v => !jaTem.has(v.id)).slice(0, limite);
  if (!alvo.length) { console.log(' [auto-backfill trocas] nada pendente'); return; }
  console.log(` [auto-backfill trocas] ${alvo.length} sem troca nesta rodada`);
  let ok = 0;
  for (const v of alvo) {
    try {
      const det = await fnGet(`/vendas/${v.id}`);
      const up = (det.data || det).upgrade;
      const prods = up && Array.isArray(up.produtos) ? up.produtos : [];
      if (prods.length) { await salvarTrocasVenda(v.id, prods); ok++; }
    } catch (e) { console.warn(` Erro venda ${v.id}:`, e.message); }
    await sleep(200);
  }
  console.log(` [auto-backfill trocas] ${ok} preenchidas`);
  await logSync('auto_backfill_trocas', ok, 'ok');
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Phone Cart Sync v3.1 —', new Date().toLocaleString('pt-BR'));
  console.log('━'.repeat(50));
  if (!FONENINJA_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Variáveis de ambiente faltando!');
    process.exit(1);
  }
  const RESYNC = process.env.RESYNC_PRODUTOS === 'true';
  const BACKFILL_FROM = process.env.BACKFILL_FROM;
  const BACKFILL_TO   = process.env.BACKFILL_TO;
  const BACKFILL_TROCAS  = process.env.BACKFILL_TROCAS === 'true';
  const BACKFILL_COMPRAS = process.env.BACKFILL_COMPRAS === 'true';
  try {
    // Modo backfill (manual): roda SO o backfill, pula o sync incremental
    if (BACKFILL_FROM && BACKFILL_TO) {
      console.log(`\n⏬ Modo backfill (${BACKFILL_FROM} → ${BACKFILL_TO}) — sync incremental pulado`);
      await backfillDetalhes(BACKFILL_FROM, BACKFILL_TO);
      console.log('\n✅ Backfill completo!');
      return;
    }
    if (BACKFILL_TROCAS) {
      console.log('\n⏬ Modo backfill de trocas — sync incremental pulado');
      await backfillTrocas();
      console.log('\n✅ Backfill de trocas completo!');
      return;
    }
    if (BACKFILL_COMPRAS) {
      console.log('\n⏬ Modo backfill de itens de compra — sync incremental pulado');
      await backfillCompraItens(process.env.COMPRAS_FROM, process.env.COMPRAS_TO);
      console.log('\n✅ Backfill de itens de compra completo!');
      return;
    }
    console.log('\n👔 Funcionários...'); await syncFuncionarios();
    console.log('\n📱 Estoque...');     await syncEstoque();
    console.log('\n👥 Clientes...');    await syncClientes();
    console.log('\n🛒 Compras...');     await syncCompras();
    console.log('\n📦 Vendas...');      await syncVendas();
    // Auto-completa histórico (itens de compra + trocas) em lotes, até zerar.
    // Não crítico: se falhar, não derruba o sync principal.
    try {
      console.log('\n🧩 Auto-backfill de itens de compra...'); await autoBackfillCompras();
      console.log('🧩 Auto-backfill de trocas...');           await autoBackfillTrocas();
    } catch (e) { console.warn(' Auto-backfill falhou (não crítico):', e.message); }
    if (RESYNC) { console.log('\n🔄 Resync produtos...'); await resyncProdutos(); }
    console.log('\n✅ Sync completo!');
  } catch (err) {
    console.error('\n❌ Erro:', err.message);
    await supabase.from('sync_log').upsert({ tabela: 'geral', last_sync: new Date().toISOString(), total_rows: 0, status: 'erro', erro: err.message });
    process.exit(1);
  }
}

main();
