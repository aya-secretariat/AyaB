// Serveur.js — AYA Secretariat Digital v2.7 — Corrections fichiers/vocaux
'use strict';

const express  = require('express');
const { Pool } = require('pg');
const path     = require('path');
const crypto   = require('crypto');
const fs       = require('fs');
require('dotenv').config();

const app  = express();

// ─────────────────────────────────────────────
// Configuration Cloudflare / Reverse Proxy
// ─────────────────────────────────────────────
// Trust proxy pour que Express gère correctement les headers
// X-Forwarded-* envoyés par Cloudflare Workers
app.set('trust proxy', true);

// Middleware pour gérer le header Host de manière souple
// Le Worker Cloudflare peut modifier l'origine de la requête
app.use((req, res, next) => {
    // Accepter n'importe quel Host et ne pas bloquer sur la vérification
    req.headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    next();
});

const http = require('http').createServer(app);
const io   = require('socket.io')(http, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
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
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20 Mo max

// ─────────────────────────────────────────────
// PostgreSQL — Connexion avec retry
// ─────────────────────────────────────────────
const pool = new Pool({
    user:     process.env.DB_USER     || 'postgres',
    host:     process.env.DB_HOST     || 'localhost',
    database: process.env.DB_DATABASE || 'aya_db',
    password: process.env.DB_PASSWORD || '',
    port:     parseInt(process.env.DB_PORT || '5432'),
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('PostgreSQL :', err.stack);
        console.log('Le serveur fonctionne en mode sans base de donnees (mock mode)');
        return;
    }
    console.log('Connecte a PostgreSQL');
    release();
});

