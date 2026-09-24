// Servidor de la app de precios ELYCON.
// - Sirve index.html
// - POST /api/precios-web  { material }  -> busca precios en tiendas de Colombia con Claude + búsqueda web
// Variables de entorno:
//   ANTHROPIC_API_KEY  (obligatoria para la búsqueda web)
//   CODIGO_ACCESO      (opcional: si se define, la app lo pide antes de buscar)
//   CLAUDE_MODEL       (opcional, por defecto claude-sonnet-4-5)
//   LIMITE_POR_HORA    (opcional, búsquedas por IP por hora, por defecto 30)
//   TIENDAS            (opcional, dominios donde se busca primero, separados por coma)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CODIGO = process.env.CODIGO_ACCESO || '';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
const LIMITE = parseInt(process.env.LIMITE_POR_HORA || '30', 10);
const API_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';

const INDEX = path.join(__dirname, 'index.html');

// ---- límite simple por IP ----
const usos = new Map();
function permitido(ip) {
  const ahora = Date.now(), hora = 3600e3;
  const lista = (usos.get(ip) || []).filter(t => ahora - t < hora);
  if (lista.length >= LIMITE) { usos.set(ip, lista); return false; }
  lista.push(ahora); usos.set(ip, lista); return true;
}

// ---- caché de 12 h para no repetir la misma búsqueda ----
const cache = new Map();
const CACHE_MS = 12 * 3600e3;

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function leerCuerpo(req) {
  return new Promise((ok, mal) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 10000) { mal(new Error('Cuerpo muy grande')); req.destroy(); } });
    req.on('end', () => ok(d));
    req.on('error', mal);
  });
}

// Tiendas donde se busca primero (se pueden cambiar con la variable TIENDAS, separadas por coma)
const TIENDAS = (process.env.TIENDAS || 'interelectricas.com.co,homecenter.com.co,easy.com.co,mercadolibre.com.co')
  .split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
const MINIMO = 3;

const PROMPT = (material, restringida, yaTengo) => `Busca en la web el precio actual en Colombia (pesos colombianos, COP) de este material eléctrico:

"${material}"

Reglas:
- ${restringida
    ? `Busca SOLO en estas tiendas: ${TIENDAS.join(', ')}. Empieza por Interelectricas (interelectricas.com.co) y Homecenter (homecenter.com.co).`
    : 'Busca en tiendas o distribuidores eléctricos que vendan en Colombia (ferreterías, distribuidores eléctricos, Mercado Libre Colombia). Nada de tiendas de otros países.'}
${yaTengo.length ? `- Ya tengo estos enlaces, NO los repitas: ${yaTengo.join(' , ')}\n` : ''}- Cada precio debe venir de una página que hayas visto en los resultados de búsqueda, con su enlace exacto a la página del producto. No inventes precios ni enlaces.
- Interpreta el lenguaje de obra: "tubo imc" = tubería conduit IMC galvanizada, "emt" = conduit EMT, "breaker" = interruptor automático / breaker enchufable, "thhn 12" = cable THHN/THWN calibre 12 AWG.
- Si la descripción no trae medida, calibre o amperaje, busca la presentación más común en obra (por ejemplo tubo de 3 m de 1/2") y dilo en "nota".
- Marca "coincidencia":"exacta" si el producto coincide con lo pedido (medida, calibre, amperaje), o "similar" si es parecido pero con alguna diferencia.
- Indica la presentación del precio en "presentacion" (unidad, tubo de 3 m, rollo de 100 m, metro, caja x 10...).
- Da el precio tal como lo muestra la tienda e indica si incluye IVA (si la página dice "+ IVA" o "antes de IVA", incluye_iva=false).
- Busca mínimo ${MINIMO} y máximo 6 referencias, cada una de una página distinta. Si no encuentras ninguna, devuelve la lista vacía y explica en "nota" qué dato falta.

Responde SOLO con un JSON válido, sin texto adicional, con esta forma:
{"referencias":[{"precio":12345,"incluye_iva":true,"tienda":"Nombre de la tienda","url":"https://...","producto":"nombre del producto en la tienda","presentacion":"tubo de 3 m","coincidencia":"exacta"}],"nota":"observación breve en español o cadena vacía"}`;

async function llamarClaude(messages, dominios) {
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      messages,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 6,
        ...(dominios ? { allowed_domains: dominios } : {}),
        user_location: { type: 'approximate', country: 'CO', city: 'Bucaramanga', region: 'Santander', timezone: 'America/Bogota' },
      }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || `HTTP ${r.status}`;
    throw new Error('Error de la API de Claude: ' + msg);
  }
  return data;
}

function extraerJSON(texto) {
  const a = texto.indexOf('{'), b = texto.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(texto.slice(a, b + 1)); } catch { return null; }
}

// Precio en pesos: acepta 19900, "19.900", "$ 19.900,00", "19,900"
function aPesos(v) {
  if (typeof v === 'number') return Math.round(v);
  let t = String(v || '').replace(/[^\d.,]/g, '');
  t = t.replace(/[.,]\d{1,2}$/, '');   // decimales tipo ,00
  return parseInt(t.replace(/[.,]/g, ''), 10) || 0;
}

