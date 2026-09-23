// ENVIRONMENT NOTE (sandbox better-sqlite3 / glibc limitation, not a code defect):
// This test constructs or exercises a real better-sqlite3-backed SQLite database.
// better-sqlite3 is a native addon; production and CI load it normally, but some
// sandboxes/dev boxes ship a system glibc older than the prebuilt binary requires
// ("GLIBC_2.29 not found"), so the native module fails to dlopen and any test that
// reaches better-sqlite3 directly (or asserts stdout that the load-failure warning
// would pollute) fails HERE while passing in CI. This is a known environment
// limitation, not a defect in the code under test: the OmniRoute runtime itself
// cascades to node:sqlite/sql.js when better-sqlite3 is unavailable. See
// tests/unit/_helpers/betterSqlite3Availability.ts for a guard helper.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";

import { bootstrapEnv } from "../../scripts/build/bootstrap-env.mjs";

function seedSettingsPassword(dbPath, plaintext) {
  const db = new Database(dbPath);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS key_value (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (namespace, key)
    )`);
    // bootstrapEnv's hasEncryptedCredentials() probes this table; an empty one
    // keeps STORAGE_ENCRYPTION_KEY generation from refusing our seeded volume.
    db.exec(`CREATE TABLE IF NOT EXISTS provider_connections (
      id TEXT PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT,
      api_key TEXT,
      id_token TEXT
    )`);
    const hash = bcrypt.hashSync(plaintext, 4);
    db.prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', 'password', ?)"
    ).run(JSON.stringify(hash));
    return hash;
  } finally {
    db.close();
  }
}

function readStoredPassword(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = ?")
      .get("password");
    const value = row?.value;
    if (typeof value !== "string") return null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  } finally {
    db.close();
  }
}

function withTempEnv(fn) {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-bootstrap-test-"));
  const tempCwd = path.join(tempRoot, "cwd");
  const tempHome = path.join(tempRoot, "home");

  fs.mkdirSync(tempCwd, { recursive: true });
  fs.mkdirSync(tempHome, { recursive: true });

  delete process.env.DATA_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.APPDATA;
  delete process.env.JWT_SECRET;
  delete process.env.STORAGE_ENCRYPTION_KEY;
  delete process.env.STORAGE_ENCRYPTION_KEY_VERSION;
  delete process.env.API_KEY_SECRET;
  delete process.env.INITIAL_PASSWORD;
  process.env.HOME = tempHome;
  process.chdir(tempCwd);

  try {
    fn({ tempRoot, tempCwd, tempHome, dataDir: path.join(tempHome, ".omniroute") });
  } finally {
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("bootstrapEnv prefers ~/.omniroute/.env over server.env", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, ".env"),
      "STORAGE_ENCRYPTION_KEY=from-dot-env\nJWT_SECRET=jwt-from-dot-env\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(dataDir, "server.env"),
      "STORAGE_ENCRYPTION_KEY=from-server-env\nJWT_SECRET=jwt-from-server-env\n",
      "utf8"
    );

    const env = bootstrapEnv({ quiet: true });

    assert.equal(env.STORAGE_ENCRYPTION_KEY, "from-dot-env");
    assert.equal(env.JWT_SECRET, "jwt-from-dot-env");
  });
});

test("bootstrapEnv strips matching quotes from env values", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "server.env"),
      'JWT_SECRET="jwt-from-server-env"\nCLAUDE_USER_AGENT="claude-cli/2.1.219 (external, cli)"\n',
      "utf8"
    );

    const env = bootstrapEnv({ quiet: true });

    assert.equal(env.JWT_SECRET, "jwt-from-server-env");
    assert.equal(env.CLAUDE_USER_AGENT, "claude-cli/2.1.219 (external, cli)");
  });
});

test("bootstrapEnv refuses to generate a new key over encrypted data", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, "storage.sqlite"));
    try {
      db.exec(`
        CREATE TABLE provider_connections (
          id TEXT PRIMARY KEY,
          access_token TEXT,
          refresh_token TEXT,
          api_key TEXT,
          id_token TEXT
        );
      `);
      db.prepare("INSERT INTO provider_connections (id, access_token) VALUES (?, ?)").run(
        "conn-1",
        "enc:v1:deadbeef:feedface:cafebabe"
      );
    } finally {
      db.close();
    }

    assert.throws(
      () => bootstrapEnv({ quiet: true }),
      /Refusing to auto-generate STORAGE_ENCRYPTION_KEY/
    );
  });
});

test("bootstrapEnv fails closed when existing database cannot be inspected", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    fs.mkdirSync(path.join(dataDir, "storage.sqlite"), { recursive: true });

    assert.throws(() => bootstrapEnv({ quiet: true }), /Unable to inspect existing database/);
  });
});

test("bootstrapEnv ignores blank process.env values that would override persisted secrets (#6824)", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });

    // Persisted secrets in server.env
    fs.writeFileSync(
      path.join(dataDir, "server.env"),
      "STORAGE_ENCRYPTION_KEY=persisted-key\nJWT_SECRET=persisted-jwt\n",
      "utf8"
    );

    // Simulate Docker `-e STORAGE_ENCRYPTION_KEY=` — sets an empty string
    process.env.STORAGE_ENCRYPTION_KEY = "";
    process.env.JWT_SECRET = "";

    const env = bootstrapEnv({ quiet: true });

    // Empty process.env values must NOT override persisted secrets
    assert.equal(env.STORAGE_ENCRYPTION_KEY, "persisted-key");
    assert.equal(env.JWT_SECRET, "persisted-jwt");
  });
});

test("bootstrapEnv ignores blank dataDirOverride values", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, ".env"), "JWT_SECRET=jwt-from-dot-env\n", "utf8");

    const env = bootstrapEnv({ dataDirOverride: "   ", quiet: true });

    assert.equal(env.JWT_SECRET, "jwt-from-dot-env");
  });
});

test("bootstrapEnv creates DATA_DIR/.env with the default CHANGEME password when no .env exists (#13679)", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });

    const env = bootstrapEnv({ quiet: true });

    const dotEnvPath = path.join(dataDir, ".env");
    assert.ok(fs.existsSync(dotEnvPath), "a .env must be created in DATA_DIR");
    const dotEnv = fs.readFileSync(dotEnvPath, "utf8");
    assert.ok(
      dotEnv.includes("INITIAL_PASSWORD=CHANGEME"),
      "created .env must carry the default INITIAL_PASSWORD=CHANGEME"
    );
    assert.equal(env.INITIAL_PASSWORD, "CHANGEME");
  });
});

test("bootstrapEnv respects an explicit CHANGEME INITIAL_PASSWORD and never randomizes it (#13679)", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    process.env.INITIAL_PASSWORD = "CHANGEME";
    fs.mkdirSync(dataDir, { recursive: true });

    const env = bootstrapEnv({ quiet: true });

    assert.equal(env.INITIAL_PASSWORD, "CHANGEME");
  });
});

test("bootstrapEnv keeps a strong operator-provided INITIAL_PASSWORD verbatim (#13679)", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    process.env.INITIAL_PASSWORD = "UmaSenhaBemForte123";
    fs.mkdirSync(dataDir, { recursive: true });

    const env = bootstrapEnv({ quiet: true });

    assert.equal(env.INITIAL_PASSWORD, "UmaSenhaBemForte123");
  });
});

test("bootstrapEnv rotates a stored CHANGEME hash to a strong supplied INITIAL_PASSWORD (#13679)", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    process.env.INITIAL_PASSWORD = "UmaSenhaBemForte123";
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "storage.sqlite");
    seedSettingsPassword(dbPath, "CHANGEME");

    const env = bootstrapEnv({ quiet: true });

    assert.equal(env.INITIAL_PASSWORD, "UmaSenhaBemForte123");
    const storedHash = readStoredPassword(dbPath);
    assert.ok(storedHash, "expected a stored password hash");
    assert.equal(bcrypt.compareSync("UmaSenhaBemForte123", storedHash), true);
    assert.equal(bcrypt.compareSync("CHANGEME", storedHash), false);
  });
});

test("bootstrapEnv syncs a previously-random stored hash to the .env INITIAL_PASSWORD (#13679)", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    process.env.INITIAL_PASSWORD = "UmaSenhaBemForte123";
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "storage.sqlite");
    seedSettingsPassword(dbPath, "randomOldPass456");

    const env = bootstrapEnv({ quiet: true });

    assert.equal(env.INITIAL_PASSWORD, "UmaSenhaBemForte123");
    const storedHash = readStoredPassword(dbPath);
    assert.equal(bcrypt.compareSync("UmaSenhaBemForte123", storedHash), true);
    assert.equal(bcrypt.compareSync("randomOldPass456", storedHash), false);
  });
});

test("bootstrapEnv leaves a stored strong hash untouched when no INITIAL_PASSWORD is supplied (#13679)", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "storage.sqlite");
    const originalHash = seedSettingsPassword(dbPath, "CredencialFortissima1");

    const env = bootstrapEnv({ quiet: true });

    assert.equal(env.INITIAL_PASSWORD, undefined);
    assert.equal(readStoredPassword(dbPath), originalHash);
  });
});

test("bootstrapEnv preserves the legacy ~/.omniroute dir over APPDATA when it exists (resolver parity)", () => {
  withTempEnv(({ tempHome }) => {
    // Make os.homedir() resolve under the temp root on every platform so the
    // legacy-dir check is deterministic and does not touch the real user home.
    process.env.USERPROFILE = tempHome;
    process.env.HOME = tempHome;
    const legacyDir = path.join(tempHome, ".omniroute");
    fs.mkdirSync(legacyDir, { recursive: true });
    // APPDATA points at a DIFFERENT dir — a resolver that ignores the legacy
    // dir (like the old win32 branch) would wrongly create the .env there.
    process.env.APPDATA = path.join(tempHome, "appdata");
    fs.mkdirSync(process.env.APPDATA, { recursive: true });

    const env = bootstrapEnv({ quiet: true });

    const expectedEnvPath = path.join(legacyDir, ".env");
    assert.ok(
      fs.existsSync(expectedEnvPath),
      `expected .env created in the legacy dir: ${expectedEnvPath}`
    );
    assert.equal(
      fs.existsSync(path.join(process.env.APPDATA, "omniroute", ".env")),
      false,
      "must NOT create .env under the APPDATA default when a legacy ~/.omniroute exists"
    );
    assert.equal(env.INITIAL_PASSWORD, "CHANGEME");
  });
});
