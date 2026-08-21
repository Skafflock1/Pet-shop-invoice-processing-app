/*
 * Pet Shop Invoice Assistant — demo prototype.
 * Vanilla JS, single-file state machine + string-template rendering.
 * No backend: recognition is scripted (see data.js SCENARIOS), history/products
 * persist to localStorage so the demo feels real across reloads.
 */

const CATEGORIES = ['Dog food', 'Cat food', 'Aquarium', 'Fish food', 'Health', 'Accessories', 'Other'];
const UNITS = ['pc', 'pack', 'kg', 'box'];
const TODAY = '2026-08-20';

const state = {
  screen: 'login',
  selectedPersonaId: null,
  persona: null,
  currentStore: null,
  storeSelection: null,
  historyStoreFilter: 'all',
  historyOpenId: null,
  productsQuery: '',
  toast: null,
  history: [],
  products: {},
  draft: null,
};

// ---------- persistence ----------

function loadPersisted() {
  try {
    const h = localStorage.getItem('psi_history');
    state.history = h ? JSON.parse(h) : seedHistory();
  } catch (e) { state.history = seedHistory(); }
  try {
    const p = localStorage.getItem('psi_products');
    state.products = p ? JSON.parse(p) : { ...PRODUCTS };
  } catch (e) { state.products = { ...PRODUCTS }; }
}
function saveHistory() { localStorage.setItem('psi_history', JSON.stringify(state.history)); }
function saveProducts() { localStorage.setItem('psi_products', JSON.stringify(state.products)); }
function resetDemoData() {
  localStorage.removeItem('psi_history');
  localStorage.removeItem('psi_products');
  location.reload();
}

// ---------- helpers ----------

function uid() { return Math.random().toString(36).slice(2, 10); }
function fmt(n) { return '€' + Number(n).toFixed(2); }
function storeName(id) { const s = STORES.find(x => x.id === id); return s ? s.name : id; }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function sumItems(draft) {
  let sum = draft.items.reduce((s, it) => s + it.lineTotal, 0);
  // The batch's money is printed on the invoice whether or not the products
  // behind it exist yet — only stop counting it once real line items have
  // been materialized for it (batch-save), to avoid double-counting.
  const batchQ = draft.queue.find(q => q.type === 'batch_new');
  if (batchQ && !batchQ.batch.saved) sum += batchQ.batch.lineTotal;
  return +sum.toFixed(2);
}
function draftIssues(draft) {
  const issues = [];
  if (draft.pagesProvided < draft.pagesExpected) issues.push('pages');
  if (Math.abs(+(draft.header.subtotal - sumItems(draft)).toFixed(2)) > 0.01) issues.push('mismatch');
  return issues;
}
function queueUnresolvedCount(draft) { return draft.queue.filter(q => !q.resolved).length; }
function readyToSave(draft) {
  const issues = draftIssues(draft);
  return queueUnresolvedCount(draft) === 0 && (issues.length === 0 || draft.mismatchOverride);
}

function buildDraftFromScenario(key) {
  const sc = SCENARIOS[key];
  const items = sc.items.map(it => ({ ...it }));
  const header = { ...sc.header };
  const queue = [];
  items.forEach((it, idx) => {
    if (it.confidence === 'low') {
      queue.push({
        id: uid(),
        type: it.handwritten ? 'ocr_qty' : 'ocr_barcode',
        itemIdx: idx,
        resolved: false,
        recognizedValue: it.handwritten ? it.qtyPrinted : it.barcode,
      });
    }
    if (it.packInvoice) {
      const master = state.products[it.barcode];
      const ok = master && master.packMultiplier === it.packInvoice.size;
      queue.push({
        id: uid(),
        type: ok ? 'pack_ok' : 'pack_warn',
        itemIdx: idx,
        resolved: false,
        invoiceSize: it.packInvoice.size,
        cardSize: master ? master.packMultiplier : null,
      });
    }
    if (it.isNew) {
      queue.push({ id: uid(), type: 'new_product', itemIdx: idx, resolved: false });
    }
  });
  if (sc.batch) {
    queue.push({ id: uid(), type: 'batch_new', resolved: false, batch: JSON.parse(JSON.stringify(sc.batch)) });
  }
  return {
    scenarioKey: key,
    supplier: sc.supplier,
    header,
    items,
    queue,
    pagesExpected: sc.pagesExpected,
    pagesProvided: sc.pagesProvided,
    extraPages: sc.extraPages ? sc.extraPages.map(it => ({ ...it })) : [],
    mismatchOverride: false,
    photos: (state.draft && state.draft.photos) || [],
    editIdx: null,
    editValue: '',
    subform: null,
    npForm: null,
    batchForm: null,
    isLive: false,
  };
}

// ============================================================
// LIVE RECOGNITION — real Claude API calls (Vision + tool use).
//
// Everything else in this app runs on the scripted SCENARIOS. This section
// is the one part that talks to the real Claude API: it sends the photos
// you actually add on the capture screen, asks Claude to extract the
// invoice into the same shape the scripted demo uses, and feeds the result
// through the exact same review/clarification/save pipeline. See the
// README ("Live recognition") for the security caveats — pasting an API
// key into a client-side page like this is a demo convenience, never a
// production pattern.
// ============================================================

const LIVE_MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', hint: 'best accuracy · ~$0.05/invoice' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', hint: 'balanced · ~$0.02/invoice' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', hint: 'fastest & cheapest · ~$0.01/invoice' },
];

const INVOICE_TOOL = {
  name: 'record_invoice',
  description: 'Record the structured data extracted from a photographed supplier invoice.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['supplier', 'invoiceNo', 'orderNo', 'invoiceDate', 'dueDate', 'subtotal', 'vat', 'total', 'qtyPrinted', 'pagesExpected', 'items'],
    properties: {
      supplier: { type: 'string', description: 'Supplier / vendor name as printed.' },
      invoiceNo: { type: 'string', description: 'Invoice number. Always present on a real invoice.' },
      orderNo: { type: 'string', description: 'Purchase order number, or "—" if none printed.' },
      invoiceDate: { type: 'string', description: 'Invoice date as printed (use YYYY-MM-DD if you can tell the format, otherwise copy as printed).' },
      dueDate: { type: 'string', description: 'Payment due date as printed, or "" if none.' },
      subtotal: { type: 'number', description: 'Total before VAT/tax, as a plain number with no currency symbol.' },
      vat: { type: 'number', description: 'VAT / tax amount, as a plain number.' },
      total: { type: 'number', description: 'Grand total including VAT/tax, as a plain number.' },
      qtyPrinted: { type: 'number', description: 'The total-quantity figure printed on the invoice, if any; 0 if none is printed.' },
      pagesExpected: { type: 'integer', description: 'The Y in a "Page X of Y" marker, if printed anywhere. If no such marker is visible, set this to the number of photos you were given.' },
      items: {
        type: 'array',
        description: 'Every line item on the invoice, across all pages given.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['barcode', 'name', 'qty', 'unit', 'price', 'confidence', 'reason', 'packSize'],
          properties: {
            barcode: { type: 'string', description: 'Barcode/SKU as printed. Empty string if none is visible on this line.' },
            name: { type: 'string', description: 'Product description as printed.' },
            qty: { type: 'number', description: 'Quantity as printed for this line (in whatever unit the invoice prints — packs, cases, or individual units).' },
            unit: { type: 'string', description: 'Unit the quantity is printed in, e.g. "pc", "pack", "box", "kg".' },
            price: { type: 'number', description: 'Unit price as printed for this line, as a plain number.' },
            confidence: { type: 'string', enum: ['high', 'low'], description: '"low" if this line was handwritten, corrected, smudged, or otherwise hard to read — even if you gave your best guess.' },
            reason: { type: 'string', description: 'If confidence is "low", a short reason (e.g. "handwritten quantity", "barcode partly smudged"). Empty string if confidence is "high".' },
            packSize: { type: 'number', description: 'If the line explicitly states a pack/case size (e.g. "Pack of 12", "12x85g"), the number of units per pack. 0 if no such notation appears.' },
          },
        },
      },
    },
  },
};

