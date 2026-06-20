import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cerida',
});

export interface YesNoTick {
  oracleId: string;
  strike: number;
  ts: number; // ms
  yes: number; // cents
  no: number; // cents
  spot: number;
  expiry: number; // ms
}

// Stores the derived yes/no price series per market (oracle, strike).
export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS yesno_ticks (
      oracle_id TEXT        NOT NULL,
      strike    DOUBLE PRECISION NOT NULL,
      ts        TIMESTAMPTZ  NOT NULL,
      yes_cents DOUBLE PRECISION NOT NULL,
      no_cents  DOUBLE PRECISION NOT NULL,
      spot      DOUBLE PRECISION NOT NULL,
      expiry    TIMESTAMPTZ  NOT NULL,
      PRIMARY KEY (oracle_id, strike, ts)
    );
  `);
  // TimescaleDB hypertable (no-op if the extension isn't installed).
  try {
    await pool.query(`SELECT create_hypertable('yesno_ticks', 'ts', if_not_exists => TRUE);`);
  } catch {
    /* plain Postgres — fine */
  }
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_yesno_oracle_ts ON yesno_ticks (oracle_id, ts DESC);`,
  );
}

export async function insertTick(t: YesNoTick): Promise<void> {
  await pool.query(
    `INSERT INTO yesno_ticks (oracle_id, strike, ts, yes_cents, no_cents, spot, expiry)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5,$6,to_timestamp($7/1000.0))
     ON CONFLICT (oracle_id, strike, ts) DO NOTHING`,
    [t.oracleId, t.strike, t.ts, t.yes, t.no, t.spot, t.expiry],
  );
}

export async function latest(oracleId: string) {
  const r = await pool.query(
    `SELECT oracle_id, strike, extract(epoch from ts)*1000 AS ts,
            yes_cents, no_cents, spot, extract(epoch from expiry)*1000 AS expiry
     FROM yesno_ticks WHERE oracle_id = $1 ORDER BY ts DESC LIMIT 1`,
    [oracleId],
  );
  return r.rows[0] ?? null;
}

export async function history(oracleId: string, limit = 500) {
  const r = await pool.query(
    `SELECT extract(epoch from ts)*1000 AS ts, yes_cents, no_cents, spot, strike
     FROM yesno_ticks WHERE oracle_id = $1 ORDER BY ts DESC LIMIT $2`,
    [oracleId, limit],
  );
  return r.rows.reverse();
}

// Latest yes/no per market (for a markets list).
export async function markets() {
  const r = await pool.query(`
    SELECT DISTINCT ON (oracle_id) oracle_id, strike,
           extract(epoch from ts)*1000 AS ts, yes_cents, no_cents, spot,
           extract(epoch from expiry)*1000 AS expiry
    FROM yesno_ticks ORDER BY oracle_id, ts DESC
  `);
  return r.rows;
}
