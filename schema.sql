-- schema.sql — AYA Secretariat Digital v2.3 (Communication & Fichiers corriges)
-- Executer avec : psql -d aya_db -f schema.sql

-- 1. Identites des appareils clients
CREATE TABLE IF NOT EXISTS digital_ids (
    id          SERIAL PRIMARY KEY,
    device_id   VARCHAR(64) UNIQUE NOT NULL,
    fingerprint TEXT,
    user_name   TEXT,
    photo_url   TEXT,
    display_id  VARCHAR(20),
    lang        VARCHAR(10) DEFAULT 'fr',
    created_at  TIMESTAMP DEFAULT NOW(),
    last_seen   TIMESTAMP DEFAULT NOW()
);

-- 2. Messages du chat
CREATE TABLE IF NOT EXISTS chat_messages (
    id               SERIAL PRIMARY KEY,
    device_id        VARCHAR(64) NOT NULL,
    message_text     TEXT NOT NULL,
    sender_type      VARCHAR(20) DEFAULT 'client',
    message_type     VARCHAR(20) DEFAULT 'text',
    media_url        TEXT,
    sent_at          TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_device_id ON chat_messages(device_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sent_at ON chat_messages(sent_at);

-- 3. Fichiers uploades (CORRECTION v2.3 : ajout uploaded_by pour distinguer agent/client)
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

CREATE INDEX IF NOT EXISTS idx_fichiers_device_id ON fichiers(device_id);
CREATE INDEX IF NOT EXISTS idx_fichiers_uploaded_by ON fichiers(uploaded_by);

-- 4. Sessions QR Code (synchronisation telephone <-> ordinateur)
CREATE TABLE IF NOT EXISTS qr_sessions (
    id                  SERIAL PRIMARY KEY,
    token               VARCHAR(64) UNIQUE NOT NULL,
    device_id_desktop   VARCHAR(64),
    device_id_mobile    VARCHAR(64),
    status              VARCHAR(20) DEFAULT 'pending',
    created_at          TIMESTAMP DEFAULT NOW(),
    expires_at          TIMESTAMP DEFAULT NOW() + INTERVAL '60 seconds'
);

CREATE INDEX IF NOT EXISTS idx_qr_sessions_token ON qr_sessions(token);

-- 5. Paires d'appareils lies
CREATE TABLE IF NOT EXISTS device_pairs (
    id                SERIAL PRIMARY KEY,
    device_id_primary VARCHAR(64) NOT NULL,
    device_id_linked  VARCHAR(64) NOT NULL,
    created_at        TIMESTAMP DEFAULT NOW(),
    UNIQUE(device_id_primary, device_id_linked)
);

-- 6. Demandes de service (file d'attente agents)
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

CREATE INDEX IF NOT EXISTS idx_service_requests_status ON service_requests(status);
CREATE INDEX IF NOT EXISTS idx_service_requests_device_id ON service_requests(device_id);

-- ============================================
-- TABLES AGENTS v2.0
-- ============================================

-- 7. Table des agents
CREATE TABLE IF NOT EXISTS agents (
    id          SERIAL PRIMARY KEY,
    nom         TEXT NOT NULL,
    email       TEXT UNIQUE,
    password_hash TEXT,
    created_at  TIMESTAMP DEFAULT NOW(),
    is_active   BOOLEAN DEFAULT TRUE
);

-- 8. Sessions agent (connexions / deconnexions)
CREATE TABLE IF NOT EXISTS agent_sessions (
    id              SERIAL PRIMARY KEY,
    agent_id        INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    login_time      TIMESTAMP DEFAULT NOW(),
    logout_time     TIMESTAMP,
    total_duration  INTEGER DEFAULT 0,
    ip_address      TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent_id ON agent_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_login ON agent_sessions(login_time);

-- 9. Interactions agent-client (prises en charge)
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

CREATE INDEX IF NOT EXISTS idx_agent_interactions_agent ON agent_interactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_interactions_status ON agent_interactions(status);
CREATE INDEX IF NOT EXISTS idx_agent_interactions_device ON agent_interactions(client_device_id);

-- 10. Statistiques journalieres par agent
CREATE TABLE IF NOT EXISTS agent_daily_stats (
    id              SERIAL PRIMARY KEY,
    agent_id        INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    date            DATE NOT NULL DEFAULT CURRENT_DATE,
    total_time_seconds INTEGER DEFAULT 0,
    total_earnings  NUMERIC(10,2) DEFAULT 0,
    clients_served  INTEGER DEFAULT 0,
    UNIQUE(agent_id, date)
);

CREATE INDEX IF NOT EXISTS idx_agent_daily_stats_date ON agent_daily_stats(date);

-- 11. Liens de confirmation de prix envoyes aux clients
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

CREATE INDEX IF NOT EXISTS idx_price_confirmations_device ON price_confirmations(client_device_id);
CREATE INDEX IF NOT EXISTS idx_price_confirmations_status ON price_confirmations(status);

-- Insertion d'un agent demo (mot de passe: aya2024)
INSERT INTO agents (nom, email, password_hash) 
VALUES ('Agent Demo', 'agent@aya.com', '$2b$10$demo_hash_pour_test_aya2024')
ON CONFLICT (email) DO NOTHING;
