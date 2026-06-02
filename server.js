const admin = require('firebase-admin');
const http = require('http');

// Configurar Firebase
let serviceAccount;
if (process.env.SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
} else {
  try {
    serviceAccount = require('./serviceAccountKey.json');
  } catch (e) {
    console.error('❌ No se encontró serviceAccountKey.json. Usa variable SERVICE_ACCOUNT_JSON en producción.');
    process.exit(1);
  }
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TICK_INTERVAL = 3000;
const DECAY = { hambre: 0.5, aburrimiento: 0.3, saludExtrema: 1 };
const UMBRAL = { hambreCritica: 70, aburrimientoCritico: 60, saludBaja: 30 };
const SYMBOLS = { comida: 'C', agua: 'A', cama: 'B', juguete: 'J' };

// Funciones auxiliares
function encontrarMasCercano(mapa, x, y, char) {
  let mejor = null, mejorDist = Infinity;
  for (let fy = 0; fy < mapa.length; fy++) {
    for (let fx = 0; fx < mapa[fy].length; fx++) {
      if (mapa[fy][fx] === char) {
        const dist = Math.abs(fx - x) + Math.abs(fy - y);
        if (dist < mejorDist) { mejorDist = dist; mejor = { x: fx, y: fy }; }
      }
    }
  }
  return mejor;
}

function esTransitable(x, y, mapa) {
  return y >= 0 && y < mapa.length && x >= 0 && x < mapa[0].length && mapa[y][x] !== 'M';
}

function moverHacia(x, y, tx, ty, mapa) {
  const dx = Math.sign(tx - x), dy = Math.sign(ty - y);
  if (Math.abs(tx - x) > Math.abs(ty - y)) {
    if (esTransitable(x + dx, y, mapa)) return { x: x + dx, y };
    if (esTransitable(x, y + dy, mapa)) return { x, y: y + dy };
  } else {
    if (esTransitable(x, y + dy, mapa)) return { x, y: y + dy };
    if (esTransitable(x + dx, y, mapa)) return { x: x + dx, y };
  }
  return { x, y };
}

function emocion(est) {
  const f = est.felicidad ?? (100 - (est.hambre + est.aburrimiento) / 2);
  if (f > 70) return 'feliz'; else if (f > 40) return 'neutro'; else if (f > 20) return 'triste'; else return 'enojado';
}

async function procesarMascota(doc) {
  const data = doc.data();
  if (!data.uid) return;
  let est = data.estadisticas;
  let hambre = Math.min(100, est.hambre + DECAY.hambre);
  let aburrimiento = Math.min(100, est.aburrimiento + DECAY.aburrimiento);
  let salud = est.salud;
  if (hambre >= 90 || aburrimiento >= 90) salud = Math.max(0, salud - DECAY.saludExtrema);

  let accion = data.accionActual || 'vagar';
  let tarea = data.tareaAsignada;

  if (tarea && hambre < UMBRAL.hambreCritica && salud > 20) accion = 'tarea_asignada';
  else if (hambre > UMBRAL.hambreCritica) accion = 'buscar_comida';
  else if (aburrimiento > UMBRAL.aburrimientoCritico) accion = 'buscar_juguete';
  else if (salud < UMBRAL.saludBaja) accion = 'buscar_cama';
  else accion = 'vagar';

  let { x, y } = data;
  const mapa = data.mapa;

  const ejecutarBusqueda = async (tipo, simbolo) => {
    const coord = encontrarMasCercano(mapa, x, y, simbolo);
    if (coord) {
      const nuevo = moverHacia(x, y, coord.x, coord.y, mapa);
      x = nuevo.x; y = nuevo.y;
      if (x === coord.x && y === coord.y) {
        if (tipo === 'comida') hambre = Math.max(0, hambre - 30);
        else if (tipo === 'juguete') aburrimiento = Math.max(0, aburrimiento - 25);
        else if (tipo === 'cama') salud = Math.min(100, salud + 20);
        if (tarea) data.tareaAsignada = null;
      }
    }
    return { x, y };
  };

  if (accion === 'tarea_asignada' && tarea) {
    const simbolo = SYMBOLS[tarea.tipo];
    if (simbolo) await ejecutarBusqueda(tarea.tipo, simbolo);
  } else if (accion.startsWith('buscar_')) {
    const tipo = accion.replace('buscar_', '');
    const simbolo = SYMBOLS[tipo];
    if (simbolo) await ejecutarBusqueda(tipo, simbolo);
  } else if (accion === 'vagar') {
    const dirs = [[0,1],[0,-1],[1,0],[-1,0]].sort(() => Math.random() - 0.5);
    for (const [dx, dy] of dirs) {
      if (esTransitable(x + dx, y + dy, mapa)) { x += dx; y += dy; break; }
    }
  }

  await doc.ref.update({
    x, y,
    estadisticas: { hambre, aburrimiento, salud },
    emocion: emocion({ hambre, aburrimiento, salud }),
    accionActual: accion,
    tareaAsignada: data.tareaAsignada || null,
    ultimaActualizacion: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function tick() {
  try {
    const snapshot = await db.collection('mascotas').get();
    const promesas = [];
    snapshot.forEach(doc => promesas.push(procesarMascota(doc)));
    await Promise.all(promesas);
    console.log(`✅ Tick para ${promesas.length} mascotas`);
  } catch (err) {
    console.error('Error en tick:', err);
  }
}

// Iniciar bucle de IA
tick();
setInterval(tick, TICK_INTERVAL);
console.log('🧠 Servidor de mascotas corriendo cada', TICK_INTERVAL/1000, 's');

// ─── Crear servidor HTTP mínimo para Render ───
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Mascota virtual viva 🐜');
});

server.listen(PORT, () => {
  console.log(`🌐 Servidor HTTP escuchando en puerto ${PORT} (para health check)`);
});