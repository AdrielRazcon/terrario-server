const admin = require('firebase-admin');
const http = require('http');

// Configuración de Firebase
let serviceAccount;
if (process.env.SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
} else {
  try {
    serviceAccount = require('./serviceAccountKey.json');
  } catch (e) {
    console.error('❌ Falta serviceAccountKey.json o variable SERVICE_ACCOUNT_JSON');
    process.exit(1);
  }
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TICK_INTERVAL = 3000;

// Decaimientos por tick
const DECAY = {
  hambre: 0.5,
  sed: 0.5,
  aburrimiento: 0.3,
  sueño: 0.4,
  saludExtrema: 1       // cuando hambre y sed están al 100%
};

const UMBRAL = {
  hambreCritica: 70,
  sedCritica: 70,
  aburrimientoCritico: 60,
  sueñoCritico: 70,
  saludBaja: 30
};

// Símbolos del mapa
const SYMBOLS = {
  comida: 'C',
  agua: 'A',
  cama: 'B',
  juguete: 'J',
  suelo: 'S',
  muro: 'M',
  popo: 'P'
};

// ===================== Pathfinding A* =====================
function aStar(mapa, startX, startY, targetX, targetY) {
  const rows = mapa.length;
  const cols = mapa[0].length;
  const open = [];
  const closed = new Set();
  const gScores = new Map();
  const fScores = new Map();
  const cameFrom = new Map();

  const key = (x, y) => `${x},${y}`;

  const heuristic = (x, y) => Math.abs(x - targetX) + Math.abs(y - targetY); // Manhattan

  const startKey = key(startX, startY);
  gScores.set(startKey, 0);
  fScores.set(startKey, heuristic(startX, startY));
  open.push({ x: startX, y: startY, f: fScores.get(startKey) });

  while (open.length > 0) {
    // Ordenar por fScore más bajo (podríamos usar una cola de prioridad, pero así funciona)
    open.sort((a, b) => a.f - b.f);
    const current = open.shift();
    const currentKey = key(current.x, current.y);

    if (current.x === targetX && current.y === targetY) {
      // Reconstruir camino
      const path = [];
      let k = currentKey;
      while (k) {
        const [x, y] = k.split(',').map(Number);
        path.unshift({ x, y });
        k = cameFrom.get(k);
      }
      return path;
    }

    closed.add(currentKey);

    const neighbors = [
      { x: current.x + 1, y: current.y },
      { x: current.x - 1, y: current.y },
      { x: current.x, y: current.y + 1 },
      { x: current.x, y: current.y - 1 }
    ];

    for (const neighbor of neighbors) {
      const nx = neighbor.x, ny = neighbor.y;
      if (ny < 0 || ny >= rows || nx < 0 || nx >= cols) continue;
      const tile = mapa[ny][nx];
      if (tile === SYMBOLS.muro) continue; // no atravesable

      const neighborKey = key(nx, ny);
      if (closed.has(neighborKey)) continue;

      const tentativeG = (gScores.get(currentKey) || 0) + 1;
      if (!gScores.has(neighborKey) || tentativeG < gScores.get(neighborKey)) {
        cameFrom.set(neighborKey, currentKey);
        gScores.set(neighborKey, tentativeG);
        fScores.set(neighborKey, tentativeG + heuristic(nx, ny));
        open.push({ x: nx, y: ny, f: fScores.get(neighborKey) });
      }
    }
  }
  return null; // no hay camino
}

function moverConAStar(x, y, mapa, targetX, targetY) {
  const path = aStar(mapa, x, y, targetX, targetY);
  if (path && path.length > 1) {
    return path[1]; // siguiente paso (índice 0 es la posición actual)
  }
  return { x, y }; // no se mueve
}

// ===================== Funciones de IA =====================
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

function esTransitable(mapa, x, y) {
  return y >= 0 && y < mapa.length && x >= 0 && x < mapa[0].length && mapa[y][x] !== SYMBOLS.muro;
}

function emocion(est) {
  const f = est.felicidad ?? (100 - (est.hambre + est.sed + est.aburrimiento + est.sueño) / 4);
  if (f > 70) return 'feliz'; else if (f > 40) return 'neutro'; else if (f > 20) return 'triste'; else return 'enojado';
}

async function procesarMascota(doc) {
  const data = doc.data();
  if (!data.uid) return;

  // Inicializar estadísticas si faltan (por migración)
  let est = data.estadisticas || { hambre: 50, sed: 50, aburrimiento: 30, sueño: 30, salud: 80 };
  est.hambre = est.hambre ?? 50;
  est.sed = est.sed ?? 50;
  est.aburrimiento = est.aburrimiento ?? 30;
  est.sueño = est.sueño ?? 30;
  est.salud = est.salud ?? 80;

  // Aplicar decaimientos
  est.hambre = Math.min(100, est.hambre + DECAY.hambre);
  est.sed = Math.min(100, est.sed + DECAY.sed);
  est.aburrimiento = Math.min(100, est.aburrimiento + DECAY.aburrimiento);
  est.sueño = Math.min(100, est.sueño + DECAY.sueño);

  // Salud solo baja si hambre Y sed están al tope
  if (est.hambre >= 100 && est.sed >= 100) {
    est.salud = Math.max(0, est.salud - DECAY.saludExtrema);
  }

  // Decidir acción
  let accion = data.accionActual || 'vagar';
  const tarea = data.tareaAsignada;

  if (tarea && est.hambre < UMBRAL.hambreCritica && est.sed < UMBRAL.sedCritica && est.salud > 20) {
    accion = 'tarea_asignada';
  } else if (est.hambre > UMBRAL.hambreCritica) {
    accion = 'buscar_comida';
  } else if (est.sed > UMBRAL.sedCritica) {
    accion = 'buscar_agua';
  } else if (est.aburrimiento > UMBRAL.aburrimientoCritico) {
    accion = 'buscar_juguete';
  } else if (est.sueño > UMBRAL.sueñoCritico) {
    accion = 'buscar_cama';
  } else {
    accion = 'vagar';
  }

  let { x, y } = data;
  const mapa = data.mapa;

  // Ejecutar acción con A*
  const ejecutarBusqueda = async (tipo, simbolo) => {
    const coord = encontrarMasCercano(mapa, x, y, simbolo);
    if (coord) {
      const paso = moverConAStar(x, y, mapa, coord.x, coord.y);
      x = paso.x; y = paso.y;
      if (x === coord.x && y === coord.y) {
        // Interacción: satisfacer necesidad
        if (tipo === 'comida') est.hambre = Math.max(0, est.hambre - 30);
        else if (tipo === 'agua') est.sed = Math.max(0, est.sed - 30);
        else if (tipo === 'juguete') est.aburrimiento = Math.max(0, est.aburrimiento - 25);
        else if (tipo === 'cama') est.sueño = Math.max(0, est.sueño - 40);
        if (tarea && tarea.tipo === tipo) data.tareaAsignada = null;
      }
    }
  };

  if (accion === 'tarea_asignada' && tarea) {
    const simbolo = SYMBOLS[tarea.tipo];
    if (simbolo) await ejecutarBusqueda(tarea.tipo, simbolo);
  } else if (accion === 'buscar_comida') {
    await ejecutarBusqueda('comida', SYMBOLS.comida);
  } else if (accion === 'buscar_agua') {
    await ejecutarBusqueda('agua', SYMBOLS.agua);
  } else if (accion === 'buscar_juguete') {
    await ejecutarBusqueda('juguete', SYMBOLS.juguete);
  } else if (accion === 'buscar_cama') {
    await ejecutarBusqueda('cama', SYMBOLS.cama);
  } else if (accion === 'vagar') {
    const dirs = [[0,1],[0,-1],[1,0],[-1,0]].sort(() => Math.random() - 0.5);
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (esTransitable(mapa, nx, ny)) {
        x = nx; y = ny;
        break;
      }
    }
  }

  // Defecación: probabilidad del 5% si está sobre suelo
  if (Math.random() < 0.05 && mapa[y] && mapa[y][x] === SYMBOLS.suelo) {
    // Convertir esa celda en popó
    const fila = mapa[y];
    mapa[y] = fila.substring(0, x) + SYMBOLS.popo + fila.substring(x + 1);
    // Guardar el mapa actualizado
    data.mapa = mapa;
  }

  // Guardar cambios
  await doc.ref.update({
    x, y,
    mapa: data.mapa,
    estadisticas: est,
    emocion: emocion(est),
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

tick();
setInterval(tick, TICK_INTERVAL);
console.log('🧠 Servidor con A* corriendo cada', TICK_INTERVAL/1000, 's');

// Servidor HTTP mínimo para Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Mascota virtual viva 🐜');
}).listen(PORT, () => {
  console.log(`🌐 Health check escuchando en puerto ${PORT}`);
});