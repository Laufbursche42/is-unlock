'use strict';
// Laufbursche iScooter Tool - a Web Bluetooth client for the loby/MiniRobot BLE protocol family.
// Shell (header, footer, i18n, theme, doc viewer, anonymized log) matches the Laufbursche tool family;
// the BLE protocol is the proven iScooter frame engine. The pre-commit cache-buster auto-bumps BUILD
// and every ?v= in index.html on any web-asset change.
const BUILD = 'isu-v3';

// =====================================================================================
// iScooter BLE protocol (ground truth - do not reinvent)
// =====================================================================================

// --------------------------- BLE transports (5 GATT profiles) ---------------------------
const TRANSPORTS = [
  { id:1, name:'Nordic UART', service:'6e400001-b5a3-f393-e0a9-e50e24dcca9e', write:'6e400002-b5a3-f393-e0a9-e50e24dcca9e', notify:'6e400003-b5a3-f393-e0a9-e50e24dcca9e' },
  { id:2, name:'ae00',        service:'0000ae00-0000-1000-8000-00805f9b34fb', write:'0000ae01-0000-1000-8000-00805f9b34fb', notify:'0000ae02-0000-1000-8000-00805f9b34fb' },
  { id:3, name:'ffe0/fff4',   service:'0000ffe0-0000-1000-8000-00805f9b34fb', write:'0000fff3-0000-1000-8000-00805f9b34fb', notify:'0000fff4-0000-1000-8000-00805f9b34fb' },
  { id:5, name:'fff0/fff1',   service:'0000fff0-0000-1000-8000-00805f9b34fb', write:'0000fff2-0000-1000-8000-00805f9b34fb', notify:'0000fff1-0000-1000-8000-00805f9b34fb' },
  { id:4, name:'fff0/fff7',   service:'0000fff0-0000-1000-8000-00805f9b34fb', write:'0000fff3-0000-1000-8000-00805f9b34fb', notify:'0000fff7-0000-1000-8000-00805f9b34fb' },
];
const ALL_SERVICES = [...new Set(TRANSPORTS.map(t=>t.service))];

// Advertised-name prefixes the app accepts during scan.
const SCAN_PREFIXES = ['M0','H1','M1','Mini','Plus','X1','X3','M6','GoKart','A6','MI','N3MTenbot',
  'miniPLUS_','MiniPro','SFSO','V5Robot','EO STREET','XRIDER','TECAR','MAX','i10','NEXRIDE',
  'E-WHEELS','E12','E9PRO','T10','KING','oP9G','Mentor','E9G','XT-','SPARK','EROBOT'];

// --------------------------- register map ---------------------------
// Write command: CMD 0x20 SUB 0x03. Read command: CMD 0x06 SUB 0x01. Values are 16-bit little-endian.
// Speed setters use value = kmh * mul + add.
const SPEED_TARGETS = [
  { reg:0x7d, mul:1000, add:2000,  label:'MaxSpeed (0x7d)' },
  { reg:0x73, mul:1000, add:10000, label:'Normal mode (0x73)' },
  { reg:0x74, mul:1000, add:4000,  label:'Train/Limit mode (0x74)' },
  { reg:0xf3, mul:1000, add:5000,  label:'LimitSpeed3 / Cruise (0xf3)' },
  { reg:0xf1, mul:1,    add:0,     label:'LimitSpeed2 (0xf1, direct)' },
];
// Register 0xd3 is a bitfield of light/switch flags.
const D3 = 0xd3;
const D3_BITS = { headlight:0x01, brakelight:0x02, lockShutDown:0x04, lockWarn:0x08, hub:0x20, ambient:0x80 };
const REG_LOCK = 0xf6;          // electronic lock: 1 = lock, 0 = unlock
const REG_HEADLIGHT_T3 = 0xf2;  // headlight on transport profile 3
const REG_LIMIT_ENABLE = 0x72;  // cruise/limit mode on/off: 1 = on, 0 = off
const REG_KICKSTART = 0x7e;     // zero-start candidate register
const REG_LIGHTMODE = 0xf4;     // light mode / brightness index (SwitchLightMode)
// Proven main-bank poll cycle (getMainPageNewDate4): four SendReadCmdWithAddr2 blocks on the main
// dashboard bank. The BLE/TK-bank reads the app also issues are omitted on purpose - this page keeps a
// single flat register map, so a BLE/TK-bank read would overwrite overlapping main-bank registers;
// those banks stay gated.
const POLL_BLOCKS = [
  { addr:0x1a, count:0x34 },  // 26..77:   speed/batt/volt/curr/trip/total/error/ride-time
  { addr:0x6c, count:0x34 },  // 108..159: extended dashboard registers
  { addr:0xc2, count:0x2c },  // 194..237: flags bank incl. the 0xd3 light bitfield (211)
  { addr:0xea, count:0x20 },  // 234..265: setting read-back (speed-limit / lock registers)
];
const POLL_MS = 2000;
// Telemetry registers (RefreshInfo4 dual-battery dashboard, the most complete variant). Speed and
// voltage use the re-disassembled /100 divisor (float 0x42c80000 = 100.0f); max speed and ride time
// are 32-bit quantities spread over two consecutive registers (low, high).
const TELE = {
  speed:{reg:39, div:100}, speedFallback:{reg:38, div:1000}, batt:{reg:34, div:1},
  volt:{reg:74, div:100}, curr:{reg:76, div:10},
  trip:{reg:37, div:10}, totalLo:{reg:41}, totalHi:{reg:42},
  maxLo:{reg:191}, maxHi:{reg:192}, rideLo:{reg:50}, rideHi:{reg:51},
  err:{reg:27}, lock:{reg:178}, fw:{reg:21},
};

