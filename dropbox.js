// Dropbox: Anmeldung mit OAuth PKCE (ohne Geheimschlüssel) und Datei-Upload direkt aus dem Browser.
// Zugangsdaten bleiben nur im Speicher dieses Browsers (localStorage).
import { CONFIG } from './config.js';

const K_KEY = 'fmrs_scanner_appkey';
const K_TOK = 'fmrs_scanner_dropbox';
const K_PKCE = 'fmrs_scanner_pkce';
const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const UPLOAD_URL = 'https://content.dropboxapi.com/2/files/upload';
const SCOPES = 'files.content.write files.metadata.read';

export class AuthError extends Error {}

export function appKey() { return (localStorage.getItem(K_KEY) || CONFIG.DROPBOX_APP_KEY || '').trim(); }
export function setAppKey(k) { if (k) localStorage.setItem(K_KEY, k.trim()); else localStorage.removeItem(K_KEY); }
export function redirectUri() {
  return CONFIG.REDIRECT_URI || (location.origin + location.pathname.replace(/index\.html$/, ''));
}
function loadTok() { try { return JSON.parse(localStorage.getItem(K_TOK) || 'null'); } catch { return null; } }
function saveTok(t) { localStorage.setItem(K_TOK, JSON.stringify(t)); }
export function isConnected() { const t = loadTok(); return !!(t && t.refresh_token); }
export function account() { const t = loadTok(); return t && t.account_id ? t.account_id : null; }
export function disconnect() {
  const t = loadTok();
  localStorage.removeItem(K_TOK);
  if (t && t.access_token) fetch('https://api.dropboxapi.com/2/auth/token/revoke', { method: 'POST', headers: { Authorization: 'Bearer ' + t.access_token } }).catch(() => {});
}

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function pkcePair() {
  const v = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const c = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
  return { verifier: v, challenge: c };
}

// Variante 1: Weiterleitung zu Dropbox und zurück (Normalfall)
export async function startLogin() {
  const key = appKey();
  if (!key) throw new AuthError('Kein App-Schlüssel eingetragen');
  const { verifier, challenge } = await pkcePair();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  localStorage.setItem(K_PKCE, JSON.stringify({ verifier, state, redirect: redirectUri() }));
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: key, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
    redirect_uri: redirectUri(), token_access_type: 'offline', scope: SCOPES, state,
  });
  location.assign(u.toString());
}

// Variante 2: Code abtippen/einfügen (falls die Weiterleitung auf dem iPhone nicht zurückkommt)
export async function manualLoginUrl() {
  const key = appKey();
  if (!key) throw new AuthError('Kein App-Schlüssel eingetragen');
  const { verifier, challenge } = await pkcePair();
  localStorage.setItem(K_PKCE, JSON.stringify({ verifier, state: null, redirect: null }));
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: key, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
    token_access_type: 'offline', scope: SCOPES,
  });
  return u.toString();
}

async function tokenRequest(params) {
  let r;
  try {
    r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  } catch (e) { throw new Error('Kein Netz'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 400 || r.status === 401) throw new AuthError(j.error_description || j.error || 'Anmeldung abgelehnt');
    throw new Error('Dropbox Fehler ' + r.status);
  }
  return j;
}
function storeToken(j, old) {
  saveTok({
    access_token: j.access_token,
    refresh_token: j.refresh_token || (old && old.refresh_token),
    expires_at: Date.now() + (j.expires_in || 14400) * 1000,
    account_id: j.account_id || (old && old.account_id) || null,
  });
}

export async function exchangeCode(code, fromRedirect) {
  const p = JSON.parse(localStorage.getItem(K_PKCE) || 'null');
  if (!p) throw new AuthError('Anmeldung bitte neu starten');
  const params = { code: code.trim(), grant_type: 'authorization_code', code_verifier: p.verifier, client_id: appKey() };
  if (fromRedirect && p.redirect) params.redirect_uri = p.redirect;
  const j = await tokenRequest(params);
  localStorage.removeItem(K_PKCE);
  storeToken(j, null);
}

// Beim Start aufrufen: kommt die Seite gerade von Dropbox zurück?
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return null;
  const clean = () => history.replaceState(null, '', location.pathname);
  if (q.has('error')) { clean(); return { ok: false, msg: q.get('error_description') || 'Abgebrochen' }; }
  const p = JSON.parse(localStorage.getItem(K_PKCE) || 'null');
  if (!p || p.state !== q.get('state')) { clean(); return { ok: false, msg: 'Anmeldung bitte neu starten' }; }
  try { await exchangeCode(q.get('code'), true); clean(); return { ok: true }; }
  catch (e) { clean(); return { ok: false, msg: e.message }; }
}

async function accessToken(force) {
  const t = loadTok();
  if (!t || !t.refresh_token) throw new AuthError('Dropbox nicht verbunden');
  if (!force && t.access_token && t.expires_at > Date.now() + 60000) return t.access_token;
  const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: appKey() });
  storeToken(j, t);
  return j.access_token;
}

// Dropbox-API-Arg muss reines ASCII sein
const apiArg = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

export async function upload(path, blob) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await accessToken(attempt > 0);
    let r;
    try {
      r = await fetch(UPLOAD_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + tok,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': apiArg({ path, mode: 'add', autorename: true, mute: false }),
        },
        body: blob,
      });
    } catch (e) { throw new Error('Kein Netz'); }
    if (r.status === 401 && attempt === 0) continue;
    if (r.status === 401) throw new AuthError('Dropbox Anmeldung abgelaufen');
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error('Dropbox Fehler ' + r.status + (t ? ': ' + t.slice(0, 120) : ''));
    }
    return r.json();
  }
}
