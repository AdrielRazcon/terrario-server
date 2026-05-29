const admin = require('firebase-admin');
let serviceAccount;
if (process.env.SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const TICK_INTERVAL = 3000;

const DECAY_HAMBRE = 0.5;
const DECAY_ABURRIMIENTO = 0.3;
const DECAY_SALUD_EXTREMA = 1;
const HAMBRE_CRITICA = 70;
const ABURRIMIENTO_CRITICO = 60;
const SALUD_BAJA = 30;

// Mapeo de símbolos que usa el mapa (S, M, C, A, B, J)
const SYMBOLS = {
  comida: 'C',
  agua: 'A',
  cama: 'B',
  juguete: 'J'
};

function encontrarMasCercano(mapa, x, y, charObjetivo) {
  let mejor = null, mejorDist = Infinity;
  for (let fy = 0; fy < mapa.length; fy++) {
    for (let fx = 0; fx < mapa[fy].length; fx++) {
      if (mapa[fy][fx] === charObjetivo) {
        const dist = Math.abs(fx - x) + Math.abs(fy - y);
        if (dist < mejorDist) {
          mejorDist = dist;
          mejor = { x: fx, y: fy };
        }
      }
    }
  }
  return mejor;
}

function esTransitable(x, y, mapa) {
  return y >= 0 && y < mapa.length && x >= 0 && x < mapa[0].length && mapa[y][x] !== 'M'; // 'M' es muro
}

function moverHacia(x, y, tx, ty, mapa) {
  const dx = Math.sign(tx - x);
  const dy = Math.sign(ty - y);
  if (Math.abs(tx - x) > Math.abs(ty - y)) {
    if (esTransitable(x + dx, y, mapa)) return { x: x + dx, y };
    if (esTransitable(x, y + dy, mapa)) return { x, y: y + dy };
  } else {
    if (esTransitable(x, y + dy, mapa)) return { x, y: y + dy };
    if (esTransitable(x + dx, y, mapa)) return { x: x + dx, y };
  }
  return { x, y };
}

function calcularEmocion(est) {
  const f = est.felicidad ?? (100 - (est.hambre + est.aburrimiento) / 2);
  if (f > 70) return 'feliz';
  if (f > 40) return 'neutro';
  if (f > 20) return 'triste';
  return 'enojado';
}

async function procesarMascota(doc) {
  const data = doc.data();
  if (!data.uid) return;

  let { hambre, aburrimiento, salud } = data.estadisticas;
  hambre = Math.min(100, hambre + DECAY_HAMBRE);
  aburrimiento = Math.min(100, aburrimiento + DECAY_ABURRIMIENTO);
  if (hambre >= 90 || aburrimiento >= 90) {
    salud = Math.max(0, salud - DECAY_SALUD_EXTREMA);
  }

  let accion = data.accionActual || 'vagar';
  let tarea = data.tareaAsignada;

  if (tarea && hambre < HAMBRE_CRITICA && salud > 20) {
    accion = 'tarea_asignada';
  } else if (hambre > HAMBRE_CRITICA) {
    accion = 'buscar_comida';
  } else if (aburrimiento > ABURRIMIENTO_CRITICO) {
    accion = 'buscar_juguete';
  } else if (salud < SALUD_BAJA) {
    accion = 'buscar_cama';
  } else {
    accion = 'vagar';
  }

  let { x, y } = data;
  const mapa = data.mapa;

  if (accion === 'tarea_asignada' && tarea) {
    const tipo = tarea.tipo; // 'comida', 'juguete', 'cama'
    const charObjetivo = SYMBOLS[tipo];
    if (charObjetivo) {
      const coords = encontrarMasCercano(mapa, x, y, charObjetivo);
      if (coords) {
        const nuevo = moverHacia(x, y, coords.x, coords.y, mapa);
        x = nuevo.x; y = nuevo.y;
        if (x === coords.x && y === coords.y) {
          // Interactuar
          if (tipo === 'comida') hambre = Math.max(0, hambre - 30);
          else if (tipo === 'juguete') aburrimiento = Math.max(0, aburrimiento - 25);
          else if (tipo === 'cama') salud = Math.min(100, salud + 20);
          data.tareaAsignada = null;
        }
      }
    }
  } else if (accion.startsWith('buscar_')) {
    const tipo = accion.replace('buscar_', '');
    const charObjetivo = SYMBOLS[tipo];
    if (charObjetivo) {
      const coords = encontrarMasCercano(mapa, x, y, charObjetivo);
      if (coords) {
        const nuevo = moverHacia(x, y, coords.x, coords.y, mapa);
        x = nuevo.x; y = nuevo.y;
        if (x === coords.x && y === coords.y) {
          if (tipo === 'comida') hambre = Math.max(0, hambre - 30);
          else if (tipo === 'juguete') aburrimiento = Math.max(0, aburrimiento - 25);
          else if (tipo === 'cama') salud = Math.min(100, salud + 20);
        }
      }
    }
  } else if (accion === 'vagar') {
    const dirs = [[0,1],[0,-1],[1,0],[-1,0]];
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (esTransitable(nx, ny, mapa)) {
        x = nx; y = ny;
        break;
      }
    }
  }

  const emocion = calcularEmocion({ hambre, aburrimiento, salud });

  await doc.ref.update({
    x, y,
    estadisticas: { hambre, aburrimiento, salud },
    emocion,
    accionActual: accion,
    tareaAsignada: data.tareaAsignada || null,
    ultimaActualizacion: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function tick() {
  const snapshot = await db.collection('mascotas').get();
  const promesas = [];
  snapshot.forEach(doc => promesas.push(procesarMascota(doc)));
  await Promise.all(promesas);
  console.log(`Tick para ${promesas.length} mascotas`);
}

tick();
setInterval(tick, TICK_INTERVAL);
console.log('Servidor de mascotas en marcha');  