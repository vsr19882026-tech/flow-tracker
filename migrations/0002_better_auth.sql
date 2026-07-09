-- Better Auth required tables. Singular table names (user, session, account,
-- verification) and camelCase columns, matching Better Auth's default schema.

CREATE TABLE "user" (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image         TEXT,
  createdAt     INTEGER NOT NULL,
  updatedAt     INTEGER NOT NULL
);

CREATE TABLE "session" (
  id        TEXT PRIMARY KEY,
  userId    TEXT NOT NULL REFERENCES "user"(id),
  token     TEXT NOT NULL UNIQUE,
  expiresAt INTEGER NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE "account" (
  id                    TEXT PRIMARY KEY,
  userId                TEXT NOT NULL REFERENCES "user"(id),
  accountId             TEXT NOT NULL,
  providerId            TEXT NOT NULL,
  accessToken           TEXT,
  refreshToken          TEXT,
  idToken               TEXT,
  accessTokenExpiresAt  INTEGER,
  refreshTokenExpiresAt INTEGER,
  scope                 TEXT,
  password              TEXT,
  createdAt             INTEGER NOT NULL,
  updatedAt             INTEGER NOT NULL
);

CREATE TABLE "verification" (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value      TEXT NOT NULL,
  expiresAt  INTEGER NOT NULL,
  createdAt  INTEGER NOT NULL,
  updatedAt  INTEGER NOT NULL
);
