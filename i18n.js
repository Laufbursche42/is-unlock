// i18n strings for the is-unlock page (DE default, EN secondary).
const I18N = {
  de: {
    stDisconnected: "nicht verbunden",
    stConnecting: "verbinde ...",
    stConnected: "verbunden",
    s1Title: "1. Modell und Verbindung",
    modelLabel: "Modell",
    btnConnect: "Verbinden",
    btnDisconnect: "Trennen",
    liveTitle: "2. Telemetrie live",
    tSpeed: "Tempo", tBatt: "Akku", tVolt: "Spannung", tCurr: "Strom/Leistung",
    tTrip: "Fahrt", tTotal: "Gesamt", tMax: "Max-Tempo", tLock: "Sperre",
    tErr: "Fehler", tFw: "Firmware",
    ctrlTitle: "3. Steuerung",
    cSpeedLimit: "Speed-Limit / Maximaltempo",
    btnSetSpeed: "Setzen",
    cCruise: "Tempomat (Cruise)",
    btnOn: "An", btnOff: "Aus",
    cKick: "Kickstart (Zero-Start)",
    btnZeroOn: "Zero-Start an", btnZeroOff: "Zero-Start aus",
    cLock: "Sperre und Licht",
    btnLock: "Sperren", btnUnlock: "Entsperren", btnLightOn: "Licht an", btnLightOff: "Licht aus",
    expertTitle: "4. Experten-Modus",
    expertHint: "Generisches Schreib- und Lesekommando. Wo die exakte Registernummer je Modell abweicht, hier Register plus Wert direkt setzen.",
    locked: "gesperrt", unlocked: "frei", autoDetect: "Auto-Erkennung (alle Modelle)",
    eReg: "Register schreiben (CMD 0x20)", eRegNr: "Register", eRegVal: "Wert",
    btnWriteReg: "Register schreiben",
    eRead: "Register lesen (CMD 0x06)", eCount: "Anzahl", btnReadReg: "Lesen anstoßen",
    eRaw: "Roh-Frame senden", btnRaw: "Senden (Prüfsumme + XOR auto)", btnRawPlain: "Roh senden (unverändert)",
    eXor: "Modell-XOR",
    logTitle: "Protokoll",
    laTitle: "5. Bluetooth-Log analysieren",
    laIntro: "Alles läuft lokal im Browser (CSP self), nichts wird hochgeladen. Welcher genaue Befehl (CMD/SUB) die 6-stellige Verbindungs-PIN trägt, ist aus der statischen Analyse NICHT bekannt (siehe data/iscooter.json, Finding 4). Dieses Werkzeug behauptet daher nicht, das PIN-Frame zu finden. Es liest ein lokales btsnoop-Log und listet die iScooter-55-AA-Frames auf, die die App an die Schreib-Charakteristik gesendet hat, damit du den passenden Befehl selbst erkennst.",
    laBtn: "Analysieren",
    laHint: "So zeichnest du auf: Entwickleroptionen -> Bluetooth-HCI-Snoop-Log aktivieren, Bluetooth aus/an, in der Original-App verbinden und die Standard-PIN 000000 eingeben, dann btsnoop_hci.log (oder den Fehlerbericht als .zip/.gz) hier laden.",
    laReading: "lese und werte aus ...",
    laNoFile: "keine Datei gewählt",
    laNoFrames: "keine gültigen iScooter-55-AA-Frames gefunden",
    laDistinct: "verschiedene gesendete Frames",
    laListHeader: "Gesendete iScooter-Frames (55 AA). Kandidaten mit einer 6-stelligen Ziffernfolge stehen oben:",
    laCand: "enthält eine 6-stellige ASCII-Ziffernfolge (möglicher PIN-Träger, z. B. 000000) - selbst prüfen",
    laCandidateNote: "Hinweis: Die Markierung ist nur eine Heuristik. Der exakte PIN-Befehl ist nicht bewiesen; gib 000000 in der App ein und vergleiche, welches Frame dabei neu auftaucht.",
    footer: "Nur für das eigene Gerät auf privatem Gelände. Das Anheben der Höchstgeschwindigkeit hebt die ABE auf. Web Bluetooth braucht Chrome (Android/Desktop) oder Bluefy (iOS).",
    encNone: "Kein Pairing, keine PIN, kein AES - Klartext-Frames mit Prüfsumme (optional Ein-Byte-XOR).",
  },
  en: {
    stDisconnected: "disconnected", stConnecting: "connecting ...", stConnected: "connected",
    s1Title: "1. Model and connection", modelLabel: "Model", btnConnect: "Connect", btnDisconnect: "Disconnect",
    liveTitle: "2. Live telemetry",
    tSpeed: "Speed", tBatt: "Battery", tVolt: "Voltage", tCurr: "Current/Power",
    tTrip: "Trip", tTotal: "Total", tMax: "Max speed", tLock: "Lock", tErr: "Error", tFw: "Firmware",
    ctrlTitle: "3. Control", cSpeedLimit: "Speed limit / max speed", btnSetSpeed: "Set",
    cCruise: "Cruise control", btnOn: "On", btnOff: "Off",
    cKick: "Kickstart (zero start)", btnZeroOn: "Zero start on", btnZeroOff: "Zero start off",
    cLock: "Lock and light", btnLock: "Lock", btnUnlock: "Unlock", btnLightOn: "Light on", btnLightOff: "Light off",
    expertTitle: "4. Expert mode",
    expertHint: "Generic write and read command. Where the exact per-model register differs, set register plus value directly here.",
    locked: "locked", unlocked: "free", autoDetect: "Auto detect (all models)",
    eReg: "Write register (CMD 0x20)", eRegNr: "Register", eRegVal: "Value", btnWriteReg: "Write register",
    eRead: "Read register (CMD 0x06)", eCount: "Count", btnReadReg: "Trigger read",
    eRaw: "Send raw frame", btnRaw: "Send (checksum + XOR auto)", btnRawPlain: "Send raw (unchanged)",
    eXor: "Model XOR", logTitle: "Log",
    laTitle: "5. Analyse a Bluetooth log",
    laIntro: "Everything runs locally in the browser (CSP self), nothing is uploaded. Which exact command (CMD/SUB) carries the 6-digit connection PIN is NOT known from static analysis (see data/iscooter.json, Finding 4). This tool therefore does not claim to find the PIN frame. It parses a local btsnoop log and lists the iScooter 55 AA frames the app wrote to the write characteristic, so you can identify the right command yourself.",
    laBtn: "Analyse",
    laHint: "How to capture: Developer options -> enable Bluetooth HCI snoop log, toggle Bluetooth off/on, connect in the original app and enter the default PIN 000000, then load btsnoop_hci.log (or the bug report as .zip/.gz) here.",
    laReading: "reading and parsing ...",
    laNoFile: "no file selected",
    laNoFrames: "no valid iScooter 55 AA frames found",
    laDistinct: "distinct sent frames",
    laListHeader: "Sent iScooter frames (55 AA). Candidates with a 6-digit numeric run are listed first:",
    laCand: "contains a 6-digit ASCII numeric run (possible PIN carrier, e.g. 000000) - verify yourself",
    laCandidateNote: "Note: the marker is only a heuristic. The exact PIN command is not proven; enter 000000 in the app and compare which frame newly appears.",
    footer: "Own device on private ground only. Raising the top speed voids road approval. Web Bluetooth needs Chrome (Android/desktop) or Bluefy (iOS).",
    encNone: "No pairing, no PIN, no AES - plaintext frames with checksum (optional single-byte XOR).",
  }
};
// Expose the table so tooling (scripts/check-i18n.js) can require this file under Node.
if (typeof window !== 'undefined') window.I18N = I18N;
else if (typeof global !== 'undefined') { global.window = global.window || {}; global.window.I18N = I18N; }

let LANG = 'de';
try {
  const stored = (typeof localStorage !== 'undefined') && localStorage.getItem('isu_lang');
  const nav = (typeof navigator !== 'undefined' && navigator.language) ? navigator.language.slice(0,2) : 'de';
  LANG = stored || nav;
} catch (e) { /* non-browser context */ }
if (!I18N[LANG]) LANG = 'de';

function t(k){ return (I18N[LANG] && I18N[LANG][k]) || (I18N.de[k]) || k; }
function applyI18n(){
  document.querySelectorAll('[data-t]').forEach(el => { el.textContent = t(el.getAttribute('data-t')); });
  const ls = document.getElementById('langs');
  if (!ls) return;
  ls.textContent = '';
  Object.keys(I18N).forEach(l => {
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = l.toUpperCase();
    if (l === LANG) a.className = 'active';
    a.onclick = e => {
      e.preventDefault();
      LANG = l;
      try { localStorage.setItem('isu_lang', LANG); } catch (err) { /* ignore */ }
      applyI18n();
      if (window.onLangChange) window.onLangChange();
    };
    ls.appendChild(a);
  });
}