const LIVE_SYSTEM_PROMPT = `You are extracting structured data from photographed pages of a single supplier invoice for a pet shop's stock system. You will be given one or more photos, in page order, followed by an instruction. Read both printed and handwritten text, including corrections written over printed values. Report money fields as plain numbers with no currency symbol. If a photo shows multiple pages are stapled or a "Page X of Y" marker, use it to fill in pagesExpected. Always call the record_invoice tool with your best-effort extraction — never refuse or ask a clarifying question, since a human will review every low-confidence field afterward.`;

async function fileToBase64(file) {
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function callClaudeVision(apiKey, model, photos) {
  const imageBlocks = await Promise.all(photos.map(async p => ({
    type: 'image',
    source: { type: 'base64', media_type: p.mediaType || 'image/jpeg', data: await fileToBase64(p.file) },
  })));
  const body = {
    model,
    max_tokens: 8192,
    system: LIVE_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        ...imageBlocks,
        { type: 'text', text: `These are ${photos.length} photo(s) of one supplier invoice, in order. Extract it with the record_invoice tool.` },
      ],
    }],
    tools: [INVOICE_TOOL],
    tool_choice: { type: 'tool', name: 'record_invoice' },
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch (e) { /* ignore */ }
    throw new Error(`Claude API error ${res.status}${detail ? ': ' + detail : ''}`);
  }
  const data = await res.json();
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude responded without structured data — try again.');
  return toolUse.input;
}

function buildDraftFromLiveExtraction(extracted, photos) {
  const header = {
    supplier: extracted.supplier || 'Unknown supplier',
    invoiceNo: extracted.invoiceNo || '',
    orderNo: extracted.orderNo || '—',
    invoiceDate: extracted.invoiceDate || '',
    dueDate: extracted.dueDate || '',
    subtotal: +extracted.subtotal || 0,
    vat: +extracted.vat || 0,
    total: +extracted.total || 0,
    qtyPrinted: +extracted.qtyPrinted || 0,
  };
  const items = (extracted.items || []).map(raw => {
    const barcode = (raw.barcode || '').trim();
    const master = barcode && state.products[barcode];
    const qtyPrinted = +raw.qty || 0;
    const price = +raw.price || 0;
    return {
      barcode: barcode || '(none printed)',
      name: raw.name || 'Unrecognized item',
      qtyPrinted,
      unit: raw.unit || 'pc',
      price,
      lineTotal: +(qtyPrinted * price).toFixed(2),
      confidence: raw.confidence === 'low' ? 'low' : 'high',
      liveReason: raw.reason || '',
      isNew: !master,
      isBatch: false,
      packInvoice: raw.packSize ? { size: +raw.packSize } : null,
      handwritten: false,
    };
  });
  const queue = [];
  items.forEach((it, idx) => {
    if (it.confidence === 'low') {
      queue.push({ id: uid(), type: 'live_review', itemIdx: idx, resolved: false, reason: it.liveReason });
    }
    if (it.packInvoice && !it.isNew) {
      const master = state.products[it.barcode];
      const ok = master.packMultiplier === it.packInvoice.size;
      queue.push({
        id: uid(), type: ok ? 'pack_ok' : 'pack_warn', itemIdx: idx, resolved: false,
        invoiceSize: it.packInvoice.size, cardSize: master.packMultiplier,
      });
    }
    if (it.isNew) {
      queue.push({ id: uid(), type: 'new_product', itemIdx: idx, resolved: false });
    }
  });
  const pagesExpected = Math.max(1, +extracted.pagesExpected || photos.length);
  return {
    scenarioKey: null,
    supplier: header.supplier,
    header,
    items,
    queue,
    pagesExpected,
    pagesProvided: photos.length,
    extraPages: [],
    mismatchOverride: false,
    photos: state.draft.photos,
    editIdx: null,
    editValue: '',
    subform: null,
    npForm: null,
    batchForm: null,
    isLive: true,
  };
}

async function runLiveRecognition() {
  const d = state.draft;
  const stepEl = (name) => document.querySelector(`#recogSteps li[data-step="${name}"]`);
  const msgEl = () => document.getElementById('recogMsg');
  const photosWithFiles = d.photos.filter(p => p.file);

  stepEl('quality').classList.add('is-done');
  await new Promise(r => setTimeout(r, 300));
  stepEl('header').textContent = 'Sending photos to Claude API…';

  try {
    const extracted = await callClaudeVision(d.liveApiKey, d.liveModel, photosWithFiles);
    stepEl('header').classList.add('is-done');
    stepEl('items').textContent = 'Parsing extracted line items…';
    await new Promise(r => setTimeout(r, 250));
    stepEl('items').classList.add('is-done');
    await new Promise(r => setTimeout(r, 250));
    stepEl('totals').classList.add('is-done');
    await new Promise(r => setTimeout(r, 350));
    const built = buildDraftFromLiveExtraction(extracted, photosWithFiles);
    state.draft = built;
    goto('review');
  } catch (err) {
    msgEl().innerHTML = `
      <div class="alert alert--warn">
        <div>⚠️ Live recognition failed: ${esc(err.message || String(err))}</div>
        <div class="muted small">If this page is running inside a claude.ai Artifact preview, its sandbox blocks calls to the Claude API — clone the GitHub repo and open it locally (or host it yourself) to try live recognition with your own key.</div>
        <div class="alert__actions">
          <button class="btn btn--primary" data-action="retry-live">Try again</button>
          <button class="btn btn--secondary" data-action="fallback-to-sample">Use a sample invoice instead</button>
        </div>
      </div>`;
  }
}

// ---------- init ----------

function init() {
  loadPersisted();
  render();
  window.addEventListener('click', onClick);
  window.addEventListener('change', onChange);
  window.addEventListener('submit', e => e.preventDefault());
}

function goto(screen) { state.screen = screen; render(); }
function toast(msg) { state.toast = msg; render(); setTimeout(() => { state.toast = null; renderToastOnly(); }, 2200); }

// ============================================================
// RENDER
// ============================================================

function render() {
  const app = document.getElementById('app');
  app.innerHTML = screenChrome(currentScreenHtml());
  window.scrollTo(0, 0);
}
function renderToastOnly() {
  const el = document.getElementById('toast');
  if (el) el.remove();
}

function currentScreenHtml() {
  switch (state.screen) {
    case 'login': return renderLogin();
    case 'storeConfirm': return renderStoreConfirm();
    case 'home': return renderHome();
    case 'capture': return renderCapture();
    case 'recognizing': return renderRecognizing();
    case 'review': return renderReview();
    case 'success': return renderSuccess();
    case 'history': return renderHistory();
    case 'historyDetail': return renderHistoryDetail();
    case 'products': return renderProducts();
    default: return renderLogin();
  }
}

function screenChrome(inner) {
  const showChrome = !['login', 'storeConfirm'].includes(state.screen);
  const toastHtml = state.toast ? `<div id="toast" class="toast">${esc(state.toast)}</div>` : '';
  if (!showChrome) {
    return `<div class="shell shell--bare">${inner}</div>${toastHtml}`;
  }
  return `
    <div class="shell">
      ${renderTopBar()}
      <main class="content">${inner}</main>
      ${renderBottomNav()}
    </div>
    ${toastHtml}
  `;
}

function renderTopBar() {
  const p = state.persona;
  return `
    <header class="topbar">
      <div class="topbar__store" data-action="switch-store">
        <span class="topbar__pin">📍</span>
        <div>
          <div class="topbar__store-name">${esc(storeName(state.currentStore))}</div>
          <div class="topbar__switch">Switch store ›</div>
        </div>
      </div>
      <div class="topbar__user">
        <div class="topbar__user-name">${esc(p.name)}</div>
        <div class="badge badge--role">${esc(p.roleLabel)}</div>
      </div>
      <button class="iconbtn" data-action="logout" title="Log out" aria-label="Log out">⏻</button>
    </header>
  `;
}

