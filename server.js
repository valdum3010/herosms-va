require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HERO_API_KEY = process.env.HERO_API_KEY;
const SMSPOOL_API_KEY = process.env.SMSPOOL_API_KEY;
const VA_PASSWORD = process.env.VA_PASSWORD || 'changeme123';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin_secret';
const NB_SLOTS = parseInt(process.env.NB_SLOTS) || 10;

const HERO_BASE = 'https://hero-sms.com/stubs/handler_api.php';
const POOL_BASE = 'https://api.smspool.net';
const HERO_SERVICE = 'ig';
const HERO_COUNTRY = '187'; // USA
const POOL_COUNTRY = 'US';
const POOL_SERVICE = 'Instagram';

// ── HORAIRE AUTO 20h-22h ──────────────────────────────────────
function isWithinSchedule() {
  const frTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const h = frTime.getHours();
  return h >= 20 && h < 22;
}

// ── ÉTAT GLOBAL ───────────────────────────────────────────────
let adminOverride = null;
let botEnabled = isWithinSchedule();
const slots = {};
for (let i = 1; i <= NB_SLOTS; i++) slots[i] = null;

setInterval(() => {
  if (adminOverride !== null) return;
  const next = isWithinSchedule();
  if (next !== botEnabled) {
    botEnabled = next;
    io.emit('bot_state', { enabled: botEnabled });
    broadcastAll();
  }
}, 60000);

// ── API HEROSMS ───────────────────────────────────────────────
async function heroApi(action, params = {}) {
  const url = new URL(HERO_BASE);
  url.searchParams.set('api_key', HERO_API_KEY);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString());
  return await resp.text();
}

// ── API SMSPOOL ───────────────────────────────────────────────
async function poolApi(endpoint, params = {}) {
  const url = new URL(POOL_BASE + endpoint);
  url.searchParams.set('api_key', SMSPOOL_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString());
  return await resp.json();
}

// ── ACHETER NUMÉRO ────────────────────────────────────────────
async function buyNumber(provider, maxPrice) {
  if (provider === 'hero') {
    const ALLOWED = [0.077, 0.1075, 0.1104];
    const price = ALLOWED.includes(maxPrice) ? maxPrice : 0.12;
    const res = await heroApi('getNumber', { service: HERO_SERVICE, country: HERO_COUNTRY, maxPrice: price });
    if (res.startsWith('ACCESS_NUMBER:')) {
      const parts = res.split(':');
      return { ok: true, activationId: parts[1], number: parts[2], provider: 'hero' };
    }
    if (res === 'NO_NUMBERS') return { ok: false, reason: 'Aucun numéro disponible sur HeroSMS.' };
    if (res === 'NO_BALANCE') return { ok: false, reason: 'Solde HeroSMS insuffisant.' };
    return { ok: false, reason: 'Erreur HeroSMS : ' + res };
  }

  if (provider === 'smspool') {
    const res = await poolApi('/purchase/sms', { country: POOL_COUNTRY, service: POOL_SERVICE });
    if (res.success === 1) {
      return { ok: true, activationId: res.order_id, number: res.number, provider: 'smspool' };
    }
    if (res.message) return { ok: false, reason: 'Erreur SMSPool : ' + res.message };
    return { ok: false, reason: 'Erreur SMSPool.' };
  }
}

// ── VÉRIFIER CODE ─────────────────────────────────────────────
async function checkCode(provider, activationId) {
  if (provider === 'hero') {
    const res = await heroApi('getStatus', { id: activationId });
    if (res.startsWith('STATUS_OK:')) return { ok: true, code: res.split(':')[1] };
    return { ok: false };
  }
  if (provider === 'smspool') {
    const res = await poolApi('/sms/check', { orderid: activationId });
    if (res.sms && res.sms !== '0') return { ok: true, code: res.sms };
    return { ok: false };
  }
}

// ── ANNULER NUMÉRO ────────────────────────────────────────────
async function cancelNumber(provider, activationId) {
  try {
    if (provider === 'hero') await heroApi('setStatus', { id: activationId, status: 8 });
    if (provider === 'smspool') await poolApi('/sms/cancel', { orderid: activationId });
  } catch(e) {}
}