// --------------------------- frame engine ---------------------------
// Checksum = one's complement of the 16-bit byte sum, starting at the given offset.
function checksum16(bytes, from){
  let s=0; for(let i=from;i<bytes.length;i++) s=(s+bytes[i])&0xffff;
  return (~s)&0xffff;
}
// Frame layout: 55 AA <LEN> <CMD> <SUB> <REG> <payload...> <CK_LO> <CK_HI>. LEN = payload + 2.
function buildFrame(cmd, sub, reg, payload){
  payload = payload || [];
  const f = [0x55, 0xAA, payload.length + 2, cmd, sub, reg, ...payload];
  const ck = checksum16(f, 2);
  f.push(ck & 0xff, (ck >> 8) & 0xff);
  return f;
}
// Optional whole-frame single-byte XOR obfuscation (0 = none).
function applyXor(frame, key){ return key ? frame.map(b => b ^ key) : frame; }
function reg16LE(v){ v &= 0xffff; return [v & 0xff, (v >> 8) & 0xff]; }
function hex(bytes){ return bytes.map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join(' '); }

// Load-time protocol self-test: the builder must reproduce a known-good device frame, and every
// built frame must pass the frame validator/checksum. Not a tautology - a real builder<->vector check.
const FRAME_OK = (function(){
  const eq = (a, b) => a.length === b.length && a.every((v, i) => (v & 0xff) === (b[i] & 0xff));
  // Known-vector: the proven byte-exact version/handshake frame TestSendMsg
  // (decompiled app, decomp.c:3113-3136): 55 AA 02 FF 01 03 FA FE.
  const kv = eq(buildFrame(0xFF, 0x01, 0x03, []), [0x55, 0xAA, 0x02, 0xFF, 0x01, 0x03, 0xFA, 0xFE]);
  // Round-trip: a representative write (SendWriteCmd_HB, CMD 0x20 SUB 0x03) and the poll read
  // (SendReadCmdWithAddr, CMD 0x06 SUB 0x01) must pass frameLenAt (same checksum the device verifies).
  const wr = buildFrame(0x20, 0x03, 0x7d, reg16LE(27000));
  const rd = buildFrame(0x06, 0x01, POLL_BLOCKS[0].addr, [POLL_BLOCKS[0].count & 0xff]);
  const rt = frameLenAt(wr, 0, 0) === wr.length && frameLenAt(rd, 0, 0) === rd.length;
  return kv && rt;
})();

// --------------------------- helpers ---------------------------
const $ = (id) => document.getElementById(id);
const short = (u) => String(u).slice(0, 8).toUpperCase();
const LS = { THEME: 'isu_theme', LANG: 'isu_lang', PUBLOG: 'isu_publiclog' };

// =====================================================================================
// i18n
// =====================================================================================
let lang = 'de';
function table() { return (window.I18N && window.I18N[lang]) || {}; }
function t(key) { const v = table()[key]; return (typeof v === 'string') ? v : ''; }
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(n => {
    const v = t(n.getAttribute('data-t'));
    if (/[<&]/.test(v)) n.innerHTML = v; else n.textContent = v;   // scan-ok: our own translation table
  });
  { const el = $('link-guide'); if (el) el.href = docFile('GUIDE'); }
  { const el = $('link-readme'); if (el) el.href = docFile('README'); }
  { const el = $('link-license'); if (el) el.href = docFile('LICENSE'); }
  { const el = $('link-privacy'); if (el) el.href = docFile('PRIVACY'); }
  { const el = $('link-trademarks'); if (el) el.href = docFile('TRADEMARKS'); }
  { const el = $('langs'); if (el) el.setAttribute('aria-label', t('langGroup')); }
  { const el = $('build-ver'); if (el) el.textContent = t('buildLabel') + ' ' + BUILD; }
  { const el = $('enc-state'); if (el) el.textContent = t('encNone'); }
  document.querySelectorAll('#langs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  fillSpeedTargets();
  { const el = $('status'); setStatus(el ? el.dataset.state : 'disconnected'); }
  refreshTele();
  { const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    const el = $('btn-theme'); if (el) { el.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); el.title = el.getAttribute('aria-label'); } }
}
function initLangSwitch() {
  let saved = null; try { saved = localStorage.getItem(LS.LANG); } catch (e) {}
  if (saved === 'de' || saved === 'en') lang = saved;
  document.querySelectorAll('#langs button').forEach(b => b.addEventListener('click', () => {
    lang = b.dataset.lang; try { localStorage.setItem(LS.LANG, lang); } catch (e) {} applyLang();
  }));
}

// =====================================================================================
// theme
// =====================================================================================
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const b = $('btn-theme');
  if (b) { b.textContent = dark ? '\u2600' : '\u263E'; b.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); b.title = b.getAttribute('aria-label'); }
  try { localStorage.setItem(LS.THEME, dark ? 'dark' : 'light'); } catch (e) {}
}
function initTheme() {
  let saved = null; try { saved = localStorage.getItem(LS.THEME); } catch (e) {}
  applyTheme(saved !== 'light');
  const b = $('btn-theme');
  if (b) b.addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'light'));
}

