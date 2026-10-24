/**
 * app.js — Lógica de la PWA Finanzas Inteligentes.
 *
 * Esta es una adaptación fiel de la lógica real del proyecto original
 * (apps-script/original/JavaScript.html): mismos IDs, mismo render, mismas
 * validaciones, mismo flujo de edición/eliminación, búsqueda, exportar CSV,
 * toasts, etc. El único cambio de fondo es el transporte: en vez de
 * `google.script.run` (que solo funciona dentro de script.google.com) se usa
 * `fetch()` contra la API multiusuario de apps-script/backend/, con
 * Content-Type: text/plain;charset=utf-8 y el cuerpo como string JSON (para
 * evitar el preflight CORS que Apps Script no maneja bien).
 *
 * También se agrega, al principio, una capa de autenticación que el original
 * no necesitaba: ahí la sesión de Google ya estaba activa por ejecutarse
 * dentro de Apps Script. Aquí el usuario inicia sesión con Google Identity
 * Services, el backend valida su ID token y emite un token de sesión propio
 * que se reutiliza en cada llamada (sessionToken), guardado en localStorage.
 */

const SESSION_KEY = 'fi_session';
let session = null; // { sessionToken, email }

// ---------- Transporte: fetch() con el mismo contrato que google.script.run ----------

async function callApi(action, extra) {
  const body = Object.assign({ action: action }, extra || {});
  if (session && session.sessionToken) body.sessionToken = session.sessionToken;

  const response = await fetch(window.APP_CONFIG.BACKEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  });

  const json = await response.json();
  if (!json.ok) {
    throw new Error(json.error || 'Error desconocido del servidor.');
  }
  return json;
}

/**
 * Shim de reemplazo de `google.script.run`: mismo patrón encadenado
 * `.withSuccessHandler(fn).withFailureHandler(fn).metodo(args)` que usa el
 * código original, pero por debajo llama a `callApi()` vía fetch().
 */
function gsRun() {
  let onSuccess = function () {};
  let onFailure = function (err) { console.error(err); };

  const ACTION_ARGS = {
    getAppData: function () { return {}; },
    saveTransaction: function (input) { return { input: input }; },
    updateTransaction: function (id, input) { return { id: id, input: input }; },
    deleteTransaction: function (id) { return { id: id }; },
    saveBudget: function (input) { return { input: input }; },
    saveSettings: function (input) { return { input: input }; },
    saveGoal: function (input) { return { input: input }; },
    deleteGoal: function (id) { return { id: id }; },
    saveDebt: function (input) { return { input: input }; },
    deleteDebt: function (id) { return { id: id }; }
  };

  const builder = {
    withSuccessHandler: function (fn) { onSuccess = fn; return builder; },
    withFailureHandler: function (fn) { onFailure = fn; return builder; }
  };

  Object.keys(ACTION_ARGS).forEach(function (action) {
    builder[action] = function () {
      const extra = ACTION_ARGS[action].apply(null, arguments);
      callApi(action, extra).then(onSuccess).catch(function (err) { onFailure(err); });
    };
  });

  return builder;
}

// ---------- Autenticación (capa nueva, no presente en el original) ----------

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.sessionToken || !parsed.email) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function saveSession(s) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

async function handleCredentialResponse(response) {
  const loginError = document.getElementById('login-error');
  loginError.classList.add('hidden');
  try {
    const result = await callApi('login', { idToken: response.credential });
    session = { sessionToken: result.data.sessionToken, email: result.data.email };
    saveSession(session);
    enterApp();
  } catch (err) {
    loginError.textContent = 'No se pudo iniciar sesión: ' + err.message;
    loginError.classList.remove('hidden');
  }
}

function initGoogleSignIn() {
  if (!window.google || !google.accounts || !google.accounts.id) {
    setTimeout(initGoogleSignIn, 200);
    return;
  }
  google.accounts.id.initialize({
    client_id: window.APP_CONFIG.GOOGLE_CLIENT_ID,
    callback: handleCredentialResponse
  });
  google.accounts.id.renderButton(document.getElementById('google-signin-button'), {
    theme: 'outline',
    size: 'large',
    text: 'signin_with'
  });
}

function logout() {
  clearSession();
  session = null;
  if (window.google && google.accounts && google.accounts.id) {
    google.accounts.id.disableAutoSelect();
  }
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}

function enterApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  document.getElementById('sidebar-user-email').textContent = session.email;
  startApp();
}

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('logout-button').addEventListener('click', logout);

  const existing = loadSession();
  if (existing) {
    session = existing;
    enterApp();
  } else {
    initGoogleSignIn();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(function () {
      // Si falla el registro del service worker, la app sigue funcionando en línea.
    });
  }
});

// ---------- A partir de aquí: lógica original de JavaScript.html, fiel 1:1 ----------
// (solo se reemplazó `google.script.run` por `gsRun()`, y `DOMContentLoaded` se movió a
// `startApp()`, llamada únicamente después de iniciar sesión).

(function () {
  'use strict';
  let data = null, activeView = 'dashboard', editingId = null;
  const $ = function (id) { return document.getElementById(id); };
  const names = { NECESIDADES: 'Necesidades', DESEOS: 'Deseos', AHORRO: 'Ahorro', DEUDAS: 'Deudas', OTROS: 'Otros', INGRESOS: 'Ingresos' };
  const cats = {
    INGRESO: ['Salario', 'Trabajo independiente', 'Ventas', 'Comisiones', 'Rendimientos', 'Regalo', 'Otro ingreso'],
    GASTO: ['Vivienda', 'Alimentación', 'Transporte', 'Servicios', 'Salud', 'Educación', 'Entretenimiento', 'Compras', 'Suscripciones', 'Pago de deuda', 'Ahorro', 'Otros gastos']
  };

  window.startApp = function () {
    $('date').value = localDate(new Date());
    populateCategories('INGRESO');
    bindNav();
    bindForms();
    load();
  };

  function bindNav() {
    document.querySelectorAll('[data-view]').forEach(function (b) { b.addEventListener('click', function () { showView(b.dataset.view); }); });
    document.querySelectorAll('[data-go]').forEach(function (b) { b.addEventListener('click', function () { showView(b.dataset.go); }); });
    $('top-add').onclick = function () { showView('movements'); };
    document.querySelectorAll('input[name="tipo"]').forEach(function (r) { r.addEventListener('change', function () { updateType(); populateCategories(r.value); }); });
    document.querySelectorAll('input[name="modelo"]').forEach(function (r) { r.addEventListener('change', updateCustom); });
    ['necesidades', 'deseos', 'ahorro', 'deudas', 'otros'].forEach(function (k) { document.querySelector('#budget-form [name="' + k + '"]').addEventListener('input', updatePercentTotal); });
    $('transaction-search').addEventListener('input', function () { renderTransactions('all-transactions', filteredTransactions()); });
  }

  function bindForms() {
    $('transaction-form').addEventListener('submit', function (e) {
      e.preventDefault();
      const f = e.currentTarget, type = f.querySelector('[name="tipo"]:checked').value;
      const p = {
        tipo: type, importe: $('amount').value, fecha: $('date').value, categoria: $('category').value,
        grupoPresupuesto: $('budget-group').value, descripcion: $('description').value, cuenta: $('account').value,
        deudaId: type === 'GASTO' && $('debt-field').classList.contains('hidden') === false ? $('debt-select').value : '',
        metaId: type === 'GASTO' && $('goal-field').classList.contains('hidden') === false ? $('goal-select').value : ''
      };
      if (p.deudaId) {
        const d = data.debts.find(function (x) { return x.id === p.deudaId; });
        if (d) {
          const previous = editingId ? data.transactions.find(function (x) { return x.id === editingId; }) : null;
          const available = d.saldoActual + (previous && previous.deudaId === p.deudaId ? previous.importe : 0);
          if (Number(p.importe) > available) { showError('El pago no puede superar el saldo pendiente de la deuda.'); return; }
        }
      }
      busy('save-transaction', true);
      const wasEditing = !!editingId;
      const call = gsRun().withSuccessHandler(function (d) {
        busy('save-transaction', false);
        data = d; render(); f.reset(); editingId = null;
        $('save-transaction').textContent = 'Guardar movimiento';
        $('date').value = localDate(new Date());
        $('account').value = 'Principal';
        f.querySelector('[name="tipo"][value="INGRESO"]').checked = true;
        updateType(); populateCategories('INGRESO');
        showToast('Movimiento ' + (wasEditing ? 'actualizado' : 'guardado') + '; cálculos actualizados.');
        showView('dashboard');
      }).withFailureHandler(function (err) { busy('save-transaction', false); showError(err.message || String(err)); });
      if (editingId) call.updateTransaction(editingId, p); else call.saveTransaction(p);
    });

    $('budget-form').addEventListener('submit', function (e) {
      e.preventDefault();
      const f = e.currentTarget, model = f.querySelector('[name="modelo"]:checked').value, p = { modelo: model };
      ['necesidades', 'deseos', 'ahorro', 'deudas', 'otros'].forEach(function (k) { p[k] = f.querySelector('[name="' + k + '"]').value; });
      const b = f.querySelector('button[type="submit"]'); b.disabled = true;
      gsRun().withSuccessHandler(function (d) { b.disabled = false; data = d; render(); showToast('Presupuesto actualizado.'); })
        .withFailureHandler(function (err) { b.disabled = false; showError(err.message || String(err)); })
        .saveBudget(p);
    });

    $('settings-form').addEventListener('submit', function (e) {
      e.preventDefault();
      const b = e.currentTarget.querySelector('button'); b.disabled = true;
      gsRun().withSuccessHandler(function (d) { b.disabled = false; data = d; render(); showToast('Configuración guardada.'); })
        .withFailureHandler(function (err) { b.disabled = false; showError(err.message || String(err)); })
        .saveSettings({ saldoInicial: $('opening-balance').value, moneda: $('currency').value });
    });

    $('goal-form').addEventListener('submit', function (e) {
      e.preventDefault();
      const f = e.currentTarget, p = Object.fromEntries(new FormData(f).entries()), b = f.querySelector('button');
      b.disabled = true;
      gsRun().withSuccessHandler(function (d) {
        b.disabled = false; data = d; render(); f.reset(); f.querySelector('[name="ahorrado"]').value = '0';
        showToast('Meta de ahorro creada.');
      }).withFailureHandler(function (err) { b.disabled = false; showError(err.message || String(err)); }).saveGoal(p);
    });

    $('debt-form').addEventListener('submit', function (e) {
      e.preventDefault();
      const f = e.currentTarget, p = Object.fromEntries(new FormData(f).entries()), b = f.querySelector('button');
      b.disabled = true;
      gsRun().withSuccessHandler(function (d) {
        b.disabled = false; data = d; render(); f.reset();
        f.querySelector('[name="tasaAnual"]').value = '0'; f.querySelector('[name="pagoMinimo"]').value = '0'; f.querySelector('[name="diaPago"]').value = '0';
        showToast('Deuda registrada.');
      }).withFailureHandler(function (err) { b.disabled = false; showError(err.message || String(err)); }).saveDebt(p);
    });

    function deleteMovement(id, btn) {
      if (!confirm('¿Eliminar este movimiento? Se recalculará el saldo y se revertirá su efecto en la meta o deuda asociada.')) return;
      if (btn) btn.disabled = true;
      gsRun().withSuccessHandler(function (d) { data = d; render(); showToast('Movimiento eliminado y cifras recalculadas.'); })
        .withFailureHandler(function (err) { if (btn) btn.disabled = false; showError(err.message || String(err)); })
        .deleteTransaction(id);
    }
    function movementAction(e) {
      const edit = e.target.closest('[data-edit-id]');
      if (edit) { startEdit(edit.dataset.editId); return; }
      const del = e.target.closest('[data-delete-id]');
      if (del) deleteMovement(del.dataset.deleteId, del);
    }
    $('all-transactions').addEventListener('click', movementAction);
    $('recent-transactions').addEventListener('click', movementAction);

    $('goals-list').addEventListener('click', function (e) {
      const b = e.target.closest('[data-delete-goal]');
      if (!b || !confirm('¿Archivar esta meta? Los movimientos históricos no se eliminan.')) return;
      gsRun().withSuccessHandler(function (d) { data = d; render(); showToast('Meta archivada.'); })
        .withFailureHandler(function (err) { showError(err.message || String(err)); }).deleteGoal(b.dataset.deleteGoal);
    });
    $('debts-list').addEventListener('click', function (e) {
      const b = e.target.closest('[data-delete-debt]');
      if (!b || !confirm('¿Archivar esta deuda? Los movimientos históricos no se eliminan.')) return;
      gsRun().withSuccessHandler(function (d) { data = d; render(); showToast('Deuda archivada.'); })
        .withFailureHandler(function (err) { showError(err.message || String(err)); }).deleteDebt(b.dataset.deleteDebt);
    });
    $('export-csv').addEventListener('click', exportCSV);
  }

  function load() {
    $('loading').classList.remove('hidden');
    gsRun().withSuccessHandler(function (d) { data = d; $('loading').classList.add('hidden'); render(); showView('dashboard'); })
      .withFailureHandler(function (err) {
        $('loading').classList.add('hidden');
        showError((err.message || String(err)) + ' Si es la primera vez que usas esta instancia, puede que el administrador aún deba ejecutar setupApp() en Apps Script.');
      }).getAppData();
  }

  function render() {
    if (!data) return;
    $('balance-value').textContent = money(data.metrics.currentBalance);
    $('spendable-value').textContent = money(data.metrics.spendable);
    $('income-value').textContent = money(data.metrics.incomeMonth);
    $('expense-value').textContent = money(data.metrics.expenseMonth);
    $('net-value').textContent = money(data.metrics.netMonth);
    $('debt-value').textContent = money(data.metrics.debtTotal);
    $('currency-prefix').textContent = symbol(data.currency);
    $('opening-balance').value = data.metrics.openingBalance;
    $('currency').value = data.currency;
    $('month-chip').textContent = data.monthLabel;
    $('total-income').textContent = money(data.metrics.totalIncome);
    $('total-expense').textContent = money(data.metrics.totalExpense);
    $('total-goal-saved').textContent = money(data.metrics.goalsSaved);
    renderBudgetSummary(); renderCategories();
    renderTransactions('recent-transactions', data.transactions.slice(0, 5));
    renderTransactions('all-transactions', filteredTransactions());
    renderBudgetDetail(); syncBudget(); renderGoals(); renderDebts(); renderHistory(); populateAssociations();
    $('error-banner').classList.add('hidden');
  }

  function startEdit(id) {
    const t = data.transactions.find(function (x) { return x.id === id; });
    if (!t) return;
    editingId = id; showView('movements');
    const f = $('transaction-form');
    f.querySelector('[name="tipo"][value="' + t.tipo + '"]').checked = true;
    $('amount').value = t.importe; $('date').value = t.fecha; $('description').value = t.descripcion;
    $('account').value = t.cuenta || 'Principal';
    populateCategories(t.tipo); $('category').value = t.categoria;
    $('budget-group').value = t.grupoPresupuesto || 'NECESIDADES';
    updateType();
    $('debt-select').value = t.deudaId || ''; $('goal-select').value = t.metaId || '';
    $('save-transaction').textContent = 'Actualizar movimiento';
    $('transaction-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderBudgetSummary() {
    const root = $('budget-summary'), b = data.budgets, gs = ['NECESIDADES', 'DESEOS', 'AHORRO', 'DEUDAS', 'OTROS'];
    const visible = gs.filter(function (g) { return (b.porcentajes[g] || 0) > 0 || (b.gastado[g] || 0) > 0; });
    if (!data.metrics.incomeMonth) { root.innerHTML = '<div class="empty-state">Registra un ingreso este mes para calcular los límites. Todos los presupuestos se conectan a ese ingreso.</div>'; return; }
    root.innerHTML = visible.map(function (g) { return budgetRow(g, b); }).join('');
  }

  function budgetRow(g, b) {
    const limit = b.limites[g] || 0, spent = b.gastado[g] || 0, pct = limit ? Math.min(100, spent / limit * 100) : (spent ? 100 : 0), over = spent > limit;
    return '<div class="budget-item"><div class="budget-line-top"><span>' + names[g] + ' · ' + (b.porcentajes[g] || 0) + '%</span><strong>' + money(spent) + ' / ' + money(limit) + '</strong></div><div class="progress-track"><div class="progress-fill ' + (over ? 'over' : '') + '" style="width:' + pct + '%"></div></div><div class="budget-sub">' + (over ? 'Superaste el límite en ' + money(spent - limit) : 'Disponible en esta categoría: ' + money(Math.max(0, limit - spent))) + '</div></div>';
  }

  function renderCategories() {
    const root = $('category-summary'), list = data.categoryTotals || [];
    if (!list.length) { root.innerHTML = '<div class="empty-state">Aún no hay gastos este mes.</div>'; return; }
    const max = Math.max.apply(Math, list.map(function (x) { return x.amount; }).concat([1]));
    root.innerHTML = list.slice(0, 7).map(function (x) {
      return '<div class="category-row"><span class="category-name">' + esc(x.category) + '</span><span class="category-amount">' + money(x.amount) + '</span><div class="progress-track"><div class="progress-fill" style="width:' + Math.max(2, x.amount / max * 100) + '%"></div></div></div>';
    }).join('');
  }

  function filteredTransactions() {
    if (!data) return [];
    const q = ($('transaction-search') && $('transaction-search').value || '').toLowerCase().trim();
    return data.transactions.filter(function (t) { return !q || [t.categoria, t.descripcion, t.tipo, t.cuenta, t.fecha].join(' ').toLowerCase().includes(q); });
  }

  function renderTransactions(id, arr) {
    const root = $(id);
    if (!arr.length) { root.innerHTML = '<div class="empty-state">No hay movimientos que mostrar. Registra un ingreso o gasto para empezar.</div>'; return; }
    root.innerHTML = '<div class="transaction-list">' + arr.map(function (t) {
      const inc = t.tipo === 'INGRESO', title = t.descripcion || t.categoria;
      const meta = dateFmt(t.fecha) + ' · ' + esc(t.categoria) + (inc ? '' : ' · ' + esc(names[t.grupoPresupuesto] || 'Otros')) + (t.cuenta ? ' · ' + esc(t.cuenta) : '');
      return '<div class="transaction-row"><div class="transaction-symbol ' + (inc ? 'income' : 'expense') + '">' + (inc ? '↙' : '↗') + '</div><div class="transaction-info"><div class="transaction-title">' + esc(title) + '</div><div class="transaction-meta">' + meta + '</div></div><div class="transaction-amount ' + (inc ? 'income' : 'expense') + '">' + (inc ? '+' : '−') + money(t.importe) + '</div><button class="edit-button" data-edit-id="' + esc(t.id) + '" aria-label="Editar movimiento" title="Editar">Editar</button><button class="delete-button" data-delete-id="' + esc(t.id) + '" aria-label="Eliminar movimiento" title="Eliminar">×</button></div>';
    }).join('') + '</div>';
  }

  function renderBudgetDetail() {
    const root = $('budget-detail'), b = data.budgets, gs = ['NECESIDADES', 'DESEOS', 'AHORRO', 'DEUDAS', 'OTROS'];
    if (!data.metrics.incomeMonth) { root.innerHTML = '<div class="empty-state">El cálculo aparecerá al registrar ingresos del mes.</div>'; return; }
    root.innerHTML = '<div class="budget-detail-row"><div class="budget-detail-top"><span>Ingreso base mensual</span><strong>' + money(b.ingresoBaseMes) + '</strong></div></div>' + gs.map(function (g) {
      const lim = b.limites[g] || 0, spent = b.gastado[g] || 0, p = lim ? Math.min(100, spent / lim * 100) : (spent ? 100 : 0);
      return '<div class="budget-detail-row"><div class="budget-detail-top"><span>' + names[g] + ' · ' + (b.porcentajes[g] || 0) + '%</span><strong>' + money(lim) + '</strong></div><div class="progress-track"><div class="progress-fill ' + (spent > lim ? 'over' : '') + '" style="width:' + p + '%"></div></div><div class="budget-detail-bottom"><span>Gastado: ' + money(spent) + '</span><span>Restante: ' + money(Math.max(0, lim - spent)) + '</span></div></div>';
    }).join('');
  }

  function syncBudget() {
    const b = data.budgets, model = ['50-30-20', '70-20-10'].indexOf(b.modelo) !== -1 ? b.modelo : 'PERSONALIZADO';
    const r = document.querySelector('input[name="modelo"][value="' + model + '"]');
    if (r) r.checked = true;
    ['necesidades', 'deseos', 'ahorro', 'deudas', 'otros'].forEach(function (k) {
      const el = document.querySelector('#budget-form [name="' + k + '"]');
      el.value = b.porcentajes[k.toUpperCase()] || 0;
    });
    updateCustom();
  }

  function updateCustom() {
    const checked = document.querySelector('input[name="modelo"]:checked');
    const model = checked ? checked.value : null;
    $('custom-percentages').classList.toggle('hidden', model !== 'PERSONALIZADO');
    updatePercentTotal();
  }

  function updatePercentTotal() {
    if (!$('percentage-total')) return;
    const sum = ['necesidades', 'deseos', 'ahorro', 'deudas', 'otros'].reduce(function (s, k) {
      return s + Number(document.querySelector('#budget-form [name="' + k + '"]').value || 0);
    }, 0);
    $('percentage-total').textContent = 'Total: ' + sum + '% ' + (sum === 100 ? '✓' : '(debe sumar 100 %)');
    $('percentage-total').classList.toggle('invalid', sum !== 100);
  }

  function renderGoals() {
    const goals = data.goals || [];
    $('goal-total-label').textContent = goals.length + ' meta(s) · ' + money(data.metrics.goalsSaved) + ' ahorrados de ' + money(data.metrics.goalsTarget);
    const html = goals.length ? goals.map(function (g) {
      const pct = g.objetivo ? Math.min(100, g.ahorrado / g.objetivo * 100) : 0;
      return '<div class="goal-card"><div class="goal-head"><div><h4>' + esc(g.nombre) + '</h4><p class="muted small">Prioridad ' + esc(g.prioridad) + (g.fechaLimite ? ' · Fecha objetivo ' + dateFmt(g.fechaLimite) : '') + '</p></div><button class="delete-button" data-delete-goal="' + esc(g.id) + '" title="Archivar meta">×</button></div><div class="goal-values"><strong>' + money(g.ahorrado) + '</strong><span>de ' + money(g.objetivo) + '</span><b>' + Math.round(pct) + '%</b></div><div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div><p class="budget-sub">' + (g.objetivo - g.ahorrado <= 0 ? '¡Meta completada!' : 'Faltan ' + money(Math.max(0, g.objetivo - g.ahorrado))) + '</p></div>';
    }).join('') : '<div class="empty-state">Aún no tienes metas. Crea una meta y luego vincula aportes desde Movimientos.</div>';
    $('goals-list').innerHTML = html;
    $('dashboard-goals').innerHTML = goals.length ? goals.slice(0, 2).map(function (g) {
      return '<div class="mini-item"><strong>' + esc(g.nombre) + '</strong><span>' + money(g.ahorrado) + ' / ' + money(g.objetivo) + '</span></div>';
    }).join('') : '<div class="empty-state">Crea tu primera meta de ahorro.</div>';
  }

  function renderDebts() {
    const debts = (data.debts || []).filter(function (d) { return d.saldoActual > 0; });
    $('debt-total-label').textContent = 'Saldo pendiente: ' + money(data.metrics.debtTotal);
    $('debts-list').innerHTML = debts.length ? debts.map(function (d) {
      const pct = d.saldoInicial ? Math.min(100, (1 - d.saldoActual / d.saldoInicial) * 100) : 0;
      return '<div class="debt-card"><div class="goal-head"><div><h4>' + esc(d.nombre) + '</h4><p class="muted small">' + esc(d.acreedor || 'Acreedor no indicado') + ' · Tasa anual ' + d.tasaAnual + '%</p></div><button class="delete-button" data-delete-debt="' + esc(d.id) + '" title="Archivar deuda">×</button></div><div class="goal-values"><strong>' + money(d.saldoActual) + '</strong><span>saldo actual</span><b>' + (d.saldoInicial ? Math.round((1 - d.saldoActual / d.saldoInicial) * 100) : 0) + '% pagado</b></div><div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div><div class="budget-sub">Pago mínimo: ' + money(d.pagoMinimo) + (d.diaPago ? ' · Día ' + d.diaPago : '') + '. Para abonar, registra un gasto de tipo "Deudas" y selecciona esta deuda.</div></div>';
    }).join('') : '<div class="empty-state">No has registrado deudas. Si no tienes, puedes dejar esta sección vacía.</div>';
    $('dashboard-debts').innerHTML = debts.length ? debts.slice(0, 2).map(function (d) {
      return '<div class="mini-item"><strong>' + esc(d.nombre) + '</strong><span>' + money(d.saldoActual) + ' pendientes</span></div>';
    }).join('') : '<div class="empty-state">Sin deudas activas registradas.</div>';
  }

  function populateAssociations() {
    const d = $('debt-select'), g = $('goal-select'), oldD = d.value, oldG = g.value;
    d.innerHTML = '<option value="">No asociar</option>' + (data.debts || []).map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.nombre) + ' — ' + money(x.saldoActual) + '</option>'; }).join('');
    g.innerHTML = '<option value="">No asociar</option>' + (data.goals || []).map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.nombre) + ' — faltan ' + money(x.objetivo - x.ahorrado) + '</option>'; }).join('');
    d.value = oldD; g.value = oldG;
  }

  function renderHistory() {
    const list = data.monthlyHistory || [];
    if (!list.length) { $('history-list').innerHTML = '<div class="empty-state">El histórico aparecerá cuando registres movimientos.</div>'; return; }
    const max = Math.max.apply(Math, [1].concat(list.map(function (x) { return Math.max(x.ingresos, x.gastos); })));
    $('history-list').innerHTML = list.slice().reverse().map(function (x) {
      return '<div class="history-row"><div class="history-title"><strong>' + esc(x.mes) + '</strong><span class="' + (x.neto >= 0 ? 'positive' : 'negative') + '">Neto ' + money(x.neto) + '</span></div><div class="history-bars"><div class="history-bar income-bar" style="width:' + Math.max(x.ingresos ? 2 : 0, x.ingresos / max * 100) + '%"></div><div class="history-bar expense-bar" style="width:' + Math.max(x.gastos ? 2 : 0, x.gastos / max * 100) + '%"></div></div><div class="history-legend"><span>Ingresos ' + money(x.ingresos) + '</span><span>Gastos ' + money(x.gastos) + '</span></div></div>';
    }).join('');
  }

  function populateCategories(type) {
    $('category').innerHTML = cats[type].map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + '</option>'; }).join('');
    updateType();
  }

  function updateType() {
    const t = document.querySelector('input[name="tipo"]:checked').value, isExpense = t === 'GASTO';
    $('income-option').classList.toggle('selected', !isExpense);
    $('expense-option').classList.toggle('selected', isExpense);
    $('group-field').classList.toggle('hidden', !isExpense);
    $('debt-field').classList.toggle('hidden', !isExpense || $('budget-group').value !== 'DEUDAS');
    $('goal-field').classList.toggle('hidden', !isExpense || $('budget-group').value !== 'AHORRO');
  }
  $('budget-group').addEventListener('change', updateType);

  function showView(v) {
    activeView = v;
    document.querySelectorAll('.view').forEach(function (x) { x.classList.toggle('hidden', x.id !== 'view-' + v); });
    document.querySelectorAll('[data-view]').forEach(function (x) { x.classList.toggle('active', x.dataset.view === v); });
    const titles = { dashboard: 'Resumen financiero', movements: 'Movimientos', budget: 'Presupuesto', goals: 'Metas de ahorro', debts: 'Gestión de deudas', reports: 'Reportes y tendencias', settings: 'Configuración' };
    $('page-title').textContent = titles[v] || 'Finanzas';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function money(n) {
    try {
      return new Intl.NumberFormat('es-CO', { style: 'currency', currency: (data && data.currency) || 'COP', maximumFractionDigits: 0 }).format(Number(n) || 0);
    } catch (e) {
      return '$' + (Number(n) || 0).toLocaleString();
    }
  }
  function symbol(c) { return ({ COP: '$', USD: '$', EUR: '€', MXN: '$', PEN: 'S/', CLP: '$', ARS: '$' })[c] || '$'; }
  function dateFmt(s) { if (!s) return ''; const p = s.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function localDate(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function busy(id, on) { const b = $(id); b.disabled = on; b.textContent = on ? 'Guardando…' : 'Guardar movimiento'; }
  function showToast(t) { const x = $('toast'); x.textContent = t; x.classList.add('show'); setTimeout(function () { x.classList.remove('show'); }, 2800); }
  function showError(t) { $('error-banner').textContent = t; $('error-banner').classList.remove('hidden'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function exportCSV() {
    const rows = [['Fecha', 'Tipo', 'Importe', 'Categoría', 'Grupo', 'Descripción', 'Cuenta']].concat(data.transactions.map(function (t) {
      return [t.fecha, t.tipo, t.importe, t.categoria, t.grupoPresupuesto, t.descripcion, t.cuenta];
    }));
    const csv = rows.map(function (r) { return r.map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(';'); }).join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'finanzas-movimientos.csv'; a.click(); URL.revokeObjectURL(url);
  }
})();