// ── COMPLÉTER NUMÉRO ──────────────────────────────────────────
async function completeNumber(provider, activationId) {
  try {
    if (provider === 'hero') await heroApi('setStatus', { id: activationId, status: 6 });
  } catch(e) {}
}

// ── STATIC ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/va', (req, res) => res.sendFile(path.join(__dirname, 'public', 'va.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── SOCKET.IO ─────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('login', ({ password, role }) => {
    if (role === 'va' && password === VA_PASSWORD) {
      socket.role = 'va';
      socket.slotId = null;
      socket.emit('login_ok', { role: 'va', botEnabled });
      socket.emit('slots_state', buildSlotsState());
    } else if (role === 'admin' && password === ADMIN_PASSWORD) {
      socket.role = 'admin';
      socket.emit('login_ok', { role: 'admin', botEnabled });
      socket.emit('admin_state', buildAdminState());
    } else {
      socket.emit('login_error', 'Mot de passe incorrect');
    }
  });

  // ── VA : PRENDRE SLOT ──
  socket.on('take_slot', (slotId) => {
    if (socket.role !== 'va') return;
    if (socket.slotId) { socket.emit('slot_error', 'Vous avez déjà le slot ' + socket.slotId); return; }
    if (slots[slotId] !== null) { socket.emit('slot_error', 'Slot déjà pris.'); return; }
    slots[slotId] = { socketId: socket.id, provider: null, number: null, activationId: null, startTime: null, interval: null };
    socket.slotId = slotId;
    socket.emit('slot_taken', { slotId });
    broadcastAll();
  });

  // ── VA : ACHETER NUMÉRO ──
  socket.on('buy_number', async ({ provider, maxPrice } = {}) => {
    if (socket.role !== 'va') return;
    if (!botEnabled) { socket.emit('error_msg', 'Bot désactivé — disponible de 20h à 22h.'); return; }
    if (!socket.slotId) { socket.emit('error_msg', 'Prenez d\'abord un slot.'); return; }
    const slot = slots[socket.slotId];
    if (!slot || slot.activationId) { socket.emit('error_msg', 'Numéro déjà actif.'); return; }
    if (!provider) { socket.emit('error_msg', 'Choisissez un fournisseur.'); return; }

    socket.emit('status', { state: 'loading', info: 'Achat sur ' + (provider === 'hero' ? 'HeroSMS' : 'SMSPool') + '...' });

    try {
      const result = await buyNumber(provider, maxPrice);
      if (result.ok) {
        slot.provider = result.provider;
        slot.activationId = result.activationId;
        slot.number = result.number;
        slot.startTime = Date.now();
        socket.emit('number_received', { number: '+' + result.number, provider });
        socket.emit('status', { state: 'waiting', info: 'En attente du SMS Instagram...' });
        broadcastAll();
        startPolling(socket);
      } else {
        socket.emit('status', { state: 'error', info: result.reason });
      }
    } catch(e) {
      socket.emit('status', { state: 'error', info: 'Erreur réseau.' });
    }
  });

  // ── VA : ANNULER ──
  socket.on('cancel_number', async () => {
    if (!socket.slotId) return;
    const slot = slots[socket.slotId];
    if (slot) {
      if (slot.interval) clearInterval(slot.interval);
      if (slot.activationId) await cancelNumber(slot.provider, slot.activationId);
      slot.activationId = null; slot.number = null; slot.provider = null; slot.interval = null;
    }
    socket.emit('status', { state: 'idle', info: 'Annulé — prêt pour un nouveau numéro.' });
    socket.emit('reset');
    broadcastAll();
  });

  // ── VA : QUITTER SLOT ──
  socket.on('leave_slot', async () => {
    if (!socket.slotId) return;
    await freeSlot(socket.slotId);
    socket.slotId = null;
    socket.emit('slot_left');
    socket.emit('slots_state', buildSlotsState());
    broadcastAll();
  });

  // ── ADMIN : TOGGLE BOT ──
  socket.on('toggle_bot', () => {
    if (socket.role !== 'admin') return;
    adminOverride = adminOverride === null ? !botEnabled : !adminOverride;
    botEnabled = adminOverride;
    io.emit('bot_state', { enabled: botEnabled });
    broadcastAll();
  });

  socket.on('reset_schedule', () => {
    if (socket.role !== 'admin') return;
    adminOverride = null;
    botEnabled = isWithinSchedule();
    io.emit('bot_state', { enabled: botEnabled });
    broadcastAll();
  });

  socket.on('kick_va', async (targetId) => {
    if (socket.role !== 'admin') return;
    const target = io.sockets.sockets.get(targetId);
    if (target) {
      if (target.slotId) await freeSlot(target.slotId);
      target.emit('kicked');
      target.disconnect();
      broadcastAll();
    }
  });

  socket.on('disconnect', async () => {
    if (socket.slotId) { await freeSlot(socket.slotId); socket.slotId = null; }
    broadcastAll();
  });
});