// ─────────────────────────────────────────────
// Creation des tables au demarrage
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

            INSERT INTO agents (nom, email, password_hash) 
            VALUES ('Agent Demo', 'agent@aya.com', '$2b$10$demo_hash_pour_test_aya2024')
            ON CONFLICT (email) DO NOTHING;
        `);
        console.log('Tables pretes (v2.7)');
    } catch(err) {
        console.error('initDB:', err.message);
        console.log('Base de donnees indisponible — mode sans BDD active');
    }
}
initDB();

// ─────────────────────────────────────────────
// Etat en memoire
// ─────────────────────────────────────────────
const connectedUsers = new Map();
const connectedAgents = new Map();
const fileAttente    = new Map();

// ─────────────────────────────────────────────
// Socket.io — Gestionnaire principal
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('Connexion :', socket.id);

    // ═════════════════════════════════════════
    // 1. ENREGISTREMENT CLIENT
    // ═════════════════════════════════════════
    socket.on('register', async ({ deviceId, fingerprint, lang, displayId }) => {
        try {
            await pool.query(`
                INSERT INTO digital_ids (device_id, fingerprint, lang, last_seen, display_id)
                VALUES ($1, $2, $3, NOW(), $4)
                ON CONFLICT (device_id)
                DO UPDATE SET fingerprint=$2, lang=$3, last_seen=NOW(), display_id=COALESCE($4, digital_ids.display_id)
            `, [deviceId, fingerprint, lang, displayId || null]);

            const userRow = await pool.query('SELECT user_name FROM digital_ids WHERE device_id=$1', [deviceId]);
            const userName = userRow.rows[0]?.user_name || '';

            connectedUsers.set(socket.id, { deviceId, lang, userName });
            socket.join('user:' + deviceId);

            const hist = await pool.query(
                `SELECT * FROM chat_messages WHERE device_id=$1 ORDER BY sent_at ASC LIMIT 100`,
                [deviceId]
            );

            socket.emit('registered', {
                deviceId,
                history: hist.rows.map(row => ({
                    id:   row.id,
                    text: row.message_text,
                    type: row.sender_type === 'client' ? 'sent' : 'received',
                    time: new Date(row.sent_at).toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'})
                }))
            });
        } catch(err) {
            console.error('register:', err.message);
            connectedUsers.set(socket.id, { deviceId, lang, userName: '', displayId: displayId || deviceId.substring(0, 8).toUpperCase() });
            socket.join('user:' + deviceId);
            socket.emit('registered', { deviceId, history: [] });
        }
    });

    // ═════════════════════════════════════════
    // 2. MESSAGE CLIENT — CORRECTION v2.9 : displayId AYA
    // ═════════════════════════════════════════
    socket.on('client_message', async ({ text }) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const { deviceId } = user;
        const now = new Date();

        // Récupérer le displayId depuis connectedUsers
        const displayId = user?.displayId || deviceId.substring(0, 8).toUpperCase();

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

    // ═════════════════════════════════════════
    // 3. SERVICE CHOISI — CORRECTION v2.8 : callback + logs
    // ═════════════════════════════════════════
    socket.on('service_choisi', async ({ nomService }, callback) => {
        const user = connectedUsers.get(socket.id);
        if (!user) {
            console.warn('[Server] service_choisi refuse — user non enregistre pour socket', socket.id);
            if (typeof callback === 'function') callback({ ok: false, error: 'User not registered' });
            return;
        }
        const { deviceId } = user;

        try {
            const userRow = await pool.query('SELECT user_name FROM digital_ids WHERE device_id=$1', [deviceId]);
            const userName = userRow.rows[0]?.user_name || 'Client';
            const displayId = deviceId.substring(0, 8).toUpperCase();

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

            console.log('[File] Client ajoute:', userName, '- Service:', nomService, '- Agents notifies:', io.sockets.adapter.rooms.get('agents')?.size || 0);
            if (typeof callback === 'function') callback({ ok: true });
        } catch(err) {
            console.error('service_choisi:', err.message);
            const userName = user.userName || 'Client';
            const displayId = user.displayId || deviceId.substring(0, 8).toUpperCase();

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

            if (typeof callback === 'function') callback({ ok: true });
        }
    });

    // ═════════════════════════════════════════
    // 4. CONFIRMATION PRIX PAR CLIENT
    // ═════════════════════════════════════════
    socket.on('confirm_price', async ({ confirmationId, deviceId }) => {
        try {
            await pool.query(`
                UPDATE price_confirmations 
                SET status='confirmed', confirmed_at=NOW() 
                WHERE id=$1
            `, [confirmationId]);

            const pcRow = await pool.query('SELECT * FROM price_confirmations WHERE id=$1', [confirmationId]);
            if (pcRow.rows.length) {
                const pc = pcRow.rows[0];
                await pool.query(`
                    UPDATE agent_interactions 
                    SET price_agreed=$1 
                    WHERE id=$2
                `, [pc.price, pc.interaction_id]);

                io.to('agents').emit('price_confirmed_by_client', {
                    confirmationId,
                    price: pc.price
                });
            }
        } catch(err) {
            console.error('confirm_price:', err.message);
        }
    });

    // ═════════════════════════════════════════
    // 5. AGENT SE CONNECTE
    // ═════════════════════════════════════════
    socket.on('agent_connect', async ({ agentName, lang }) => {
        try {
            let agentRow = await pool.query('SELECT * FROM agents WHERE nom=$1', [agentName]);
            let agentId;
            if (!agentRow.rows.length) {
                const newAgent = await pool.query(`
                    INSERT INTO agents (nom) VALUES ($1) RETURNING id
                `, [agentName]);
                agentId = newAgent.rows[0].id;
            } else {
                agentId = agentRow.rows[0].id;
            }

            const sessionRes = await pool.query(`
                INSERT INTO agent_sessions (agent_id, login_time)
                VALUES ($1, NOW()) RETURNING id
            `, [agentId]);
            const sessionId = sessionRes.rows[0].id;

            socket.join('agents');
            connectedAgents.set(socket.id, { agentId, agentName, sessionId, currentClientDeviceId: null });

            socket.emit('agent_registered', { agentId, sessionId, agentName });

            const liste = Array.from(fileAttente.values());
            socket.emit('liste_attente', liste);

            const today = new Date().toISOString().split('T')[0];
            const statsRow = await pool.query(`
                SELECT * FROM agent_daily_stats 
                WHERE agent_id=$1 AND date=$2
            `, [agentId, today]);
            if (statsRow.rows.length) {
                socket.emit('agent_stats_update', {
                    clientsServed: statsRow.rows[0].clients_served,
                    totalEarnings: statsRow.rows[0].total_earnings
                });
            }

            console.log('Agent connecte :', agentName, '(ID:', agentId, ')');
        } catch(err) {
            console.error('agent_connect:', err.message);
            const mockAgentId = Math.floor(Math.random() * 10000);
            const mockSessionId = Math.floor(Math.random() * 10000);
            socket.join('agents');
            connectedAgents.set(socket.id, { agentId: mockAgentId, agentName, sessionId: mockSessionId, currentClientDeviceId: null });
            socket.emit('agent_registered', { agentId: mockAgentId, sessionId: mockSessionId, agentName });
            const liste = Array.from(fileAttente.values());
            socket.emit('liste_attente', liste);
            console.log('Agent connecte (mode sans BDD) :', agentName);
        }
    });

    // ═════════════════════════════════════════
    // 5b. AGENT CHANGE SON NOM
    // ═════════════════════════════════════════
    socket.on('agent_update_name', async ({ newName }) => {
        const agent = connectedAgents.get(socket.id);
        if (!agent || !newName || newName.trim().length < 2) return;

        try {
            await pool.query('UPDATE agents SET nom=$1 WHERE id=$2', [newName.trim(), agent.agentId]);
            agent.agentName = newName.trim();
            connectedAgents.set(socket.id, agent);
            socket.emit('agent_name_updated', { agentName: newName.trim() });
            console.log('Agent renomme :', newName.trim(), '(ID:', agent.agentId, ')');
        } catch(err) {
            console.error('agent_update_name:', err.message);
            agent.agentName = newName.trim();
            connectedAgents.set(socket.id, agent);
            socket.emit('agent_name_updated', { agentName: newName.trim() });
        }
    });

    // ═════════════════════════════════════════
    // 6. AGENT DEMANDE FILE D'ATTENTE
    // ═════════════════════════════════════════
    socket.on('agent_request_queue', () => {
        const liste = Array.from(fileAttente.values());
        socket.emit('liste_attente', liste);
    });

    // ═════════════════════════════════════════
    // 7. AGENT PREND UN CLIENT
    // ═════════════════════════════════════════
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

            const interactionId = interactionRes.rows[0].id;
            agent.currentClientDeviceId = deviceId;
            agent.currentInteractionId = interactionId;
            connectedAgents.set(socket.id, agent);

            await pool.query(`
                UPDATE service_requests SET agent_id=$1, status='active', taken_at=NOW()
                WHERE device_id=$2 AND status='waiting'
            `, [agent.agentId, deviceId]);

            socket.join('chat:' + deviceId);
        } catch(err) {
            console.error('agent_prend_client:', err.message);
            agent.currentClientDeviceId = deviceId;
            agent.currentInteractionId = Math.floor(Math.random() * 10000);
            connectedAgents.set(socket.id, agent);
            socket.join('chat:' + deviceId);
        }
    });

    // ═════════════════════════════════════════
    // 8. MESSAGE AGENT -> CLIENT
    // ═════════════════════════════════════════
    socket.on('agent_message', async ({ deviceId, text }) => {
        const agent = connectedAgents.get(socket.id);
        if (!agent) return;
        const now = new Date();

        try {
            await pool.query(`
                INSERT INTO chat_messages (device_id, message_text, sender_type)
                VALUES ($1, $2, 'agent')
            `, [deviceId, text]);

            const timeStr = now.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});

            io.to('user:' + deviceId).emit('agent_reply', { text, time: timeStr });
            socket.emit('agent_message_sent', { deviceId, text, time: timeStr });
        } catch(err) {
            console.error('agent_message:', err.message);
            const timeStr = now.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
            io.to('user:' + deviceId).emit('agent_reply', { text, time: timeStr });
        }
    });

    // ═════════════════════════════════════════
    // 8b. AGENT ENVOIE UN FICHIER/VOCAL
    // ═════════════════════════════════════════
    socket.on('agent_upload_media', async ({ deviceId, url, fileName, mediaType, text }) => {
        const agent = connectedAgents.get(socket.id);
        if (!agent) return;
        const now = new Date();
        const timeStr = now.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});

        try {
            await pool.query(`
                INSERT INTO chat_messages (device_id, message_text, sender_type, message_type, media_url)
                VALUES ($1, $2, 'agent', $3, $4)
            `, [deviceId, text || fileName, mediaType || 'file', url]);
        } catch(e) {}

        // CORRECTION v2.7 : Envoyer AUSSI à la room chat: pour l'agent
        io.to('user:' + deviceId).emit('agent_reply', {
            text: text || fileName,
            mediaUrl: url,
            mediaType: mediaType,
            fileName: fileName,
            time: timeStr
        });

        // Feedback pour l'agent
        socket.emit('agent_message_sent', { deviceId, text: text || fileName, time: timeStr });
    });

    // ═════════════════════════════════════════
    // 8c. CLIENT ENVOIE UN FICHIER/VOCAL — CORRECTION v2.9 : displayId AYA
    // ═════════════════════════════════════════
    socket.on('client_upload_media', async ({ url, fileName, mediaType, text }) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const { deviceId } = user;
        const now = new Date();
        const timeStr = now.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});

        // Récupérer le displayId depuis connectedUsers
        const displayId = user?.displayId || deviceId.substring(0, 8).toUpperCase();

        try {
            await pool.query(`
                INSERT INTO chat_messages (device_id, message_text, sender_type, message_type, media_url)
                VALUES ($1, $2, 'client', $3, $4)
            `, [deviceId, text || fileName, mediaType || 'file', url]);
        } catch(e) {}

        // CORRECTION v2.7 : Envoyer à la room chat: pour que l'agent reçoive
        io.to('chat:' + deviceId).emit('client_message_to_agent', {
            deviceId,
            text: text || fileName,
            mediaUrl: url,
            mediaType: mediaType,
            fileName: fileName,
            time: timeStr,
            userName: user.userName || 'Client',
            displayId
        });
    });

    // ═════════════════════════════════════════
    // 9. AGENT ENVOIE UN LIEN DE PRIX
    // ═════════════════════════════════════════
    socket.on('agent_send_price', async ({ deviceId, price }) => {
        const agent = connectedAgents.get(socket.id);
        if (!agent) return;

        try {
            const interactionId = agent.currentInteractionId;
            if (!interactionId) return;

            const pcRes = await pool.query(`
                INSERT INTO price_confirmations (interaction_id, agent_id, client_device_id, price)
                VALUES ($1, $2, $3, $4) RETURNING id
            `, [interactionId, agent.agentId, deviceId, price]);

            const confirmationId = pcRes.rows[0].id;

            io.to('user:' + deviceId).emit('price_link', {
                price,
                confirmationId
            });
        } catch(err) {
            console.error('agent_send_price:', err.message);
            io.to('user:' + deviceId).emit('price_link', {
                price,
                confirmationId: Math.floor(Math.random() * 100000)
            });
        }
    });

    // ═════════════════════════════════════════
    // 10. AGENT FERME LE CHAT
    // ═════════════════════════════════════════
    socket.on('agent_close_chat', async ({ deviceId, firstResponseTime, interactionDuration }) => {
        const agent = connectedAgents.get(socket.id);
        if (!agent) return;

        try {
            const interactionId = agent.currentInteractionId;
            if (interactionId) {
                await pool.query(`
                    UPDATE agent_interactions 
                    SET end_time=NOW(), first_response_time=$1, interaction_duration=$2, status='closed'
                    WHERE id=$3
                `, [firstResponseTime || 0, interactionDuration || 0, interactionId]);

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

                await pool.query(`
                    UPDATE service_requests SET status='closed', closed_at=NOW()
                    WHERE device_id=$1 AND status='active'
                `, [deviceId]);
            }

            agent.currentClientDeviceId = null;
            agent.currentInteractionId = null;
            connectedAgents.set(socket.id, agent);

            const today = new Date().toISOString().split('T')[0];
            const statsRow = await pool.query(`
                SELECT * FROM agent_daily_stats WHERE agent_id=$1 AND date=$2
            `, [agent.agentId, today]);
            if (statsRow.rows.length) {
                io.to(socket.id).emit('agent_stats_update', {
                    clientsServed: statsRow.rows[0].clients_served,
                    totalEarnings: statsRow.rows[0].total_earnings
                });
            }
        } catch(err) {
            console.error('agent_close_chat:', err.message);
            agent.currentClientDeviceId = null;
            agent.currentInteractionId = null;
            connectedAgents.set(socket.id, agent);
        }
    });

    // ═════════════════════════════════════════
    // 11. AGENT SE DECONNECTE
    // ═════════════════════════════════════════
    socket.on('agent_disconnect', async () => {
        const agent = connectedAgents.get(socket.id);
        if (agent) {
            try {
                await pool.query(`
                    UPDATE agent_sessions 
                    SET logout_time=NOW(), 
                        total_duration=EXTRACT(EPOCH FROM (NOW() - login_time))::INTEGER
                    WHERE id=$1
                `, [agent.sessionId]);
            } catch(err) {
                console.error('agent_disconnect:', err.message);
            }
            connectedAgents.delete(socket.id);
            console.log('Agent deconnecte :', agent.agentName);
        }
    });

    // ═════════════════════════════════════════
    // 12. ROOM FICHIERS
    // ═════════════════════════════════════════
    socket.on('rejoindre_fichiers', ({ deviceId }) => {
        socket.join('fichiers:' + deviceId);
    });

    // ═════════════════════════════════════════
    // 13. QR CODE
    // ═════════════════════════════════════════
    socket.on('qr_generate', async ({ deviceId }) => {
        try {
            const token = crypto.randomBytes(32).toString('hex');
            await pool.query(`
                INSERT INTO qr_sessions (token, device_id_desktop, status, expires_at)
                VALUES ($1, $2, 'pending', NOW() + INTERVAL '5 minutes')
            `, [token, deviceId]);
            socket.emit('qr_token', { token, expiresIn: 300 });
        } catch(err) {
            console.error('qr_generate:', err.message);
            socket.emit('qr_token', { token: crypto.randomBytes(32).toString('hex'), expiresIn: 300 });
        }
    });

    socket.on('qr_scanned_by_mobile', async ({ token, mobileDeviceId }) => {
        try {
            const row = await pool.query(`
                SELECT * FROM qr_sessions
                WHERE token=$1 AND status='pending' AND expires_at > NOW()
            `, [token]);

            if (!row.rows.length) {
                socket.emit('qr_error', { message: 'Token invalide ou expire' });
                return;
            }

            const session = row.rows[0];
            const desktopDeviceId = session.device_id_desktop;

            await pool.query(`
                UPDATE qr_sessions SET device_id_mobile=$1, status='connected'
                WHERE token=$2
            `, [mobileDeviceId, token]);

            await pool.query(`
                INSERT INTO device_pairs (device_id_primary, device_id_linked)
                VALUES ($1, $2), ($2, $1)
                ON CONFLICT DO NOTHING
            `, [desktopDeviceId, mobileDeviceId]);

            const pairRoom = 'pair:' + desktopDeviceId;
            socket.join(pairRoom);
            io.to('user:' + desktopDeviceId).socketsJoin(pairRoom);

            io.to('user:' + desktopDeviceId).emit('qr_connected', { mobileDeviceId });
            socket.emit('qr_connected', { desktopDeviceId });
        } catch(err) {
            console.error('qr_scanned:', err.message);
        }
    });

    // ═════════════════════════════════════════
    // 14. MISE A JOUR NOM UTILISATEUR
    // ═════════════════════════════════════════
    socket.on('update_name', async ({ deviceId, userName }) => {
        try {
            await pool.query('UPDATE digital_ids SET user_name=$1 WHERE device_id=$2', [userName, deviceId]);
            const user = connectedUsers.get(socket.id);
            if (user) {
                user.userName = userName;
                connectedUsers.set(socket.id, user);
            }
        } catch(err) {
            console.error('update_name:', err.message);
        }
    });

    // ═════════════════════════════════════════
    // 15. DECONNEXION GENERALE
    // ═════════════════════════════════════════
    socket.on('disconnect', () => {
        const user = connectedUsers.get(socket.id);
        const agent = connectedAgents.get(socket.id);

        if (agent) {
            pool.query(`
                UPDATE agent_sessions 
                SET logout_time=NOW(), 
                    total_duration=EXTRACT(EPOCH FROM (NOW() - login_time))::INTEGER
                WHERE id=$1 AND logout_time IS NULL
            `, [agent.sessionId]).catch(() => {});
            connectedAgents.delete(socket.id);
            console.log('Agent deconnecte (socket):', agent.agentName);
        }

        if (user) {
            connectedUsers.delete(socket.id);
        }
        console.log('Deconnecte :', socket.id);
    });
});

// ─────────────────────────────────────────────
// Middlewares
// ─────────────────────────────────────────────
// Servir les fichiers statiques depuis /Front-End
app.use(express.static(path.join(__dirname, 'Front-End')));
app.use(express.json());
app.use('/uploads', express.static(uploadDir));

// ─────────────────────────────────────────────
// Routes API REST
// ─────────────────────────────────────────────

// POST /api/device
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

// POST /api/upload (CORRECTION v2.7 : uploaded_by + targetDeviceId)
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
            // Notifier la room fichiers
            io.to('fichiers:' + effectiveDeviceId).emit('nouveau_fichier', {
                nom: file.originalname, url,
                type_mime: file.mimetype,
                taille: file.size,
                uploaded_by: effectiveUploader,
                uploade_le: new Date()
            });

            // Notifier le chat
            const timeStr = new Date().toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});
            const isAudio = file.mimetype && file.mimetype.includes('audio');
            const isImage = file.mimetype && file.mimetype.includes('image');
            const isVideo = file.mimetype && file.mimetype.includes('video');

            let msgText = '📎 Fichier : ' + file.originalname;
            if (isAudio) msgText = '🎤 Message vocal';
            if (isImage) msgText = '🖼️ Image : ' + file.originalname;
            if (isVideo) msgText = '🎥 Vidéo : ' + file.originalname;

            // Si c'est l'agent qui envoie, notifier le client
            if (effectiveUploader === 'agent') {
                io.to('user:' + effectiveDeviceId).emit('agent_reply', {
                    text: msgText,
                    mediaUrl: url,
                    mediaType: file.mimetype,
                    fileName: file.originalname,
                    time: timeStr
                });
            }

            // Si c'est le client qui envoie, notifier l'agent
            if (effectiveUploader === 'client') {
                io.to('chat:' + effectiveDeviceId).emit('client_message_to_agent', {
                    deviceId: effectiveDeviceId,
                    text: msgText,
                    mediaUrl: url,
                    mediaType: file.mimetype,
                    fileName: file.originalname,
                    time: timeStr,
                    userName: 'Client'
                });
            }
        }

        res.json({ ok: true, url, nom: file.originalname, type: file.mimetype });
    } catch(err) {
        console.error('Upload error:', err.message);
        res.json({ ok: true, url, nom: file.originalname, type: file.mimetype, warning: 'Non enregistre en BDD' });
    }
});

// GET /api/fichiers
app.get('/api/fichiers', async (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.json({ fichiers: [] });
    try {
        const result = await pool.query(
            'SELECT * FROM fichiers WHERE device_id=$1 ORDER BY uploade_le DESC',
            [deviceId]
        );
        res.json({ fichiers: result.rows });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/fichiers/:id
app.delete('/api/fichiers/:id', async (req, res) => {
    const { deviceId } = req.query;
    const { id } = req.params;
    if (!deviceId || !id) return res.status(400).json({ error: 'Parametres manquants' });
    try {
        // Vérifier que le fichier appartient bien à cet appareil
        const check = await pool.query(
            'SELECT url FROM fichiers WHERE id=$1 AND device_id=$2',
            [id, deviceId]
        );
        if (!check.rows.length) return res.status(404).json({ error: 'Fichier introuvable' });

        // Supprimer le fichier physique du disque
        const fileUrl = check.rows[0].url;
        const filePath = path.join(__dirname, fileUrl);
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch(e) { console.warn('Suppression disque:', e.message); }
        }

        await pool.query('DELETE FROM fichiers WHERE id=$1', [id]);
        res.json({ ok: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/conversation/:deviceId
app.get('/api/conversation/:deviceId', async (req, res) => {
    try {
        const rows = await pool.query(
            'SELECT * FROM chat_messages WHERE device_id=$1 ORDER BY sent_at ASC',
            [req.params.deviceId]
        );
        res.json(rows.rows.map(row => ({
            id:   row.id,
            text: row.message_text,
            type: row.sender_type,
            time: row.sent_at
        })));
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/clients
app.get('/api/clients', async (req, res) => {
    try {
        const rows = await pool.query(`
            SELECT d.device_id, d.lang, d.last_seen, d.user_name,
                (SELECT message_text FROM chat_messages
                 WHERE device_id=d.device_id ORDER BY sent_at DESC LIMIT 1) AS last_msg
            FROM digital_ids d ORDER BY d.last_seen DESC LIMIT 50
        `);
        res.json(rows.rows);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/file-attente
app.get('/api/file-attente', (req, res) => {
    res.json(Array.from(fileAttente.values()));
});

// POST /api/qr/generate
app.post('/api/qr/generate', async (req, res) => {
    const { deviceId } = req.body;
    try {
        const token = crypto.randomBytes(32).toString('hex');
        await pool.query(`
            INSERT INTO qr_sessions (token, device_id_desktop, status, expires_at)
            VALUES ($1, $2, 'pending', NOW() + INTERVAL '5 minutes')
        `, [token, deviceId]);
        res.json({ token, expiresIn: 300 });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// Routes Agent API
// ─────────────────────────────────────────────
app.get('/api/agent/stats/:agentId', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const stats = await pool.query(`
            SELECT * FROM agent_daily_stats 
            WHERE agent_id=$1 AND date=$2
        `, [req.params.agentId, today]);

        const interactions = await pool.query(`
            SELECT * FROM agent_interactions 
            WHERE agent_id=$1 AND DATE(start_time)=$2
            ORDER BY start_time DESC
        `, [req.params.agentId, today]);

        res.json({
            daily: stats.rows[0] || { total_time_seconds: 0, total_earnings: 0, clients_served: 0 },
            interactions: interactions.rows
        });
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
            WHERE ai.agent_id=$1
            ORDER BY ai.start_time DESC
            LIMIT 100
        `, [req.params.agentId]);
        res.json(rows.rows);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// Routes pages HTML
