import { DatabaseSync } from "node:sqlite";
import { chmod, copyFile, lstat, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { privateDirectory } from "./config.ts";
import { requireThat } from "./validation.ts";
import type { WorkspaceSelection } from "./api.ts";

export interface StoredRun {
  id:string; key:string; workspace:WorkspaceSelection; state:"starting"|"ready"|"failed"|"stopping"|"stopped"|"unknown";
  created:number; path?:string; error?:string; runId?:string; pid?:number; containerId?:string;
}
export interface StoredAccount { username:string; passwordHash:string; version:number }
export interface StoredSession { hash:string; csrf:string; expires:number; version:number }
const states = ["starting","ready","failed","stopping","stopped","unknown"];
function validateRuns(value:unknown):asserts value is StoredRun[] {
  requireThat(Array.isArray(value) && value.length <= 1000);
  const ids = new Set(), keys = new Set();
  for (const run of value) {
    requireThat(run && /^pi-local-[a-f0-9]{24}$/.test(run.id) && !ids.has(run.id) &&
      typeof run.key === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(run.key) && !keys.has(run.key) &&
      states.includes(run.state) && Number.isSafeInteger(run.created) && run.created >= 0 &&
      run.workspace && typeof run.workspace.root === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(run.workspace.root) &&
      typeof run.workspace.path === "string" && !/[\\\u0000-\u001f\u007f]/.test(run.workspace.path) &&
      (run.workspace.path === "" || run.workspace.path.split("/").every((s:string) => s !== "" && s !== "." && s !== "..")) &&
      (run.pid === undefined || Number.isSafeInteger(run.pid) && run.pid > 0) &&
      (run.runId === undefined || /^[a-f0-9]{32}$/.test(run.runId)) &&
      (run.containerId === undefined || /^[a-f0-9]{64}$/.test(run.containerId)) &&
      (run.path === undefined || typeof run.path === "string" && /^\/s\/[A-Za-z0-9._~-]+\/$/.test(run.path)) &&
      (run.error === undefined || typeof run.error === "string" && run.error.length <= 2048));
    ids.add(run.id); keys.add(run.key);
  }
}

/** Small single-owner metadata database. Never stores conversations or model credentials. */
export class LocalStore {
  readonly #db:DatabaseSync;
  private constructor(db:DatabaseSync) { this.#db = db; }
  static async open(root:string) {
    await privateDirectory(root);
    const file = path.join(root,"manager.sqlite3");
    try { const info = await lstat(file); requireThat(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.()); }
    catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const db = new DatabaseSync(file);
    const store = new LocalStore(db);
    try {
      await chmod(file,0o600);
      db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;");
      const version = (db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version;
      requireThat(version <= 1,503);
      db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS account(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,passwordHash TEXT NOT NULL,version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL,version INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,event TEXT NOT NULL);
        PRAGMA user_version=1;`);
      if (!db.prepare("SELECT 1 FROM meta WHERE key='runs-imported'").get()) {
        let rows:StoredRun[] = [];
        const source = path.join(root,"runs.json");
        try {
          const info = await lstat(source); requireThat(info.isFile() && !info.isSymbolicLink() && info.size <= 4*1024*1024);
          rows = JSON.parse(await readFile(source,"utf8")); validateRuns(rows);
          const backup = source + ".pre-sqlite.bak";
          try { await copyFile(source,backup,constants.COPYFILE_EXCL); }
          catch(error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const info = await lstat(backup); requireThat(info.isFile() && !info.isSymbolicLink());
            requireThat(await readFile(backup,"utf8") === await readFile(source,"utf8")); }
          await chmod(backup,0o600);
        } catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        store.#transaction(()=> { store.#writeRuns(rows); db.prepare("INSERT INTO meta VALUES('runs-imported','1')").run(); });
      }
      store.cleanup(); return store;
    } catch(error) { db.close(); throw error; }
  }
  #transaction<T>(fn:()=>T):T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result=fn(); this.#db.exec("COMMIT"); return result; } catch(error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  #writeRuns(rows:StoredRun[]) { this.#db.exec("DELETE FROM runs"); const put=this.#db.prepare("INSERT INTO runs VALUES(?,?)"); for (const row of rows) put.run(row.id,JSON.stringify(row)); }
  runs():StoredRun[] { const rows=this.#db.prepare("SELECT body FROM runs ORDER BY rowid").all().map(row=>JSON.parse(row.body as string)); validateRuns(rows); return rows; }
  saveRuns(rows:StoredRun[]) { validateRuns(rows); this.#transaction(()=>this.#writeRuns(rows)); }
  account():StoredAccount|undefined { return this.#db.prepare("SELECT username,passwordHash,version FROM account WHERE id=1").get() as StoredAccount|undefined; }
  createAccount(username:string,passwordHash:string) { this.#transaction(()=> { requireThat(!this.account(),409); this.#db.prepare("INSERT INTO account VALUES(1,?,?,1)").run(username,passwordHash); this.audit("account-created"); }); }
  changeAccount(username:string,passwordHash:string,version:number) {
    this.#transaction(()=> { const result=this.#db.prepare("UPDATE account SET username=?,passwordHash=?,version=version+1 WHERE id=1 AND version=?").run(username,passwordHash,version);
      requireThat(result.changes === 1,409); this.#db.exec("DELETE FROM sessions"); this.audit("password-changed"); });
  }
  addSession(session:StoredSession) {
    this.#transaction(()=> { requireThat(this.account()?.version === session.version,401); this.cleanup();
      this.#db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(session.hash,session.csrf,session.expires,session.version);
      this.#db.exec("DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions ORDER BY expires DESC LIMIT -1 OFFSET 64)"); });
  }
  session(hash:string):StoredSession|undefined {
    return this.#db.prepare("SELECT sessions.* FROM sessions JOIN account ON account.id=1 AND sessions.version=account.version WHERE hash=? AND expires>?").get(hash,Date.now()) as StoredSession|undefined;
  }
  revoke(hash?:string) { if (hash) this.#db.prepare("DELETE FROM sessions WHERE hash=?").run(hash); else this.#db.exec("DELETE FROM sessions"); }
  preference(key:string,value?:unknown):unknown {
    if (value !== undefined) { this.#db.prepare("INSERT INTO preferences VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(key,JSON.stringify(value)); return value; }
    const row = this.#db.prepare("SELECT body FROM preferences WHERE key=?").get(key); return row ? JSON.parse(row.body as string) : undefined;
  }
  audit(event:string) { requireThat(/^[a-z-]{1,48}$/.test(event)); this.#db.prepare("INSERT INTO audit(at,event) VALUES(?,?)").run(Date.now(),event); this.#db.exec("DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 1000)"); }
  cleanup() { this.#db.prepare("DELETE FROM sessions WHERE expires<=?").run(Date.now()); }
  close() { this.#db.close(); }
}
