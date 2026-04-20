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
const MAX_PRICE = parseFloat(process.env.MAX_PRICE) || 0.10;

const API_BASE = 'https://hero-sms.com/stubs/handler_api.php';
const SERVICE = 'ig';
const COUNTRY = '187'; // USA

// ── ÉTAT GLOBAL ──────────────────────────────────────────────
let botEnabled = true;
let connectedVAs = {}; // socketId -> { name, joinedAt }
let activeSessions = {}; // socketId -> { activationId, number, pollInterval }

// ── HELPER API HEROSMS ────────────────────────────────────────
async function heroApi(action, params = {}) {
  const url = new URL(API_BASE);
  url.searchParams.set('api_key', HERO_API_KEY);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString());
  return await resp.text();
}

// ── STATIC FILES ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/va', (req, res) => res.sendFile(path.join(__dirname, 'public', 'va.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── SOCKET.IO ─────────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── LOGIN ──
  socket.on('login', ({ password, role }) => {
    if (role === 'va' && password === VA_PASSWORD) {
      socket.role = 'va';
      connectedVAs[socket.id] = { id: socket.id, joinedAt: new Date().toISOString() };
      socket.emit('login_ok', { role: 'va', botEnabled });
      broadcastAdminState();
    } else if (role === 'admin' && password === ADMIN_PASSWORD) {
      socket.role = 'admin';
      socket.emit('login_ok', { role: 'admin', botEnabled });
      socket.emit('admin_state', buildAdminState());
    } else {
      socket.emit('login_error', 'Mot de passe incorrect');
    }
  });

  // ── VA : ACHETER NUMÉRO ──
  socket.on('buy_number', async ({ maxPrice } = {}) => {
    if (socket.role !== 'va') return;
    if (!botEnabled) { socket.emit('error_msg', 'Le bot est désactivé par l\'admin.'); return; }
    if (activeSessions[socket.id]) { socket.emit('error_msg', 'Un numéro est déjà actif.'); return; }

    // Vérifier que le prix choisi est valide (0.077, 0.1075, 0.1104)
    const ALLOWED_PRICES = [0.077, 0.1075, 0.1104];
    const chosenPrice = ALLOWED_PRICES.includes(maxPrice) ? maxPrice : MAX_PRICE;

    socket.emit('status', { state: 'loading', info: 'Achat du numéro en cours...' });

    try {
      const res = await heroApi('getNumber', { service: SERVICE, country: COUNTRY, maxPrice: chosenPrice });

      if (res.startsWith('ACCESS_NUMBER:')) {
        const parts = res.split(':');
        const activationId = parts[1];
        const number = parts[2];
        activeSessions[socket.id] = { activationId, number, startTime: Date.now() };

        socket.emit('number_received', { number: '+' + number, activationId });
        socket.emit('status', { state: 'waiting', info: 'En attente du SMS Instagram...' });
        broadcastAdminState();
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
    await cancelSession(socket);
    socket.emit('status', { state: 'idle', info: 'Annulé — prêt pour un nouveau numéro.' });
    socket.emit('reset');
    broadcastAdminState();
  });

  // ── ADMIN : TOGGLE BOT ──
  socket.on('toggle_bot', () => {
    if (socket.role !== 'admin') return;
    botEnabled = !botEnabled;
    io.emit('bot_state', { enabled: botEnabled });
    socket.emit('admin_state', buildAdminState());
  });

  // ── ADMIN : KICK VA ──
  socket.on('kick_va', (targetId) => {
    if (socket.role !== 'admin') return;
    const target = io.sockets.sockets.get(targetId);
    if (target) {
      target.emit('kicked', 'Vous avez été déconnecté par l\'admin.');
      target.disconnect();
    }
  });

  // ── DÉCONNEXION ──
  socket.on('disconnect', async () => {
    await cancelSession(socket);
    delete connectedVAs[socket.id];
    broadcastAdminState();
  });
});

// ── POLLING SMS ───────────────────────────────────────────────
function startPolling(socket) {
  const MAX_WAIT = 20 * 60 * 1000;
  const interval = setInterval(async () => {
    const session = activeSessions[socket.id];
    if (!session) { clearInterval(interval); return; }

    const elapsed = Date.now() - session.startTime;
    if (elapsed >= MAX_WAIT) {
      clearInterval(interval);
      await heroApi('setStatus', { id: session.activationId, status: 8 });
      delete activeSessions[socket.id];
      socket.emit('status', { state: 'error', info: 'Temps écoulé (20 min) — numéro annulé automatiquement.' });
      socket.emit('reset');
      broadcastAdminState();
      return;
    }

    try {
      const res = await heroApi('getStatus', { id: session.activationId });
      if (res.startsWith('STATUS_OK:')) {
        const code = res.split(':')[1];
        clearInterval(interval);
        socket.emit('code_received', { code });
        socket.emit('status', { state: 'ok', info: 'Code reçu !' });
        await heroApi('setStatus', { id: session.activationId, status: 6 });
        delete activeSessions[socket.id];
        broadcastAdminState();
      }
      // STATUS_WAIT_CODE = continuer d'attendre
    } catch(e) {}

  }, 5000);

  // Stocker l'interval pour pouvoir l'annuler
  if (activeSessions[socket.id]) activeSessions[socket.id].interval = interval;
}

// ── CANCEL SESSION ────────────────────────────────────────────
async function cancelSession(socket) {
  const session = activeSessions[socket.id];
  if (!session) return;
  if (session.interval) clearInterval(session.interval);
  try {
    await heroApi('setStatus', { id: session.activationId, status: 8 });
  } catch(e) {}
  delete activeSessions[socket.id];
}

// ── ADMIN STATE ───────────────────────────────────────────────
function buildAdminState() {
  const vas = Object.entries(connectedVAs).map(([id, va]) => ({
    id,
    joinedAt: va.joinedAt,
    hasNumber: !!activeSessions[id],
    number: activeSessions[id]?.number || null,
  }));
  return { botEnabled, vas, total: vas.length };
}

function broadcastAdminState() {
  const state = buildAdminState();
  for (const [, socket] of io.sockets.sockets) {
    if (socket.role === 'admin') socket.emit('admin_state', state);
  }
}

// ── BALANCE ENDPOINT ──────────────────────────────────────────
app.get('/api/balance', async (req, res) => {
  try {
    const r = await heroApi('getBalance');
    if (r.startsWith('ACCESS_BALANCE:')) res.json({ balance: r.split(':')[1] });
    else res.json({ balance: null, error: r });
  } catch(e) { res.json({ balance: null, error: 'Erreur réseau' }); }
});

server.listen(PORT, () => console.log(`HeroSMS VA — port ${PORT}`));