function renderBottomNav() {
  const p = state.persona;
  const items = [
    { id: 'home', label: 'Home', icon: '🏠' },
    { id: 'capture', label: 'New Invoice', icon: '📷', primary: true, nav: 'capture' },
    { id: 'history', label: 'History', icon: '🕘' },
  ];
  if (p.role === 'manager' || p.role === 'owner') items.push({ id: 'products', label: 'Products', icon: '📦' });
  const active = (id) => (state.screen === id || (id === 'capture' && ['capture', 'recognizing', 'review', 'success'].includes(state.screen))) ? ' is-active' : '';
  return `
    <nav class="bottomnav">
      ${items.map(it => `
        <button class="bottomnav__item${it.primary ? ' bottomnav__item--primary' : ''}${active(it.id)}" data-action="nav" data-screen="${it.id === 'capture' ? 'new-invoice' : it.id}">
          <span class="bottomnav__icon">${it.icon}</span>
          <span class="bottomnav__label">${it.label}</span>
        </button>
      `).join('')}
    </nav>
  `;
}

// ---------- LOGIN ----------

function renderLogin() {
  return `
    <div class="auth">
      <div class="auth__brand">
        <div class="auth__logo">🐾</div>
        <h1>Pet Shop Invoice Assistant</h1>
        <p class="muted">Demo prototype for the invoice-entry rework. Recognition steps in this build are scripted — see the README for what's real vs. simulated.</p>
      </div>

      <div class="card">
        <div class="card__title">Choose a demo profile</div>
        <div class="persona-grid">
          ${PERSONAS.map(p => `
            <button class="persona-card${state.selectedPersonaId === p.id ? ' is-selected' : ''}" data-action="select-persona" data-id="${p.id}">
              <div class="persona-card__avatar">${p.role === 'owner' ? '👑' : p.role === 'manager' ? '🧑‍💼' : '🧑‍🔧'}</div>
              <div class="persona-card__name">${esc(p.name)}</div>
              <div class="persona-card__role">${esc(p.roleLabel)}</div>
              <div class="persona-card__stores">${p.stores.length === STORES.length ? 'All stores' : p.stores.map(storeName).join(' · ')}</div>
            </button>
          `).join('')}
        </div>

        <label class="field">
          <span class="field__label">Weekly access code</span>
          <input class="field__input" id="accessCode" value="7421" inputmode="numeric" />
          <span class="field__hint">Demo: any code is accepted.</span>
        </label>

        <button class="btn btn--primary btn--block" data-action="login-continue" ${state.selectedPersonaId ? '' : 'disabled'}>Continue</button>
      </div>
    </div>
  `;
}

// ---------- STORE CONFIRM ----------

function renderStoreConfirm() {
  const p = state.persona;
  // Everyone can pick any store (staff can cover shifts elsewhere) — their
  // own assigned store(s) are just listed first and marked as suggested.
  const others = STORES.map(s => s.id).filter(id => !p.stores.includes(id));
  const options = [...p.stores, ...others];
  if (!state.storeSelection || !options.includes(state.storeSelection)) state.storeSelection = options[0];
  return `
    <div class="auth">
      <div class="auth__brand auth__brand--tight">
        <h1>Confirm your store</h1>
        <p class="muted">Required at the start of every session — pick whichever location you're working from today, not just your usual store.</p>
      </div>
      <div class="card">
        <div class="store-list">
          ${options.map((id, i) => `
            <button class="store-option${state.storeSelection === id ? ' is-selected' : ''}" data-action="pick-store" data-store="${id}">
              <span>${esc(storeName(id))}</span>
              ${i === 0 ? '<span class="badge badge--suggested">📶 Suggested</span>' : ''}
              <span class="store-option__check">${state.storeSelection === id ? '✓' : ''}</span>
            </button>
          `).join('')}
        </div>
        <button class="btn btn--primary btn--block" data-action="confirm-store">Confirm: ${esc(storeName(state.storeSelection))}</button>
        <button class="btn btn--ghost btn--block" data-action="logout">Not you? Switch profile</button>
      </div>
    </div>
  `;
}

// ---------- HOME ----------

function renderHome() {
  const p = state.persona;
  const mine = state.history.filter(h => p.role === 'owner' || h.store === state.currentStore);
  const recent = mine.slice(0, 4);

  let ownerOverview = '';
  if (p.role === 'owner') {
    const rows = STORES.map(s => {
      const count = state.history.filter(h => h.store === s.id).length;
      return `<div class="overview-row"><span>${esc(s.name)}</span><span class="muted">${count} invoice${count === 1 ? '' : 's'}</span></div>`;
    }).join('');
    ownerOverview = `
      <div class="card">
        <div class="card__title">All stores <span class="muted">— owner view</span></div>
        ${rows}
        <button class="btn btn--ghost btn--block" data-action="add-store">+ Add store</button>
      </div>
    `;
  }

  return `
    <div class="stack">
      <div class="hero">
        <div class="hero__greeting">Hi, ${esc(p.name).split(' ')[0]} 👋</div>
        <div class="hero__sub">${esc(p.roleLabel)} · ${esc(storeName(state.currentStore))}</div>
      </div>

      <button class="cta" data-action="nav" data-screen="new-invoice">
        <span class="cta__icon">📷</span>
        <span>
          <span class="cta__title">New Invoice</span>
          <span class="cta__sub">Photograph or upload all pages at once</span>
        </span>
        <span class="cta__arrow">›</span>
      </button>

      ${ownerOverview}

      <div class="card">
        <div class="card__title-row">
          <div class="card__title">Recent activity</div>
          <button class="link" data-action="nav" data-screen="history">View all ›</button>
        </div>
        ${recent.length ? recent.map(historyRow).join('') : '<div class="empty">No invoices yet.</div>'}
      </div>
    </div>
  `;
}

function statusChip(status) {
  const map = {
    auto: '<span class="chip chip--ok">Auto-approved</span>',
    review: '<span class="chip chip--warn">Needed review</span>',
    draft: '<span class="chip chip--muted">In progress</span>',
  };
  return map[status] || '';
}

function historyRow(h) {
  return `
    <button class="hist-row" data-action="open-history" data-id="${h.id}">
      <div class="hist-row__main">
        <div class="hist-row__supplier">${esc(h.supplier)}</div>
        <div class="hist-row__meta muted">${h.date} · ${esc(storeName(h.store))} · ${esc(h.enteredBy)}</div>
      </div>
      <div class="hist-row__right">
        ${statusChip(h.status)}
        <div class="hist-row__total">${h.status === 'draft' ? '—' : fmt(h.total)}</div>
      </div>
    </button>
  `;
}

// ---------- CAPTURE ----------

