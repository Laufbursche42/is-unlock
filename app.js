// iScooter unlock - a Web Bluetooth client for the loby/MiniRobot BLE protocol family.
'use strict';
const BUILD = 'isu-v2';

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
// Poll block that covers registers 0x1a..0x4e (speed, battery, voltage, current, trip, total, error).
const POLL = { addr:0x1a, count:0x34, everyMs:2000 };
// Telemetry registers (dual-battery dashboard). %.01f fields are raw/10.
const TELE = {
  speed:{reg:39, div:10}, batt:{reg:34, div:1}, volt:{reg:74, div:10}, curr:{reg:76, div:10},
  trip:{reg:37, div:10}, totalLo:{reg:41}, totalHi:{reg:42}, max:{reg:1, div:10},
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

// --------------------------- BLE state ---------------------------
let device=null, server=null, writeChar=null, notifyChar=null, transport=null;
let connected=false, pollTimer=null;
const regBank = {};   // received registers: absolute number -> 16-bit value

function $(id){ return document.getElementById(id); }
function log(msg){ const l=$('log'); l.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`; l.scrollTop=l.scrollHeight; }
function xorKey(){ return parseInt($('xor-mode').value) || 0; }

async function sendFrame(frame){
  if(!writeChar){ log('not connected'); return; }
  const out = applyXor(frame, xorKey());
  const buf = Uint8Array.from(out);
  try{
    if(writeChar.writeValueWithoutResponse) await writeChar.writeValueWithoutResponse(buf);
    else await writeChar.writeValue(buf);
    log('TX ' + hex(out));
  }catch(e){ log('TX error: ' + e); }
}
function writeReg(reg, value){ return sendFrame(buildFrame(0x20, 0x03, reg, reg16LE(value))); }
function readReg(addr, count){ return sendFrame(buildFrame(0x06, 0x01, addr, [count & 0xff])); }
function writeRegNamed(name, reg, val){ writeReg(reg, val); log(`${name}: reg 0x${reg.toString(16)} = ${val}`); }

// --------------------------- receive / telemetry ---------------------------
function onNotify(ev){
  const v = new Uint8Array(ev.target.value.buffer);
  let b = Array.from(v);
  const key = xorKey();
  if(key) b = b.map(x => x ^ key);
  if(b.length < 6 || b[0] !== 0x55 || b[1] !== 0xAA){ log('RX (raw) ' + hex(Array.from(v))); return; }
  log('RX ' + hex(b));
  const len = b[2], startReg = b[5], payLen = Math.max(0, len - 2);
  for(let i=0; i+1<payLen; i+=2) regBank[startReg + (i/2)] = b[6+i] | (b[6+i+1] << 8);
  refreshTele();
}
function te(sel){ const c=TELE[sel]; const raw=regBank[c.reg]; return raw===undefined ? null : (c.div ? raw/c.div : raw); }
function refreshTele(){
  const sp=te('speed'); $('t-speed').textContent = sp!=null ? sp.toFixed(1)+' km/h' : '-';
  const ba=te('batt');  $('t-batt').textContent  = ba!=null ? ba+' %' : '-';
  const vo=te('volt');  $('t-volt').textContent  = vo!=null ? vo.toFixed(1)+' V' : '-';
  const cu=te('curr');  $('t-curr').textContent  = cu!=null ? cu.toFixed(1)+' A' : '-';
  const tr=te('trip');  $('t-trip').textContent  = tr!=null ? tr.toFixed(1)+' km' : '-';
  const tl=regBank[TELE.totalLo.reg], th=regBank[TELE.totalHi.reg];
  $('t-total').textContent = (tl!==undefined) ? (((th||0)*65536+tl)/10).toFixed(1)+' km' : '-';
  const mx=te('max'); $('t-max').textContent = mx!=null ? mx.toFixed(1)+' km/h' : '-';
  const lk=regBank[TELE.lock.reg]; $('t-lock').textContent = lk!==undefined ? (lk ? t('locked') : t('unlocked')) : '-';
  const er=regBank[TELE.err.reg];  $('t-err').textContent  = (er!==undefined && er) ? String(er) : '0';
  const fw=regBank[TELE.fw.reg];   $('t-fw').textContent   = fw!==undefined ? '0x'+fw.toString(16) : '-';
}

// --------------------------- connect ---------------------------
async function connect(){
  if(connected){ await disconnect(); return; }
  if(!navigator.bluetooth){ log('Web Bluetooth not available (needs Chrome or Bluefy)'); return; }
  try{
    $('status').textContent = t('stConnecting');
    const filters = SCAN_PREFIXES.map(p => ({ namePrefix: p }));
    device = await navigator.bluetooth.requestDevice({ filters, optionalServices: ALL_SERVICES });
    device.addEventListener('gattserverdisconnected', onDisc);
    log('device: ' + (device.name || '(no name)'));
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
    if(!transport){ log('no matching GATT profile found'); await disconnect(); return; }
    log('profile ' + transport.id + ' (' + transport.name + ')');
    await notifyChar.startNotifications();
    notifyChar.addEventListener('characteristicvaluechanged', onNotify);
    connected = true;
    $('status').textContent = t('stConnected');
    $('btn-conn').textContent = t('btnDisconnect');
    $('devinfo').textContent = (device.name||'') + '  -  profile ' + transport.id;
    startPoll();
  }catch(e){ log('connect aborted: ' + e); $('status').textContent = t('stDisconnected'); }
}
function startPoll(){ stopPoll(); readReg(POLL.addr, POLL.count);
  pollTimer = setInterval(()=>{ if(connected) readReg(POLL.addr, POLL.count); }, POLL.everyMs); }
function stopPoll(){ if(pollTimer){ clearInterval(pollTimer); pollTimer=null; } }
async function disconnect(){ stopPoll(); try{ if(device && device.gatt.connected) device.gatt.disconnect(); }catch(e){} onDisc(); }
function onDisc(){ connected=false; writeChar=null; notifyChar=null; transport=null;
  $('status').textContent = t('stDisconnected'); $('btn-conn').textContent = t('btnConnect'); log('disconnected'); }

// --------------------------- UI wiring ---------------------------
function makeOption(value, label){ const o=document.createElement('option'); o.value=value; o.textContent=label; return o; }
function fillSelects(){
  const st=$('speed-target'); st.textContent='';
  SPEED_TARGETS.forEach(s=> st.appendChild(makeOption(s.reg, s.label)));
  const mi=$('model-in'); mi.textContent=''; mi.appendChild(makeOption('auto', t('autoDetect')));
}
// Read-modify-write one bit of the 0xd3 light bitfield via the local mirror.
function d3set(bit, on, name){
  let cur = regBank[D3] || 0;
  cur = on ? (cur | bit) : (cur & ~bit & 0xffff);
  regBank[D3] = cur;
  writeReg(D3, cur);
  log(`${name}: 0xd3 bit 0x${bit.toString(16)} -> ${on?'on':'off'} (0x${cur.toString(16)})`);
}
function wire(){
  $('btn-conn').onclick = connect;
  $('btn-theme').onclick = ()=>{ const d=document.documentElement; const now=d.getAttribute('data-theme')==='dark'?'light':'dark';
    d.setAttribute('data-theme', now); localStorage.setItem('isu_theme', now); };
  const th = localStorage.getItem('isu_theme'); if(th) document.documentElement.setAttribute('data-theme', th);

  $('btn-setspeed').onclick = ()=>{
    const kmh = parseFloat($('speed-kmh').value) || 0;
    const reg = parseInt($('speed-target').value);
    const tg = SPEED_TARGETS.find(s=>s.reg===reg) || { mul:1000, add:0 };
    const raw = Math.round(kmh*tg.mul + tg.add) & 0xffff;
    writeReg(reg, raw); log(`speed limit: reg 0x${reg.toString(16)} = ${kmh} km/h (raw ${raw})`);
  };

  $('btn-light-on').onclick  = ()=>{ d3set(D3_BITS.headlight, true,  'headlight'); if(transport && transport.id===3) writeReg(REG_HEADLIGHT_T3, 1); };
  $('btn-light-off').onclick = ()=>{ d3set(D3_BITS.headlight, false, 'headlight'); if(transport && transport.id===3) writeReg(REG_HEADLIGHT_T3, 0); };

  $('btn-lock').onclick   = ()=> writeRegNamed('lock',   REG_LOCK, 1);
  $('btn-unlock').onclick = ()=> writeRegNamed('unlock', REG_LOCK, 0);

  // Cruise and speed-limit mode are the same on/off switch; the target speed is set separately above.
  $('btn-cruise-on').onclick  = ()=> writeRegNamed('cruise/limit on',  REG_LIMIT_ENABLE, 1);
  $('btn-cruise-off').onclick = ()=> writeRegNamed('cruise/limit off', REG_LIMIT_ENABLE, 0);
  $('btn-kick-on').onclick  = ()=> writeRegNamed('zero-start on',  REG_KICKSTART, 1);
  $('btn-kick-off').onclick = ()=> writeRegNamed('zero-start off', REG_KICKSTART, 0);

  $('btn-writereg').onclick = ()=> writeReg(parseInt($('reg-nr').value)&0xff, parseInt($('reg-val').value)&0xffff);
  $('btn-readreg').onclick  = ()=> readReg(parseInt($('read-addr').value)&0xff, parseInt($('read-count').value)&0xff);
  $('btn-raw').onclick = ()=>{ const bytes=parseHex($('raw-hex').value); if(bytes.length<3){ log('too short'); return; }
    const ck=checksum16(bytes,2); bytes.push(ck&0xff,(ck>>8)&0xff); sendFrame(bytes); };
  $('btn-raw-plain').onclick = ()=>{ const bytes=parseHex($('raw-hex').value); if(!bytes.length) return;
    if(!writeChar){ log('not connected'); return; }
    const buf=Uint8Array.from(bytes);
    (writeChar.writeValueWithoutResponse ? writeChar.writeValueWithoutResponse(buf) : writeChar.writeValue(buf));
    log('TX raw ' + hex(bytes)); };

  $('btn-analyze').onclick = onAnalyze;
}
function parseHex(s){ return (s.match(/[0-9a-fA-F]{2}/g) || []).map(h=>parseInt(h,16)); }

// --------------------------- Bluetooth-log (btsnoop) frame lister ---------------------------
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

window.onLangChange = ()=>{ $('enc-state').textContent = t('encNone'); fillSelects(); };
document.addEventListener('DOMContentLoaded', ()=>{
  applyI18n(); fillSelects(); wire();
  $('enc-state').textContent = t('encNone');
  log('build ' + BUILD + ' ready');
});
