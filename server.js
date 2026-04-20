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
const VA_PASSWORD = process.env.VA_PASSWORD || 'changeme123';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin_secret';
const MAX_PRICE = parseFloat(process.env.MAX_PRICE) || 0.12;
const NB_SLOTS = parseInt(process.env.NB_SLOTS) || 10;

const API_BASE = 'https://hero-sms.com/stubs/handler_api.php';
const SERVICE = 'ig';
const COUNTRY = '187';

// ── HORAIRE AUTO 20h-22h ──────────────────────────────────────
function isWithinSchedule() {
  const frTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const h = frTime.getHours();
  return h >= 20 && h < 22;
}

// ── ÉTAT GLOBAL ───────────────────────────────────────────────
let adminOverride = null;
let botEnabled = isWithinSchedule();

// Slots : { 1: { socketId, number, activationId, startTime, interval } | null }
const slots = {};
for (let i = 1; i <= NB_SLOTS; i++) slots[i] = null;

setInterval(() => {
  if (adminOverride !== null) return;
  const next = isWithinSchedule();
  if (next !== botEnabled) {
    botEnabled = next;
    io.emit('bot_state', { enabled: botEnabled });
    broadcastAll();
    console.log('Bot auto ' + (botEnabled ? 'ON' : 'OFF'));
  }
}, 60000);

// ── API HEROSMS ───────────────────────────────────────────────
async function heroApi(action, params = {}) {
  const url = new URL(API_BASE);
  url.searchParams.set('api_key', HERO_API_KEY);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString());
  return await resp.text();
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

  // ── VA : PRENDRE UN SLOT ──
  socket.on('take_slot', (slotId) => {
    if (socket.role !== 'va') return;
    if (socket.slotId) { socket.emit('slot_error', 'Vous avez déjà le slot ' + socket.slotId); return; }
    if (!slots[slotId] === false && slots[slotId] !== null) { socket.emit('slot_error', 'Slot déjà pris'); return; }
    if (slots[slotId] !== null) { socket.emit('slot_error', 'Slot déjà pris'); return; }

    slots[slotId] = { socketId: socket.id, number: null, activationId: null, startTime: null, interval: null };
    socket.slotId = slotId;
    socket.emit('slot_taken', { slotId });
    broadcastAll();
  });

  // ── VA : ACHETER NUMÉRO ──
  socket.on('buy_number', async ({ maxPrice } = {}) => {
    if (socket.role !== 'va') return;
    if (!botEnabled) { socket.emit('error_msg', 'Bot désactivé — disponible de 20h à 22h.'); return; }
    if (!socket.slotId) { socket.emit('error_msg', 'Prenez d\'abord un slot.'); return; }
    const slot = slots[socket.slotId];
    if (!slot) { socket.emit('error_msg', 'Slot invalide.'); return; }
    if (slot.activationId) { socket.emit('error_msg', 'Un numéro est déjà actif sur ce slot.'); return; }

    const ALLOWED = [0.077, 0.1075, 0.1104];
    const chosenPrice = ALLOWED.includes(maxPrice) ? maxPrice : MAX_PRICE;

    socket.emit('status', { state: 'loading', info: 'Achat du numéro en cours...' });

    try {
      const res = await heroApi('getNumber', { service: SERVICE, country: COUNTRY, maxPrice: chosenPrice });

      if (res.startsWith('ACCESS_NUMBER:')) {
        const parts = res.split(':');
        slot.activationId = parts[1];
        slot.number = parts[2];
        slot.startTime = Date.now();
        socket.emit('number_received', { number: '+' + slot.number });
        socket.emit('status', { state: 'waiting', info: 'En attente du SMS Instagram...' });
        broadcastAll();
        startPolling(socket);
      } else if (res === 'NO_NUMBERS') {
        socket.emit('status', { state: 'error', info: 'Aucun numéro disponible, réessayez.' });
      } else if (res === 'NO_BALANCE') {
        socket.emit('status', { state: 'error', info: 'Solde insuffisant — contactez l\'admin.' });
      } else {
        socket.emit('status', { state: 'error', info: 'Erreur : ' + res });
      }
    } catch(e) {
      socket.emit('status', { state: 'error', info: 'Erreur réseau.' });
    }
  });

  // ── VA : ANNULER NUMÉRO ──
  socket.on('cancel_number', async () => {
    if (!socket.slotId) return;
    await cancelSlot(socket.slotId, false);
    socket.emit('status', { state: 'idle', info: 'Annulé — prêt pour un nouveau numéro.' });
    socket.emit('reset');
    broadcastAll();
  });

  // ── VA : QUITTER SON SLOT ──
  socket.on('leave_slot', async () => {
    if (!socket.slotId) return;
    await cancelSlot(socket.slotId, true);
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

  // ── ADMIN : KICK VA ──
  socket.on('kick_va', async (targetId) => {
    if (socket.role !== 'admin') return;
    const target = io.sockets.sockets.get(targetId);
    if (target) {
      if (target.slotId) await cancelSlot(target.slotId, true);
      target.emit('kicked');
      target.disconnect();
      broadcastAll();
    }
  });

  // ── DÉCONNEXION ──
  socket.on('disconnect', async () => {
    if (socket.slotId) {
      await cancelSlot(socket.slotId, true);
      socket.slotId = null;
    }
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
      await heroApi('setStatus', { id: slot.activationId, status: 8 });
      slot.activationId = null; slot.number = null;
      socket.emit('status', { state: 'error', info: 'Temps écoulé — numéro annulé automatiquement.' });
      socket.emit('reset');
      broadcastAll();
      return;
    }

    try {
      const res = await heroApi('getStatus', { id: slot.activationId });
      if (res.startsWith('STATUS_OK:')) {
        const code = res.split(':')[1];
        clearInterval(interval);
        socket.emit('code_received', { code });
        socket.emit('status', { state: 'ok', info: 'Code reçu !' });
        await heroApi('setStatus', { id: slot.activationId, status: 6 });
        slot.activationId = null; slot.number = null;
        broadcastAll();
      }
    } catch(e) {}
  }, 5000);

  if (slots[slotId]) slots[slotId].interval = interval;
}

// ── CANCEL SLOT ───────────────────────────────────────────────
async function cancelSlot(slotId, freeSlot) {
  const slot = slots[slotId];
  if (!slot) return;
  if (slot.interval) clearInterval(slot.interval);
  if (slot.activationId) {
    try { await heroApi('setStatus', { id: slot.activationId, status: 8 }); } catch(e) {}
  }
  if (freeSlot) slots[slotId] = null;
  else { slot.activationId = null; slot.number = null; slot.interval = null; }
}

// ── ÉTAT ──────────────────────────────────────────────────────
function buildSlotsState() {
  const result = {};
  for (let i = 1; i <= NB_SLOTS; i++) {
    const s = slots[i];
    result[i] = s ? { taken: true, hasNumber: !!s.activationId, number: s.number } : { taken: false };
  }
  return result;
}

function buildAdminState() {
  const vaList = [];
  for (let i = 1; i <= NB_SLOTS; i++) {
    const s = slots[i];
    if (s) {
      vaList.push({ slotId: i, socketId: s.socketId, hasNumber: !!s.activationId, number: s.number });
    }
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
    const r = await heroApi('getBalance');
    if (r.startsWith('ACCESS_BALANCE:')) res.json({ balance: r.split(':')[1] });
    else res.json({ balance: null, error: r });
  } catch(e) { res.json({ balance: null, error: 'Erreur réseau' }); }
});

server.listen(PORT, () => console.log(`HeroSMS VA — port ${PORT} — ${NB_SLOTS} slots`));