function renderCapture() {
  const d = state.draft;
  const mode = d.mode || 'sample';
  const scenario = d.scenarioKey;
  const photos = d.photos || [];
  const realPhotoCount = photos.filter(p => p.file).length;
  const canStart = mode === 'sample'
    ? (scenario && photos.length)
    : ((d.liveApiKey || '').trim() && realPhotoCount);

  return `
    <div class="stack">
      <h2 class="screen-title">New Invoice</h2>
      <p class="muted">${esc(storeName(state.currentStore))}</p>

      <div class="mode-toggle">
        <button class="mode-btn${mode === 'sample' ? ' is-active' : ''}" data-action="set-mode" data-mode="sample">🎬 Sample invoice</button>
        <button class="mode-btn${mode === 'live' ? ' is-active' : ''}" data-action="set-mode" data-mode="live">🔴 Live Claude recognition</button>
      </div>

      ${mode === 'sample' ? `
        <div class="card">
          <div class="card__title">1. Pick a sample invoice to simulate</div>
          <p class="muted small">This mode doesn't call a real OCR service — choose which supplier's invoice the scan should reveal.</p>
          <div class="scenario-grid">
            ${Object.values(SCENARIOS).map(sc => `
              <button class="scenario-card${scenario === sc.key ? ' is-selected' : ''}" data-action="pick-scenario" data-key="${sc.key}">
                <div class="scenario-card__name">${esc(sc.supplier)}</div>
                <div class="scenario-card__blurb muted small">${esc(sc.blurb)}</div>
              </button>
            `).join('')}
          </div>
        </div>
      ` : `
        <div class="card card--live">
          <div class="card__title">1. Real Claude API recognition</div>
          <p class="muted small">The photos you add below are actually sent to Claude for extraction — nothing scripted. Needs your own Anthropic API key.</p>
          <label class="field field--tight">
            <span class="field__label">Anthropic API key</span>
            <input class="field__input" type="password" placeholder="sk-ant-…" data-action="live-key" value="${esc(d.liveApiKey || '')}" autocomplete="off" />
            <span class="field__hint">Kept in memory for this session only — never saved, never sent anywhere but api.anthropic.com. Get one at <span class="field__hint-strong">console.anthropic.com</span>.</span>
          </label>
          <label class="field field--tight">
            <span class="field__label">Model</span>
            <select class="field__input" data-action="live-model">
              ${LIVE_MODELS.map(m => `<option value="${m.id}" ${d.liveModel === m.id ? 'selected' : ''}>${m.label} — ${m.hint}</option>`).join('')}
            </select>
          </label>
          <div class="alert alert--warn live-warning">
            ⚠️ This pastes your key into client-side JavaScript, visible to anyone with dev tools open. Fine for trying this out yourself — a real product would hold the key on a backend, never in the browser.
          </div>
        </div>
      `}

      <div class="card">
        <div class="card__title">2. Add photos</div>
        <p class="muted small">All pages at once — no need to split header and line items.</p>
        <div class="capture-actions">
          <button class="btn btn--secondary" data-action="open-camera">📷 Take photo</button>
          <button class="btn btn--secondary" data-action="open-upload">🖼️ Upload photos</button>
        </div>
        <input type="file" id="cameraInput" accept="image/*" capture="environment" hidden />
        <input type="file" id="uploadInput" accept="image/*" multiple hidden />

        ${photos.length ? `<div class="thumb-strip">${photos.map(ph => `
          <div class="thumb ${ph.blurry ? 'thumb--blurry' : ''}">
            ${ph.url ? `<img src="${ph.url}" alt="page" />` : '<div class="thumb__placeholder">〰️ blurry</div>'}
            <button class="thumb__remove" data-action="remove-photo" data-id="${ph.id}">✕</button>
          </div>
        `).join('')}</div>` : '<div class="empty">No photos added yet.</div>'}

        ${mode === 'sample' ? `<button class="link small" data-action="sim-blurry">🧪 Simulate a blurry photo (demo)</button>` : ''}
      </div>

      <button class="btn btn--primary btn--block btn--lg" data-action="start-recognition" ${canStart ? '' : 'disabled'}>
        ${mode === 'live' ? '🔴 Send to Claude & recognize' : 'Start recognition'}
      </button>
    </div>
  `;
}

// ---------- RECOGNIZING ----------

function renderRecognizing() {
  return `
    <div class="stack recognizing">
      <div class="spinner" aria-hidden="true"></div>
      <h2 class="screen-title center">Reading the invoice…</h2>
      <ul class="steps" id="recogSteps">
        <li data-step="quality">Checking photo quality</li>
        <li data-step="header">Reading invoice header</li>
        <li data-step="items">Reading line items</li>
        <li data-step="totals">Cross-checking totals</li>
      </ul>
      <div id="recogMsg"></div>
    </div>
  `;
}

function runRecognitionSequence() {
  const d = state.draft;
  const hasBlurry = d.photos.some(p => p.blurry);
  const stepEl = (name) => document.querySelector(`#recogSteps li[data-step="${name}"]`);
  const msgEl = () => document.getElementById('recogMsg');

  setTimeout(() => {
    const el = stepEl('quality');
    if (!el) return;
    if (hasBlurry) {
      el.classList.add('is-fail');
      el.textContent = 'Checking photo quality — one photo is too blurry to read';
      msgEl().innerHTML = `
        <div class="alert alert--warn">
          <div>⚠️ One of the photos is too blurry to read reliably. Retake it before we try to recognize the text — no point wasting a pass on it.</div>
          <button class="btn btn--primary btn--block" data-action="retake-blurry">Retake photo</button>
        </div>`;
      return;
    }
    el.classList.add('is-done');
    setTimeout(() => {
      stepEl('header').classList.add('is-done');
      setTimeout(() => {
        stepEl('items').classList.add('is-done');
        setTimeout(() => {
          stepEl('totals').classList.add('is-done');
          setTimeout(() => {
            const built = buildDraftFromScenario(d.scenarioKey);
            built.photos = d.photos;
            state.draft = built;
            goto('review');
          }, 500);
        }, 700);
      }, 700);
    }, 600);
  }, 600);
}

// ---------- REVIEW ----------

function renderReview() {
  const d = state.draft;
  const issues = draftIssues(d);
  const sum = sumItems(d);
  const missingPages = issues.includes('pages');
  const mismatch = issues.includes('mismatch');
  const canFixPages = missingPages && d.extraPages && d.extraPages.length;
  const p = state.persona;

  const banner = (missingPages || mismatch) ? `
    <div class="alert alert--warn">
      ${missingPages ? `<div>⚠️ Page ${d.pagesProvided} of ${d.pagesExpected} received — looks like ${d.pagesExpected - d.pagesProvided} page(s) are missing.</div>` : ''}
      ${mismatch ? `<div>Recognized items total <strong>${fmt(sum)}</strong> but the invoice header says <strong>${fmt(d.header.subtotal)}</strong>. This invoice won't be posted automatically until it's sorted out.</div>` : ''}
      <div class="alert__actions">
        ${canFixPages ? `<button class="btn btn--primary" data-action="add-missing-pages">📷 Add missing page(s)</button>` : ''}
        ${(missingPages && d.isLive) ? `<button class="btn btn--primary" data-action="capture-more-pages">📷 Take/upload the missing page(s)</button>` : ''}
        ${(p.role !== 'employee') ? `
          <label class="checkbox">
            <input type="checkbox" data-action="toggle-override" ${d.mismatchOverride ? 'checked' : ''} />
            <span>I've checked this manually — save anyway</span>
          </label>` : `<div class="muted small">Ask a manager to review before this can be saved.</div>`}
      </div>
    </div>
  ` : '';

  return `
    <div class="stack">
      <h2 class="screen-title">Review invoice</h2>
      ${banner}

      ${renderHeaderCard(d)}
      ${renderQueueCard(d)}
      ${renderItemsCard(d, sum)}

      <div class="save-bar">
        <button class="btn btn--primary btn--block btn--lg" data-action="save-invoice" ${readyToSave(d) ? '' : 'disabled'}>
          ${saveButtonLabel(d)}
        </button>
      </div>
    </div>
  `;
}

function saveButtonLabel(d) {
  if (readyToSave(d)) return '✓ Save invoice';
  const unresolved = queueUnresolvedCount(d);
  if (unresolved > 0) return `Resolve ${unresolved} item(s) to save`;
  return 'Sort out the totals above to save';
}

function renderHeaderCard(d) {
  const f = (label, field, type = 'text') => `
    <label class="field field--tight">
      <span class="field__label">${label}</span>
      <input class="field__input" data-action="edit-header" data-field="${field}" type="${type}" value="${esc(d.header[field])}" />
    </label>`;
  return `
    <div class="card">
      <div class="card__title">Invoice header</div>
      <div class="grid-2">
        ${f('Supplier', 'supplier')}
        ${f('Invoice No.', 'invoiceNo')}
        ${f('Order No.', 'orderNo')}
        ${f('Invoice date', 'invoiceDate', 'date')}
        ${f('Due date', 'dueDate', 'date')}
        ${f('Total qty (printed)', 'qtyPrinted', 'number')}
      </div>
      <div class="grid-3 totals-row">
        ${f('Subtotal', 'subtotal', 'number')}
        ${f('VAT', 'vat', 'number')}
        ${f('Total incl. VAT', 'total', 'number')}
      </div>
      <div class="muted small">Pages: ${d.pagesProvided} of ${d.pagesExpected}${d.pagesProvided >= d.pagesExpected ? ' ✓' : ' ⚠️'}</div>
    </div>
  `;
}