// =====================================================================================
// log (anonymized on the way out; the buffer keeps raw text with \x01..\x01 sensitive spans)
// =====================================================================================
let logBuffer = [];    // { raw, cls }
let publicLog = true;  // anonymize the log (default on)
let diag = false;      // verbose diagnostic logging (default off)
function redact(text) {
  let s = String(text);
  if (device && device.id) s = s.split(device.id).join('[redacted-id]');
  s = s.replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, '[redacted-mac]');   // MAC
  s = s.replace(/\b(secret|token|key|aes|pwd|password|pin|mac|serial|vin|uid|imei)\b(\s*[:=]\s*)("?)([^\s",]+)\3/gi,
    (m, k, sep) => k + sep + '[redacted]');
  s = s.replace(/\b[0-9A-Fa-f]{16,}\b/g, '[redacted-hex]');   // long hex runs (ids/serials/keys)
  return s;
}
function anonymize(s) {
  if (!publicLog) return String(s).replace(/\x01/g, '');
  return redact(String(s).replace(/\x01[^\x01]*\x01/g, 'XX').replace(/\x01/g, ''));
}
function logLine(cls, text) {
  const safe = '[' + new Date().toTimeString().slice(0, 8) + '] ' + text;
  logBuffer.push({ raw: safe, cls: cls });
  const el = $('log'); if (!el) return;
  const span = document.createElement('span');
  if (cls) span.className = cls; span.textContent = anonymize(safe) + '\n';
  el.appendChild(span); el.scrollTop = el.scrollHeight;
}
function renderLog() {
  const el = $('log'); if (!el) return;
  el.textContent = '';
  for (const e of logBuffer) { const span = document.createElement('span'); if (e.cls) span.className = e.cls; span.textContent = anonymize(e.raw) + '\n'; el.appendChild(span); }
  el.scrollTop = el.scrollHeight;
}
function logText() { return logBuffer.map(e => anonymize(e.raw)).join('\n'); }
function saveLog() {
  try {
    const blob = new Blob([logText()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'laufbursche42-iscooter-log.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logSys('log saved');
  } catch (e) { logErr('save failed: ' + (e && e.message ? e.message : e)); }
}
const logTx = (b) => logLine('log-tx', '>>> ' + hex(b));
const logRx = (b) => logLine('log-rx', '<<< ' + hex(b));
const logSys = (t) => logLine('', '--- ' + t);
const logErr = (t) => logLine('log-err', '!!! ' + t);
const logDiag = (t) => { if (diag) logLine('', '... ' + t); };
function logDiagnosticHeader() {
  logLine('', '=== is-unlock diagnostic ===');
  logLine('', 'build: ' + BUILD);
  logLine('', 'time: ' + new Date().toISOString());
  logLine('', 'userAgent: ' + (navigator.userAgent || '?'));
  logLine('', 'platform: ' + (navigator.platform || '?'));
  logLine('', 'webBluetooth: ' + (navigator.bluetooth ? 'yes' : 'no'));
  logLine('', 'protocol self-test: ' + (FRAME_OK ? 'OK' : 'FAILED'));
  logLine('', '================================');
  if (!FRAME_OK) logErr('protocol self-test FAILED - frame builder/validator mismatch');
}

// =====================================================================================
// BLE state
// =====================================================================================
let device=null, server=null, writeChar=null, notifyChar=null, transport=null;
let connected=false, pollTimer=null;
const regBank = {};   // received registers: absolute number -> 16-bit value

function xorKey(){ return parseInt($('xor-mode').value) || 0; }

async function sendFrame(frame){
  if(!writeChar){ logErr('not connected'); return; }
  const out = applyXor(frame, xorKey());
  const buf = Uint8Array.from(out);
  try{
    if(writeChar.writeValueWithoutResponse) await writeChar.writeValueWithoutResponse(buf);
    else await writeChar.writeValue(buf);
    logTx(out);
  }catch(e){ logErr('TX error: ' + (e && e.message ? e.message : e)); }
}
function writeReg(reg, value){ return sendFrame(buildFrame(0x20, 0x03, reg, reg16LE(value))); }
function readReg(addr, count){ return sendFrame(buildFrame(0x06, 0x01, addr, [count & 0xff])); }
function writeRegNamed(name, reg, val){ writeReg(reg, val); logSys(`${name}: reg 0x${reg.toString(16)} = ${val}`); }

// --------------------------- receive / telemetry ---------------------------
function onNotify(ev){
  const v = new Uint8Array(ev.target.value.buffer);
  let b = Array.from(v);
  const key = xorKey();
  if(key) b = b.map(x => x ^ key);
  if(b.length < 6 || b[0] !== 0x55 || b[1] !== 0xAA){ logRx(Array.from(v)); return; }
  logRx(b);
  const len = b[2], startReg = b[5], payLen = Math.max(0, len - 2);
  for(let i=0; i+1<payLen; i+=2) regBank[startReg + (i/2)] = b[6+i] | (b[6+i+1] << 8);
  refreshTele();
}
function te(sel){ const c=TELE[sel]; const raw=regBank[c.reg]; return raw===undefined ? null : (c.div ? raw/c.div : raw); }
// Each tile carries a presence test and a formatter. A tile is added to the grid only once its value
// first arrives, so the scooter reveals exactly the fields it reports.
const TILES = [
  { id:'t-speed', key:'tSpeed', seen:()=>regBank[TELE.speed.reg]!==undefined,
    val:()=>{ const r=regBank[TELE.speed.reg];
      const v = (r!==0) ? r/TELE.speed.div
        : (regBank[TELE.speedFallback.reg]!==undefined ? regBank[TELE.speedFallback.reg]/TELE.speedFallback.div : 0);
      return v.toFixed(1)+' km/h'; } },
  { id:'t-batt',  key:'tBatt',  seen:()=>te('batt')!=null,         val:()=>te('batt')+' %' },
  { id:'t-volt',  key:'tVolt',  seen:()=>te('volt')!=null,         val:()=>te('volt').toFixed(1)+' V' },
  { id:'t-curr',  key:'tCurr',  seen:()=>te('curr')!=null,         val:()=>te('curr').toFixed(1)+' A' },
  { id:'t-trip',  key:'tTrip',  seen:()=>te('trip')!=null,         val:()=>te('trip').toFixed(1)+' km' },
  { id:'t-total', key:'tTotal', seen:()=>regBank[TELE.totalLo.reg]!==undefined,
    val:()=>(((regBank[TELE.totalHi.reg]||0)*65536+regBank[TELE.totalLo.reg])/10).toFixed(1)+' km' },
  { id:'t-max',   key:'tMax',   seen:()=>regBank[TELE.maxLo.reg]!==undefined,
    val:()=>(((regBank[TELE.maxHi.reg]||0)*65536+regBank[TELE.maxLo.reg])/1000).toFixed(1)+' km/h' },
  { id:'t-ride',  key:'tRide',  seen:()=>regBank[TELE.rideLo.reg]!==undefined,
    val:()=>{ const s=(regBank[TELE.rideHi.reg]||0)*65536+regBank[TELE.rideLo.reg];
      return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m '+(s%60)+'s'; } },
  { id:'t-lock',  key:'tLock',  seen:()=>regBank[TELE.lock.reg]!==undefined,
    val:()=>regBank[TELE.lock.reg] ? t('valLocked') : t('valUnlocked') },
  { id:'t-err',   key:'tErr',   seen:()=>regBank[TELE.err.reg]!==undefined,
    val:()=>{ const e=regBank[TELE.err.reg]; return e ? String(e) : '0'; } },
  { id:'t-fw',    key:'tFw',    seen:()=>regBank[TELE.fw.reg]!==undefined,
    val:()=>'0x'+regBank[TELE.fw.reg].toString(16) },
];
const liveSeen = {};
function ensureTile(def) {
  if ($(def.id + '-tile')) return;
  const grid = $('tiles'); if (!grid) return;
  const tile = document.createElement('div'); tile.className = 'tile'; tile.id = def.id + '-tile';
  const b = document.createElement('b'); b.id = def.id; b.textContent = '-';
  const small = document.createElement('small'); small.setAttribute('data-t', def.key); small.textContent = t(def.key);
  tile.appendChild(b); tile.appendChild(small); grid.appendChild(tile);
}
function refreshTele(){
  let any = false;
  for (const def of TILES) {
    if (def.seen()) { liveSeen[def.id] = true; ensureTile(def); const el = $(def.id); if (el) el.textContent = def.val(); }
    if (liveSeen[def.id]) any = true;
  }
  const empty = $('tiles-empty'); if (empty) empty.hidden = any;
}
function resetTiles(){
  for (const k of Object.keys(liveSeen)) delete liveSeen[k];
  for (const k of Object.keys(regBank)) delete regBank[k];
  const grid = $('tiles'); if (grid) grid.textContent = '';
  const empty = $('tiles-empty'); if (empty) empty.hidden = false;
}

// =====================================================================================
// connect / reveal
// =====================================================================================
async function connect(){
  if(connected){ await disconnect(); return; }
  if(!navigator.bluetooth){ logErr('Web Bluetooth not available (needs Chrome, Edge or Bluefy)'); return; }
  try{
    setStatus('connecting');
    const filters = SCAN_PREFIXES.map(p => ({ namePrefix: p }));
    device = await navigator.bluetooth.requestDevice({ filters, optionalServices: ALL_SERVICES });
    device.addEventListener('gattserverdisconnected', onDisc);
    logSys('device: \x01' + (device.name || '(no name)') + '\x01');
    setStatus('linking');
    server = await device.gatt.connect();
    transport = null;
    for(const tr of TRANSPORTS){
      try{
        const svc = await server.getPrimaryService(tr.service);
        const w = await svc.getCharacteristic(tr.write).catch(()=>null);
        const n = await svc.getCharacteristic(tr.notify).catch(()=>null);
        if(w && n){ transport=tr; writeChar=w; notifyChar=n; break; }
      }catch(e){ /* try next profile */ }
    }
    if(!transport){ logErr('no matching GATT profile found'); setStatus('no-service'); await disconnect(); return; }
    logDiag('profile ' + transport.id + ' (' + transport.name + ')');
    await notifyChar.startNotifications();
    notifyChar.addEventListener('characteristicvaluechanged', onNotify);
    connected = true;
    setStatus('connected');
    revealInteractive(true);
    setControlsEnabled(true);
    { const el = $('devinfo'); if (el) el.textContent = t('devPrefix') + ' ' + ((publicLog && device.name) ? 'XX' : (device.name || '')) + '  -  profile ' + transport.id; }
    logSys('connected, profile ' + transport.id);
    startPoll();
  }catch(e){ logErr('connect aborted: ' + (e && e.message ? e.message : e)); setStatus('disconnected'); }
}
function pollAll(){ for(const blk of POLL_BLOCKS) readReg(blk.addr, blk.count); }
function startPoll(){ stopPoll(); pollAll();
  pollTimer = setInterval(()=>{ if(connected) pollAll(); }, POLL_MS); }
function stopPoll(){ if(pollTimer){ clearInterval(pollTimer); pollTimer=null; } }
async function disconnect(){ stopPoll(); try{ if(device && device.gatt.connected) device.gatt.disconnect(); }catch(e){} onDisc(); }
function onDisc(){ connected=false; writeChar=null; notifyChar=null; transport=null;
  setStatus('disconnected'); setControlsEnabled(false); revealInteractive(false); resetTiles();
  const el = $('devinfo'); if (el) el.textContent = ''; logSys('disconnected'); }

function revealInteractive(on){ ['live-card','batt-card','more-card','raw-card'].forEach(id => { const el = $(id); if (el) el.hidden = !on; }); }
const CONTROL_IDS = ['btn-setspeed','btn-cruise-on','btn-cruise-off','btn-kick-on','btn-kick-off',
  'btn-lock','btn-unlock','btn-light-on','btn-light-off',
  'btn-brake-on','btn-brake-off','btn-hub-on','btn-hub-off','btn-amb-on','btn-amb-off',
  'btn-alarm-on','btn-alarm-off','btn-lsd-on','btn-lsd-off',
  'btn-writereg','btn-readreg','btn-raw','btn-raw-plain','btn-lightmode','btn-version'];
function setControlsEnabled(on){ CONTROL_IDS.forEach(id => { const e = $(id); if (e) e.disabled = !on; }); }

// --------------------------- status ---------------------------
function statusLabel(s){
  const map = { disconnected:'stDisconnected', connecting:'stConnecting', linking:'stLinking',
    connected:'stConnected', 'no-service':'stNoService', 'no-char':'stNoChar' };
  return t(map[s] || 'stDisconnected') || s;
}
function setStatus(s){
  const el = $('status'); if (el) { el.dataset.state = s; el.textContent = statusLabel(s); }
  const cb = $('btn-conn');
  if (cb) { const on = (s === 'connecting' || s === 'linking' || s === 'connected'); cb.textContent = on ? t('btnDisconnect') : t('btnConnect'); }
}

// =====================================================================================
// control wiring
// =====================================================================================
function makeOption(value, label){ const o=document.createElement('option'); o.value=value; o.textContent=label; return o; }
function fillSpeedTargets(){
  const st=$('speed-target'); if(!st) return; const prev = st.value;
  st.textContent=''; SPEED_TARGETS.forEach(s=> st.appendChild(makeOption(s.reg, s.label)));
  if (prev) st.value = prev;
}
// Read-modify-write one bit of the 0xd3 light bitfield via the local mirror.
function d3set(bit, on, name){
  let cur = regBank[D3] || 0;
  cur = on ? (cur | bit) : (cur & ~bit & 0xffff);
  regBank[D3] = cur;
  writeReg(D3, cur);
  logSys(`${name}: 0xd3 bit 0x${bit.toString(16)} -> ${on?'on':'off'} (0x${cur.toString(16)})`);
}
function parseHex(s){ return (s.match(/[0-9a-fA-F]{2}/g) || []).map(h=>parseInt(h,16)); }
function wire(){
  $('btn-conn').addEventListener('click', connect);

  $('btn-setspeed').addEventListener('click', ()=>{
    const kmh = parseFloat($('speed-kmh').value) || 0;
    const reg = parseInt($('speed-target').value);
    const tg = SPEED_TARGETS.find(s=>s.reg===reg) || { mul:1000, add:0 };
    const raw = Math.round(kmh*tg.mul + tg.add) & 0xffff;
    writeReg(reg, raw); logSys(`speed limit: reg 0x${reg.toString(16)} = ${kmh} km/h (raw ${raw})`);
  });

  $('btn-light-on').addEventListener('click', ()=>{ d3set(D3_BITS.headlight, true,  'headlight'); if(transport && transport.id===3) writeReg(REG_HEADLIGHT_T3, 1); });
  $('btn-light-off').addEventListener('click', ()=>{ d3set(D3_BITS.headlight, false, 'headlight'); if(transport && transport.id===3) writeReg(REG_HEADLIGHT_T3, 0); });

  // 0xd3 light/switch bitfield (same read-modify-write as the headlight).
  $('btn-brake-on').addEventListener('click',  ()=> d3set(D3_BITS.brakelight, true,  'brake light'));
  $('btn-brake-off').addEventListener('click', ()=> d3set(D3_BITS.brakelight, false, 'brake light'));
  $('btn-hub-on').addEventListener('click',    ()=> d3set(D3_BITS.hub,  true,  'hub light'));
  $('btn-hub-off').addEventListener('click',   ()=> d3set(D3_BITS.hub,  false, 'hub light'));
  $('btn-amb-on').addEventListener('click',    ()=> d3set(D3_BITS.ambient, true,  'ambient light'));
  $('btn-amb-off').addEventListener('click',   ()=> d3set(D3_BITS.ambient, false, 'ambient light'));
  $('btn-alarm-on').addEventListener('click',  ()=> d3set(D3_BITS.lockWarn, true,  'overspeed alarm'));
  $('btn-alarm-off').addEventListener('click', ()=> d3set(D3_BITS.lockWarn, false, 'overspeed alarm'));
  $('btn-lsd-on').addEventListener('click',    ()=> d3set(D3_BITS.lockShutDown, true,  'shutdown after lock'));
  $('btn-lsd-off').addEventListener('click',   ()=> d3set(D3_BITS.lockShutDown, false, 'shutdown after lock'));

  $('btn-lightmode').addEventListener('click', ()=> writeRegNamed('light mode', REG_LIGHTMODE, parseInt($('lightmode-idx').value)&0xffff));
  // Version / handshake request (TestSendMsg, byte-exact 55 AA 02 FF 01 03 FA FE); the device answers
  // with its version registers (e.g. the firmware tile).
  $('btn-version').addEventListener('click', ()=>{ sendFrame(buildFrame(0xFF, 0x01, 0x03, [])); logSys('version request'); });

  $('btn-lock').addEventListener('click', ()=> writeRegNamed('lock',   REG_LOCK, 1));
  $('btn-unlock').addEventListener('click', ()=> writeRegNamed('unlock', REG_LOCK, 0));

  // Cruise and speed-limit mode are the same on/off switch; the target speed is set separately above.
  $('btn-cruise-on').addEventListener('click', ()=> writeRegNamed('cruise/limit on',  REG_LIMIT_ENABLE, 1));
  $('btn-cruise-off').addEventListener('click', ()=> writeRegNamed('cruise/limit off', REG_LIMIT_ENABLE, 0));
  $('btn-kick-on').addEventListener('click', ()=> writeRegNamed('zero-start on',  REG_KICKSTART, 1));
  $('btn-kick-off').addEventListener('click', ()=> writeRegNamed('zero-start off', REG_KICKSTART, 0));

  $('btn-writereg').addEventListener('click', ()=> writeReg(parseInt($('reg-nr').value)&0xff, parseInt($('reg-val').value)&0xffff));
  $('btn-readreg').addEventListener('click', ()=> readReg(parseInt($('read-addr').value)&0xff, parseInt($('read-count').value)&0xff));
  $('btn-raw').addEventListener('click', ()=>{ const bytes=parseHex($('raw-hex').value); if(bytes.length<3){ logErr('too short'); return; }
    const ck=checksum16(bytes,2); bytes.push(ck&0xff,(ck>>8)&0xff); sendFrame(bytes); });
  $('btn-raw-plain').addEventListener('click', ()=>{ const bytes=parseHex($('raw-hex').value); if(!bytes.length) return;
    if(!writeChar){ logErr('not connected'); return; }
    const buf=Uint8Array.from(bytes);
    (writeChar.writeValueWithoutResponse ? writeChar.writeValueWithoutResponse(buf) : writeChar.writeValue(buf));
    logTx(bytes); });

  $('btn-analyze').addEventListener('click', onAnalyze);

  // log card
  $('btn-copy-log').addEventListener('click', () => navigator.clipboard.writeText(logText()).then(() => logSys('log copied')).catch(() => {}));
  $('btn-clear-log').addEventListener('click', () => { logBuffer = []; const el = $('log'); if (el) el.textContent = ''; logDiagnosticHeader(); });
  $('btn-save-log').addEventListener('click', saveLog);
  { const pl = $('public-log'); if (pl) { pl.checked = publicLog; pl.addEventListener('change', () => { publicLog = pl.checked; try { localStorage.setItem(LS.PUBLOG, publicLog ? '1' : '0'); } catch (e) {} renderLog(); }); } }
  { const dg = $('diag-log'); if (dg) dg.addEventListener('change', () => { diag = dg.checked; }); }

  document.querySelectorAll('.help-btn').forEach(btn => btn.addEventListener('click', () => openHelp(btn.getAttribute('data-help'))));
  ['help-x', 'help-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', closeHelp); });
  { const b = $('link-disclaimer'); if (b) b.addEventListener('click', e => { e.preventDefault(); openHelp('disclaimer'); }); }
}

// =====================================================================================
// document viewer (markdown of our own docs) + help
// =====================================================================================
const DOC_TITLES = {
  'GUIDE.de.md': 'footGuide', 'GUIDE.en.md': 'footGuide',
  'PRIVACY.de.md': 'footPrivacy', 'PRIVACY.md': 'footPrivacy',
  'LICENSE.de.md': 'footLicense', 'LICENSE.md': 'footLicense',
  'TRADEMARKS.de.md': 'footTrademarks', 'TRADEMARKS.md': 'footTrademarks',
  'README.md': 'footReadme'
};
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = s => s.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/ /g, '-');
function mdToHtml(src) {
  const inline = s => escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text, href) => {
      if (DOC_TITLES[href]) return '<a href="' + href + '" data-docfile="' + href + '">' + text + '</a>';
      return '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>';
    });
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = []; let para = [], inFence = false, listKind = null;
  const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const closeList = () => { if (listKind) { out.push('</' + listKind + '>'); listKind = null; } };
  const cells = l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], body = l.trim();
    if (inFence) { if (body.startsWith('```')) { out.push('</code></pre>'); inFence = false; } else out.push(escHtml(l)); continue; }
    if (body.startsWith('```')) { flushPara(); closeList(); out.push('<pre><code>'); inFence = true; continue; }
    if (body === '') { flushPara(); closeList(); continue; }
    if (/^(-{3,})\s*$/.test(body)) { flushPara(); closeList(); out.push('<hr>'); continue; }
    { const bq = body.match(/^>\s?(.*)$/); if (bq) { flushPara(); closeList(); out.push('<blockquote>' + inline(bq[1]) + '</blockquote>'); continue; } }
    if (body.startsWith('|') && /^\|[\s:|-]+\|?\s*$/.test((lines[i + 1] || '').trim())) {
      flushPara(); closeList();
      out.push('<div class="doc-table"><table><thead><tr>' + cells(body).map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>');
      i++;
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) out.push('<tr>' + cells(lines[++i].trim()).map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>');
      out.push('</tbody></table></div>'); continue;
    }
    let m;
    if ((m = body.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); closeList(); const n = m[1].length; out.push('<h' + n + ' id="' + slug(m[2]) + '">' + inline(m[2]) + '</h' + n + '>'); continue; }
    if ((m = body.match(/^[-*]\s+(.*)$/))) { flushPara(); if (listKind !== 'ul') { closeList(); out.push('<ul>'); listKind = 'ul'; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
    if ((m = body.match(/^\d+\.\s+(.*)$/))) { flushPara(); if (listKind !== 'ol') { closeList(); out.push('<ol>'); listKind = 'ol'; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
    closeList(); para.push(body);
  }
  if (inFence) out.push('</code></pre>');
  flushPara(); closeList();
  return out.join('\n').replace(/<pre><code>\n/g, '<pre><code>');
}
const docCache = {};
const docFile = name => { if (name === 'GUIDE') return 'GUIDE.' + lang + '.md'; if (name === 'README') return 'README.md'; return lang === 'de' ? name + '.de.md' : name + '.md'; };
function openDocFile(file, titleKey) {
  const dlg = $('doc'), body = $('doc-body'); if (!dlg || !body) return;
  const mark = (lang === 'de' && !file.includes('.de.') && file !== 'README.md') ? ' ' + t('docEnglish') : '';
  $('doc-title').textContent = (t(titleKey || DOC_TITLES[file] || '') || file) + mark;
  if (typeof dlg.showModal === 'function') dlg.showModal();
  const showDoc = html => { body.innerHTML = html; const h1 = body.querySelector('h1'); if (h1) { $('doc-title').textContent = h1.textContent.trim() + mark; h1.remove(); } body.scrollTop = 0; }; // scan-ok: markdown of our own documents, escaped by mdToHtml first
  if (docCache[file]) { showDoc(docCache[file]); return; }
  body.innerHTML = '<p>' + escHtml(t('docLoading')) + '</p>'; // scan-ok: escaped
  fetch(file + '?v=' + BUILD).then(r => { if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return r.text(); })
    .then(txt => { docCache[file] = mdToHtml(txt); showDoc(docCache[file]); })
    .catch(e => { body.innerHTML = '<p>' + escHtml(t('docFail')) + '</p><pre class="log-err">' + escHtml(file + ': ' + (e && e.message ? e.message : e)) + '</pre>'; }); // scan-ok: escaped
}
function wireDocViewer() {
  document.addEventListener('click', e => {
    if (!e.target.closest) return;
    const disc = e.target.closest('[data-open-disclaimer]'); if (disc) { e.preventDefault(); openHelp('disclaimer'); return; }
    const a = e.target.closest('[data-doc], [data-docfile]'); if (!a) return;
    e.preventDefault();
    const file = a.getAttribute('data-docfile');
    if (file) openDocFile(file, a.getAttribute('data-t') || '');
    else openDocFile(docFile(a.getAttribute('data-doc')), a.getAttribute('data-t') || '');
  });
  ['doc-x', 'doc-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', () => { const d = $('doc'); if (d) d.close(); }); });
}
const HELP = { ctrl: ['ctrlTitle', 'ctrlHint'], expert: ['expertTitle', 'expertHint'], btsnoop: ['laTitle', 'laIntro'],
  batt: ['help_batt_t', 'help_batt_b'],
  publiclog: ['publicLogLabel', 'helpPublicLog'], diaglog: ['diagLogLabel', 'helpDiagLog'], disclaimer: ['footDisclaimer', 'disclaimerText'] };
function openHelp(key) {
  const m = HELP[key]; if (!m) return; const dlg = $('help'); if (!dlg) return;
  $('help-title').textContent = t(m[0]);
  const bo = $('help-body'); if (bo) { const v = t(m[1]); if (/[<&]/.test(v)) bo.innerHTML = v; else bo.textContent = v; } // scan-ok: our own translation table
  if (dlg.showModal) { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } } else dlg.setAttribute('open', '');
}
function closeHelp() { const dlg = $('help'); if (dlg && dlg.close) dlg.close(); }

