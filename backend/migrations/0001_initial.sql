CREATE TABLE request_nonces (
  owner TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (owner, nonce)
) WITHOUT ROWID;
CREATE INDEX request_nonces_expiry ON request_nonces(expires_at);

CREATE TABLE quotas (
  bucket TEXT NOT NULL,
  window INTEGER NOT NULL,
  used INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, window)
) WITHOUT ROWID;
CREATE INDEX quotas_expiry ON quotas(expires_at);

CREATE TABLE orders (
  owner TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('creating', 'created', 'uncertain')),
  provider_id TEXT UNIQUE,
  response TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, request_id)
) WITHOUT ROWID;