function currentQueueItem(d) { return d.queue.find(q => !q.resolved) || null; }

function renderQueueCard(d) {
  const total = d.queue.length;
  const remaining = queueUnresolvedCount(d);
  if (!total) return '';
  const q = currentQueueItem(d);
  if (!q) {
    return `<div class="card card--ok"><div class="card__title">✓ All clarifications resolved</div></div>`;
  }
  const resolvedList = d.queue.filter(x => x.resolved);
  return `
    <div class="card card--clarify">
      <div class="card__title-row">
        <div class="card__title">Clarification</div>
        <div class="muted small">Question ${total - remaining + 1} of ${total}</div>
      </div>
      ${resolvedList.length ? `<div class="resolved-strip">${resolvedList.map(() => '✓').join(' ')} resolved</div>` : ''}
      ${renderQueueQuestion(d, q)}
    </div>
  `;
}

function renderQueueQuestion(d, q) {
  const p = state.persona;
  const canManage = p.role === 'manager' || p.role === 'owner';

  if (q.type === 'ocr_barcode' || q.type === 'ocr_qty') {
    const it = d.items[q.itemIdx];
    const label = q.type === 'ocr_barcode' ? 'barcode' : 'quantity';
    const isEditing = d.editIdx === q.id;
    return `
      <div class="clarify-q">
        <div>${it.handwritten ? '✍️' : '🔎'} <strong>${esc(it.name)}</strong> — the ${label} was ${it.handwritten ? 'handwritten' : 'hard to read'}, recognized as <strong>${esc(q.recognizedValue)}</strong>. Correct?</div>
        ${isEditing ? `
          <div class="clarify-edit">
            <input class="field__input" id="editInput_${q.id}" value="${esc(q.recognizedValue)}" />
            <button class="btn btn--primary" data-action="q-save-edit" data-qid="${q.id}">Save</button>
          </div>
        ` : `
          <div class="clarify-actions">
            <button class="btn btn--primary" data-action="q-confirm" data-qid="${q.id}">✓ Correct</button>
            <button class="btn btn--secondary" data-action="q-edit-toggle" data-qid="${q.id}">✏️ Edit</button>
          </div>
        `}
      </div>
    `;
  }

  if (q.type === 'live_review') {
    const it = d.items[q.itemIdx];
    const isEditing = d.editIdx === q.id;
    return `
      <div class="clarify-q">
        <div>🔴 <strong>${esc(it.name)}</strong> — Claude flagged this line as low-confidence${q.reason ? `: <em>${esc(q.reason)}</em>` : '.'}</div>
        ${isEditing ? `
          <div class="live-edit-grid">
            <label class="field field--tight"><span class="field__label">Name</span><input class="field__input" id="liveEditName_${q.id}" value="${esc(it.name)}" /></label>
            <label class="field field--tight"><span class="field__label">Barcode</span><input class="field__input" id="liveEditBarcode_${q.id}" value="${esc(it.barcode)}" /></label>
            <label class="field field--tight"><span class="field__label">Qty</span><input class="field__input" id="liveEditQty_${q.id}" type="number" value="${it.qtyPrinted}" /></label>
            <label class="field field--tight"><span class="field__label">Price</span><input class="field__input" id="liveEditPrice_${q.id}" type="number" step="0.01" value="${it.price}" /></label>
          </div>
          <div class="clarify-actions">
            <button class="btn btn--primary" data-action="q-save-live-edit" data-qid="${q.id}">Save</button>
          </div>
        ` : `
          <div class="muted small">Read as: ${esc(it.barcode)} · ${it.qtyPrinted} ${esc(it.unit)} × ${fmt(it.price)}</div>
          <div class="clarify-actions">
            <button class="btn btn--primary" data-action="q-confirm" data-qid="${q.id}">✓ Correct</button>
            <button class="btn btn--secondary" data-action="q-edit-toggle" data-qid="${q.id}">✏️ Edit</button>
          </div>
        `}
      </div>
    `;
  }

  if (q.type === 'pack_ok') {
    const it = d.items[q.itemIdx];
    const units = it.qtyPrinted * q.invoiceSize;
    return `
      <div class="clarify-q">
        <div>📦 <strong>${esc(it.name)}</strong> — invoice says Pack of ${q.invoiceSize} × ${it.qtyPrinted} packs = <strong>${units} units</strong>. Matches the product card. ✓</div>
        <div class="clarify-actions">
          <button class="btn btn--primary" data-action="q-confirm" data-qid="${q.id}">Looks right</button>
        </div>
      </div>
    `;
  }

  if (q.type === 'pack_warn') {
    const it = d.items[q.itemIdx];
    return `
      <div class="clarify-q">
        <div>⚠️ <strong>${esc(it.name)}</strong> — invoice says <strong>Pack of ${q.invoiceSize}</strong>, but the product card has <strong>Pack of ${q.cardSize}</strong>. Which is correct?</div>
        <div class="clarify-actions">
          ${canManage ? `<button class="btn btn--primary" data-action="q-pack-use-invoice" data-qid="${q.id}">Use ${q.invoiceSize} & update product card</button>` : ''}
          <button class="btn btn--secondary" data-action="q-pack-use-card" data-qid="${q.id}">Use product card (${q.cardSize})</button>
          ${!canManage ? `<button class="btn btn--ghost" data-action="q-flag-manager" data-qid="${q.id}">Flag for manager</button>` : ''}
        </div>
      </div>
    `;
  }

  if (q.type === 'new_product') {
    const it = d.items[q.itemIdx];
    if (!canManage) {
      return `
        <div class="clarify-q">
          <div>🆕 Unknown barcode <strong>${esc(it.barcode)}</strong> — read as "${esc(it.name)}". Only a manager can add new products.</div>
          <div class="clarify-actions">
            <button class="btn btn--secondary" data-action="q-flag-manager" data-qid="${q.id}">Flag for manager review</button>
          </div>
        </div>
      `;
    }
    if (d.subform && d.subform.type === 'new_product' && d.subform.qid === q.id) {
      return `
        <div class="clarify-q">
          <div>🆕 Unknown barcode <strong>${esc(it.barcode)}</strong> — read as "${esc(it.name)}".</div>
          ${renderNewProductForm(d, q)}
        </div>
      `;
    }
    return `
      <div class="clarify-q">
        <div>🆕 Unknown barcode <strong>${esc(it.barcode)}</strong> — read as "${esc(it.name)}". Create a new product?</div>
        <div class="clarify-actions">
          <button class="btn btn--primary" data-action="q-new-product-yes" data-qid="${q.id}">Yes, add product</button>
          <button class="btn btn--secondary" data-action="q-edit-toggle" data-qid="${q.id}">It's a typo — edit barcode</button>
        </div>
        ${d.editIdx === q.id ? `
          <div class="clarify-edit">
            <input class="field__input" id="editInput_${q.id}" value="${esc(it.barcode)}" />
            <button class="btn btn--primary" data-action="q-save-edit" data-qid="${q.id}">Save</button>
          </div>` : ''}
      </div>
    `;
  }

  if (q.type === 'batch_new') {
    if (!canManage) {
      return `
        <div class="clarify-q">
          <div>🆕 ${q.batch.flavours.length} similar new items detected: "${esc(q.batch.label)}". Only a manager can add new products.</div>
          <div class="clarify-actions">
            <button class="btn btn--secondary" data-action="q-flag-manager" data-qid="${q.id}">Flag for manager review</button>
          </div>
        </div>
      `;
    }
    if (d.subform && d.subform.type === 'batch_new' && d.subform.qid === q.id) {
      return `
        <div class="clarify-q">
          <div>🆕 ${q.batch.flavours.length} similar new items: "${esc(q.batch.label)}"</div>
          ${renderBatchForm(d, q)}
        </div>
      `;
    }
    return `
      <div class="clarify-q">
        <div>🆕 <strong>${q.batch.flavours.length} similar new items</strong> detected from this invoice: "${esc(q.batch.label)}" (${fmt(q.batch.priceEach)} each × ${q.batch.qtyEach}). Enter the shared details once and fill in what's different per flavour?</div>
        <div class="clarify-actions">
          <button class="btn btn--primary" data-action="q-batch-yes" data-qid="${q.id}">Add all ${q.batch.flavours.length} as new products</button>
        </div>
      </div>
    `;
  }

  return '';
}

