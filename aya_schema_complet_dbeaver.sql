-- ============================================================
-- AYA DATABASE SCHEMA v3.2 — Complet pour DBeaver / PostgreSQL
-- Ordre : tables parentes → tables enfants → indexes
-- ============================================================

-- 1. TABLE : Identités numériques des clients
CREATE TABLE IF NOT EXISTS digital_ids (
    id          SERIAL PRIMARY KEY,
    device_id   VARCHAR(64) UNIQUE NOT NULL,
    fingerprint TEXT,
    lang        VARCHAR(10) DEFAULT 'fr',
    user_name   TEXT,
    photo_url   TEXT,
    display_id  VARCHAR(20),           -- AYA-00001, AYA-00002...
    created_at  TIMESTAMP DEFAULT NOW(),
    last_seen   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_digital_ids_device ON digital_ids(device_id);
CREATE INDEX IF NOT EXISTS idx_digital_ids_display ON digital_ids(display_id);

-- 2. TABLE : Messages de chat
CREATE TABLE IF NOT EXISTS chat_messages (
    id               SERIAL PRIMARY KEY,
    device_id        VARCHAR(64) NOT NULL,
    message_text     TEXT NOT NULL,
    sender_type      VARCHAR(20) DEFAULT 'client',
    message_type     VARCHAR(20) DEFAULT 'text',
    media_url        TEXT,
    sent_at          TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_device ON chat_messages(device_id);
CREATE INDEX IF NOT EXISTS idx_chat_sent ON chat_messages(sent_at);

-- 3. TABLE : Fichiers uploadés
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

CREATE INDEX IF NOT EXISTS idx_fichiers_device ON fichiers(device_id);
CREATE INDEX IF NOT EXISTS idx_fichiers_date ON fichiers(uploade_le);

-- 4. TABLE : Sessions QR (connexion appareil mobile ↔ desktop)
CREATE TABLE IF NOT EXISTS qr_sessions (
    id                  SERIAL PRIMARY KEY,
    token               VARCHAR(64) UNIQUE NOT NULL,
    device_id_desktop   VARCHAR(64),
    device_id_mobile    VARCHAR(64),
    status              VARCHAR(20) DEFAULT 'pending',
    created_at          TIMESTAMP DEFAULT NOW(),
    expires_at          TIMESTAMP DEFAULT NOW() + INTERVAL '5 minutes'
);

CREATE INDEX IF NOT EXISTS idx_qr_token ON qr_sessions(token);
CREATE INDEX IF NOT EXISTS idx_qr_status ON qr_sessions(status);

-- 5. TABLE : Paires d'appareils liés
CREATE TABLE IF NOT EXISTS device_pairs (
    id                SERIAL PRIMARY KEY,
    device_id_primary VARCHAR(64) NOT NULL,
    device_id_linked  VARCHAR(64) NOT NULL,
    created_at        TIMESTAMP DEFAULT NOW(),
    UNIQUE(device_id_primary, device_id_linked)
);

CREATE INDEX IF NOT EXISTS idx_pairs_primary ON device_pairs(device_id_primary);
CREATE INDEX IF NOT EXISTS idx_pairs_linked ON device_pairs(device_id_linked);

-- 6. TABLE : Demandes de service
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

CREATE INDEX IF NOT EXISTS idx_service_device ON service_requests(device_id);
CREATE INDEX IF NOT EXISTS idx_service_status ON service_requests(status);
CREATE INDEX IF NOT EXISTS idx_service_date ON service_requests(requested_at);

-- 7. TABLE : Agents
CREATE TABLE IF NOT EXISTS agents (
    id          SERIAL PRIMARY KEY,
    nom         TEXT NOT NULL,
    email       TEXT UNIQUE,
    password_hash TEXT,
    created_at  TIMESTAMP DEFAULT NOW(),
    is_active   BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_agents_nom ON agents(nom);
CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(is_active);

-- 8. TABLE : Sessions des agents (connexions/déconnexions)
CREATE TABLE IF NOT EXISTS agent_sessions (
    id              SERIAL PRIMARY KEY,
    agent_id        INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    login_time      TIMESTAMP DEFAULT NOW(),
    logout_time     TIMESTAMP,
    total_duration  INTEGER DEFAULT 0,
    ip_address      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent ON agent_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_login ON agent_sessions(login_time);

-- 9. TABLE : Interactions agent-client
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

CREATE INDEX IF NOT EXISTS idx_interactions_agent ON agent_interactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_interactions_client ON agent_interactions(client_device_id);
CREATE INDEX IF NOT EXISTS idx_interactions_date ON agent_interactions(start_time);
CREATE INDEX IF NOT EXISTS idx_interactions_status ON agent_interactions(status);

-- 10. TABLE : Statistiques journalières par agent
CREATE TABLE IF NOT EXISTS agent_daily_stats (
    id              SERIAL PRIMARY KEY,
    agent_id        INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    date            DATE NOT NULL DEFAULT CURRENT_DATE,
    total_time_seconds INTEGER DEFAULT 0,
    total_earnings  NUMERIC(10,2) DEFAULT 0,
    clients_served  INTEGER DEFAULT 0,
    UNIQUE(agent_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_agent ON agent_daily_stats(agent_id);
CREATE INDEX IF NOT EXISTS idx_daily_date ON agent_daily_stats(date);

-- 11. TABLE : Confirmations de prix
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

CREATE INDEX IF NOT EXISTS idx_price_interaction ON price_confirmations(interaction_id);
CREATE INDEX IF NOT EXISTS idx_price_agent ON price_confirmations(agent_id);
CREATE INDEX IF NOT EXISTS idx_price_status ON price_confirmations(status);

-- ============================================
-- NOUVELLES TABLES v3.0 / v3.1 / v3.2
-- ============================================

-- 12. TABLE : Pauses des agents (bouton pause/reprise)
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
CREATE INDEX IF NOT EXISTS idx_agent_pauses_start ON agent_pauses(start_time);

-- 13. TABLE : Évaluations des agents (par client ou système)
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

-- 14. TABLE : Statistiques mensuelles par agent (comptabilité)
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

-- 15. TABLE : Alertes clients en attente prolongée
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

-- ============================================
-- DONNÉES INITIALES
-- ============================================

-- Agent démo (évite l'erreur si le serveur tente d'insérer avant la table)
INSERT INTO agents (nom, email, password_hash) 
VALUES ('Agent Demo', 'agent@aya.com', '$2b$10$demo_hash_pour_test_aya2024')
ON CONFLICT (email) DO NOTHING;

-- ============================================
-- VÉRIFICATION : Vue récapitulative
-- ============================================

-- Cette requête permet de vérifier que tout est créé correctement
-- À exécuter dans DBeaver après import :

/*
SELECT 
    table_name,
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_schema = 'public' 
AND table_name IN (
    'digital_ids', 'chat_messages', 'fichiers', 'qr_sessions', 
    'device_pairs', 'service_requests', 'agents', 'agent_sessions',
    'agent_interactions', 'agent_daily_stats', 'price_confirmations',
    'agent_pauses', 'agent_evaluations', 'agent_monthly_stats', 'wait_alerts'
)
ORDER BY table_name, ordinal_position;
*/