// =====================================================================================
// Bluetooth-log (btsnoop) frame lister (verbatim iScooter feature)
// =====================================================================================
// Local only, nothing leaves the browser (CSP self). Modelled on the NAVEE log parser
// (lb-tool-web/drivers/navee.js: extractAuthFromLog / _scanAuthFrame / _tryDecompress / zip handling).
// HONESTY: the exact CMD/SUB that carries the 6-digit connection PIN is NOT known from static
// analysis (data/iscooter.json Finding 4: the InputPassword/SetPasswordPage handler isolates no
// single opcode). So this does NOT claim to find "the PIN frame". It parses a local btsnoop and
// lists the iScooter 55 AA frames the phone WROTE, so the user can enter 000000 in the official app
// while capturing and then identify the command themselves.
const XOR_KEYS = [0x00, 0x34, 0x55, 0x39, 0x18, 0x7a, 0xd8];   // same set as the model-XOR dropdown
const LA_MAX = 5000;                                            // hard cap on collected frames

function h2(b){ return b.toString(16).padStart(2,'0').toUpperCase(); }
// True if the payload carries a run of >= 6 ASCII digit bytes (0x30..0x39), i.e. a 6-digit PIN like
// the default 000000 travelling in the clear. A heuristic hint only, never a claim of "the" frame.
function hasAsciiRun(pl){ let run=0; for(const b of pl){ if(b>=0x30 && b<=0x39){ if(++run>=6) return true; } else run=0; } return false; }