// ─────────────────────────────────────────────
// Route racine explicite → Identification.html
app.get('/',             (_, res) => res.sendFile(path.join(__dirname, 'Front-End', 'Identification.html')));
app.get('/services',     (_, res) => res.sendFile(path.join(__dirname, 'Front-End', 'Services.html')));
app.get('/modeles',      (_, res) => res.sendFile(path.join(__dirname, 'Front-End', 'Modeles.html')));
app.get('/messagerie',   (_, res) => res.sendFile(path.join(__dirname, 'Front-End', 'Message1.html')));
app.get('/fichiers',     (_, res) => res.sendFile(path.join(__dirname, 'Front-End', 'Fichiers.html')));
app.get('/apropos',      (_, res) => res.sendFile(path.join(__dirname, 'Front-End', 'Mon Aya.html')));
app.get('/monid',        (_, res) => res.sendFile(path.join(__dirname, 'Front-End', 'Mon Aya.html')));
app.get('/agent',        (_, res) => res.sendFile(path.join(__dirname, 'Front-End', 'agent-panel.html')));

// ─────────────────────────────────────────────
// Nettoyage periodique
// ─────────────────────────────────────────────
setInterval(async () => {
    try {
        const result = await pool.query(
            "DELETE FROM qr_sessions WHERE expires_at < NOW() AND status='pending'"
        );
        if (result.rowCount > 0) console.log(result.rowCount + ' session(s) QR expiree(s) supprimee(s)');
    } catch(err) {
        // Silencieux en mode sans BDD
    }
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────
// Middleware de capture d'erreurs (404)
// ─────────────────────────────────────────────
app.use((req, res, next) => {
    console.error('[404] Route non trouvée :', req.method, req.url, '- Host:', req.headers.host);
    res.status(404).json({
        error: 'Route non trouvée',
        path: req.url,
        method: req.method,
        host: req.headers.host,
        timestamp: new Date().toISOString()
    });
});

// Middleware d'erreur général
app.use((err, req, res, next) => {
    console.error('[ERROR]', err.stack || err.message);
    res.status(500).json({
        error: 'Erreur interne du serveur',
        message: err.message,
        timestamp: new Date().toISOString()
    });
});

// ─────────────────────────────────────────────
// Lancement
// ─────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';
http.listen(PORT, HOST, () => console.log('Serveur AYA v2.7 → http://' + HOST + ':' + PORT));
