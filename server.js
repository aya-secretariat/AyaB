// server.js — AYA Backend pour Render (v3.1)
// CORRECTIONS : Endpoints admin complets, identification agent par nom (ID stable),
//               emission temps reel vers le panel patron.
'use strict';

const express  = require('express');
const { Pool } = require('pg');
const path     = require('path');
const crypto   = require('crypto');
const fs       = require('fs');
const http     = require('http');
const XLSX     = require('xlsx');

const app  = express();
const server = http.createServer(app);

// ─────────────────────────────────────────────
// CORS — Autorise le frontend GitHub Pages + Netlify
// ─────────────────────────────────────────────
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    next();
});

// ─────────────────────────────────────────────
// Socket.io
// ─────────────────────────────────────────────
const io = require('socket.io')(server, {
    cors: { 
        origin: '*', 
        methods: ['GET', 'POST'] 
    }
});

// ─────────────────────────────────────────────
// Multer — Upload de fichiers
// ─────────────────────────────────────────────
const multer  = require('multer');
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => {
        const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, Date.now() + '-' + safe);
    }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ─────────────────────────────────────────────
// PostgreSQL — Connexion Render (DATABASE_URL)
// ─────────────────────────────────────────────
let pool;

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
} else {
    pool = new Pool({
        user:     process.env.DB_USER     || 'postgres',
        host:     process.env.DB_HOST     || 'localhost',
        database: process.env.DB_DATABASE || 'aya_db',
        password: process.env.DB_PASSWORD || '',
        port:     parseInt(process.env.DB_PORT || '5432'),
    });
}

pool.connect((err, client, release) => {
    if (err) {
        console.error('PostgreSQL :', err.message);
        console.log('Mode sans base de donnees');
        return;
    }
    console.log('Connecte a PostgreSQL');
    release();
});

// ─────────────────────────────────────────────
// Mot de passe patron (doit correspondre a admin-panel.js)
// ─────────────────────────────────────────────
const BOSS_PASSWORD = 'wetseyasmine';