// Validate one 55 AA frame at offset i, reading each byte XORed with key. Returns total length or 0.
// Frame: 55 AA LEN CMD SUB REG payload(LEN-2) CK_LO CK_HI; CK = ~(sum LEN..last payload byte), LE.
function frameLenAt(buf, i, key){
  if((buf[i]^key)!==0x55 || (buf[i+1]^key)!==0xAA) return 0;
  const len = buf[i+2]^key;
  if(len < 2) return 0;                        // LEN counts SUB+REG+payload, min 2
  const total = len + 6;
  if(i + total > buf.length) return 0;
  let s=0; for(let k=i+2; k<=i+3+len; k++) s=(s+(buf[k]^key))&0xffff;
  const ck=(~s)&0xffff;
  if((buf[i+4+len]^key)!==(ck&0xff)) return 0;
  if((buf[i+5+len]^key)!==((ck>>8)&0xff)) return 0;
  return total;
}
function decodeFrame(buf, i, total, key){
  const b=new Array(total); for(let k=0;k<total;k++) b[k]=buf[i+k]^key;
  const len=b[2];
  return { cmd:b[3], sub:b[4], reg:b[5], payload:b.slice(6, 6+(len-2)), raw:b, key };
}
// Scan a buffer for valid frames. Try no-XOR first (the common case); only fall back to the known
// obfuscation keys if plaintext yields nothing, so a normal capture stays fast.
function scanAllFrames(buf){
  for(const key of XOR_KEYS){
    const out=[];
    for(let i=0; i+8<=buf.length && out.length<LA_MAX; i++){
      if((buf[i]^key)!==0x55) continue;
      const fl=frameLenAt(buf,i,key);
      if(fl){ out.push(decodeFrame(buf,i,fl,key)); i+=fl-1; }
    }
    if(out.length) return out;
  }
  return [];
}
// Parse an Android btsnoop_hci.log for record direction. Returns [{sent,data}] or null if not one.
function parseBtsnoop(buf){
  if(buf.length < 16) return null;
  const magic=[0x62,0x74,0x73,0x6e,0x6f,0x6f,0x70,0x00];       // "btsnoop\0"
  for(let k=0;k<8;k++) if(buf[k]!==magic[k]) return null;
  const dv=new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const recs=[]; let p=16;
  while(p+24 <= buf.length){
    const inclLen=dv.getUint32(p+4,false);
    const flags=dv.getUint32(p+8,false);                       // bit0: 0 = sent (host -> controller)
    p+=24;
    if(inclLen<0 || p+inclLen>buf.length) break;
    recs.push({ sent:((flags&0x01)===0), data:buf.subarray(p, p+inclLen) });
    p+=inclLen;
  }
  return recs;
}
// Collect frames from one decoded buffer. For a btsnoop, only frames the phone SENT count as
// write-characteristic frames; for a stripped raw buffer the direction is unknown.
function collectFrames(buf){
  const bt=parseBtsnoop(buf), recs=[];
  if(bt){
    for(const r of bt){ if(!r.sent) continue; for(const fr of scanAllFrames(r.data)){ fr.dir='tx'; recs.push(fr); } }
    return { frames:recs, kind:'btsnoop' };
  }
  for(const fr of scanAllFrames(buf)){ fr.dir='?'; recs.push(fr); }
  return { frames:recs, kind:'raw' };
}
async function tryDecompress(bytes, fmt){
  try{
    if(typeof DecompressionStream!=='function') return null;
    const st=new Blob([bytes]).stream().pipeThrough(new DecompressionStream(fmt));
    return new Uint8Array(await new Response(st).arrayBuffer());
  }catch(e){ return null; }
}
function zipEntries(b){
  const out=[], dv=new DataView(b.buffer,b.byteOffset,b.byteLength);
  let eocd=-1;
  for(let i=b.length-22;i>=0 && i>b.length-22-0x10000;i--){ if(b[i]===0x50&&b[i+1]===0x4b&&b[i+2]===0x05&&b[i+3]===0x06){eocd=i;break;} }
  if(eocd<0) return out;
  const n=dv.getUint16(eocd+10,true); let p=dv.getUint32(eocd+16,true);
  for(let e=0;e<n && p+46<=b.length;e++){
    if(dv.getUint32(p,true)!==0x02014b50) break;
    const method=dv.getUint16(p+10,true), compSize=dv.getUint32(p+20,true);
    const nameLen=dv.getUint16(p+28,true), extraLen=dv.getUint16(p+30,true), commentLen=dv.getUint16(p+32,true), lho=dv.getUint32(p+42,true);
    let name=''; for(let k=0;k<nameLen;k++) name+=String.fromCharCode(b[p+46+k]);
    out.push({name,method,compSize,lho}); p+=46+nameLen+extraLen+commentLen;
  }
  return out;
}
function zipEntryData(b, ent){
  const dv=new DataView(b.buffer,b.byteOffset,b.byteLength);
  if(dv.getUint32(ent.lho,true)!==0x04034b50) return null;
  const start=ent.lho+30+dv.getUint16(ent.lho+26,true)+dv.getUint16(ent.lho+28,true);
  return b.slice(start, start+ent.compSize);
}
async function analyzeLog(file){
  const raw=new Uint8Array(await file.arrayBuffer());
  let all=[], kind='raw';
  const add=(r)=>{ if(r && r.frames.length){ all=all.concat(r.frames); if(r.kind==='btsnoop') kind='btsnoop'; } };
  add(collectFrames(raw));
  if(!all.length && raw[0]===0x1f && raw[1]===0x8b){ const g=await tryDecompress(raw,'gzip'); if(g) add(collectFrames(g)); }
  if(!all.length && raw[0]===0x50 && raw[1]===0x4b){          // ZIP (e.g. Android bug report)
    const ents=zipEntries(raw);
    ents.sort((a,b)=> (/(btsnoop|bluetooth|bt)/i.test(b.name)?1:0) - (/(btsnoop|bluetooth|bt)/i.test(a.name)?1:0));
    for(const ent of ents){
      let dec=zipEntryData(raw, ent); if(!dec) continue;
      if(!(ent.method===0)) dec=await tryDecompress(dec,'deflate-raw');
      if(!dec) continue;
      if(dec[0]===0x1f && dec[1]===0x8b){ const g=await tryDecompress(dec,'gzip'); if(g) dec=g; }
      add(collectFrames(dec));
    }
  }
  return { frames:all, kind };
}
function fmtFrame(fr, count){
  const parts=[ fr.dir==='tx' ? 'TX' : '??', 'CMD '+h2(fr.cmd)+' SUB '+h2(fr.sub)+' REG '+h2(fr.reg) ];
  if(fr.key) parts.push('XOR 0x'+fr.key.toString(16));
  if(count>1) parts.push('x'+count);
  let line=parts.join('  ')+'\n     '+hex(fr.raw);
  if(hasAsciiRun(fr.payload)) line+='\n     -> '+t('laCand');
  return line;
}
function renderFrames(res, st, out){
  const map=new Map();
  for(const fr of res.frames){ const key=fr.dir+'|'+hex(fr.raw); const e=map.get(key); if(e) e.count++; else map.set(key,{fr,count:1}); }
  const list=Array.from(map.values());
  if(!list.length){ st.textContent=t('laNoFrames'); out.hidden=true; return; }
  list.sort((a,b)=>{ const ca=hasAsciiRun(a.fr.payload)?0:1, cb=hasAsciiRun(b.fr.payload)?0:1; return ca!==cb ? ca-cb : a.fr.cmd-b.fr.cmd; });
  const lines=[ t('laListHeader'), '' ];
  for(const it of list) lines.push(fmtFrame(it.fr, it.count));
  lines.push('', t('laCandidateNote'));
  st.textContent=list.length+' '+t('laDistinct')+(res.kind==='btsnoop' ? ' (btsnoop)' : '');
  out.textContent=lines.join('\n'); out.hidden=false;
}
async function onAnalyze(){
  const file=$('la-file').files && $('la-file').files[0];
  const st=$('la-status'), out=$('la-out');
  if(!file){ st.textContent=t('laNoFile'); return; }
  st.textContent=t('laReading'); out.hidden=true; out.textContent='';
  try{ renderFrames(await analyzeLog(file), st, out); }
  catch(e){ st.textContent='error: '+e; }
}

// =====================================================================================
// init
// =====================================================================================
window.addEventListener('DOMContentLoaded', () => {
  initLangSwitch();
  initTheme();
  wireDocViewer();
  wire();
  try { const p = localStorage.getItem(LS.PUBLOG); if (p === '0') publicLog = false; } catch (e) {}
  { const pl = $('public-log'); if (pl) pl.checked = publicLog; }
  fillSpeedTargets();
  applyLang();
  setStatus('disconnected');
  { const el = $('platform-note'); if (el) el.hidden = !!navigator.bluetooth; }
  logDiagnosticHeader();
});
