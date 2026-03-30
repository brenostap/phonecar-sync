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
async function syncEstoque() {
  const dp = encodeURIComponent(JSON.stringify({ first: 0, rows: 1000, sortField: 'id', sortOrder: -1, filters: { status: { value: 'available', matchMode: 'equals' } } }));
  const data = await fnGet(`/apples?dt_params=${dp}`);
  const apples = data.payload?.data || data.data || [];
  if (!apples.length) { console.log(' [estoque] Nenhum item disponível'); return; }
  const rows = apples.map(i => ({
    id: i.id, loja_id: i.loja_id, produto_id: i.produto_id,
    titulo: i.produto?.titulo || i.titulo, serial: i.serial,
    imei_1: i.imei_1, imei_2: i.imei_2, bateria: parseInt(i.bateria || 0),
    valor_estoque: parseFloat(i.valor_estoque || 0), preco_varejo: parseFloat(i.preco_varejo || 0),
    status: i.status, ultimo_fornecedor: i.ultimo_fornecedor?.nome || i.ultimo_fornecedor,
    ultimo_fornecedor_id: i.ultimo_fornecedor_id, observacoes: i.observacoes,
    created_at: i.created_at, updated_at: i.updated_at, synced_at: new Date().toISOString()
  }));
  await supabase.from('estoque').upsert(rows);
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

// ── HELPER: upsert uma venda com seus produtos ────────────────
async function upsertVenda(venda) {
  let produtos = [];
  try {
    const detail = await fnGet(`/vendas/${venda.id}`);
    produtos = (detail.data || detail).produtos || [];
  } catch (e) { console.warn(` Erro detalhe venda ${venda.id}:`, e.message); }

  const { loja, vendedor, atendente } = parseObs(venda.observacoes);
  const cli = venda.cliente || {};
  await supabase.from('vendas').upsert({
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

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Phone Cart Sync v3.1 —', new Date().toLocaleString('pt-BR'));
  console.log('━'.repeat(50));
  if (!FONENINJA_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Variáveis de ambiente faltando!');
    process.exit(1);
  }
  const RESYNC = process.env.RESYNC_PRODUTOS === 'true';
  try {
    console.log('\n👔 Funcionários...'); await syncFuncionarios();
    console.log('\n📱 Estoque...');     await syncEstoque();
    console.log('\n👥 Clientes...');    await syncClientes();
    console.log('\n🛒 Compras...');     await syncCompras();
    console.log('\n📦 Vendas...');      await syncVendas();
    if (RESYNC) { console.log('\n🔄 Resync produtos...'); await resyncProdutos(); }
    console.log('\n✅ Sync completo!');
  } catch (err) {
    console.error('\n❌ Erro:', err.message);
    await supabase.from('sync_log').upsert({ tabela: 'geral', last_sync: new Date().toISOString(), total_rows: 0, status: 'erro', erro: err.message });
    process.exit(1);
  }
}

main();
