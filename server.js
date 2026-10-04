// Artha-Drishti tool server: MCP (POST /mcp) + the same mock Pine Labs SBMD REST paths.
// Real: Gnani STT/TTS (api.vachana.ai). Mock: Pine Labs UPI Reserve Pay (Plural has no SBMD tool on the platform).
// Set env GNANI_API_KEY on your host. Never commit the key.
const http = require('http');
const GNANI = 'https://api.vachana.ai';
const subs = {}; const audio = {}; let n = 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- mock Pine Labs SBMD core (paths/fields per Pine Labs integration-steps docs; errors are OUR mock's) ----------
function createSub(b) {
  const pd = b.plan_details || {}; const cid = String(b.customer_id || '');
  if (!b.merchant_subscription_reference || !cid || !pd.reserve_amount || !pd.validity_days || b.terms_accepted !== true)
    return [400, { code: 'INVALID_REQUEST', message: 'missing or invalid field' }];
  if (cid.includes('MALFORMED')) return [200, '{"subscription_id": "SUB_BAD", "status": '];
  if (pd.reserve_amount > 10000) return [422, { code: 'AMOUNT_EXCEEDS_LIMIT', message: 'max 10000' }];
  if (pd.validity_days > 90) return [422, { code: 'VALIDITY_EXCEEDS_LIMIT', message: 'max 90 days' }];
  if (cid.includes('LOWBAL')) return [402, { code: 'INSUFFICIENT_BALANCE', message: 'balance too low to block amount' }];
  if (cid.includes('NOBANK')) return [422, { code: 'BANK_NOT_SUPPORTED', message: 'only ICICI/Axis savings' }];
  if (cid.includes('ACTIVE') || Object.values(subs).some(s => s.customer_id === cid && ['CREATED', 'ACTIVE'].includes(s.status)))
    return [409, { code: 'ACTIVE_SUBSCRIPTION_EXISTS', message: 'one SBMD subscription per customer' }];
  const id = 'SUB_' + (++n);
  subs[id] = { subscription_id: id, customer_id: cid, merchant_subscription_reference: b.merchant_subscription_reference,
    status: 'CREATED', reserve_amount: pd.reserve_amount, used_amount: 0, currency: pd.currency || 'INR',
    validity_days: pd.validity_days, description: pd.description || '' };
  return [201, { subscription_id: id, status: 'CREATED', challenge_url: `/mock/approve/${id}` }];
}
const getSub = id => subs[id] ? [200, { ...subs[id], remaining_amount: subs[id].reserve_amount - subs[id].used_amount }] : [404, { code: 'NOT_FOUND' }];
const approve = id => subs[id] ? (subs[id].status = 'ACTIVE', [200, { subscription_id: id, status: 'ACTIVE' }]) : [404, { code: 'NOT_FOUND' }];
function debit(b) {
  const s = subs[b.subscription_id]; const v = b.amount && b.amount.value;
  if (!s) return [404, { code: 'NOT_FOUND' }];
  if (s.status !== 'ACTIVE') return [422, { code: 'SUBSCRIPTION_NOT_ACTIVE', status: s.status }];
  if (!v || v <= 0 || !b.merchant_presentation_reference) return [400, { code: 'INVALID_REQUEST' }];
  if (v > s.reserve_amount - s.used_amount) return [422, { code: 'EXCEEDS_REMAINING', remaining_amount: s.reserve_amount - s.used_amount }];
  s.used_amount += v; return [201, { presentation_id: 'PRES_' + (++n), status: 'SUCCESS' }];
}

// ---------- Gnani (REAL calls) ----------
async function gnaniStt({ audio_url, language_code }) {
  if (!process.env.GNANI_API_KEY) throw new Error('GNANI_API_KEY not set on server');
  const a = await fetch(audio_url); if (!a.ok) throw new Error('could not download audio: ' + a.status);
  const fd = new FormData(); fd.append('audio_file', new Blob([await a.arrayBuffer()]), 'audio.wav');
  fd.append('language_code', language_code || 'en-IN'); fd.append('format', 'transcribe');
  const r = await fetch(GNANI + '/stt/v3', { method: 'POST', headers: { 'X-API-Key-ID': process.env.GNANI_API_KEY }, body: fd });
  const t = await r.text(); if (!r.ok) throw new Error('Gnani STT ' + r.status + ': ' + t.slice(0, 200));
  return JSON.parse(t); // success, request_id, timestamp, transcript (NO confidence field)
}
async function gnaniTts({ text, voice, language }, origin) {
  if (!process.env.GNANI_API_KEY) throw new Error('GNANI_API_KEY not set on server');
  const r = await fetch(GNANI + '/api/v1/tts/inference', { method: 'POST',
    headers: { 'X-API-Key-ID': process.env.GNANI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: voice || 'Nalini', model: 'timbre-v2.5', language: language || 'en-IN', audio_config: { container: 'wav' } }) });
  if (!r.ok) throw new Error('Gnani TTS ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const id = 'a' + (++n); audio[id] = Buffer.from(await r.arrayBuffer());
  return { success: true, audio_url: `${origin}/audio/${id}.wav`, bytes: audio[id].length };
}

// ---------- MCP tool catalog ----------
const obj = (props, req) => ({ type: 'object', properties: props, required: req });
const TOOLS = [
  { name: 'gnani_stt', description: 'REAL Gnani speech-to-text. Takes a URL of an audio clip (max 60s). Returns transcript only; NO confidence score, so always confirm with the user.',
    inputSchema: obj({ audio_url: { type: 'string' }, language_code: { type: 'string', description: 'e.g. en-IN, hi-IN' } }, ['audio_url', 'language_code']) },
  { name: 'gnani_tts', description: 'REAL Gnani text-to-speech. Returns a URL of the WAV file.',
    inputSchema: obj({ text: { type: 'string' }, voice: { type: 'string' }, language: { type: 'string' } }, ['text']) },
  { name: 'reserve_create_sbmd_subscription', description: 'MOCK Pine Labs UPI Reserve Pay: POST /ps/api/v1/public/subscriptions/sbmd. Max reserve_amount 10000, validity_days max 90, one active per customer.',
    inputSchema: obj({ merchant_subscription_reference: { type: 'string' }, customer_id: { type: 'string' },
      plan_details: obj({ reserve_amount: { type: 'number' }, currency: { type: 'string' }, validity_days: { type: 'number' }, description: { type: 'string' } }, ['reserve_amount', 'validity_days']),
      callback_url: { type: 'string' }, terms_accepted: { type: 'boolean' } }, ['merchant_subscription_reference', 'customer_id', 'plan_details', 'terms_accepted']) },
  { name: 'reserve_get_sbmd_subscription', description: 'MOCK Pine Labs: GET /ps/api/v1/public/subscriptions/sbmd/{subscription_id}. Status and live balance.',
    inputSchema: obj({ subscription_id: { type: 'string' } }, ['subscription_id']) },
  { name: 'reserve_create_presentation', description: 'MOCK Pine Labs: POST /ps/api/v1/public/presentations. Debit against an ACTIVE reserve.',
    inputSchema: obj({ subscription_id: { type: 'string' }, amount: obj({ value: { type: 'number' }, currency: { type: 'string' } }, ['value']), merchant_presentation_reference: { type: 'string' } }, ['subscription_id', 'amount', 'merchant_presentation_reference']) },
  { name: 'mock_user_approve_reserve', description: 'MOCK ONLY: stands in for the user approving the reserve in their own UPI app. Call ONLY after the user says they approved.',
    inputSchema: obj({ subscription_id: { type: 'string' } }, ['subscription_id']) },
];
async function callTool(name, a, origin) {
  let out;
  if (name === 'gnani_stt') out = await gnaniStt(a);
  else if (name === 'gnani_tts') out = await gnaniTts(a, origin);
  else if (name === 'reserve_create_sbmd_subscription') {
    if (String(a.customer_id || '').includes('TIMEOUT')) await sleep(30000); // longer than the platform's 10s connector timeout
    const [code, body] = createSub(a); return { isError: code >= 400, content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify({ http_status: code, ...body }) }] };
  } else if (name === 'reserve_get_sbmd_subscription') { const [c, b] = getSub(a.subscription_id); return { isError: c >= 400, content: [{ type: 'text', text: JSON.stringify({ http_status: c, ...b }) }] }; }
  else if (name === 'reserve_create_presentation') { const [c, b] = debit(a); return { isError: c >= 400, content: [{ type: 'text', text: JSON.stringify({ http_status: c, ...b }) }] }; }
  else if (name === 'mock_user_approve_reserve') { const [c, b] = approve(a.subscription_id); return { isError: c >= 400, content: [{ type: 'text', text: JSON.stringify({ http_status: c, ...b }) }] }; }
  else throw new Error('unknown tool ' + name);
  return { content: [{ type: 'text', text: JSON.stringify(out) }] };
}

