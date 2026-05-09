
-- ============================================
-- NOUVELLES TABLES v3.0 — Pauses, Évaluations, Export Comptabilité
-- ============================================

-- 12. Pauses des agents (bouton pause/reprise)
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

-- 13. Évaluations des agents (par client ou système)
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

-- 14. Statistiques mensuelles par agent (pour comptabilité)
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

-- 15. Alertes clients en attente prolongée
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