function renderNewProductForm(d, q) {
  const f = d.npForm;
  const slot = (key, label) => `
    <div class="photo-slot">
      <div class="photo-slot__label">${label}</div>
      ${f.photos[key] ? `<img class="photo-slot__img" src="${f.photos[key]}" />` : '<div class="photo-slot__empty">No photo</div>'}
      <button class="btn btn--secondary btn--sm" data-action="np-photo" data-slot="${key}">📷 Add</button>
    </div>`;
  return `
    <div class="subform">
      <div class="photo-slots">
        ${slot('barcode', 'Barcode on product')}
        ${slot('product', 'Product photo')}
        ${slot('label', 'Label / description')}
      </div>
      <input type="file" id="npPhotoInput" accept="image/*" capture="environment" hidden />
      <label class="field field--tight">
        <span class="field__label">Product name</span>
        <input class="field__input" id="npName" value="${esc(f.name)}" />
      </label>
      <div class="grid-2">
        <label class="field field--tight">
          <span class="field__label">Category</span>
          <select class="field__input" id="npCategory">
            ${CATEGORIES.map(c => `<option ${c === f.category ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </label>
        <label class="field field--tight">
          <span class="field__label">Unit</span>
          <select class="field__input" id="npUnit">
            ${UNITS.map(u => `<option ${u === f.unit ? 'selected' : ''}>${u}</option>`).join('')}
          </select>
        </label>
      </div>
      <label class="field field--tight">
        <span class="field__label">Pack multiplier (units per pack)</span>
        <input class="field__input" id="npMultiplier" type="number" min="1" value="${f.packMultiplier}" />
      </label>
      <div class="clarify-actions">
        <button class="btn btn--primary" data-action="np-save" data-qid="${q.id}">Save product</button>
        <button class="btn btn--ghost" data-action="np-cancel" data-qid="${q.id}">Cancel</button>
      </div>
    </div>
  `;
}

function renderBatchForm(d, q) {
  const bf = d.batchForm;
  return `
    <div class="subform">
      <div class="grid-2">
        <label class="field field--tight">
          <span class="field__label">Category</span>
          <select class="field__input" id="batchCategory">
            ${CATEGORIES.map(c => `<option ${c === bf.category ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </label>
        <label class="field field--tight">
          <span class="field__label">Unit</span>
          <select class="field__input" id="batchUnit">
            ${UNITS.map(u => `<option ${u === bf.unit ? 'selected' : ''}>${u}</option>`).join('')}
          </select>
        </label>
      </div>
      <label class="field field--tight">
        <span class="field__label">Pack multiplier</span>
        <input class="field__input" id="batchMultiplier" type="number" min="1" value="${bf.packMultiplier}" />
      </label>
      <div class="batch-table">
        <div class="batch-table__head"><span>Barcode</span><span>Flavour / variant</span></div>
        ${bf.rows.map((r, i) => `
          <div class="batch-table__row">
            <input class="field__input field__input--sm" data-batch-idx="${i}" data-batch-field="barcode" value="${esc(r.barcode)}" />
            <input class="field__input field__input--sm" data-batch-idx="${i}" data-batch-field="flavour" value="${esc(r.flavour)}" />
          </div>
        `).join('')}
      </div>
      <div class="clarify-actions">
        <button class="btn btn--primary" data-action="batch-save" data-qid="${q.id}">Save all ${bf.rows.length}</button>
        <button class="btn btn--ghost" data-action="batch-cancel" data-qid="${q.id}">Cancel</button>
      </div>
    </div>
  `;
}

function renderItemsCard(d, sum) {
  const batchQ = (d.queue || []).find(q => q.type === 'batch_new');
  const rows = d.items.map(it => {
    let status = '<span class="chip chip--ok">✓</span>';
    if (it.pendingManager) status = '<span class="chip chip--warn">⏳ Awaiting manager</span>';
    else if (it.isNew) status = '<span class="chip chip--new">🆕 new</span>';
    else if (it.confidence === 'low') status = '<span class="chip chip--muted">pending</span>';
    return `
      <div class="item-row">
        <div class="item-row__main">
          <div class="item-row__name">${esc(it.name)}</div>
          <div class="muted small">${esc(it.barcode)} · ${it.qtyPrinted} ${esc(it.unit)} × ${fmt(it.price)}</div>
        </div>
        <div class="item-row__right">
          <div>${fmt(it.lineTotal)}</div>
          ${status}
        </div>
      </div>`;
  }).join('');

  const batchRow = (batchQ && !batchQ.resolved) ? `
    <div class="item-row">
      <div class="item-row__main">
        <div class="item-row__name">🆕 ${batchQ.batch.flavours.length} new items — ${esc(batchQ.batch.label)}</div>
        <div class="muted small">Pending — resolve the clarification above</div>
      </div>
      <div class="item-row__right"><div>${fmt(batchQ.batch.lineTotal)}</div></div>
    </div>` : (batchQ && batchQ.batch.pendingManager ? `
    <div class="item-row">
      <div class="item-row__main">
        <div class="item-row__name">🆕 ${batchQ.batch.flavours.length} new items — ${esc(batchQ.batch.label)}</div>
      </div>
      <div class="item-row__right"><div>${fmt(batchQ.batch.lineTotal)}</div><span class="chip chip--warn">⏳ Awaiting manager</span></div>
    </div>` : '');

  return `
    <div class="card">
      <div class="card__title-row">
        <div class="card__title">Line items</div>
        <div class="muted small">Sum: ${fmt(sum)}</div>
      </div>
      ${rows}
      ${batchRow}
    </div>
  `;
}

// ---------- SUCCESS ----------

function renderSuccess() {
  const d = state.draft;
  return `
    <div class="stack success">
      <div class="success__icon">✅</div>
      <h2 class="screen-title center">Saved to stock</h2>
      <div class="card">
        <div class="overview-row"><span>Supplier</span><span>${esc(d.supplier)}</span></div>
        <div class="overview-row"><span>Store</span><span>${esc(storeName(state.currentStore))}</span></div>
        <div class="overview-row"><span>Entered by</span><span>${esc(state.persona.name)}</span></div>
        <div class="overview-row"><span>Total</span><span>${fmt(d.header.total)}</span></div>
      </div>
      <button class="btn btn--primary btn--block btn--lg" data-action="nav" data-screen="new-invoice">New invoice</button>
      <button class="btn btn--ghost btn--block" data-action="nav" data-screen="home">Back to home</button>
    </div>
  `;
}

// ---------- HISTORY ----------

function renderHistory() {
  const p = state.persona;
  const isOwner = p.role === 'owner';
  const filtered = state.history.filter(h => {
    if (!isOwner) return h.store === state.currentStore;
    if (state.historyStoreFilter === 'all') return true;
    return h.store === state.historyStoreFilter;
  });
  return `
    <div class="stack">
      <h2 class="screen-title">History</h2>
      ${isOwner ? `
        <select class="field__input" data-action="filter-history">
          <option value="all" ${state.historyStoreFilter === 'all' ? 'selected' : ''}>All stores</option>
          ${STORES.map(s => `<option value="${s.id}" ${state.historyStoreFilter === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
      ` : ''}
      <div class="card">
        ${filtered.length ? filtered.map(historyRow).join('') : '<div class="empty">No invoices found.</div>'}
      </div>
    </div>
  `;
}

function renderHistoryDetail() {
  const h = state.history.find(x => x.id === state.historyOpenId);
  if (!h) return renderHistory();
  const p = state.persona;
  if (h.status === 'draft' && h.enteredBy !== p.name && p.role !== 'owner') {
    return `
      <div class="stack">
        <button class="link" data-action="nav" data-screen="history">‹ Back</button>
        <div class="card card--warn">
          <div class="card__title">🔒 Locked</div>
          <p>This invoice was started by <strong>${esc(h.enteredBy)}</strong> at ${esc(storeName(h.store))} and hasn't been finished. To keep data accountable, only an owner can reassign or continue it.</p>
        </div>
      </div>
    `;
  }
  if (h.status === 'draft' && p.role === 'owner') {
    return `
      <div class="stack">
        <button class="link" data-action="nav" data-screen="history">‹ Back</button>
        <div class="card card--warn">
          <div class="card__title">🔒 In progress</div>
          <p>Started by <strong>${esc(h.enteredBy)}</strong> at ${esc(storeName(h.store))}. ${esc(h.note || '')}</p>
          <button class="btn btn--primary btn--block" data-action="reassign-draft" data-id="${h.id}">Reassign to me</button>
        </div>
      </div>
    `;
  }
  return `
    <div class="stack">
      <button class="link" data-action="nav" data-screen="history">‹ Back</button>
      <div class="card">
        <div class="card__title">${esc(h.supplier)}</div>
        <div class="overview-row"><span>Date</span><span>${h.date}</span></div>
        <div class="overview-row"><span>Store</span><span>${esc(storeName(h.store))}</span></div>
        <div class="overview-row"><span>Entered by</span><span>${esc(h.enteredBy)}</span></div>
        <div class="overview-row"><span>Status</span><span>${statusChip(h.status)}</span></div>
        <div class="overview-row"><span>Total</span><span>${fmt(h.total)}</span></div>
      </div>
      ${h.snapshot ? renderItemsCard(h.snapshot, h.snapshot.items.reduce((s, it) => s + it.lineTotal, 0)) : '<p class="muted small">Line-item detail isn\'t stored for this older demo entry.</p>'}
    </div>
  `;
}

// ---------- PRODUCTS ----------

function renderProducts() {
  const q = state.productsQuery.toLowerCase();
  const entries = Object.entries(state.products).filter(([bc, p]) =>
    !q || bc.includes(q) || p.name.toLowerCase().includes(q));
  return `
    <div class="stack">
      <h2 class="screen-title">Products</h2>
      <input class="field__input" placeholder="Search by name or barcode…" value="${esc(state.productsQuery)}" data-action="search-products" />
      <button class="btn btn--secondary btn--block" data-action="add-product-standalone">+ Add product</button>
      <div class="card">
        ${entries.map(([bc, p]) => `
          <div class="item-row">
            <div class="item-row__main">
              <div class="item-row__name">${esc(p.name)}</div>
              <div class="muted small">${esc(bc)} · ${esc(p.category)} · pack of ${p.packMultiplier}</div>
            </div>
          </div>
        `).join('') || '<div class="empty">No products match.</div>'}
      </div>
    </div>
  `;
}

// ============================================================
// EVENTS
// ============================================================

function onChange(e) {
  const t = e.target;
  if (t.id === 'cameraInput' || t.id === 'uploadInput') return handleFileInput(t);
  if (t.id === 'npPhotoInput') return handleNpPhotoInput(t);
  if (t.dataset && t.dataset.batchIdx !== undefined) {
    const i = +t.dataset.batchIdx, f = t.dataset.batchField;
    state.draft.batchForm.rows[i][f] = t.value;
    return;
  }
}

function handleFileInput(input) {
  const files = Array.from(input.files || []);
  files.forEach(file => {
    state.draft.photos.push({ id: uid(), url: URL.createObjectURL(file), blurry: false, name: file.name, file, mediaType: file.type });
  });
  input.value = '';
  render();
}

let pendingNpSlot = null;
function handleNpPhotoInput(input) {
  const file = input.files && input.files[0];
  if (file && pendingNpSlot) {
    state.draft.npForm.photos[pendingNpSlot] = URL.createObjectURL(file);
  }
  input.value = '';
  render();
}

function onClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const d = state.draft;

  switch (action) {
    case 'select-persona':
      state.selectedPersonaId = btn.dataset.id;
      render();
      break;
    case 'login-continue': {
      state.persona = PERSONAS.find(p => p.id === state.selectedPersonaId);
      state.currentStore = null;
      state.storeSelection = null;
      goto('storeConfirm');
      break;
    }
    case 'pick-store':
      state.storeSelection = btn.dataset.store;
      render();
      break;
    case 'confirm-store':
      state.currentStore = state.storeSelection;
      goto('home');
      break;
    case 'switch-store':
      state.storeSelection = state.currentStore;
      goto('storeConfirm');
      break;
    case 'logout':
      state.persona = null;
      state.selectedPersonaId = null;
      state.currentStore = null;
      goto('login');
      break;
    case 'nav':
      if (btn.dataset.screen === 'new-invoice') {
        state.draft = { scenarioKey: null, photos: [], queue: [], mode: 'sample', liveApiKey: '', liveModel: LIVE_MODELS[0].id };
        goto('capture');
      } else {
        goto(btn.dataset.screen);
      }
      break;
    case 'add-store':
      toast('Adding stores is available from the owner panel (not wired up in this demo).');
      break;

    // capture
    case 'pick-scenario':
      d.scenarioKey = btn.dataset.key;
      render();
      break;
    case 'open-camera':
      document.getElementById('cameraInput').click();
      break;
    case 'open-upload':
      document.getElementById('uploadInput').click();
      break;
    case 'remove-photo':
      d.photos = d.photos.filter(p => p.id !== btn.dataset.id);
      render();
      break;
    case 'sim-blurry':
      d.photos.push({ id: uid(), url: null, blurry: true, name: 'blurry-demo' });
      render();
      break;
    case 'set-mode':
      d.mode = btn.dataset.mode;
      render();
      break;
    case 'start-recognition':
      goto('recognizing');
      if (d.mode === 'live') setTimeout(runLiveRecognition, 50);
      else setTimeout(runRecognitionSequence, 50);
      break;
    case 'retry-live':
      setTimeout(runLiveRecognition, 50);
      break;
    case 'fallback-to-sample':
      d.mode = 'sample';
      goto('capture');
      break;
    case 'retake-blurry':
      d.photos = d.photos.filter(p => !p.blurry);
      goto('capture');
      break;
    case 'capture-more-pages':
      goto('capture');
      break;

    // review - header
    case 'toggle-override':
      d.mismatchOverride = e.target.checked;
      render();
      break;
    case 'add-missing-pages':
      d.items = d.items.concat(d.extraPages);
      d.pagesProvided = d.pagesExpected;
      d.extraPages = [];
      render();
      break;

    // queue: ocr confirm/edit
    case 'q-confirm':
      resolveQueueSimple(d, btn.dataset.qid);
      break;
    case 'q-edit-toggle':
      d.editIdx = d.editIdx === btn.dataset.qid ? null : btn.dataset.qid;
      render();
      break;
    case 'q-save-edit': {
      const q = d.queue.find(x => x.id === btn.dataset.qid);
      const input = document.getElementById('editInput_' + q.id);
      const val = input.value.trim();
      applyQueueEdit(d, q, val);
      break;
    }
    case 'q-save-live-edit': {
      const q = d.queue.find(x => x.id === btn.dataset.qid);
      const it = d.items[q.itemIdx];
      it.name = document.getElementById('liveEditName_' + q.id).value.trim() || it.name;
      it.barcode = document.getElementById('liveEditBarcode_' + q.id).value.trim() || it.barcode;
      it.qtyPrinted = +document.getElementById('liveEditQty_' + q.id).value || it.qtyPrinted;
      it.price = +document.getElementById('liveEditPrice_' + q.id).value || it.price;
      it.lineTotal = +(it.qtyPrinted * it.price).toFixed(2);
      it.confidence = 'high';
      const master = state.products[it.barcode];
      it.isNew = !master;
      if (!it.isNew) {
        const staleNewProductQ = d.queue.find(x => x.type === 'new_product' && x.itemIdx === q.itemIdx && !x.resolved);
        if (staleNewProductQ) staleNewProductQ.resolved = true;
      }
      q.resolved = true;
      d.editIdx = null;
      render();
      break;
    }
    case 'q-pack-use-invoice': {
      const q = d.queue.find(x => x.id === btn.dataset.qid);
      const it = d.items[q.itemIdx];
      state.products[it.barcode] = { ...state.products[it.barcode], packMultiplier: q.invoiceSize };
      saveProducts();
      q.resolved = true;
      d.editIdx = null;
      render();
      break;
    }
    case 'q-pack-use-card':
      resolveQueueSimple(d, btn.dataset.qid);
      break;
    case 'q-flag-manager': {
      const q = d.queue.find(x => x.id === btn.dataset.qid);
      if (q.type === 'batch_new') q.batch.pendingManager = true;
      else d.items[q.itemIdx].pendingManager = true;
      q.resolved = true;
      render();
      break;
    }

    // new product subform
    case 'q-new-product-yes': {
      const q = d.queue.find(x => x.id === btn.dataset.qid);
      const it = d.items[q.itemIdx];
      d.npForm = { name: it.name, category: CATEGORIES[0], unit: 'pc', packMultiplier: 1, photos: { barcode: null, product: null, label: null } };
      d.subform = { type: 'new_product', qid: q.id };
      render();
      break;
    }
    case 'np-photo':
      pendingNpSlot = btn.dataset.slot;
      document.getElementById('npPhotoInput').click();
      break;
    case 'np-cancel':
      d.subform = null;
      render();
      break;
    case 'np-save': {
      const q = d.queue.find(x => x.id === btn.dataset.qid);
      const it = d.items[q.itemIdx];
      const name = document.getElementById('npName').value.trim() || it.name;
      const category = document.getElementById('npCategory').value;
      const unit = document.getElementById('npUnit').value;
      const packMultiplier = +document.getElementById('npMultiplier').value || 1;
      state.products[it.barcode] = { name, category, unit, packMultiplier };
      saveProducts();
      it.name = name;
      it.unit = unit;
      it.isNew = false;
      it.confirmedNew = true;
      q.resolved = true;
      d.subform = null;
      d.npForm = null;
      render();
      break;
    }

    // batch subform
    case 'q-batch-yes': {
      const q = d.queue.find(x => x.id === btn.dataset.qid);
      d.batchForm = {
        category: q.batch.category,
        unit: q.batch.unit,
        packMultiplier: q.batch.packMultiplier,
        rows: q.batch.flavours.map((fl, i) => ({
          barcode: q.batch.barcodeBase + String(i + 1).padStart(2, '0'),
          flavour: fl,
        })),
      };
      d.subform = { type: 'batch_new', qid: q.id };
      render();
      break;
    }
    case 'batch-cancel':
      d.subform = null;
      render();
      break;
    case 'batch-save': {
      const q = d.queue.find(x => x.id === btn.dataset.qid);
      const bf = d.batchForm;
      bf.category = document.getElementById('batchCategory').value;
      bf.unit = document.getElementById('batchUnit').value;
      bf.packMultiplier = +document.getElementById('batchMultiplier').value || 1;
      bf.rows.forEach(r => {
        const name = `${q.batch.label.split(' ')[0]} – ${r.flavour}`;
        state.products[r.barcode] = { name, category: bf.category, unit: bf.unit, packMultiplier: bf.packMultiplier };
        d.items.push({
          barcode: r.barcode, name, qtyPrinted: q.batch.qtyEach, unit: bf.unit,
          price: q.batch.priceEach, lineTotal: +(q.batch.qtyEach * q.batch.priceEach).toFixed(2),
          confidence: 'high', isNew: false, isBatch: true, confirmedNew: true,
        });
      });
      saveProducts();
      q.batch.saved = true;
      q.resolved = true;
      d.subform = null;
      d.batchForm = null;
      render();
      break;
    }

    // save invoice
    case 'save-invoice': {
      const hasIssue = draftIssues(d).length > 0;
      const needsReview = hasIssue || d.items.some(it => it.pendingManager) ||
        (d.queue.some(q => q.type === 'batch_new' && q.batch.pendingManager));
      const entry = {
        id: uid(), date: TODAY, supplier: d.supplier, store: state.currentStore,
        enteredBy: state.persona.name, status: needsReview ? 'review' : 'auto',
        total: d.header.total, snapshot: { header: d.header, items: d.items },
      };
      state.history.unshift(entry);
      saveHistory();
      goto('success');
      break;
    }

    // history
    case 'open-history':
      state.historyOpenId = btn.dataset.id;
      goto('historyDetail');
      break;
    case 'filter-history':
      break; // handled in onChange-like select; see below
    case 'reassign-draft': {
      const h = state.history.find(x => x.id === btn.dataset.id);
      h.enteredBy = state.persona.name;
      h.status = 'review';
      h.note = '';
      saveHistory();
      goto('history');
      break;
    }

    // products
    case 'add-product-standalone': {
      state.draft = state.draft || { photos: [], queue: [] };
      openStandaloneProductForm();
      break;
    }

    case 'reset-demo-data':
      resetDemoData();
      break;
  }
}

function resolveQueueSimple(d, qid) {
  const q = d.queue.find(x => x.id === qid);
  q.resolved = true;
  d.editIdx = null;
  render();
}
function applyQueueEdit(d, q, val) {
  if (q.type === 'ocr_qty') {
    d.items[q.itemIdx].qtyPrinted = +val || d.items[q.itemIdx].qtyPrinted;
    d.items[q.itemIdx].lineTotal = +(d.items[q.itemIdx].qtyPrinted * d.items[q.itemIdx].price).toFixed(2);
  } else if (q.type === 'ocr_barcode') {
    d.items[q.itemIdx].barcode = val;
    const master = state.products[val];
    if (master) { d.items[q.itemIdx].name = master.name; d.items[q.itemIdx].isNew = false; }
  } else if (q.type === 'new_product') {
    d.items[q.itemIdx].barcode = val;
    const master = state.products[val];
    if (master) { d.items[q.itemIdx].name = master.name; d.items[q.itemIdx].isNew = false; }
  }
  q.resolved = true;
  d.editIdx = null;
  render();
}

function openStandaloneProductForm() {
  toast('Use "New Invoice" to see the guided add-product flow triggered by an unknown barcode.');
}

// select handlers that need live value (history filter, products search)
document.addEventListener('input', (e) => {
  if (e.target.matches('[data-action="live-key"]')) {
    state.draft.liveApiKey = e.target.value;
    const canStart = state.draft.liveApiKey.trim() && state.draft.photos.some(p => p.file);
    const startBtn = document.querySelector('[data-action="start-recognition"]');
    if (startBtn) startBtn.toggleAttribute('disabled', !canStart);
    return;
  }
  if (e.target.matches('[data-action="search-products"]')) {
    state.productsQuery = e.target.value;
    const q = state.productsQuery.toLowerCase();
    const list = Object.entries(state.products).filter(([bc, p]) => !q || bc.includes(q) || p.name.toLowerCase().includes(q));
    // lightweight re-render of just the list to preserve input focus
    const card = document.querySelectorAll('.card')[document.querySelectorAll('.card').length - 1];
    if (card) {
      card.innerHTML = list.map(([bc, p]) => `
        <div class="item-row">
          <div class="item-row__main">
            <div class="item-row__name">${esc(p.name)}</div>
            <div class="muted small">${esc(bc)} · ${esc(p.category)} · pack of ${p.packMultiplier}</div>
          </div>
        </div>`).join('') || '<div class="empty">No products match.</div>';
    }
  }
});
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-action="live-model"]')) {
    state.draft.liveModel = e.target.value;
    return;
  }
  if (e.target.matches('[data-action="filter-history"]')) {
    state.historyStoreFilter = e.target.value;
    render();
  }
  if (e.target.matches('[data-action="edit-header"]')) {
    const field = e.target.dataset.field;
    const raw = e.target.value;
    const num = ['subtotal', 'vat', 'total', 'qtyPrinted'].includes(field);
    state.draft.header[field] = num ? (+raw || 0) : raw;
    render();
  }
});

init();