// ---------- HTTP ----------
const send = (res, code, o, ct = 'application/json') => { res.writeHead(code, { 'Content-Type': ct }); res.end(typeof o === 'string' || Buffer.isBuffer(o) ? o : JSON.stringify(o)); };
const readBody = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  const origin = (req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host;
  const p = new URL(req.url, origin).pathname, m = req.method; let mm;
  try {
    if (p === '/health') return send(res, 200, { ok: true });
    if ((mm = p.match(/^\/audio\/(\w+)\.wav$/)) && audio[mm[1]]) return send(res, 200, audio[mm[1]], 'audio/wav');
    if (p === '/mcp' && m === 'POST') {
      const q = await readBody(req); const id = q.id;
      if (q.method === 'initialize') return send(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: q.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'artha-drishti-tools', version: '1.0.0' } } });
      if (q.method && q.method.startsWith('notifications/')) { res.writeHead(202); return res.end(); }
      if (q.method === 'ping') return send(res, 200, { jsonrpc: '2.0', id, result: {} });
      if (q.method === 'tools/list') return send(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
      if (q.method === 'tools/call') {
        try { return send(res, 200, { jsonrpc: '2.0', id, result: await callTool(q.params.name, q.params.arguments || {}, origin) }); }
        catch (e) { return send(res, 200, { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String(e.message) }] } }); }
      }
      return send(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
    }
    // plain REST versions of the mock SBMD paths
    if (m === 'POST' && p === '/ps/api/v1/public/subscriptions/sbmd') { const b = await readBody(req); if (String(b.customer_id || '').includes('TIMEOUT')) return; const [c, o] = createSub(b); return send(res, c, o); }
    if (m === 'GET' && (mm = p.match(/^\/ps\/api\/v1\/public\/subscriptions\/sbmd\/([^/]+)$/))) { const [c, o] = getSub(mm[1]); return send(res, c, o); }
    if (m === 'POST' && p === '/ps/api/v1/public/presentations') { const [c, o] = debit(await readBody(req)); return send(res, c, o); }
    if (m === 'POST' && (mm = p.match(/^\/mock\/approve\/([^/]+)$/))) { const [c, o] = approve(mm[1]); return send(res, c, o); }
    send(res, 404, { code: 'NO_SUCH_ENDPOINT' });
  } catch (e) { send(res, 500, { code: 'SERVER_ERROR', message: String(e.message) }); }
}).listen(process.env.PORT || 3000, () => console.log('artha tool server up'));
