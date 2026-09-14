-- Future Blue Shark 4.8: starter exercise library for Render/Neon
-- The catalog is deliberately small and safe to bootstrap. Video URLs remain NULL
-- until an exercise has an approved production video.

CREATE TABLE IF NOT EXISTS exercises (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  name TEXT,
  position TEXT,
  age_band TEXT,
  level TEXT,
  domain TEXT NOT NULL,
  difficulty INT NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 5),
  status TEXT NOT NULL DEFAULT 'PUBLISHED',
  video_url TEXT,
  video_status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exercises_status ON exercises(status);
CREATE INDEX IF NOT EXISTS idx_exercises_position ON exercises(position);
CREATE INDEX IF NOT EXISTS idx_exercises_age_band ON exercises(age_band);

CREATE TABLE IF NOT EXISTS exercise_media (
  id BIGSERIAL PRIMARY KEY,
  exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL DEFAULT 'VIDEO',
  video_url TEXT,
  provider TEXT,
  license_type TEXT,
  duration_seconds INTEGER,
  thumbnail_url TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  ai_qa_status TEXT,
  professional_review_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_exercise_media_exercise ON exercise_media(exercise_id);
CREATE INDEX IF NOT EXISTS idx_exercise_media_status ON exercise_media(status);

INSERT INTO exercises
(id,title,name,position,age_band,level,domain,difficulty,status,video_url,video_status)
VALUES
('fbs-001','Passe curto — dois toques','Passe curto — dois toques','Médio centro','6–7','Descoberta','Técnica',1,'PUBLISHED',NULL,'PENDING'),
('fbs-002','Receção orientada — direita','Receção orientada — direita','Médio centro','8–9','Iniciação','Técnica',1,'PUBLISHED',NULL,'PENDING'),
('fbs-003','Receção orientada — esquerda','Receção orientada — esquerda','Extremo','8–9','Iniciação','Técnica',1,'PUBLISHED',NULL,'PENDING'),
('fbs-004','Condução com mudança de direção','Condução com mudança de direção','Extremo','10–11','Formação I','Técnica',2,'PUBLISHED',NULL,'PENDING'),
('fbs-005','Condução pé não dominante','Condução pé não dominante','Extremo','10–11','Formação I','Técnica',2,'PUBLISHED',NULL,'PENDING'),
('fbs-006','Drible 1x1 — mudança de ritmo','Drible 1x1 — mudança de ritmo','Extremo','12–13','Formação II','Técnica',3,'PUBLISHED',NULL,'PENDING'),
('fbs-007','Finta corporal simples','Finta corporal simples','Extremo','12–13','Formação II','Técnica',2,'PUBLISHED',NULL,'PENDING'),
('fbs-008','Passe em movimento','Passe em movimento','Médio centro','12–13','Formação II','Técnica',2,'PUBLISHED',NULL,'PENDING'),
('fbs-009','Passe de primeira','Passe de primeira','Médio ofensivo','14–15','Desenvolvimento','Técnica',3,'PUBLISHED',NULL,'PENDING'),
('fbs-010','Receção sob pressão','Receção sob pressão','Médio ofensivo','14–15','Desenvolvimento','Técnica',3,'PUBLISHED',NULL,'PENDING'),
('fbs-011','Finalização após condução','Finalização após condução','Avançado','14–15','Desenvolvimento','Técnica',3,'PUBLISHED',NULL,'PENDING'),
('fbs-012','Finalização com pé não dominante','Finalização com pé não dominante','Avançado','16–17','Pré-alto rendimento','Técnica',4,'PUBLISHED',NULL,'PENDING'),
('fbs-013','Cruzamento em movimento','Cruzamento em movimento','Lateral','14–15','Desenvolvimento','Técnica',3,'PUBLISHED',NULL,'PENDING'),
('fbs-014','Controlo + passe vertical','Controlo + passe vertical','Médio defensivo','14–15','Desenvolvimento','Técnica',3,'PUBLISHED',NULL,'PENDING'),
('fbs-015','Aceleração curta 5 m','Aceleração curta 5 m','Extremo','12–13','Formação II','Física',2,'PUBLISHED',NULL,'PENDING'),
('fbs-016','Aceleração curta 10 m','Aceleração curta 10 m','Extremo','14–15','Desenvolvimento','Física',3,'PUBLISHED',NULL,'PENDING'),
('fbs-017','Agilidade — mudança de direção','Agilidade — mudança de direção','Lateral','14–15','Desenvolvimento','Física',3,'PUBLISHED',NULL,'PENDING'),
('fbs-018','Coordenação com bola','Coordenação com bola','Extremo','8–9','Iniciação','Física',1,'PUBLISHED',NULL,'PENDING'),
('fbs-019','Reação a estímulo visual','Reação a estímulo visual','Guarda-redes','10–11','Formação I','Cognitiva',2,'PUBLISHED',NULL,'PENDING'),
('fbs-020','Perceção antes da receção','Perceção antes da receção','Médio centro','12–13','Formação II','Cognitiva',2,'PUBLISHED',NULL,'PENDING'),
('fbs-021','Decisão passe ou condução','Decisão passe ou condução','Médio ofensivo','14–15','Desenvolvimento','Cognitiva',3,'PUBLISHED',NULL,'PENDING'),
('fbs-022','1x1 defensivo — contenção','1x1 defensivo — contenção','Defesa central','14–15','Desenvolvimento','Tática',3,'PUBLISHED',NULL,'PENDING'),
('fbs-023','Cobertura defensiva','Cobertura defensiva','Defesa central','16–17','Pré-alto rendimento','Tática',4,'PUBLISHED',NULL,'PENDING'),
('fbs-024','Pressão após perda','Pressão após perda','Extremo','16–17','Pré-alto rendimento','Tática',4,'PUBLISHED',NULL,'PENDING'),
('fbs-025','Transição ataque-defesa','Transição ataque-defesa','Médio centro','16–17','Pré-alto rendimento','Tática',4,'PUBLISHED',NULL,'PENDING'),
('fbs-026','Apoio ao portador da bola','Apoio ao portador da bola','Médio ofensivo','12–13','Formação II','Tática',2,'PUBLISHED',NULL,'PENDING'),
('fbs-027','Posicionamento entre linhas','Posicionamento entre linhas','Médio ofensivo','16–17','Pré-alto rendimento','Tática',4,'PUBLISHED',NULL,'PENDING'),
('fbs-028','Defesa de cruzamento','Defesa de cruzamento','Defesa central','16–17','Pré-alto rendimento','Tática',4,'PUBLISHED',NULL,'PENDING'),
('fbs-029','Saída curta do guarda-redes','Saída curta do guarda-redes','Guarda-redes','12–13','Formação II','Guarda-redes',2,'PUBLISHED',NULL,'PENDING'),
('fbs-030','Guarda-redes — passe após defesa','Guarda-redes — passe após defesa','Guarda-redes','14–15','Desenvolvimento','Guarda-redes',3,'PUBLISHED',NULL,'PENDING'),
('fbs-031','Guarda-redes — reação curta','Guarda-redes — reação curta','Guarda-redes','16–17','Pré-alto rendimento','Guarda-redes',4,'PUBLISHED',NULL,'PENDING'),
('fbs-032','Mobilidade dinâmica','Mobilidade dinâmica','Todas','6–7','Descoberta','Física',1,'PUBLISHED',NULL,'PENDING')
ON CONFLICT (id) DO NOTHING;
