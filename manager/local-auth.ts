import { LocalStore, type StoredSession } from "./local-store.ts";
import { digestToken, hashPassword, verifyPassword, newToken, sessionCookie, LoginThrottle, DUMMY_PASSWORD_HASH } from "./local-security.ts";
import { keys, record, requireThat, equalHash } from "./validation.ts";

const SESSION_SECONDS=7*24*60*60;
function username(value:unknown):string { requireThat(typeof value === "string" && /^[\p{L}\p{N}_.@-]{1,64}$/u.test(value)); return value; }
export class LocalAuth {
  readonly #store:LocalStore; readonly secure:boolean;
  readonly bootstrapCsrf=newToken(); readonly #throttle=new LoginThrottle();
  readonly #loginStarts:number[]=[];
  #setupBusy=false;
  constructor(store:LocalStore,secure:boolean) { this.#store=store; this.secure=secure; }
  get setupRequired() { return !this.#store.account(); }
  authenticate(raw:string|undefined):StoredSession|undefined { return raw && /^[A-Za-z0-9_-]{43}$/.test(raw) ? this.#store.session(digestToken(raw)) : undefined; }
  revalidate(session:StoredSession) { requireThat(this.#store.session(session.hash),401); }
  state(session?:StoredSession) {
    return {authenticated:!!session,setupRequired:this.setupRequired,setupAllowed:!this.secure && this.setupRequired,
      csrfToken:session?.csrf ?? this.bootstrapCsrf,...(session ? {username:this.#store.account()!.username} : {})};
  }
  checkCsrf(supplied:string|undefined,session?:StoredSession) { requireThat(equalHash(supplied ?? "",session?.csrf ?? this.bootstrapCsrf),403); }
  #issue(version:number) {
    const token=newToken(),session={hash:digestToken(token),csrf:newToken(),expires:Date.now()+SESSION_SECONDS*1000,version};
    this.#store.addSession(session); return {token,session,cookie:sessionCookie(token,this.secure,SESSION_SECONDS)};
  }
  async setup(value:unknown) {
    requireThat(!this.secure && this.setupRequired,403); requireThat(!this.#setupBusy,409); this.#setupBusy=true;
    try { const body=record(value); keys(body,["username","password"]); const user=username(body.username);
      const hash=await hashPassword(body.password as string); this.#store.createAccount(user,hash); return this.#issue(this.#store.account()!.version);
    } finally { this.#setupBusy=false; }
  }
  async login(value:unknown,key:string) {
    // Proxy peers are shared by phone and desktop. Bound expensive admission,
    // but never apply an anonymous long-lived ban before checking a correct password.
    const now=Date.now();while(this.#loginStarts.length && this.#loginStarts[0]<=now-1000) this.#loginStarts.shift();
    requireThat(this.#loginStarts.length<8,429);this.#loginStarts.push(now);
    const body=record(value); keys(body,["username","password"]);
    requireThat(typeof body.username === "string" && body.username.length <= 256 && typeof body.password === "string" && Buffer.byteLength(body.password) <= 2048);
    const account=this.#store.account();
    // A dummy hash of the same cost makes unknown names no cheaper to probe.
    // The constant contains no usable password and is never accepted as an account.
    const verified=await verifyPassword(body.password,account?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!account || body.username !== account.username || !verified) { this.#throttle.failure(key); this.#store.audit("login-failed");this.#throttle.allow(key); requireThat(false,401); }
    requireThat(this.#store.account()?.version === account.version,401);
    this.#throttle.success(key); this.#store.audit("login-succeeded"); return this.#issue(account.version);
  }
  async change(session:StoredSession,value:unknown) {
    this.revalidate(session); this.#throttle.allow("password-change");
    const body=record(value); keys(body,["currentPassword","username","password"]);
    requireThat(typeof body.currentPassword === "string" && Buffer.byteLength(body.currentPassword)<=2048);
    const account=this.#store.account()!;
    if (!await verifyPassword(body.currentPassword,account.passwordHash)) { this.#throttle.failure("password-change"); requireThat(false,401); }
    const user=username(body.username),hash=await hashPassword(body.password as string);
    this.revalidate(session); this.#store.changeAccount(user,hash,account.version); this.#throttle.success("password-change");
  }
  logout(session:StoredSession,all=false) { this.revalidate(session); this.#store.revoke(all ? undefined : session.hash); this.#store.audit(all ? "logout-all" : "logout"); }
  clearCookie() { return sessionCookie("",this.secure,0); }
}