// ── POLLING SMS ───────────────────────────────────────────────
function startPolling(socket) {
  const slotId = socket.slotId;
  const MAX_WAIT = 20 * 60 * 1000;
  const interval = setInterval(async () => {
    const slot = slots[slotId];
    if (!slot || !slot.activationId) { clearInterval(interval); return; }
    if (Date.now() - slot.startTime >= MAX_WAIT) {
      clearInterval(interval);
      await cancelNumber(slot.provider, slot.activationId);
      slot.activationId = null; slot.number = null; slot.provider = null;
      socket.emit('status', { state: 'error', info: 'Temps écoulé — numéro annulé automatiquement.' });
      socket.emit('reset');
      broadcastAll();
      return;
    }
    try {
      const result = await checkCode(slot.provider, slot.activationId);
      if (result.ok) {
        clearInterval(interval);
        socket.emit('code_received', { code: result.code });
        socket.emit('status', { state: 'ok', info: 'Code reçu !' });
        await completeNumber(slot.provider, slot.activationId);
        slot.activationId = null; slot.number = null; slot.provider = null;
        broadcastAll();
      }
    } catch(e) {}
  }, 5000);
  if (slots[slotId]) slots[slotId].interval = interval;
}

// ── FREE SLOT ─────────────────────────────────────────────────
async function freeSlot(slotId) {
  const slot = slots[slotId];
  if (!slot) return;
  if (slot.interval) clearInterval(slot.interval);
  if (slot.activationId) await cancelNumber(slot.provider, slot.activationId);
  slots[slotId] = null;
}

// ── STATE ─────────────────────────────────────────────────────
function buildSlotsState() {
  const result = {};
  for (let i = 1; i <= NB_SLOTS; i++) {
    const s = slots[i];
    result[i] = s ? { taken: true, hasNumber: !!s.activationId, number: s.number, provider: s.provider } : { taken: false };
  }
  return result;
}

function buildAdminState() {
  const vaList = [];
  for (let i = 1; i <= NB_SLOTS; i++) {
    const s = slots[i];
    if (s) vaList.push({ slotId: i, socketId: s.socketId, hasNumber: !!s.activationId, number: s.number, provider: s.provider });
  }
  return { botEnabled, adminOverride, slots: buildSlotsState(), vaList, total: vaList.length };
}

function broadcastAll() {
  const slotsState = buildSlotsState();
  const adminState = buildAdminState();
  for (const [, socket] of io.sockets.sockets) {
    if (socket.role === 'va') socket.emit('slots_state', slotsState);
    if (socket.role === 'admin') socket.emit('admin_state', adminState);
  }
}

app.get('/api/balance', async (req, res) => {
  try {
    const hero = await heroApi('getBalance');
    const heroBalance = hero.startsWith('ACCESS_BALANCE:') ? hero.split(':')[1] : null;
    const pool = await poolApi('/request/balance', {});
    res.json({ hero: heroBalance, smspool: pool.balance || null });
  } catch(e) { res.json({ hero: null, smspool: null }); }
});

server.listen(PORT, () => console.log(`HeroSMS VA — port ${PORT} — ${NB_SLOTS} slots`));