// ─────────────────────────────────────────────
// Creation des tables (v3.1 incluant nouvelles tables)
// ─────────────────────────────────────────────
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS digital_ids (
                id          SERIAL PRIMARY KEY,
                device_id   VARCHAR(64) UNIQUE NOT NULL,
                fingerprint TEXT,
                lang        VARCHAR(10) DEFAULT 'fr',
                user_name   TEXT,
                photo_url   TEXT,
                display_id  VARCHAR(20),
                created_at  TIMESTAMP DEFAULT NOW(),
                last_seen   TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS chat_messages (
                id               SERIAL PRIMARY KEY,
                device_id        VARCHAR(64) NOT NULL,
                message_text     TEXT NOT NULL,
                sender_type      VARCHAR(20) DEFAULT 'client',
                message_type     VARCHAR(20) DEFAULT 'text',
                media_url        TEXT,
                sent_at          TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS fichiers (
                id          SERIAL PRIMARY KEY,
                device_id   VARCHAR(64) NOT NULL,
                nom         TEXT NOT NULL,
                type_mime   TEXT,
                taille      INTEGER,
                url         TEXT NOT NULL,
                uploaded_by VARCHAR(20) DEFAULT 'client',
                uploade_le  TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS qr_sessions (
                id                  SERIAL PRIMARY KEY,
                token               VARCHAR(64) UNIQUE NOT NULL,
                device_id_desktop   VARCHAR(64),
                device_id_mobile    VARCHAR(64),
                status              VARCHAR(20) DEFAULT 'pending',
                created_at          TIMESTAMP DEFAULT NOW(),
                expires_at          TIMESTAMP DEFAULT NOW() + INTERVAL '5 minutes'
            );

            CREATE TABLE IF NOT EXISTS device_pairs (
                id                SERIAL PRIMARY KEY,
                device_id_primary VARCHAR(64) NOT NULL,
                device_id_linked  VARCHAR(64) NOT NULL,
                created_at        TIMESTAMP DEFAULT NOW(),
                UNIQUE(device_id_primary, device_id_linked)
            );

            CREATE TABLE IF NOT EXISTS service_requests (
                id              SERIAL PRIMARY KEY,
                device_id       VARCHAR(64) NOT NULL,
                service_name    TEXT NOT NULL,
                agent_id        INTEGER,
                status          VARCHAR(20) DEFAULT 'waiting',
                requested_at    TIMESTAMP DEFAULT NOW(),
                taken_at        TIMESTAMP,
                closed_at       TIMESTAMP,
                price_agreed    NUMERIC(10,2)
            );

            CREATE TABLE IF NOT EXISTS agents (
                id          SERIAL PRIMARY KEY,
                nom         TEXT NOT NULL,
                email       TEXT UNIQUE,
                password_hash TEXT,
                created_at  TIMESTAMP DEFAULT NOW(),
                is_active   BOOLEAN DEFAULT TRUE
            );

            CREATE TABLE IF NOT EXISTS agent_sessions (
                id              SERIAL PRIMARY KEY,
                agent_id        INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                login_time      TIMESTAMP DEFAULT NOW(),
                logout_time     TIMESTAMP,
                total_duration  INTEGER DEFAULT 0,
                ip_address      TEXT
            );

            CREATE TABLE IF NOT EXISTS agent_interactions (
                id                  SERIAL PRIMARY KEY,
                agent_id            INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                agent_session_id    INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
                client_device_id    VARCHAR(64) NOT NULL,
                client_name         TEXT,
                service_name        TEXT NOT NULL,
                start_time          TIMESTAMP DEFAULT NOW(),
                end_time            TIMESTAMP,
                first_response_time INTEGER DEFAULT 0,
                interaction_duration INTEGER DEFAULT 0,
                price_agreed        NUMERIC(10,2),
                status              VARCHAR(20) DEFAULT 'active',
                created_at          TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS agent_daily_stats (
                id              SERIAL PRIMARY KEY,
                agent_id        INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                date            DATE NOT NULL DEFAULT CURRENT_DATE,
                total_time_seconds INTEGER DEFAULT 0,
                total_earnings  NUMERIC(10,2) DEFAULT 0,
                clients_served  INTEGER DEFAULT 0,
                UNIQUE(agent_id, date)
            );

            CREATE TABLE IF NOT EXISTS price_confirmations (
                id              SERIAL PRIMARY KEY,
                interaction_id  INTEGER NOT NULL REFERENCES agent_interactions(id) ON DELETE CASCADE,
                agent_id        INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                client_device_id VARCHAR(64) NOT NULL,
                price           NUMERIC(10,2) NOT NULL,
                status          VARCHAR(20) DEFAULT 'pending',
                sent_at         TIMESTAMP DEFAULT NOW(),
                confirmed_at    TIMESTAMP
            );

            -- ============================================
            -- NOUVELLES TABLES v3.0 / v3.1
            -- ============================================

            CREATE TABLE IF NOT EXISTS agent_pauses (
                id              SERIAL PRIMARY KEY,
                agent_id        INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                session_id      INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL,
                start_time      TIMESTAMP DEFAULT NOW(),
                end_time        TIMESTAMP,
                duration_seconds INTEGER DEFAULT 0,
                status          VARCHAR(20) DEFAULT 'active',
                created_at      TIMESTAMP DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_agent_pauses_agent ON agent_pauses(agent_id);
            CREATE INDEX IF NOT EXISTS idx_agent_pauses_status ON agent_pauses(status);

            CREATE TABLE IF NOT EXISTS agent_evaluations (
                id              SERIAL PRIMARY KEY,
                agent_id        INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                interaction_id  INTEGER REFERENCES agent_interactions(id) ON DELETE SET NULL,
                client_device_id VARCHAR(64),
                rating          INTEGER CHECK (rating >= 1 AND rating <= 5),
                comment         TEXT,
                evaluated_by    VARCHAR(20) DEFAULT 'system',
                created_at      TIMESTAMP DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_agent_evaluations_agent ON agent_evaluations(agent_id);
            CREATE INDEX IF NOT EXISTS idx_agent_evaluations_date ON agent_evaluations(created_at);

            CREATE TABLE IF NOT EXISTS agent_monthly_stats (
                id                      SERIAL PRIMARY KEY,
                agent_id                INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                month                   INTEGER NOT NULL CHECK (month >= 1 AND month <= 12),
                year                    INTEGER NOT NULL,
                total_earnings          NUMERIC(12,2) DEFAULT 0,
                total_clients_served    INTEGER DEFAULT 0,
                total_interactions      INTEGER DEFAULT 0,
                total_pause_seconds     INTEGER DEFAULT 0,
                total_work_seconds      INTEGER DEFAULT 0,
                avg_response_time_sec   INTEGER DEFAULT 0,
                avg_interaction_duration_sec INTEGER DEFAULT 0,
                avg_rating              NUMERIC(3,2) DEFAULT 0,
                total_messages_sent     INTEGER DEFAULT 0,
                total_messages_received INTEGER DEFAULT 0,
                total_files_uploaded    INTEGER DEFAULT 0,
                total_prices_sent       INTEGER DEFAULT 0,
                total_prices_confirmed  INTEGER DEFAULT 0,
                conversion_rate         NUMERIC(5,2) DEFAULT 0,
                UNIQUE(agent_id, month, year)
            );

            CREATE INDEX IF NOT EXISTS idx_agent_monthly_stats_agent ON agent_monthly_stats(agent_id);
            CREATE INDEX IF NOT EXISTS idx_agent_monthly_stats_period ON agent_monthly_stats(year, month);

            CREATE TABLE IF NOT EXISTS wait_alerts (
                id              SERIAL PRIMARY KEY,
                device_id       VARCHAR(64) NOT NULL,
                service_name    TEXT,
                wait_seconds    INTEGER DEFAULT 0,
                alert_sent_at   TIMESTAMP DEFAULT NOW(),
                resolved_at     TIMESTAMP,
                agent_id        INTEGER REFERENCES agents(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_wait_alerts_device ON wait_alerts(device_id);
            CREATE INDEX IF NOT EXISTS idx_wait_alerts_sent ON wait_alerts(alert_sent_at);

            INSERT INTO agents (nom, email, password_hash) 
            VALUES ('Agent Demo', 'agent@aya.com', '$2b$10$demo_hash_pour_test_aya2024')
            ON CONFLICT (email) DO NOTHING;
        `);
        console.log('Tables v3.1 pretes');
    } catch(err) {
        console.error('initDB:', err.message);
        console.log('Mode sans BDD');
    }
}
initDB();

// ─────────────────────────────────────────────
// Etat en memoire
// ─────────────────────────────────────────────
const connectedUsers = new Map();
const connectedAgents = new Map();
const fileAttente    = new Map();
const agentPauses    = new Map();

// ─────────────────────────────────────────────
// Helper : emission mise a jour admin
// ─────────────────────────────────────────────
async function emitAdminAgentsUpdate() {
    try {
        const today = new Date().toISOString().split('T')[0];
        const agentsList = [];
        for (const [socketId, agent] of connectedAgents.entries()) {
            let todayClients = 0, todayEarnings = 0;
            try {
                const statsRow = await pool.query(
                    `SELECT * FROM agent_daily_stats WHERE agent_id=$1 AND date=$2`,
                    [agent.agentId, today]
                );
                if (statsRow.rows.length) {
                    todayClients = statsRow.rows[0].clients_served || 0;
                    todayEarnings = statsRow.rows[0].total_earnings || 0;
                }
            } catch(e) {}
            agentsList.push({
                agentId: agent.agentId,
                agentName: agent.agentName,
                status: agent.currentClientDeviceId ? 'busy' : 'online',
                currentClientDeviceId: agent.currentClientDeviceId || null,
                currentClientName: agent.currentClientName || null,
                currentServiceName: agent.currentServiceName || null,
                connectedAt: agent.connectedAt || new Date(),
                todayClients,
                todayEarnings
            });
        }
        io.to('admin').emit('admin_agents_update', {
            agents: agentsList,
            queue: Array.from(fileAttente.values())
        });
    } catch(err) {
        console.error('emitAdminAgentsUpdate:', err.message);
    }
}

// ─────────────────────────────────────────────
// Verification periodique alertes attente > 5min
// ─────────────────────────────────────────────
setInterval(async () => {
    const now = Date.now();
    for (const [deviceId, clientInfo] of fileAttente.entries()) {
        const waitMs = now - new Date(clientInfo.connectedAt).getTime();
        if (waitMs > 5 * 60 * 1000) {
            const waitSeconds = Math.floor(waitMs / 1000);
            io.to('agents').emit('alerte_attente_prolongee', {
                deviceId,
                userName: clientInfo.userName,
                displayId: clientInfo.displayId,
                serviceName: clientInfo.serviceName,
                waitSeconds,
                waitTimeFormatted: formatWaitTime(waitSeconds)
            });
            try {
                const existing = await pool.query(
                    `SELECT id FROM wait_alerts WHERE device_id = $1 AND resolved_at IS NULL LIMIT 1`,
                    [deviceId]
                );
                if (existing.rows.length === 0) {
                    await pool.query(`
                        INSERT INTO wait_alerts (device_id, service_name, wait_seconds)
                        VALUES ($1, $2, $3)
                    `, [deviceId, clientInfo.serviceName, waitSeconds]);
                }
            } catch(e) {}
        }
    }
}, 30000);

function formatWaitTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m + ' min ' + s + ' s';
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return h + 'h ' + m + 'min ' + s + 's';
    if (m > 0) return m + 'min ' + s + 's';
    return s + 's';
}

// ─────────────────────────────────────────────
// Socket.io
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('Connexion :', socket.id);

    // ═══════════════════════════════════════
    // CLIENT
    // ═══════════════════════════════════════
    socket.on('register', async ({ deviceId, fingerprint, lang, displayId }) => {
        try {
            // CORRECTION : Generer un displayId sequentiel si absent
            let finalDisplayId = displayId;
            if (!finalDisplayId || !finalDisplayId.startsWith('AYA-')) {
                const existing = await pool.query('SELECT display_id FROM digital_ids WHERE device_id=$1', [deviceId]);
                if (existing.rows[0]?.display_id && existing.rows[0].display_id.startsWith('AYA-')) {
                    finalDisplayId = existing.rows[0].display_id;
                } else {
                    const maxResult = await pool.query(
                        "SELECT COALESCE(MAX(CAST(NULLIF(SUBSTRING(display_id FROM 5), '') AS INTEGER)), 0) as max_num FROM digital_ids WHERE display_id LIKE 'AYA-%'"
                    );
                    const nextNum = parseInt(maxResult.rows[0].max_num) + 1;
                    finalDisplayId = 'AYA-' + String(nextNum).padStart(5, '0');
                }
            }

            await pool.query(`
                INSERT INTO digital_ids (device_id, fingerprint, lang, last_seen, display_id)
                VALUES ($1, $2, $3, NOW(), $4)
                ON CONFLICT (device_id)
                DO UPDATE SET fingerprint=$2, lang=$3, last_seen=NOW(), display_id=COALESCE($4, digital_ids.display_id)
            `, [deviceId, fingerprint, lang, finalDisplayId]);

            const userRow = await pool.query('SELECT user_name, display_id FROM digital_ids WHERE device_id=$1', [deviceId]);
            const userName = userRow.rows[0]?.user_name || '';
            const savedDisplayId = userRow.rows[0]?.display_id || finalDisplayId;

            connectedUsers.set(socket.id, { deviceId, lang, userName, displayId: savedDisplayId });
            socket.join('user:' + deviceId);

            const hist = await pool.query(
                `SELECT * FROM chat_messages WHERE device_id=$1 ORDER BY sent_at ASC LIMIT 100`,
                [deviceId]
            );

            socket.emit('registered', {
                deviceId,
                displayId: savedDisplayId,
                history: hist.rows.map(row => ({
                    id:   row.id,
                    text: row.message_text,
                    type: row.sender_type === 'client' ? 'sent' : 'received',
                    time: new Date(row.sent_at).toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'})
                }))
            });
        } catch(err) {
            console.error('register:', err.message);
            const fallbackId = displayId && displayId.startsWith('AYA-') ? displayId : 'AYA-00000';
            connectedUsers.set(socket.id, { deviceId, lang, userName: '', displayId: fallbackId });
            socket.join('user:' + deviceId);
            socket.emit('registered', { deviceId, displayId: fallbackId, history: [] });
        }
    });

    socket.on('client_message', async ({ text }) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const { deviceId } = user;
        const displayId = user.displayId || deviceId.substring(0, 8).toUpperCase();
        const now = new Date();

        try {
            const res = await pool.query(`
                INSERT INTO chat_messages (device_id, message_text, sender_type, sent_at)
                VALUES ($1, $2, 'client', $3) RETURNING id
            `, [deviceId, text, now]);

            const timeStr = now.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
            socket.emit('message_sent', { id: res.rows[0].id, text, time: timeStr });

            const userRow = await pool.query('SELECT user_name FROM digital_ids WHERE device_id=$1', [deviceId]);
            const userName = userRow.rows[0]?.user_name || 'Client';

            io.to('agents').emit('client_message_to_agent', {
                id: res.rows[0].id,
                deviceId,
                text,
                time: timeStr,
                userName,
                displayId
            });
        } catch(err) {
            console.error('client_message:', err.message);
            const timeStr = now.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
            io.to('agents').emit('client_message_to_agent', {
                deviceId,
                text,
                time: timeStr,
                userName: 'Client',
                displayId
            });
        }
    });

    socket.on('service_choisi', async ({ nomService }, callback) => {
        const user = connectedUsers.get(socket.id);
        if (!user) {
            if (typeof callback === 'function') callback({ ok: false, error: 'User not registered' });
            return;
        }
        const { deviceId } = user;
        const displayId = user.displayId || deviceId.substring(0, 8).toUpperCase();

        try {
            const userRow = await pool.query('SELECT user_name FROM digital_ids WHERE device_id=$1', [deviceId]);
            const userName = userRow.rows[0]?.user_name || 'Client';

            fileAttente.set(deviceId, {
                deviceId,
                userName,
                displayId,
                serviceName: nomService,
                lang: user.lang || 'fr',
                connectedAt: new Date()
            });

            io.to('agents').emit('nouveau_client_attente', {
                deviceId,
                userName,
                displayId,
                serviceName: nomService,
                lang: user.lang || 'fr',
                connectedAt: new Date().toISOString()
            });

            await pool.query(`
                INSERT INTO service_requests (device_id, service_name, status)
                VALUES ($1, $2, 'waiting')
            `, [deviceId, nomService]);

            const msgBase = 'Bonjour ' + userName + ', un agent va bientot prendre en charge votre demande de "' + nomService + '".';
            const now = new Date();

            await pool.query(`
                INSERT INTO chat_messages (device_id, message_text, sender_type)
                VALUES ($1, $2, 'agent')
            `, [deviceId, msgBase]);

            socket.emit('agent_reply', {
                text: msgBase,
                time: now.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'})
            });

            if (typeof callback === 'function') callback({ ok: true });
        } catch(err) {
            console.error('service_choisi:', err.message);
            fileAttente.set(deviceId, {
                deviceId,
                userName: user.userName || 'Client',
                displayId,
                serviceName: nomService,
                lang: user.lang || 'fr',
                connectedAt: new Date()
            });
            io.to('agents').emit('nouveau_client_attente', {
                deviceId,
                userName: user.userName || 'Client',
                displayId,
                serviceName: nomService,
                lang: user.lang || 'fr',
                connectedAt: new Date().toISOString()
            });
            if (typeof callback === 'function') callback({ ok: true });
        }
        emitAdminAgentsUpdate();
    });

    socket.on('confirm_price', async ({ confirmationId, deviceId }) => {
        try {
            await pool.query(`UPDATE price_confirmations SET status='confirmed', confirmed_at=NOW() WHERE id=$1`, [confirmationId]);
            const pcRow = await pool.query('SELECT * FROM price_confirmations WHERE id=$1', [confirmationId]);
            if (pcRow.rows.length) {
                const pc = pcRow.rows[0];
                await pool.query(`UPDATE agent_interactions SET price_agreed=$1 WHERE id=$2`, [pc.price, pc.interaction_id]);
                io.to('agents').emit('price_confirmed_by_client', { confirmationId, price: pc.price });
            }
        } catch(err) {
            console.error('confirm_price:', err.message);
        }
    });

    // ═══════════════════════════════════════
    // AGENT (identifie par nom = ID stable)
    // ═══════════════════════════════════════
    socket.on('agent_connect', async ({ agentName, lang }) => {
        try {
            let agentRow = await pool.query('SELECT * FROM agents WHERE nom=$1', [agentName]);
            let agentId;
            if (!agentRow.rows.length) {
                const newAgent = await pool.query(`INSERT INTO agents (nom) VALUES ($1) RETURNING id`, [agentName]);
                agentId = newAgent.rows[0].id;
            } else {
                agentId = agentRow.rows[0].id;
            }

            const sessionRes = await pool.query(`INSERT INTO agent_sessions (agent_id, login_time) VALUES ($1, NOW()) RETURNING id`, [agentId]);
            const sessionId = sessionRes.rows[0].id;

            socket.join('agents');
            connectedAgents.set(socket.id, {
                agentId,
                agentName,
                sessionId,
                currentClientDeviceId: null,
                currentClientName: null,
                currentServiceName: null,
                connectedAt: new Date()
            });

            socket.emit('agent_registered', { agentId, sessionId, agentName });
            socket.emit('liste_attente', Array.from(fileAttente.values()));

            const today = new Date().toISOString().split('T')[0];
            const statsRow = await pool.query(`SELECT * FROM agent_daily_stats WHERE agent_id=$1 AND date=$2`, [agentId, today]);
            if (statsRow.rows.length) {
                socket.emit('agent_stats_update', {
                    clientsServed: statsRow.rows[0].clients_served,
                    totalEarnings: statsRow.rows[0].total_earnings
                });
            }
            console.log('Agent connecte :', agentName, '(ID:', agentId, ')');
            emitAdminAgentsUpdate();
        } catch(err) {
            console.error('agent_connect:', err.message);
            const mockAgentId = Math.floor(Math.random() * 10000);
            const mockSessionId = Math.floor(Math.random() * 10000);
            socket.join('agents');
            connectedAgents.set(socket.id, {
                agentId: mockAgentId,
                agentName,
                sessionId: mockSessionId,
                currentClientDeviceId: null,
                currentClientName: null,
                currentServiceName: null,
                connectedAt: new Date()
            });
            socket.emit('agent_registered', { agentId: mockAgentId, sessionId: mockSessionId, agentName });
            socket.emit('liste_attente', Array.from(fileAttente.values()));
            emitAdminAgentsUpdate();
        }
    });

    socket.on('agent_update_name', async ({ newName }) => {
        const agent = connectedAgents.get(socket.id);
        if (!agent || !newName || newName.trim().length < 2) return;
        try {
            await pool.query('UPDATE agents SET nom=$1 WHERE id=$2', [newName.trim(), agent.agentId]);
            agent.agentName = newName.trim();
            connectedAgents.set(socket.id, agent);
            socket.emit('agent_name_updated', { agentName: newName.trim() });
            emitAdminAgentsUpdate();
        } catch(err) {
            console.error('agent_update_name:', err.message);
            agent.agentName = newName.trim();
            connectedAgents.set(socket.id, agent);
            socket.emit('agent_name_updated', { agentName: newName.trim() });
            emitAdminAgentsUpdate();
        }
    });

    socket.on('agent_request_queue', () => {
        socket.emit('liste_attente', Array.from(fileAttente.values()));
    });

    socket.on('agent_prend_client', async ({ deviceId }) => {
        const agent = connectedAgents.get(socket.id);
        if (!agent) return;
        const clientInfo = fileAttente.get(deviceId);
        if (!clientInfo) return;

        fileAttente.delete(deviceId);
        io.to('agents').emit('client_pris', { deviceId, agentId: agent.agentId, agentName: agent.agentName });

        try {
            const interactionRes = await pool.query(`
                INSERT INTO agent_interactions (agent_id, agent_session_id, client_device_id, client_name, service_name, status)
                VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id
            `, [agent.agentId, agent.sessionId, deviceId, clientInfo.userName, clientInfo.serviceName]);

            agent.currentClientDeviceId = deviceId;
            agent.currentClientName = clientInfo.userName;
            agent.currentServiceName = clientInfo.serviceName;
            agent.currentInteractionId = interactionRes.rows[0].id;
            connectedAgents.set(socket.id, agent);

            await pool.query(`UPDATE service_requests SET agent_id=$1, status='active', taken_at=NOW() WHERE device_id=$2 AND status='waiting'`, [agent.agentId, deviceId]);
            socket.join('chat:' + deviceId);
        } catch(err) {
            console.error('agent_prend_client:', err.message);
            agent.currentClientDeviceId = deviceId;
            agent.currentClientName = clientInfo.userName;
            agent.currentServiceName = clientInfo.serviceName;
            agent.currentInteractionId = Math.floor(Math.random() * 10000);
            connectedAgents.set(socket.id, agent);
            socket.join('chat:' + deviceId);
        }
    });

    socket.on('agent_message', async ({ deviceId, text }) => {
        const agent = connectedAgents.get(socket.id);
        if (!agent) return;
        const now = new Date();
        try {
            await pool.query(`INSERT INTO chat_messages (device_id, message_text, sender_type) VALUES ($1, $2, 'agent')`, [deviceId, text]);
            const timeStr = now.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
            io.to('user:' + deviceId).emit('agent_reply', { text, time: timeStr });
            socket.emit('agent_message_sent', { deviceId, text, time: timeStr });
        } catch(err) {
            console.error('agent_message:', err.message);
            const timeStr = now.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
            io.to('user:' + deviceId).emit('agent_reply', { text, time: timeStr });
        }
    });

    socket.on('agent_upload_media', async ({ deviceId, url, fileName, mediaType, text }) => {
        const agent = connectedAgents.get(socket.id);
        if (!agent) return;
        const now = new Date();
        const timeStr = now.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
        try {
            await pool.query(`INSERT INTO chat_messages (device_id, message_text, sender_type, message_type, media_url) VALUES ($1, $2, 'agent', $3, $4)`, [deviceId, text || fileName, mediaType || 'file', url]);
        } catch(e) {}
        io.to('user:' + deviceId).emit('agent_reply', { text: text || fileName, mediaUrl: url, mediaType, fileName, time: timeStr });
        socket.emit('agent_message_sent', { deviceId, text: text || fileName, time: timeStr });
    });

    socket.on('client_upload_media', async ({ url, fileName, mediaType, text }) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const { deviceId } = user;
        const displayId = user.displayId || deviceId.substring(0, 8).toUpperCase();
        const now = new Date();
        const timeStr = now.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
        try {
            await pool.query(`INSERT INTO chat_messages (device_id, message_text, sender_type, message_type, media_url) VALUES ($1, $2, 'client', $3, $4)`, [deviceId, text || fileName, mediaType || 'file', url]);
        } catch(e) {}
        io.to('chat:' + deviceId).emit('client_message_to_agent', {
            deviceId, text: text || fileName, mediaUrl: url, mediaType, fileName, time: timeStr,
            userName: user.userName || 'Client', displayId
        });
    });

    socket.on('agent_send_price', async ({ deviceId, price }) => {
        const agent = connectedAgents.get(socket.id);
        if (!agent) return;
        try {
            const interactionId = agent.currentInteractionId;
            if (!interactionId) return;
            const pcRes = await pool.query(`INSERT INTO price_confirmations (interaction_id, agent_id, client_device_id, price) VALUES ($1, $2, $3, $4) RETURNING id`, [interactionId, agent.agentId, deviceId, price]);
            io.to('user:' + deviceId).emit('price_link', { price, confirmationId: pcRes.rows[0].id });
        } catch(err) {
            console.error('agent_send_price:', err.message);
            io.to('user:' + deviceId).emit('price_link', { price, confirmationId: Math.floor(Math.random() * 100000) });
        }
    });

    socket.on('agent_close_chat', async ({ deviceId, firstResponseTime, interactionDuration }) => {
        const agent = connectedAgents.get(socket.id);
        if (!agent) return;
        try {
            const interactionId = agent.currentInteractionId;
            if (interactionId) {
                await pool.query(`UPDATE agent_interactions SET end_time=NOW(), first_response_time=$1, interaction_duration=$2, status='closed' WHERE id=$3`, [firstResponseTime || 0, interactionDuration || 0, interactionId]);
                const today = new Date().toISOString().split('T')[0];
                const interactionRow = await pool.query('SELECT price_agreed FROM agent_interactions WHERE id=$1', [interactionId]);
                const priceAgreed = interactionRow.rows[0]?.price_agreed || 0;
                await pool.query(`
                    INSERT INTO agent_daily_stats (agent_id, date, total_time_seconds, total_earnings, clients_served)
                    VALUES ($1, $2, $3, $4, 1)
                    ON CONFLICT (agent_id, date)
                    DO UPDATE SET
                        total_time_seconds = agent_daily_stats.total_time_seconds + $3,
                        total_earnings = agent_daily_stats.total_earnings + $4,
                        clients_served = agent_daily_stats.clients_served + 1
                `, [agent.agentId, today, interactionDuration || 0, priceAgreed]);
                await pool.query(`UPDATE service_requests SET status='closed', closed_at=NOW() WHERE device_id=$1 AND status='active'`, [deviceId]);
            }
            agent.currentClientDeviceId = null;
            agent.currentClientName = null;
            agent.currentServiceName = null;
            agent.currentInteractionId = null;
            connectedAgents.set(socket.id, agent);
            const today = new Date().toISOString().split('T')[0];
            const statsRow = await pool.query(`SELECT * FROM agent_daily_stats WHERE agent_id=$1 AND date=$2`, [agent.agentId, today]);
            if (statsRow.rows.length) {
                io.to(socket.id).emit('agent_stats_update', {
                    clientsServed: statsRow.rows[0].clients_served,
                    totalEarnings: statsRow.rows[0].total_earnings
                });
            }
        } catch(err) {
            console.error('agent_close_chat:', err.message);
            agent.currentClientDeviceId = null;
            agent.currentClientName = null;
            agent.currentServiceName = null;
            agent.currentInteractionId = null;
            connectedAgents.set(socket.id, agent);
        }
    });

    // ═══════════════════════════════════════
    // PAUSE AGENT
    // ═══════════════════════════════════════
    socket.on('agent_start_pause', async () => {
        const agent = connectedAgents.get(socket.id);
        if (!agent) return;
        if (agentPauses.has(socket.id)) {
            socket.emit('pause_error', { message: 'Vous etes deja en pause' });
            return;
        }
        try {
            const res = await pool.query(`
                INSERT INTO agent_pauses (agent_id, session_id, start_time, status)
                VALUES ($1, $2, NOW(), 'active') RETURNING id
            `, [agent.agentId, agent.sessionId]);
            const pauseId = res.rows[0].id;
            agentPauses.set(socket.id, { agentId: agent.agentId, pauseId, startTime: Date.now() });
            socket.emit('pause_started', { pauseId, startTime: new Date().toISOString() });
            console.log('Agent en pause:', agent.agentName);
            emitAdminAgentsUpdate();
        } catch(err) {
            console.error('agent_start_pause:', err.message);
            socket.emit('pause_error', { message: 'Erreur lors du demarrage de la pause' });
        }
    });

    socket.on('agent_end_pause', async () => {
        const agent = connectedAgents.get(socket.id);
        if (!agent) return;
        const pauseInfo = agentPauses.get(socket.id);
        if (!pauseInfo) {
            socket.emit('pause_error', { message: 'Aucune pause en cours' });
            return;
        }
        const durationSeconds = Math.floor((Date.now() - pauseInfo.startTime) / 1000);
        try {
            await pool.query(`
                UPDATE agent_pauses 
                SET end_time = NOW(), duration_seconds = $1, status = 'completed'
                WHERE id = $2
            `, [durationSeconds, pauseInfo.pauseId]);
            agentPauses.delete(socket.id);
            socket.emit('pause_ended', { 
                pauseId: pauseInfo.pauseId, 
                durationSeconds,
                durationFormatted: formatDuration(durationSeconds)
            });
            console.log('Agent fin de pause:', agent.agentName, '-', durationSeconds, 's');
            emitAdminAgentsUpdate();
        } catch(err) {
            console.error('agent_end_pause:', err.message);
            agentPauses.delete(socket.id);
            socket.emit('pause_ended', { 
                pauseId: pauseInfo.pauseId, 
                durationSeconds,
                durationFormatted: formatDuration(durationSeconds)
            });
            emitAdminAgentsUpdate();
        }
    });

    socket.on('agent_disconnect', async () => {
        const agent = connectedAgents.get(socket.id);
        if (agent) {
            const pauseInfo = agentPauses.get(socket.id);
            if (pauseInfo) {
                const durationSeconds = Math.floor((Date.now() - pauseInfo.startTime) / 1000);
                try {
                    await pool.query(`
                        UPDATE agent_pauses 
                        SET end_time = NOW(), duration_seconds = $1, status = 'completed'
                        WHERE id = $2
                    `, [durationSeconds, pauseInfo.pauseId]);
                } catch(e) {}
                agentPauses.delete(socket.id);
            }
            try {
                await pool.query(`UPDATE agent_sessions SET logout_time=NOW(), total_duration=EXTRACT(EPOCH FROM (NOW() - login_time))::INTEGER WHERE id=$1`, [agent.sessionId]);
            } catch(err) {
                console.error('agent_disconnect:', err.message);
            }
            connectedAgents.delete(socket.id);
            console.log('Agent deconnecte :', agent.agentName);
            emitAdminAgentsUpdate();
        }
    });

    // ═══════════════════════════════════════
    // ADMIN / PATRON
    // ═══════════════════════════════════════
    socket.on('admin_connect', ({ password }) => {
        if (password === BOSS_PASSWORD) {
            socket.join('admin');
            socket.emit('admin_auth_success');
            emitAdminAgentsUpdate();
        } else {
            socket.emit('admin_auth_failed', { message: 'Mot de passe incorrect. Acces refuse.' });
        }
    });

    socket.on('admin_request_stats', async () => {
        if (!socket.rooms.has('admin')) return;
        try {
            const today = new Date().toISOString().split('T')[0];
            const agents = await pool.query(`
                SELECT a.id, a.nom, a.created_at,
                    COALESCE(s.clients_served, 0) as today_clients,
                    COALESCE(s.total_earnings, 0) as today_earnings,
                    COALESCE(s.total_time_seconds, 0) as today_time
                FROM agents a
                LEFT JOIN agent_daily_stats s ON a.id = s.agent_id AND s.date = $1
                WHERE a.is_active = TRUE
                ORDER BY a.nom
            `, [today]);
            socket.emit('admin_stats', { agents: agents.rows });
        } catch(err) {
            console.error('admin_request_stats:', err.message);
        }
    });

    socket.on('admin_request_conversation', async ({ deviceId }) => {
        if (!socket.rooms.has('admin')) return;
        try {
            const client = await pool.query('SELECT * FROM digital_ids WHERE device_id = $1', [deviceId]);
            const messages = await pool.query(`
                SELECT * FROM chat_messages WHERE device_id = $1 ORDER BY sent_at ASC
            `, [deviceId]);
            socket.emit('admin_conversation_data', {
                deviceId,
                clientName: client.rows[0]?.user_name || '',
                displayId: client.rows[0]?.display_id || deviceId,
                messages: messages.rows
            });
        } catch(err) {
            console.error('admin_request_conversation:', err.message);
        }
    });

    socket.on('admin_request_agent_history', async ({ agentId }) => {
        if (!socket.rooms.has('admin')) return;
        try {
            const interactions = await pool.query(`
                SELECT ai.*, d.user_name as client_display_name 
                FROM agent_interactions ai 
                LEFT JOIN digital_ids d ON ai.client_device_id = d.device_id 
                WHERE ai.agent_id = $1 
                ORDER BY ai.start_time DESC LIMIT 100
            `, [agentId]);
            const ratings = await pool.query(`
                SELECT ae.*, ai.service_name 
                FROM agent_evaluations ae 
                LEFT JOIN agent_interactions ai ON ae.interaction_id = ai.id 
                WHERE ae.agent_id = $1 
                ORDER BY ae.created_at DESC LIMIT 100
            `, [agentId]);
            socket.emit('admin_agent_history', { agentId, interactions: interactions.rows, ratings: ratings.rows });
        } catch(err) {
            console.error('admin_request_agent_history:', err.message);
        }
    });

    // ═══════════════════════════════════════
    // AUTRES
    // ═══════════════════════════════════════
    socket.on('rejoindre_fichiers', ({ deviceId }) => {
        socket.join('fichiers:' + deviceId);
    });

    socket.on('qr_generate', async ({ deviceId }) => {
        try {
            const token = crypto.randomBytes(32).toString('hex');
            await pool.query(`INSERT INTO qr_sessions (token, device_id_desktop, status, expires_at) VALUES ($1, $2, 'pending', NOW() + INTERVAL '5 minutes')`, [token, deviceId]);
            socket.emit('qr_token', { token, expiresIn: 300 });
        } catch(err) {
            console.error('qr_generate:', err.message);
            socket.emit('qr_token', { token: crypto.randomBytes(32).toString('hex'), expiresIn: 300 });
        }
    });

    socket.on('qr_scanned_by_mobile', async ({ token, mobileDeviceId }) => {
        try {
            const row = await pool.query(`SELECT * FROM qr_sessions WHERE token=$1 AND status='pending' AND expires_at > NOW()`, [token]);
            if (!row.rows.length) {
                socket.emit('qr_error', { message: 'Token invalide ou expire' });
                return;
            }
            const session = row.rows[0];
            const desktopDeviceId = session.device_id_desktop;
            await pool.query(`UPDATE qr_sessions SET device_id_mobile=$1, status='connected' WHERE token=$2`, [mobileDeviceId, token]);
            await pool.query(`INSERT INTO device_pairs (device_id_primary, device_id_linked) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING`, [desktopDeviceId, mobileDeviceId]);
            io.to('user:' + desktopDeviceId).emit('qr_connected', { mobileDeviceId });
            socket.emit('qr_connected', { desktopDeviceId });
        } catch(err) {
            console.error('qr_scanned:', err.message);
        }
    });

    socket.on('update_name', async ({ deviceId, userName }) => {
        try {
            await pool.query('UPDATE digital_ids SET user_name=$1 WHERE device_id=$2', [userName, deviceId]);
            const user = connectedUsers.get(socket.id);
            if (user) { user.userName = userName; connectedUsers.set(socket.id, user); }
        } catch(err) {
            console.error('update_name:', err.message);
        }
    });

    socket.on('disconnect', () => {
        const user = connectedUsers.get(socket.id);
        const agent = connectedAgents.get(socket.id);
        if (agent) {
            const pauseInfo = agentPauses.get(socket.id);
            if (pauseInfo) {
                const durationSeconds = Math.floor((Date.now() - pauseInfo.startTime) / 1000);
                pool.query(`UPDATE agent_pauses SET end_time=NOW(), duration_seconds=$1, status='completed' WHERE id=$2`, [durationSeconds, pauseInfo.pauseId]).catch(() => {});
                agentPauses.delete(socket.id);
            }
            pool.query(`UPDATE agent_sessions SET logout_time=NOW(), total_duration=EXTRACT(EPOCH FROM (NOW() - login_time))::INTEGER WHERE id=$1 AND logout_time IS NULL`, [agent.sessionId]).catch(() => {});
            connectedAgents.delete(socket.id);
            console.log('Agent deconnecte:', agent.agentName);
            emitAdminAgentsUpdate();
        }
        if (user) connectedUsers.delete(socket.id);
        console.log('Deconnecte :', socket.id);
    });
});

// ─────────────────────────────────────────────
// Middlewares
// ─────────────────────────────────────────────
app.use(express.json());
app.use('/uploads', express.static(uploadDir));

// ─────────────────────────────────────────────
// Routes API REST
// ─────────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({ status: 'OK', message: 'Backend AYA v3.1 fonctionne !', timestamp: new Date().toISOString() });
});

app.post('/api/device', async (req, res) => {
    const { deviceId, fingerprint, lang, userName } = req.body;
    try {
        await pool.query(`
            INSERT INTO digital_ids (device_id, fingerprint, lang, user_name, last_seen)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (device_id)
            DO UPDATE SET last_seen=NOW(), lang=$3, user_name=COALESCE($4, digital_ids.user_name)
        `, [deviceId, fingerprint, lang || 'fr', userName || null]);
        res.json({ ok: true, deviceId });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/upload', upload.single('fichier'), async (req, res) => {
    const { deviceId, targetDeviceId, uploadedBy } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ erreur: 'Aucun fichier recu' });
    const url = '/uploads/' + file.filename;
    const effectiveDeviceId = targetDeviceId || deviceId || 'anonymous';
    const effectiveUploader = uploadedBy || 'client';
    try {
        await pool.query(`
            INSERT INTO fichiers (device_id, nom, type_mime, taille, url, uploaded_by, uploade_le)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
        `, [effectiveDeviceId, file.originalname, file.mimetype, file.size, url, effectiveUploader]);
        if (effectiveDeviceId && effectiveDeviceId !== 'anonymous') {
            io.to('fichiers:' + effectiveDeviceId).emit('nouveau_fichier', {
                nom: file.originalname, url, type_mime: file.mimetype, taille: file.size,
                uploaded_by: effectiveUploader, uploade_le: new Date()
            });
            const timeStr = new Date().toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});
            const msgText = file.mimetype?.includes('audio') ? '\ud83c\udfa4 Message vocal'
                : file.mimetype?.includes('image') ? '\ud83d\uddbc\ufe0f Image : ' + file.originalname
                : file.mimetype?.includes('video') ? '\ud83c\udfa5 Video : ' + file.originalname
                : '\ud83d\udcce Fichier : ' + file.originalname;
            if (effectiveUploader === 'agent') {
                io.to('user:' + effectiveDeviceId).emit('agent_reply', {
                    text: msgText, mediaUrl: url, mediaType: file.mimetype, fileName: file.originalname, time: timeStr
                });
            }
            if (effectiveUploader === 'client') {
                io.to('chat:' + effectiveDeviceId).emit('client_message_to_agent', {
                    deviceId: effectiveDeviceId, text: msgText, mediaUrl: url,
                    mediaType: file.mimetype, fileName: file.originalname, time: timeStr, userName: 'Client'
                });
            }
        }
        res.json({ ok: true, url, nom: file.originalname, type: file.mimetype });
    } catch(err) {
        console.error('Upload error:', err.message);
        res.json({ ok: true, url, nom: file.originalname, type: file.mimetype, warning: 'Non enregistre en BDD' });
    }
});

app.get('/api/fichiers', async (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.json({ fichiers: [] });
    try {
        const result = await pool.query('SELECT * FROM fichiers WHERE device_id=$1 ORDER BY uploade_le DESC', [deviceId]);
        res.json({ fichiers: result.rows });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/fichiers/:id', async (req, res) => {
    const { deviceId } = req.query;
    const { id } = req.params;
    if (!deviceId || !id) return res.status(400).json({ error: 'Parametres manquants' });
    try {
        const check = await pool.query('SELECT url FROM fichiers WHERE id=$1 AND device_id=$2', [id, deviceId]);
        if (!check.rows.length) return res.status(404).json({ error: 'Fichier introuvable' });
        const filePath = path.join(__dirname, check.rows[0].url);
        if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch(e) {} }
        await pool.query('DELETE FROM fichiers WHERE id=$1', [id]);
        res.json({ ok: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/conversation/:deviceId', async (req, res) => {
    try {
        const rows = await pool.query('SELECT * FROM chat_messages WHERE device_id=$1 ORDER BY sent_at ASC', [req.params.deviceId]);
        res.json(rows.rows.map(row => ({ id: row.id, text: row.message_text, type: row.sender_type, time: row.sent_at })));
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/clients', async (req, res) => {
    try {
        const rows = await pool.query(`
            SELECT d.device_id, d.lang, d.last_seen, d.user_name,
                (SELECT message_text FROM chat_messages WHERE device_id=d.device_id ORDER BY sent_at DESC LIMIT 1) AS last_msg
            FROM digital_ids d ORDER BY d.last_seen DESC LIMIT 50
        `);
        res.json(rows.rows);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/file-attente', (req, res) => {
    res.json(Array.from(fileAttente.values()));
});

app.post('/api/qr/generate', async (req, res) => {
    const { deviceId } = req.body;
    try {
        const token = crypto.randomBytes(32).toString('hex');
        await pool.query(`INSERT INTO qr_sessions (token, device_id_desktop, status, expires_at) VALUES ($1, $2, 'pending', NOW() + INTERVAL '5 minutes')`, [token, deviceId]);
        res.json({ token, expiresIn: 300 });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/agent/stats/:agentId', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const stats = await pool.query(`SELECT * FROM agent_daily_stats WHERE agent_id=$1 AND date=$2`, [req.params.agentId, today]);
        const interactions = await pool.query(`SELECT * FROM agent_interactions WHERE agent_id=$1 AND DATE(start_time)=$2 ORDER BY start_time DESC`, [req.params.agentId, today]);
        res.json({ daily: stats.rows[0] || { total_time_seconds: 0, total_earnings: 0, clients_served: 0 }, interactions: interactions.rows });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/agent/history/:agentId', async (req, res) => {
    try {
        const rows = await pool.query(`
            SELECT ai.*, d.user_name as client_name
            FROM agent_interactions ai
            LEFT JOIN digital_ids d ON ai.client_device_id = d.device_id
            WHERE ai.agent_id=$1 ORDER BY ai.start_time DESC LIMIT 100
        `, [req.params.agentId]);
        res.json(rows.rows);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════
// ADMIN REST ENDPOINTS (pour le panel patron)
// ═══════════════════════════════════════════════════════════
app.get('/api/admin/dashboard', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const clientsToday = await pool.query(`SELECT COUNT(DISTINCT device_id) FROM chat_messages WHERE DATE(sent_at) = $1`, [today]);
        const earningsToday = await pool.query(`SELECT COALESCE(SUM(price_agreed), 0) as total FROM agent_interactions WHERE DATE(start_time) = $1 AND status = 'closed'`, [today]);
        const avgRating = await pool.query(`SELECT COALESCE(AVG(rating), 0) as avg FROM agent_evaluations WHERE DATE(created_at) = $1`, [today]);
        const agentsOnline = await pool.query(`SELECT COUNT(*) FROM agent_sessions WHERE DATE(login_time) = $1 AND logout_time IS NULL`, [today]);
        res.json({
            totalClientsToday: parseInt(clientsToday.rows[0].count) || 0,
            totalEarningsToday: parseFloat(earningsToday.rows[0].total) || 0,
            avgRatingToday: parseFloat(avgRating.rows[0].avg) || 0,
            agentsOnline: parseInt(agentsOnline.rows[0].count) || 0
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/agents', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const agents = await pool.query(`
            SELECT a.id, a.nom, a.created_at,
                COALESCE(s.clients_served, 0) as today_clients,
                COALESCE(s.total_earnings, 0) as today_earnings,
                COALESCE(s.total_time_seconds, 0) as today_time
            FROM agents a
            LEFT JOIN agent_daily_stats s ON a.id = s.agent_id AND s.date = $1
            WHERE a.is_active = TRUE
            ORDER BY a.nom
        `, [today]);
        res.json({ agents: agents.rows });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/agent/:agentId/full', async (req, res) => {
    try {
        const agentId = req.params.agentId;
        const interactions = await pool.query(`
            SELECT ai.*, d.user_name as client_display_name 
            FROM agent_interactions ai 
            LEFT JOIN digital_ids d ON ai.client_device_id = d.device_id 
            WHERE ai.agent_id = $1 
            ORDER BY ai.start_time DESC LIMIT 100
        `, [agentId]);
        const ratings = await pool.query(`
            SELECT ae.*, ai.service_name 
            FROM agent_evaluations ae 
            LEFT JOIN agent_interactions ai ON ae.interaction_id = ai.id 
            WHERE ae.agent_id = $1 
            ORDER BY ae.created_at DESC LIMIT 100
        `, [agentId]);
        res.json({ interactions: interactions.rows, ratings: ratings.rows });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/conversations/:deviceId', async (req, res) => {
    try {
        const deviceId = req.params.deviceId;
        const client = await pool.query('SELECT * FROM digital_ids WHERE device_id = $1', [deviceId]);
        const messages = await pool.query(`SELECT * FROM chat_messages WHERE device_id = $1 ORDER BY sent_at ASC`, [deviceId]);
        res.json({ client: client.rows[0] || {}, messages: messages.rows });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});



// ═══════════════════════════════════════════════════════════
// ENDPOINTS ADMIN EXPORT — Rapports patron journalier/mensuel
// ═══════════════════════════════════════════════════════════

// Export Excel journalier (tous les agents, aujourd'hui)
app.get('/api/admin/export/daily', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const todayDate = new Date();

        // ── FEUILLE 1 : RESUME GLOBAL DU JOUR ──
        const globalStats = await pool.query(`
            SELECT 
                COUNT(DISTINCT ai.agent_id) as agents_active,
                COUNT(ai.id) as total_interactions,
                COALESCE(SUM(ai.price_agreed), 0) as total_earnings,
                COALESCE(AVG(ai.interaction_duration), 0) as avg_duration,
                COUNT(DISTINCT ai.client_device_id) as unique_clients
            FROM agent_interactions ai
            WHERE DATE(ai.start_time) = $1 AND ai.status = 'closed'
        `, [today]);

        const queueStats = await pool.query(`
            SELECT COUNT(*) as queue_count FROM service_requests 
            WHERE DATE(requested_at) = $1 AND status = 'waiting'
        `, [today]);

        const alertsStats = await pool.query(`
            SELECT COUNT(*) as alerts_count FROM wait_alerts 
            WHERE DATE(alert_sent_at) = $1
        `, [today]);

        // ── FEUILLE 2 : DETAIL PAR AGENT ──
        const agentsDetail = await pool.query(`
            SELECT 
                a.id, a.nom,
                COALESCE(s.clients_served, 0) as clients_served,
                COALESCE(s.total_earnings, 0) as earnings,
                COALESCE(s.total_time_seconds, 0) as work_seconds,
                (SELECT COUNT(*) FROM agent_interactions 
                 WHERE agent_id = a.id AND DATE(start_time) = $1 AND status = 'closed') as interactions,
                (SELECT COALESCE(SUM(duration_seconds), 0) FROM agent_pauses 
                 WHERE agent_id = a.id AND DATE(start_time) = $1 AND status = 'completed') as pause_seconds
            FROM agents a
            LEFT JOIN agent_daily_stats s ON a.id = s.agent_id AND s.date = $1
            WHERE a.is_active = TRUE
            ORDER BY COALESCE(s.total_earnings, 0) DESC
        `, [today]);

        // ── FEUILLE 3 : INTERACTIONS DETAILLEES ──
        const interactionsDetail = await pool.query(`
            SELECT 
                ai.id, a.nom as agent_name, ai.client_name, ai.service_name,
                ai.start_time, ai.end_time, ai.first_response_time,
                ai.interaction_duration, ai.price_agreed, ai.status
            FROM agent_interactions ai
            JOIN agents a ON ai.agent_id = a.id
            WHERE DATE(ai.start_time) = $1
            ORDER BY ai.start_time DESC
        `, [today]);

        // ── FEUILLE 4 : FILE D'ATTENTE ──
        const queueDetail = await pool.query(`
            SELECT 
                device_id, service_name, status,
                requested_at, taken_at, closed_at
            FROM service_requests
            WHERE DATE(requested_at) = $1
            ORDER BY requested_at DESC
        `, [today]);

        // ── CREATION EXCEL ──
        const wb = XLSX.utils.book_new();
        wb.Props = {
            Title: 'Rapport Journalier AYA — ' + today,
            Subject: 'Supervision quotidienne',
            Author: 'AYA Secretariat Digital',
            CreatedDate: new Date()
        };

        // Feuille 1 : Resume
        const g = globalStats.rows[0] || {};
        const resumeData = [
            ['RAPPORT JOURNALIER AYA'],
            ['Date:', todayDate.toLocaleDateString('fr-FR')],
            ['Genere le:', new Date().toLocaleString('fr-FR')],
            [],
            ['INDICATEURS GLOBAUX'],
            ['Agents actifs', parseInt(g.agents_active) || 0],
            ['Clients uniques', parseInt(g.unique_clients) || 0],
            ['Interactions totales', parseInt(g.total_interactions) || 0],
            ['Gains totaux (FCFA)', parseFloat(g.total_earnings) || 0],
            ['Duree moyenne interaction (sec)', Math.round(parseFloat(g.avg_duration)) || 0],
            ["Clients en file d'attente", parseInt(queueStats.rows[0]?.queue_count) || 0],
            ['Alertes attente prolongee', parseInt(alertsStats.rows[0]?.alerts_count) || 0]
        ];
        const wsResume = XLSX.utils.aoa_to_sheet(resumeData);
        XLSX.utils.book_append_sheet(wb, wsResume, 'Resume Global');

        // Feuille 2 : Agents
        const agentsHeaders = ['ID Agent', 'Nom', 'Clients servis', 'Gains (FCFA)', 'Temps travail (h)', 'Interactions', 'Temps pause (h)'];
        const agentsData = [agentsHeaders];
        agentsDetail.rows.forEach(row => {
            agentsData.push([
                row.id, row.nom, row.clients_served || 0, row.earnings || 0,
                ((row.work_seconds || 0) / 3600).toFixed(2),
                row.interactions || 0,
                ((row.pause_seconds || 0) / 3600).toFixed(2)
            ]);
        });
        // Totaux
        const totalEarnings = agentsDetail.rows.reduce((s, r) => s + (parseFloat(r.earnings) || 0), 0);
        const totalClients = agentsDetail.rows.reduce((s, r) => s + (parseInt(r.clients_served) || 0), 0);
        const totalInteractions = agentsDetail.rows.reduce((s, r) => s + (parseInt(r.interactions) || 0), 0);
        agentsData.push([]);
        agentsData.push(['TOTAL', '', totalClients, totalEarnings, '', totalInteractions, '']);
        const wsAgents = XLSX.utils.aoa_to_sheet(agentsData);
        XLSX.utils.book_append_sheet(wb, wsAgents, 'Detail Agents');

        // Feuille 3 : Interactions
        const intHeaders = ['ID', 'Agent', 'Client', 'Service', 'Debut', 'Fin', '1ere reponse (sec)', 'Duree (sec)', 'Prix (FCFA)', 'Statut'];
        const intData = [intHeaders];
        interactionsDetail.rows.forEach(row => {
            intData.push([
                row.id, row.agent_name, row.client_name || '—', row.service_name,
                row.start_time ? new Date(row.start_time).toLocaleString('fr-FR') : '—',
                row.end_time ? new Date(row.end_time).toLocaleString('fr-FR') : '—',
                row.first_response_time || 0, row.interaction_duration || 0,
                row.price_agreed || 0, row.status
            ]);
        });
        const totalIntEarnings = interactionsDetail.rows.reduce((s, r) => s + (parseFloat(r.price_agreed) || 0), 0);
        const totalIntDuration = interactionsDetail.rows.reduce((s, r) => s + (parseInt(r.interaction_duration) || 0), 0);
        intData.push([]);
        intData.push(['TOTAL', '', '', '', '', '', '', totalIntDuration, totalIntEarnings, '']);
        const wsInteractions = XLSX.utils.aoa_to_sheet(intData);
        XLSX.utils.book_append_sheet(wb, wsInteractions, 'Interactions');

        // Feuille 4 : File d'attente
        const queueHeaders = ['Device ID', 'Service', 'Statut', 'Demande', 'Prise en charge', 'Fermeture'];
        const queueData = [queueHeaders];
        queueDetail.rows.forEach(row => {
            queueData.push([
                row.device_id, row.service_name, row.status,
                row.requested_at ? new Date(row.requested_at).toLocaleString('fr-FR') : '—',
                row.taken_at ? new Date(row.taken_at).toLocaleString('fr-FR') : '—',
                row.closed_at ? new Date(row.closed_at).toLocaleString('fr-FR') : '—'
            ]);
        });
        const wsQueue = XLSX.utils.aoa_to_sheet(queueData);
        XLSX.utils.book_append_sheet(wb, wsQueue, 'File attente');

        const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
        const fileName = 'AYA_Rapport_Journalier_' + today + '.xlsx';

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
        res.setHeader('Content-Length', excelBuffer.length);
        res.send(excelBuffer);

    } catch(err) {
        console.error('export daily:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Export Excel mensuel (consolide tous les agents)
app.get('/api/admin/export/monthly', async (req, res) => {
    try {
        const { month, year } = req.query;
        const monthInt = month ? parseInt(month) : new Date().getMonth() + 1;
        const yearInt = year ? parseInt(year) : new Date().getFullYear();

        const monthNames = ['', 'Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin',
                           'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre'];
        const periodLabel = monthNames[monthInt] + ' ' + yearInt;

        // ── FEUILLE 1 : RESUME MENSUEL GLOBAL ──
        const globalStats = await pool.query(`
            SELECT 
                COUNT(DISTINCT ai.agent_id) as agents_active,
                COUNT(ai.id) as total_interactions,
                COALESCE(SUM(ai.price_agreed), 0) as total_earnings,
                COALESCE(AVG(ai.interaction_duration), 0) as avg_duration,
                COUNT(DISTINCT ai.client_device_id) as unique_clients
            FROM agent_interactions ai
            WHERE EXTRACT(MONTH FROM ai.start_time) = $1 
            AND EXTRACT(YEAR FROM ai.start_time) = $2
            AND ai.status = 'closed'
        `, [monthInt, yearInt]);

        const pauseGlobal = await pool.query(`
            SELECT COALESCE(SUM(duration_seconds), 0) as total_pause_seconds
            FROM agent_pauses
            WHERE EXTRACT(MONTH FROM start_time) = $1 
            AND EXTRACT(YEAR FROM start_time) = $2
            AND status = 'completed'
        `, [monthInt, yearInt]);

        const evalGlobal = await pool.query(`
            SELECT COALESCE(AVG(rating), 0) as avg_rating, COUNT(*) as total_evals
            FROM agent_evaluations
            WHERE EXTRACT(MONTH FROM created_at) = $1 
            AND EXTRACT(YEAR FROM created_at) = $2
        `, [monthInt, yearInt]);

        // ── FEUILLE 2 : CUMUL PAR AGENT ──
        const agentsMonthly = await pool.query(`
            SELECT 
                a.id, a.nom,
                COUNT(ai.id) as interactions,
                COALESCE(SUM(ai.price_agreed), 0) as earnings,
                COALESCE(AVG(ai.interaction_duration), 0) as avg_duration,
                COALESCE(AVG(ai.first_response_time), 0) as avg_response,
                (SELECT COALESCE(SUM(duration_seconds), 0) FROM agent_pauses 
                 WHERE agent_id = a.id AND EXTRACT(MONTH FROM start_time) = $1 
                 AND EXTRACT(YEAR FROM start_time) = $2 AND status = 'completed') as pause_seconds,
                (SELECT COALESCE(AVG(rating), 0) FROM agent_evaluations 
                 WHERE agent_id = a.id AND EXTRACT(MONTH FROM created_at) = $1 
                 AND EXTRACT(YEAR FROM created_at) = $2) as avg_rating
            FROM agents a
            LEFT JOIN agent_interactions ai ON a.id = ai.agent_id 
                AND EXTRACT(MONTH FROM ai.start_time) = $1 
                AND EXTRACT(YEAR FROM ai.start_time) = $2
                AND ai.status = 'closed'
            WHERE a.is_active = TRUE
            GROUP BY a.id, a.nom
            ORDER BY COALESCE(SUM(ai.price_agreed), 0) DESC
        `, [monthInt, yearInt]);

        // ── FEUILLE 3 : JOURNALIER (par jour du mois) ──
        const dailyStats = await pool.query(`
            SELECT 
                DATE(start_time) as day,
                COUNT(*) as interactions,
                COALESCE(SUM(price_agreed), 0) as earnings,
                COUNT(DISTINCT agent_id) as agents_active,
                COUNT(DISTINCT client_device_id) as unique_clients
            FROM agent_interactions
            WHERE EXTRACT(MONTH FROM start_time) = $1 
            AND EXTRACT(YEAR FROM start_time) = $2
            AND status = 'closed'
            GROUP BY DATE(start_time)
            ORDER BY day DESC
        `, [monthInt, yearInt]);

        // ── FEUILLE 4 : INTERACTIONS COMPLETES DU MOIS ──
        const allInteractions = await pool.query(`
            SELECT 
                ai.id, a.nom as agent_name, ai.client_name, ai.service_name,
                ai.start_time, ai.end_time, ai.first_response_time,
                ai.interaction_duration, ai.price_agreed, ai.status
            FROM agent_interactions ai
            JOIN agents a ON ai.agent_id = a.id
            WHERE EXTRACT(MONTH FROM ai.start_time) = $1 
            AND EXTRACT(YEAR FROM ai.start_time) = $2
            ORDER BY ai.start_time DESC
        `, [monthInt, yearInt]);

        // ── CREATION EXCEL ──
        const wb = XLSX.utils.book_new();
        wb.Props = {
            Title: 'Rapport Mensuel AYA — ' + periodLabel,
            Subject: 'Supervision mensuelle',
            Author: 'AYA Secretariat Digital',
            CreatedDate: new Date()
        };

        // Feuille 1 : Resume global
        const g = globalStats.rows[0] || {};
        const p = pauseGlobal.rows[0] || {};
        const e = evalGlobal.rows[0] || {};
        const resumeData = [
            ['RAPPORT MENSUEL AYA'],
            ['Periode:', periodLabel],
            ['Genere le:', new Date().toLocaleString('fr-FR')],
            [],
            ['INDICATEURS GLOBAUX'],
            ['Agents ayant travaille', parseInt(g.agents_active) || 0],
            ['Clients uniques', parseInt(g.unique_clients) || 0],
            ['Interactions totales', parseInt(g.total_interactions) || 0],
            ['Gains totaux (FCFA)', parseFloat(g.total_earnings) || 0],
            ['Duree moyenne interaction (sec)', Math.round(parseFloat(g.avg_duration)) || 0],
            ['Temps total pause (h)', ((parseInt(p.total_pause_seconds) || 0) / 3600).toFixed(2)],
            ['Note moyenne (/5)', parseFloat(e.avg_rating || 0).toFixed(2)],
            ['Nombre evaluations', parseInt(e.total_evals) || 0],
            [],
            ['CALCULS COMPTABLES'],
            ['Gain moyen par interaction (FCFA)', parseInt(g.total_interactions) > 0 ? (parseFloat(g.total_earnings) / parseInt(g.total_interactions)).toFixed(2) : 0],
            ['Gain moyen par agent (FCFA)', parseInt(g.agents_active) > 0 ? (parseFloat(g.total_earnings) / parseInt(g.agents_active)).toFixed(2) : 0]
        ];
        const wsResume = XLSX.utils.aoa_to_sheet(resumeData);
        XLSX.utils.book_append_sheet(wb, wsResume, 'Resume Global');

        // Feuille 2 : Cumul par agent
        const agentHeaders = ['ID', 'Nom', 'Interactions', 'Gains (FCFA)', 'Duree moyenne (sec)', 'Temps reponse moyen (sec)', 'Temps pause (h)', 'Note moyenne (/5)'];
        const agentData = [agentHeaders];
        agentsMonthly.rows.forEach(row => {
            agentData.push([
                row.id, row.nom, row.interactions || 0, row.earnings || 0,
                Math.round(row.avg_duration) || 0,
                Math.round(row.avg_response) || 0,
                ((row.pause_seconds || 0) / 3600).toFixed(2),
                row.avg_rating ? parseFloat(row.avg_rating).toFixed(2) : '—'
            ]);
        });
        const totalAgentEarnings = agentsMonthly.rows.reduce((s, r) => s + (parseFloat(r.earnings) || 0), 0);
        const totalAgentInteractions = agentsMonthly.rows.reduce((s, r) => s + (parseInt(r.interactions) || 0), 0);
        agentData.push([]);
        agentData.push(['TOTAL', '', totalAgentInteractions, totalAgentEarnings, '', '', '', '']);
        const wsAgents = XLSX.utils.aoa_to_sheet(agentData);
        XLSX.utils.book_append_sheet(wb, wsAgents, 'Cumul par Agent');

        // Feuille 3 : Journalier
        const dailyHeaders = ['Date', 'Interactions', 'Gains (FCFA)', 'Agents actifs', 'Clients uniques'];
        const dailyData = [dailyHeaders];
        dailyStats.rows.forEach(row => {
            dailyData.push([
                row.day ? new Date(row.day).toLocaleDateString('fr-FR') : '—',
                row.interactions || 0, row.earnings || 0,
                row.agents_active || 0, row.unique_clients || 0
            ]);
        });
        const totalDailyEarnings = dailyStats.rows.reduce((s, r) => s + (parseFloat(r.earnings) || 0), 0);
        const totalDailyInteractions = dailyStats.rows.reduce((s, r) => s + (parseInt(r.interactions) || 0), 0);
        dailyData.push([]);
        dailyData.push(['TOTAL', totalDailyInteractions, totalDailyEarnings, '', '']);
        const wsDaily = XLSX.utils.aoa_to_sheet(dailyData);
        XLSX.utils.book_append_sheet(wb, wsDaily, 'Journalier');

        // Feuille 4 : Toutes les interactions
        const allIntHeaders = ['ID', 'Agent', 'Client', 'Service', 'Debut', 'Fin', '1ere reponse (sec)', 'Duree (sec)', 'Prix (FCFA)', 'Statut'];
        const allIntData = [allIntHeaders];
        allInteractions.rows.forEach(row => {
            allIntData.push([
                row.id, row.agent_name, row.client_name || '—', row.service_name,
                row.start_time ? new Date(row.start_time).toLocaleString('fr-FR') : '—',
                row.end_time ? new Date(row.end_time).toLocaleString('fr-FR') : '—',
                row.first_response_time || 0, row.interaction_duration || 0,
                row.price_agreed || 0, row.status
            ]);
        });
        const totalAllEarnings = allInteractions.rows.reduce((s, r) => s + (parseFloat(r.price_agreed) || 0), 0);
        const totalAllDuration = allInteractions.rows.reduce((s, r) => s + (parseInt(r.interaction_duration) || 0), 0);
        allIntData.push([]);
        allIntData.push(['TOTAL', '', '', '', '', '', '', totalAllDuration, totalAllEarnings, '']);
        const wsAllInt = XLSX.utils.aoa_to_sheet(allIntData);
        XLSX.utils.book_append_sheet(wb, wsAllInt, 'Toutes Interactions');

        const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
        const fileName = 'AYA_Rapport_Mensuel_' + monthInt + '_' + yearInt + '.xlsx';

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
        res.setHeader('Content-Length', excelBuffer.length);
        res.send(excelBuffer);

    } catch(err) {
        console.error('export monthly:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════
// ENDPOINTS v3.0 — PAUSES, ALERTES, EXPORT EXCEL
// ═══════════════════════════════════════════════════════════
app.post('/api/agent/pause/start', async (req, res) => {
    const { agentId, sessionId } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId requis' });
    try {
        const result = await pool.query(`
            INSERT INTO agent_pauses (agent_id, session_id, start_time, status)
            VALUES ($1, $2, NOW(), 'active') RETURNING *
        `, [agentId, sessionId || null]);
        res.json({ ok: true, pause: result.rows[0] });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/agent/pause/end', async (req, res) => {
    const { pauseId } = req.body;
    if (!pauseId) return res.status(400).json({ error: 'pauseId requis' });
    try {
        const pause = await pool.query('SELECT * FROM agent_pauses WHERE id=$1', [pauseId]);
        if (!pause.rows.length) return res.status(404).json({ error: 'Pause introuvable' });
        const startTime = new Date(pause.rows[0].start_time);
        const durationSeconds = Math.floor((Date.now() - startTime.getTime()) / 1000);
        const result = await pool.query(`
            UPDATE agent_pauses 
            SET end_time = NOW(), duration_seconds = $1, status = 'completed'
            WHERE id = $2 RETURNING *
        `, [durationSeconds, pauseId]);
        res.json({ ok: true, pause: result.rows[0], durationSeconds });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/agent/pauses/:agentId', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        let query = 'SELECT * FROM agent_pauses WHERE agent_id=$1';
        let params = [req.params.agentId];
        if (startDate && endDate) {
            query += ' AND start_time >= $2 AND start_time <= $3';
            params.push(startDate + ' 00:00:00', endDate + ' 23:59:59');
        }
        query += ' ORDER BY start_time DESC';
        const result = await pool.query(query, params);
        res.json({ pauses: result.rows });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/agent/stats/monthly/:agentId/:year/:month', async (req, res) => {
    try {
        const { agentId, year, month } = req.params;
        const monthInt = parseInt(month);
        const yearInt = parseInt(year);

        const interactions = await pool.query(`
            SELECT 
                COUNT(*) as total_interactions,
                COALESCE(SUM(price_agreed), 0) as total_earnings,
                COALESCE(AVG(first_response_time), 0) as avg_response_time,
                COALESCE(AVG(interaction_duration), 0) as avg_interaction_duration,
                COUNT(CASE WHEN price_agreed > 0 THEN 1 END) as confirmed_prices
            FROM agent_interactions 
            WHERE agent_id = $1 
            AND EXTRACT(MONTH FROM start_time) = $2 
            AND EXTRACT(YEAR FROM start_time) = $3
            AND status = 'closed'
        `, [agentId, monthInt, yearInt]);

        const pauses = await pool.query(`
            SELECT COALESCE(SUM(duration_seconds), 0) as total_pause_seconds
            FROM agent_pauses 
            WHERE agent_id = $1 
            AND EXTRACT(MONTH FROM start_time) = $2 
            AND EXTRACT(YEAR FROM start_time) = $3
            AND status = 'completed'
        `, [agentId, monthInt, yearInt]);

        const sessions = await pool.query(`
            SELECT COALESCE(SUM(total_duration), 0) as total_work_seconds
            FROM agent_sessions 
            WHERE agent_id = $1 
            AND EXTRACT(MONTH FROM login_time) = $2 
            AND EXTRACT(YEAR FROM login_time) = $3
        `, [agentId, monthInt, yearInt]);

        const evaluations = await pool.query(`
            SELECT COALESCE(AVG(rating), 0) as avg_rating, COUNT(*) as total_evaluations
            FROM agent_evaluations 
            WHERE agent_id = $1 
            AND EXTRACT(MONTH FROM created_at) = $2 
            AND EXTRACT(YEAR FROM created_at) = $3
        `, [agentId, monthInt, yearInt]);

        const messages = await pool.query(`
            SELECT 
                COUNT(CASE WHEN sender_type = 'agent' THEN 1 END) as messages_sent,
                COUNT(CASE WHEN sender_type = 'client' THEN 1 END) as messages_received
            FROM chat_messages cm
            JOIN agent_interactions ai ON cm.device_id = ai.client_device_id
            WHERE ai.agent_id = $1 
            AND EXTRACT(MONTH FROM cm.sent_at) = $2 
            AND EXTRACT(YEAR FROM cm.sent_at) = $3
        `, [agentId, monthInt, yearInt]);

        const files = await pool.query(`
            SELECT COUNT(*) as total_files
            FROM fichiers f
            JOIN agent_interactions ai ON f.device_id = ai.client_device_id
            WHERE ai.agent_id = $1 
            AND EXTRACT(MONTH FROM f.uploade_le) = $2 
            AND EXTRACT(YEAR FROM f.uploade_le) = $3
        `, [agentId, monthInt, yearInt]);

        const prices = await pool.query(`
            SELECT 
                COUNT(*) as total_prices_sent,
                COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as total_prices_confirmed
            FROM price_confirmations 
            WHERE agent_id = $1 
            AND EXTRACT(MONTH FROM sent_at) = $2 
            AND EXTRACT(YEAR FROM sent_at) = $3
        `, [agentId, monthInt, yearInt]);

        const intData = interactions.rows[0];
        const totalInteractions = parseInt(intData.total_interactions) || 0;
        const confirmedPrices = parseInt(intData.confirmed_prices) || 0;
        const conversionRate = totalInteractions > 0 ? (confirmedPrices / totalInteractions * 100).toFixed(2) : 0;

        const stats = {
            agentId: parseInt(agentId),
            month: monthInt,
            year: yearInt,
            totalEarnings: parseFloat(intData.total_earnings) || 0,
            totalClientsServed: totalInteractions,
            totalInteractions: totalInteractions,
            totalPauseSeconds: parseInt(pauses.rows[0].total_pause_seconds) || 0,
            totalWorkSeconds: parseInt(sessions.rows[0].total_work_seconds) || 0,
            avgResponseTimeSec: Math.round(parseFloat(intData.avg_response_time)) || 0,
            avgInteractionDurationSec: Math.round(parseFloat(intData.avg_interaction_duration)) || 0,
            avgRating: parseFloat(evaluations.rows[0].avg_rating) || 0,
            totalEvaluations: parseInt(evaluations.rows[0].total_evaluations) || 0,
            totalMessagesSent: parseInt(messages.rows[0].messages_sent) || 0,
            totalMessagesReceived: parseInt(messages.rows[0].messages_received) || 0,
            totalFilesUploaded: parseInt(files.rows[0].total_files) || 0,
            totalPricesSent: parseInt(prices.rows[0].total_prices_sent) || 0,
            totalPricesConfirmed: parseInt(prices.rows[0].total_prices_confirmed) || 0,
            conversionRate: parseFloat(conversionRate)
        };

        await pool.query(`
            INSERT INTO agent_monthly_stats 
            (agent_id, month, year, total_earnings, total_clients_served, total_interactions, 
             total_pause_seconds, total_work_seconds, avg_response_time_sec, avg_interaction_duration_sec,
             avg_rating, total_messages_sent, total_messages_received, total_files_uploaded,
             total_prices_sent, total_prices_confirmed, conversion_rate)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            ON CONFLICT (agent_id, month, year) DO UPDATE SET
                total_earnings = EXCLUDED.total_earnings,
                total_clients_served = EXCLUDED.total_clients_served,
                total_interactions = EXCLUDED.total_interactions,
                total_pause_seconds = EXCLUDED.total_pause_seconds,
                total_work_seconds = EXCLUDED.total_work_seconds,
                avg_response_time_sec = EXCLUDED.avg_response_time_sec,
                avg_interaction_duration_sec = EXCLUDED.avg_interaction_duration_sec,
                avg_rating = EXCLUDED.avg_rating,
                total_messages_sent = EXCLUDED.total_messages_sent,
                total_messages_received = EXCLUDED.total_messages_received,
                total_files_uploaded = EXCLUDED.total_files_uploaded,
                total_prices_sent = EXCLUDED.total_prices_sent,
                total_prices_confirmed = EXCLUDED.total_prices_confirmed,
                conversion_rate = EXCLUDED.conversion_rate
        `, [agentId, monthInt, yearInt, stats.totalEarnings, stats.totalClientsServed, stats.totalInteractions,
            stats.totalPauseSeconds, stats.totalWorkSeconds, stats.avgResponseTimeSec, stats.avgInteractionDurationSec,
            stats.avgRating, stats.totalMessagesSent, stats.totalMessagesReceived, stats.totalFilesUploaded,
            stats.totalPricesSent, stats.totalPricesConfirmed, stats.conversionRate]);

        res.json({ ok: true, stats });
    } catch(err) {
        console.error('stats monthly:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/agent/stats/export/:agentId', async (req, res) => {
    try {
        const { agentId } = req.params;
        const { month, year } = req.query;
        const monthInt = month ? parseInt(month) : new Date().getMonth() + 1;
        const yearInt = year ? parseInt(year) : new Date().getFullYear();

        const agentRow = await pool.query('SELECT * FROM agents WHERE id=$1', [agentId]);
        const agentName = agentRow.rows[0]?.nom || 'Agent ' + agentId;

        const monthlyRes = await pool.query(`
            SELECT * FROM agent_monthly_stats 
            WHERE agent_id = $1 AND month = $2 AND year = $3
        `, [agentId, monthInt, yearInt]);

        const interactionsRes = await pool.query(`
            SELECT 
                ai.id, ai.client_name, ai.service_name, ai.start_time, ai.end_time,
                ai.first_response_time, ai.interaction_duration, ai.price_agreed, ai.status,
                d.user_name as client_display_name
            FROM agent_interactions ai
            LEFT JOIN digital_ids d ON ai.client_device_id = d.device_id
            WHERE ai.agent_id = $1 
            AND EXTRACT(MONTH FROM ai.start_time) = $2 
            AND EXTRACT(YEAR FROM ai.start_time) = $3
            ORDER BY ai.start_time DESC
        `, [agentId, monthInt, yearInt]);

        const pausesRes = await pool.query(`
            SELECT * FROM agent_pauses 
            WHERE agent_id = $1 
            AND EXTRACT(MONTH FROM start_time) = $2 
            AND EXTRACT(YEAR FROM start_time) = $3
            AND status = 'completed'
            ORDER BY start_time DESC
        `, [agentId, monthInt, yearInt]);

        const evalsRes = await pool.query(`
            SELECT * FROM agent_evaluations 
            WHERE agent_id = $1 
            AND EXTRACT(MONTH FROM created_at) = $2 
            AND EXTRACT(YEAR FROM created_at) = $3
            ORDER BY created_at DESC
        `, [agentId, monthInt, yearInt]);

        const monthNames = ['', 'Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin',
                           'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre'];

        const wb = XLSX.utils.book_new();
        wb.Props = {
            Title: 'Rapport Comptabilite AYA - ' + agentName,
            Subject: 'Statistiques mensuelles agent',
            Author: 'AYA Secretariat Digital',
            CreatedDate: new Date()
        };

        const stats = monthlyRes.rows[0] || {};
        const resumeData = [
            ['RAPPORT DE COMPTABILITE AYA'],
            ['Agent:', agentName],
            ['Periode:', monthNames[monthInt] + ' ' + yearInt],
            ['Genere le:', new Date().toLocaleDateString('fr-FR')],
            [],
            ['INDICATEURS CLES'],
            ['Total gains (FCFA)', stats.total_earnings || 0],
            ['Clients servis', stats.total_clients_served || 0],
            ['Interactions totales', stats.total_interactions || 0],
            ['Temps de travail total (h)', ((stats.total_work_seconds || 0) / 3600).toFixed(2)],
            ['Temps de pause total (h)', ((stats.total_pause_seconds || 0) / 3600).toFixed(2)],
            ['Temps effectif (h)', (((stats.total_work_seconds || 0) - (stats.total_pause_seconds || 0)) / 3600).toFixed(2)],
            [],
            ['PERFORMANCES'],
            ['Temps moyen de reponse (sec)', stats.avg_response_time_sec || 0],
            ['Duree moyenne interaction (sec)', stats.avg_interaction_duration_sec || 0],
            ['Note moyenne (/5)', stats.avg_rating || 0],
            ['Taux de conversion (%)', stats.conversion_rate || 0],
            [],
            ['ACTIVITE'],
            ['Messages envoyes', stats.total_messages_sent || 0],
            ['Messages recus', stats.total_messages_received || 0],
            ['Fichiers uploades', stats.total_files_uploaded || 0],
            ['Prix envoyes', stats.total_prices_sent || 0],
            ['Prix confirmes', stats.total_prices_confirmed || 0],
            [],
            ['CALCULS COMPTABLES'],
            ['Gain moyen par client (FCFA)', stats.total_clients_served > 0 ? ((stats.total_earnings || 0) / stats.total_clients_served).toFixed(2) : 0],
            ['Gain moyen par heure (FCFA)', ((stats.total_work_seconds || 0) - (stats.total_pause_seconds || 0)) > 0 ? 
                ((stats.total_earnings || 0) / (((stats.total_work_seconds || 0) - (stats.total_pause_seconds || 0)) / 3600)).toFixed(2) : 0],
            ['Productivite (clients/heure)', ((stats.total_work_seconds || 0) - (stats.total_pause_seconds || 0)) > 0 ? 
                ((stats.total_clients_served || 0) / (((stats.total_work_seconds || 0) - (stats.total_pause_seconds || 0)) / 3600)).toFixed(2) : 0]
        ];
        const wsResume = XLSX.utils.aoa_to_sheet(resumeData);
        XLSX.utils.book_append_sheet(wb, wsResume, 'Resume');

        const interactionsHeaders = ['ID', 'Client', 'Service', 'Date debut', 'Date fin', 
            'Temps 1ere reponse (sec)', 'Duree interaction (sec)', 'Prix convenu (FCFA)', 'Statut'];
        const interactionsData = [interactionsHeaders];
        interactionsRes.rows.forEach(row => {
            interactionsData.push([
                row.id, row.client_name || row.client_display_name || 'Inconnu', row.service_name,
                row.start_time ? new Date(row.start_time).toLocaleString('fr-FR') : '-',
                row.end_time ? new Date(row.end_time).toLocaleString('fr-FR') : '-',
                row.first_response_time || 0, row.interaction_duration || 0, row.price_agreed || 0, row.status
            ]);
        });
        const totalEarnings = interactionsRes.rows.reduce((sum, r) => sum + (parseFloat(r.price_agreed) || 0), 0);
        const totalDuration = interactionsRes.rows.reduce((sum, r) => sum + (parseInt(r.interaction_duration) || 0), 0);
        interactionsData.push([]);
        interactionsData.push(['TOTAL', '', '', '', '', '', totalDuration, totalEarnings, '']);
        const wsInteractions = XLSX.utils.aoa_to_sheet(interactionsData);
        XLSX.utils.book_append_sheet(wb, wsInteractions, 'Interactions');

        const pausesHeaders = ['ID', 'Date debut', 'Date fin', 'Duree (sec)', 'Duree formatee'];
        const pausesData = [pausesHeaders];
        let totalPauseSeconds = 0;
        pausesRes.rows.forEach(row => {
            const d = row.duration_seconds || 0;
            totalPauseSeconds += d;
            const h = Math.floor(d / 3600);
            const m = Math.floor((d % 3600) / 60);
            const s = d % 60;
            pausesData.push([
                row.id,
                row.start_time ? new Date(row.start_time).toLocaleString('fr-FR') : '-',
                row.end_time ? new Date(row.end_time).toLocaleString('fr-FR') : '-',
                d, (h > 0 ? h + 'h ' : '') + (m > 0 ? m + 'min ' : '') + s + 's'
            ]);
        });
        pausesData.push([]);
        const pH = Math.floor(totalPauseSeconds / 3600);
        const pM = Math.floor((totalPauseSeconds % 3600) / 60);
        const pS = totalPauseSeconds % 60;
        pausesData.push(['TOTAL', '', '', totalPauseSeconds, (pH > 0 ? pH + 'h ' : '') + (pM > 0 ? pM + 'min ' : '') + pS + 's']);
        const wsPauses = XLSX.utils.aoa_to_sheet(pausesData);
        XLSX.utils.book_append_sheet(wb, wsPauses, 'Pauses');

        const evalsHeaders = ['ID', 'Interaction ID', 'Note (/5)', 'Commentaire', 'Evalue par', 'Date'];
        const evalsData = [evalsHeaders];
        let totalRating = 0;
        evalsRes.rows.forEach(row => {
            totalRating += (row.rating || 0);
            evalsData.push([
                row.id, row.interaction_id || '-', row.rating || '-', row.comment || '-',
                row.evaluated_by || 'system', row.created_at ? new Date(row.created_at).toLocaleString('fr-FR') : '-'
            ]);
        });
        evalsData.push([]);
        evalsData.push(['MOYENNE', '', '', evalsRes.rows.length > 0 ? (totalRating / evalsRes.rows.length).toFixed(2) : 0, '', '']);
        const wsEvals = XLSX.utils.aoa_to_sheet(evalsData);
        XLSX.utils.book_append_sheet(wb, wsEvals, 'Evaluations');

        const dailyRes = await pool.query(`
            SELECT 
                DATE(start_time) as day,
                COUNT(*) as interactions,
                COALESCE(SUM(price_agreed), 0) as earnings,
                COALESCE(AVG(interaction_duration), 0) as avg_duration
            FROM agent_interactions
            WHERE agent_id = $1 
            AND EXTRACT(MONTH FROM start_time) = $2 
            AND EXTRACT(YEAR FROM start_time) = $3
            AND status = 'closed'
            GROUP BY DATE(start_time)
            ORDER BY day DESC
        `, [agentId, monthInt, yearInt]);

        const dailyHeaders = ['Date', 'Interactions', 'Gains (FCFA)', 'Duree moyenne (sec)', 'Productivite (clients/h)'];
        const dailyData = [dailyHeaders];
        dailyRes.rows.forEach(row => {
            dailyData.push([
                row.day ? new Date(row.day).toLocaleDateString('fr-FR') : '-',
                row.interactions || 0, row.earnings || 0, Math.round(row.avg_duration) || 0,
                row.avg_duration > 0 ? (3600 / row.avg_duration).toFixed(2) : 0
            ]);
        });
        const wsDaily = XLSX.utils.aoa_to_sheet(dailyData);
        XLSX.utils.book_append_sheet(wb, wsDaily, 'Journalier');

        const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
        const fileName = 'AYA_Comptabilite_' + agentName.replace(/[^a-zA-Z0-9]/g, '_') + '_' + monthNames[monthInt] + '_' + yearInt + '.xlsx';

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
        res.setHeader('Content-Length', excelBuffer.length);
        res.send(excelBuffer);
    } catch(err) {
        console.error('export excel:', err.message);
        res.status(500).json({ error: err.message });
    }
});


        const totalEarnings = interactionsRes.rows.reduce((sum, r) => sum + (parseFloat(r.price_agreed) || 0), 0);
        const totalDuration = interactionsRes.rows.reduce((sum, r) => sum + (parseInt(r.interaction_duration) || 0), 0);
        interactionsData.push([]);
        interactionsData.push(['TOTAL', '', '', '', '', '', totalDuration, totalEarnings, '']);
        const wsInteractions = XLSX.utils.aoa_to_sheet(interactionsData);
        XLSX.utils.book_append_sheet(wb, wsInteractions, 'Interactions');

        const pausesHeaders = ['ID', 'Date debut', 'Date fin', 'Duree (sec)', 'Duree formatee'];
        const pausesData = [pausesHeaders];
        let totalPauseSeconds = 0;
        pausesRes.rows.forEach(row => {
            const d = row.duration_seconds || 0;
            totalPauseSeconds += d;
            const h = Math.floor(d / 3600);
            const m = Math.floor((d % 3600) / 60);
            const s = d % 60;
            pausesData.push([
                row.id,
                row.start_time ? new Date(row.start_time).toLocaleString('fr-FR') : '-',
                row.end_time ? new Date(row.end_time).toLocaleString('fr-FR') : '-',
                d, (h > 0 ? h + 'h ' : '') + (m > 0 ? m + 'min ' : '') + s + 's'
            ]);
        });
        pausesData.push([]);
        const pH = Math.floor(totalPauseSeconds / 3600);
        const pM = Math.floor((totalPauseSeconds % 3600) / 60);
        const pS = totalPauseSeconds % 60;
        pausesData.push(['TOTAL', '', '', totalPauseSeconds, (pH > 0 ? pH + 'h ' : '') + (pM > 0 ? pM + 'min ' : '') + pS + 's']);
        const wsPauses = XLSX.utils.aoa_to_sheet(pausesData);
        XLSX.utils.book_append_sheet(wb, wsPauses, 'Pauses');

        const evalsHeaders = ['ID', 'Interaction ID', 'Note (/5)', 'Commentaire', 'Evalue par', 'Date'];
        const evalsData = [evalsHeaders];
        let totalRating = 0;
        evalsRes.rows.forEach(row => {
            totalRating += (row.rating || 0);
            evalsData.push([
                row.id, row.interaction_id || '-', row.rating || '-', row.comment || '-',
                row.evaluated_by || 'system', row.created_at ? new Date(row.created_at).toLocaleString('fr-FR') : '-'
            ]);
        });
        evalsData.push([]);
        evalsData.push(['MOYENNE', '', '', evalsRes.rows.length > 0 ? (totalRating / evalsRes.rows.length).toFixed(2) : 0, '', '']);
        const wsEvals = XLSX.utils.aoa_to_sheet(evalsData);
        XLSX.utils.book_append_sheet(wb, wsEvals, 'Evaluations');

        const dailyRes = await pool.query(`
            SELECT 
                DATE(start_time) as day,
                COUNT(*) as interactions,
                COALESCE(SUM(price_agreed), 0) as earnings,
                COALESCE(AVG(interaction_duration), 0) as avg_duration
            FROM agent_interactions
            WHERE agent_id = $1 
            AND EXTRACT(MONTH FROM start_time) = $2 
            AND EXTRACT(YEAR FROM start_time) = $3
            AND status = 'closed'
            GROUP BY DATE(start_time)
            ORDER BY day DESC
        `, [agentId, monthInt, yearInt]);

        const dailyHeaders = ['Date', 'Interactions', 'Gains (FCFA)', 'Duree moyenne (sec)', 'Productivite (clients/h)'];
        const dailyData = [dailyHeaders];
        dailyRes.rows.forEach(row => {
            dailyData.push([
                row.day ? new Date(row.day).toLocaleDateString('fr-FR') : '-',
                row.interactions || 0, row.earnings || 0, Math.round(row.avg_duration) || 0,
                row.avg_duration > 0 ? (3600 / row.avg_duration).toFixed(2) : 0
            ]);
        });
        const wsDaily = XLSX.utils.aoa_to_sheet(dailyData);
        XLSX.utils.book_append_sheet(wb, wsDaily, 'Journalier');

        const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
        const fileName = 'AYA_Comptabilite_' + agentName.replace(/[^a-zA-Z0-9]/g, '_') + '_' + monthNames[monthInt] + '_' + yearInt + '.xlsx';

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
        res.setHeader('Content-Length', excelBuffer.length);
        res.send(excelBuffer);
    } catch(err) {
        console.error('export excel:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════
// ROUTE ID SEQUENTIEL GLOBAL — CORRECTION CRITIQUE
// ═══════════════════════════════════════════════════════════
app.post('/api/device/sequential-id', async (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId requis' });
    try {
        // Verifier si deja attribue
        const existing = await pool.query('SELECT display_id FROM digital_ids WHERE device_id = $1', [deviceId]);
        if (existing.rows[0]?.display_id && existing.rows[0].display_id.startsWith('AYA-')) {
            return res.json({ displayId: existing.rows[0].display_id });
        }
        // Recuperer le max actuel
        const maxResult = await pool.query(
            "SELECT COALESCE(MAX(CAST(NULLIF(SUBSTRING(display_id FROM 5), '') AS INTEGER)), 0) as max_num FROM digital_ids WHERE display_id LIKE 'AYA-%'"
        );
        const nextNum = parseInt(maxResult.rows[0].max_num) + 1;
        const newId = 'AYA-' + String(nextNum).padStart(5, '0');

        // Mettre a jour ou inserer
        await pool.query(`
            INSERT INTO digital_ids (device_id, display_id, last_seen)
            VALUES ($1, $2, NOW())
            ON CONFLICT (device_id)
            DO UPDATE SET display_id = COALESCE(digital_ids.display_id, $2), last_seen = NOW()
        `, [deviceId, newId]);

        // Forcer la mise a jour si display_id etait null
        await pool.query('UPDATE digital_ids SET display_id = $1 WHERE device_id = $2 AND (display_id IS NULL OR display_id = '')', [newId, deviceId]);

        res.json({ displayId: newId });
    } catch(err) {
        console.error('sequential-id:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/agent/evaluations', async (req, res) => {
    const { agentId, interactionId, clientDeviceId, rating, comment, evaluatedBy } = req.body;
    if (!agentId || !rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'agentId et rating (1-5) requis' });
    }
    try {
        const result = await pool.query(`
            INSERT INTO agent_evaluations (agent_id, interaction_id, client_device_id, rating, comment, evaluated_by)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
        `, [agentId, interactionId || null, clientDeviceId || null, rating, comment || null, evaluatedBy || 'system']);
        res.json({ ok: true, evaluation: result.rows[0] });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/agent/evaluations/:agentId', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM agent_evaluations 
            WHERE agent_id = $1 
            ORDER BY created_at DESC
        `, [req.params.agentId]);
        res.json({ evaluations: result.rows });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/alerts/waiting', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM wait_alerts 
            WHERE resolved_at IS NULL 
            ORDER BY alert_sent_at DESC
        `);
        res.json({ alerts: result.rows });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// Nettoyage periodique
// ─────────────────────────────────────────────
setInterval(async () => {
    try {
        const result = await pool.query("DELETE FROM qr_sessions WHERE expires_at < NOW() AND status='pending'");
        if (result.rowCount > 0) console.log(result.rowCount + ' session(s) QR expiree(s) supprimee(s)');
    } catch(err) {}
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────
// Middleware d'erreurs
// ─────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ error: 'Route non trouvee', path: req.url, timestamp: new Date().toISOString() });
});

app.use((err, req, res, next) => {
    console.error('[ERROR]', err.stack || err.message);
    res.status(500).json({ error: 'Erreur interne', message: err.message, timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────
// Lancement
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Serveur AYA v3.1 -> Port ' + PORT));