function normUrl(u) {
  try { const x = new URL(u); x.hash = ''; return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '')).toLowerCase(); }
  catch { return ''; }
}

async function buscarUnaVez(material, restringida, yaTengo) {
  const messages = [{ role: 'user', content: PROMPT(material, restringida, yaTengo) }];
  const vistas = new Set();   // URLs que realmente aparecieron en la búsqueda
  let data, texto = '';
  for (let i = 0; i < 4; i++) {
    data = await llamarClaude(messages, restringida ? TIENDAS : null);
    for (const b of data.content || []) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const r of b.content) if (r.url) vistas.add(normUrl(r.url));
      }
      if (b.type === 'text') {
        texto += b.text;
        for (const c of b.citations || []) if (c.url) vistas.add(normUrl(c.url));
      }
    }
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }
  const out = extraerJSON(texto) || { referencias: [], nota: '' };
  const refs = [];
  let descartadas = 0;
  const vistasHost = new Set([...vistas].map(u => u.split('/')[0]));
  for (const r of Array.isArray(out.referencias) ? out.referencias : []) {
    const precio = aPesos(r.precio);
    const url = String(r.url || '');
    const n = normUrl(url);
    const ok = precio > 0 && /^https?:\/\//.test(url) && r.tienda &&
      (vistas.has(n) || vistasHost.has(n.split('/')[0]));
    if (!ok) { descartadas++; continue; }
    refs.push({
      precio,
      incluye_iva: r.incluye_iva !== false,
      tienda: String(r.tienda || '').slice(0, 80),
      url,
      producto: String(r.producto || '').slice(0, 200),
      presentacion: String(r.presentacion || '').slice(0, 80),
      coincidencia: r.coincidencia === 'similar' ? 'similar' : 'exacta',
      verificada: vistas.has(n),
    });
  }
  console.log(`[busqueda] "${material}" · ${restringida ? 'tiendas preferidas' : 'web abierta'} · urls vistas: ${vistas.size} · validas: ${refs.length} · descartadas: ${descartadas}`);
  return { refs, descartadas, nota: String(out.nota || '') };
}

async function buscarPrecios(material) {
  // 1) tiendas preferidas (Interelectricas, Homecenter...)
  const a = await buscarUnaVez(material, true, []);
  let refs = a.refs, descartadas = a.descartadas, nota = a.nota;
  // 2) si faltan referencias exactas para llegar al mínimo, se amplía a toda la web de Colombia
  if (refs.filter(r => r.coincidencia === 'exacta').length < MINIMO) {
    const b = await buscarUnaVez(material, false, refs.map(r => r.url));
    const ya = new Set(refs.map(r => normUrl(r.url)));
    refs = refs.concat(b.refs.filter(r => !ya.has(normUrl(r.url))));
    descartadas += b.descartadas;
    if (!nota) nota = b.nota;
  }
  const pref = r => TIENDAS.some(t => normUrl(r.url).startsWith(t) || normUrl(r.url).includes('.' + t)) ? 0 : 1;
  refs.sort((x, y) => (x.coincidencia === 'exacta' ? 0 : 1) - (y.coincidencia === 'exacta' ? 0 : 1) || pref(x) - pref(y));
  return { material, referencias: refs.slice(0, 8), descartadas, nota, tiendas: TIENDAS, modelo: MODEL };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(INDEX).pipe(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/estado') {
    return json(res, 200, { busqueda_web: !!API_KEY, pide_codigo: !!CODIGO, tiendas: TIENDAS });
  }

  if (req.method === 'POST' && url.pathname === '/api/precios-web') {
    if (!API_KEY) return json(res, 503, { error: 'La búsqueda web no está configurada: falta ANTHROPIC_API_KEY en Render.' });
    if (CODIGO && req.headers['x-codigo-acceso'] !== CODIGO) return json(res, 401, { error: 'Código de acceso incorrecto.' });
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    let material = '';
    try { material = String(JSON.parse(await leerCuerpo(req)).material || '').trim().slice(0, 200); }
    catch { return json(res, 400, { error: 'Solicitud inválida.' }); }
    if (material.length < 3) return json(res, 400, { error: 'Escribe el material con su medida.' });

    const clave = material.toLowerCase().replace(/\s+/g, ' ');
    const c = cache.get(clave);
    if (c && Date.now() - c.t < CACHE_MS) return json(res, 200, { ...c.v, cache: true });

    if (!permitido(ip)) return json(res, 429, { error: `Límite de ${LIMITE} búsquedas por hora alcanzado. Intenta más tarde.` });
    try {
      const v = await buscarPrecios(material);
      if (v.referencias.length) cache.set(clave, { t: Date.now(), v });
      return json(res, 200, v);
    } catch (e) {
      console.error(e);
      return json(res, 502, { error: e.message || 'Falló la búsqueda web.' });
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('No encontrado');
});

server.listen(PORT, () => console.log(`Precios ELYCON en puerto ${PORT} · búsqueda web ${API_KEY ? 'activa' : 'SIN CONFIGURAR'}`));
