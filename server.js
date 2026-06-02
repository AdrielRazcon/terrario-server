const admin = require('firebase-admin');
const http = require('http');

// Configuración de Firebase
let serviceAccount;
if (process.env.SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
} else {
  try { serviceAccount = require('./serviceAccountKey.json'); }
  catch (e) { console.error('❌ Falta clave'); process.exit(1); }
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TICK_INTERVAL = 2000;
const TICKS_POR_HORA = 30;
let tickCount = 0;

const SYMB = {
  suelo: 'S', muro: 'M', comida: 'C', agua: 'A', cama: 'B', juguete: 'J',
  arbusto: 'Y', almacen: 'L', pozo: 'W', muerto: 'D'
};

const DECAY = {
  hambre: 0.08, sed: 0.08, aburrimiento: 0.05, sueño: 0.06
};
const UMBRAL = {
  hambreCritica: 70, sedCritica: 70, aburrimientoCritico: 60, sueñoCritico: 70,
  saludBaja: 30
};

// Pathfinding A* (sin cambios)
function aStar(mapa, startX, startY, targetX, targetY) {
  const rows = mapa.length, cols = mapa[0].length;
  const open = [], closed = new Set();
  const gScores = new Map(), fScores = new Map(), cameFrom = new Map();
  const key = (x, y) => `${x},${y}`;
  const heuristic = (x, y) => Math.abs(x - targetX) + Math.abs(y - targetY);

  open.push({ x: startX, y: startY, f: heuristic(startX, startY) });
  gScores.set(key(startX, startY), 0);
  fScores.set(key(startX, startY), heuristic(startX, startY));

  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f);
    const current = open.shift();
    const ck = key(current.x, current.y);
    if (current.x === targetX && current.y === targetY) {
      const path = [];
      let k = ck;
      while (k) {
        const [x, y] = k.split(',').map(Number);
        path.unshift({ x, y });
        k = cameFrom.get(k);
      }
      return path;
    }
    closed.add(ck);
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = current.x + dx, ny = current.y + dy;
      if (ny < 0 || ny >= rows || nx < 0 || nx >= cols) continue;
      if (mapa[ny][nx] === SYMB.muro) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const tg = (gScores.get(ck) || 0) + 1;
      if (!gScores.has(nk) || tg < gScores.get(nk)) {
        cameFrom.set(nk, ck);
        gScores.set(nk, tg);
        fScores.set(nk, tg + heuristic(nx, ny));
        open.push({ x: nx, y: ny, f: fScores.get(nk) });
      }
    }
  }
  return null;
}

function moverHaciaConAStar(x, y, mapa, tx, ty) {
  const path = aStar(mapa, x, y, tx, ty);
  if (path && path.length > 1) return path[1];
  return { x, y };
}

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
  return y >= 0 && y < mapa.length && x >= 0 && x < mapa[0].length && mapa[y][x] !== SYMB.muro;
}

function calcularEmocion(est) {
  const bienestar = 100 - (est.hambre + est.sed + est.aburrimiento + est.sueño) / 4;
  if (bienestar > 70) return 'feliz';
  if (bienestar > 40) return 'neutro';
  if (bienestar > 20) return 'triste';
  return 'enojado';
}

// ==================== Procesamiento de una criatura ====================
async function procesarCriatura(docRef, criaturaId, colonia, mapa, recursos, hora) {
  const criaturaDoc = await docRef.collection('criaturas').doc(criaturaId).get();
  if (!criaturaDoc.exists) return;
  const data = criaturaDoc.data();
  if (data.estado !== 'viva') return;

  let est = data.estadisticas;
  let x = data.x, y = data.y;

  // Decaimientos
  est.hambre = Math.min(100, est.hambre + DECAY.hambre);
  est.sed = Math.min(100, est.sed + DECAY.sed);
  est.aburrimiento = Math.min(100, est.aburrimiento + DECAY.aburrimiento);
  est.sueño = Math.min(100, est.sueño + DECAY.sueño);

  // Enfermedad
  if (!est.enfermedad && Math.random() < 0.001) est.enfermedad = true;
  if (est.enfermedad) est.salud = Math.max(0, est.salud - 0.3);

  // Muerte por causas naturales
  if (est.salud <= 0 || est.hambre >= 100 || est.sed >= 100 || data.edad >= data.edadMaxima) {
    const fila = mapa[y];
    mapa[y] = fila.substring(0, x) + SYMB.muerto + fila.substring(x + 1);
    await criaturaDoc.ref.update({ estado: 'muerta' });
    return;
  }

  // Decidir acción
  const esDeNoche = (hora >= 20 || hora < 6);
  let accion = 'vagar';
  let objetivoChar = null;

  if (data.tareaAsignada) {
    accion = 'tarea';
    objetivoChar = SYMB[data.tareaAsignada.tipo] || null;
    if (!objetivoChar) accion = 'vagar';
  } else if (est.hambre > UMBRAL.hambreCritica) {
    if (recursos.comida > 0) {
      accion = 'ir_almacen_comer';
      objetivoChar = SYMB.almacen;
    } else {
      accion = 'buscar_comida';
      objetivoChar = SYMB.comida;
    }
  } else if (est.sed > UMBRAL.sedCritica) {
    if (recursos.agua > 0) {
      accion = 'ir_almacen_beber';
      objetivoChar = SYMB.almacen;
    } else {
      accion = 'buscar_agua';
      objetivoChar = SYMB.agua;
    }
  } else if (est.aburrimiento > UMBRAL.aburrimientoCritico) {
    accion = 'buscar_juguete';
    objetivoChar = SYMB.juguete;
  } else if (est.sueño > UMBRAL.sueñoCritico || (esDeNoche && est.sueño > 50)) {
    accion = 'buscar_cama';
    objetivoChar = SYMB.cama;
  } else {
    // Recolección si hay arbustos y espacio en almacén
    const hayArbusto = mapa.some(fila => fila.includes(SYMB.arbusto));
    if (hayArbusto && recursos.comida < 20) {
      accion = 'recolectar';
      objetivoChar = SYMB.arbusto;
    } else {
      accion = 'vagar';
    }
  }

  // Movimiento e interacción
  if (objetivoChar) {
    const coords = encontrarMasCercano(mapa, x, y, objetivoChar);
    if (coords) {
      const paso = moverHaciaConAStar(x, y, mapa, coords.x, coords.y);
      x = paso.x; y = paso.y;
      if (x === coords.x && y === coords.y) {
        const tile = mapa[coords.y][coords.x];
        if (accion === 'ir_almacen_comer') {
          if (recursos.comida > 0) {
            est.hambre = Math.max(0, est.hambre - 30);
            recursos.comida--;
          }
        } else if (accion === 'ir_almacen_beber') {
          if (recursos.agua > 0) {
            est.sed = Math.max(0, est.sed - 30);
            recursos.agua--;
          }
        } else if (accion === 'buscar_comida' && tile === SYMB.comida) {
          est.hambre = Math.max(0, est.hambre - 25);
        } else if (accion === 'buscar_agua' && tile === SYMB.agua) {
          est.sed = Math.max(0, est.sed - 25);
        } else if (accion === 'buscar_juguete' && tile === SYMB.juguete) {
          est.aburrimiento = Math.max(0, est.aburrimiento - 20);
        } else if (accion === 'buscar_cama' && tile === SYMB.cama) {
          est.sueño = Math.max(0, est.sueño - 35);
        } else if (accion === 'recolectar' && tile === SYMB.arbusto) {
          recursos.comida++;
          if (Math.random() < 0.3) {
            const fila = mapa[coords.y];
            mapa[coords.y] = fila.substring(0, coords.x) + SYMB.suelo + fila.substring(coords.x + 1);
          }
        }
        data.tareaAsignada = null;
      }
    }
  } else if (accion === 'vagar') {
    const dirs = [[0,1],[0,-1],[1,0],[-1,0]].sort(() => Math.random() - 0.5);
    for (const [dx, dy] of dirs) {
      if (esTransitable(mapa, x + dx, y + dy)) {
        x += dx; y += dy;
        break;
      }
    }
  }

  await criaturaDoc.ref.update({
    estadisticas: est,
    x, y,
    tareaAsignada: data.tareaAsignada,
    emocion: calcularEmocion(est)
  });

  return { recursos };
}

// ==================== Reglas de población y nacimientos ====================
async function aplicarReglasPoblacion(docRef, criaturasVivas, mapa) {
  const machos = criaturasVivas.filter(c => c.sexo === 'macho' && c.edad >= 3);
  const hembras = criaturasVivas.filter(c => c.sexo === 'hembra' && c.edad >= 3);
  const limiteMachos = 1;
  const limiteHembras = 5;

  // Peleas entre machos
  while (machos.length > limiteMachos) {
    const perdedor = machos.pop();
    await docRef.collection('criaturas').doc(perdedor.id).update({ estado: 'muerta' });
    const fila = mapa[perdedor.y];
    mapa[perdedor.y] = fila.substring(0, perdedor.x) + SYMB.muerto + fila.substring(perdedor.x + 1);
  }

  // Peleas entre hembras
  while (hembras.length > limiteHembras) {
    const perdedor = hembras.pop();
    await docRef.collection('criaturas').doc(perdedor.id).update({ estado: 'muerta' });
    const fila = mapa[perdedor.y];
    mapa[perdedor.y] = fila.substring(0, perdedor.x) + SYMB.muerto + fila.substring(perdedor.x + 1);
  }

  // Reproducción
  if (machos.length > 0 && hembras.length > 0) {
    const hembraDisponible = hembras.find(h => !h.embarazada);
    if (hembraDisponible && Math.random() < 0.05) {
      await docRef.collection('criaturas').doc(hembraDisponible.id).update({
        embarazada: true,
        tiempoRestanteEmbarazo: 100
      });
    }
  }

  // Progreso de embarazos
  const embarazadas = criaturasVivas.filter(c => c.embarazada);
  for (const hembra of embarazadas) {
    let nuevoTiempo = hembra.tiempoRestanteEmbarazo - 1;
    if (nuevoTiempo <= 0) {
      // Nacer cría
      const sexo = Math.random() < 0.5 ? 'macho' : 'hembra';
      const { x, y } = hembra;
      let nx = x, ny = y;
      const dirs = [[0,1],[0,-1],[1,0],[-1,0]];
      for (const [dx, dy] of dirs) {
        if (esTransitable(mapa, x+dx, y+dy)) { nx = x+dx; ny = y+dy; break; }
      }
      const nuevoRef = await docRef.collection('criaturas').add({
        nombre: `Cria ${Math.floor(Math.random()*1000)}`,
        sexo,
        edad: 0,
        edadMaxima: 20,
        embarazada: false,
        tiempoRestanteEmbarazo: 0,
        estadisticas: { hambre: 50, sed: 50, aburrimiento: 0, sueño: 0, salud: 100, enfermedad: false },
        estado: 'viva',
        x: nx,
        y: ny,
        tareaAsignada: null
      });
      await docRef.collection('criaturas').doc(hembra.id).update({
        embarazada: false,
        tiempoRestanteEmbarazo: 0
      });
    } else {
      await docRef.collection('criaturas').doc(hembra.id).update({ tiempoRestanteEmbarazo: nuevoTiempo });
    }
  }
}

// ==================== Tick principal ====================
async function tick() {
  const coloniasSnap = await db.collection('mascotas').get();
  coloniasSnap.forEach(async doc => {
    const colonia = doc.data();
    if (colonia.finDelJuego) return;

    // Inicializar campos si faltan
    let mapa = colonia.mapa;
    let recursos = colonia.recursos || { comida: 0, agua: 0 };
    let hora = colonia.horaDelDia ?? 12;
    let dias = colonia.diasTranscurridos ?? 0;

    // --- INICIALIZACIÓN DE CRIATURAS INICIALES ---
    const criaturasSnap = await doc.collection('criaturas').get();
    if (criaturasSnap.empty) {
      // Buscar posiciones libres en el mapa
      let pos1 = null, pos2 = null;
      for (let y = 1; y < mapa.length-1; y++) {
        for (let x = 1; x < mapa[0].length-1; x++) {
          if (mapa[y][x] === SYMB.suelo) {
            if (!pos1) pos1 = { x, y };
            else if (!pos2) { pos2 = { x, y }; break; }
          }
        }
        if (pos2) break;
      }
      if (!pos1) pos1 = { x: 1, y: 1 };
      if (!pos2) pos2 = { x: 2, y: 1 };

      await doc.collection('criaturas').add({
        nombre: 'Adam',
        sexo: 'macho',
        edad: 5,
        edadMaxima: 20,
        embarazada: false,
        tiempoRestanteEmbarazo: 0,
        estadisticas: { hambre: 50, sed: 50, aburrimiento: 0, sueño: 0, salud: 100, enfermedad: false },
        estado: 'viva',
        x: pos1.x,
        y: pos1.y,
        tareaAsignada: null
      });
      await doc.collection('criaturas').add({
        nombre: 'Eva',
        sexo: 'hembra',
        edad: 5,
        edadMaxima: 20,
        embarazada: false,
        tiempoRestanteEmbarazo: 0,
        estadisticas: { hambre: 50, sed: 50, aburrimiento: 0, sueño: 0, salud: 100, enfermedad: false },
        estado: 'viva',
        x: pos2.x,
        y: pos2.y,
        tareaAsignada: null
      });

      // También añadir un arbusto inicial y un almacén si no existen (opcional)
      // ...
    }

    // Actualizar hora y días
    tickCount++;
    if (tickCount % TICKS_POR_HORA === 0) {
      hora = (hora + 1) % 24;
      if (hora === 0) {
        dias++;
        // Aumentar edad de criaturas vivas
        const vivasSnap = await doc.collection('criaturas').where('estado', '==', 'viva').get();
        vivasSnap.forEach(c => c.ref.update({ edad: admin.firestore.FieldValue.increment(1) }));
      }
    }

    // Obtener criaturas vivas (ahora ya existen)
    const vivasSnap = await doc.collection('criaturas').where('estado', '==', 'viva').get();
    const criaturasVivas = [];
    vivasSnap.forEach(c => criaturasVivas.push({ id: c.id, ...c.data() }));

    // Procesar cada criatura
    for (const criatura of criaturasVivas) {
      const result = await procesarCriatura(doc, criatura.id, colonia, mapa, recursos, hora);
      if (result && result.recursos) recursos = result.recursos;
    }

    // Reglas de población (ahora con criaturas actualizadas)
    await aplicarReglasPoblacion(doc, criaturasVivas, mapa);

    // Reaparición de arbustos
    if (hora === 6 && Math.random() < 0.7) {
      const suelos = [];
      for (let y = 0; y < mapa.length; y++) {
        for (let x = 0; x < mapa[y].length; x++) {
          if (mapa[y][x] === SYMB.suelo) suelos.push({ x, y });
        }
      }
      if (suelos.length > 0) {
        const { x, y } = suelos[Math.floor(Math.random() * suelos.length)];
        mapa[y] = mapa[y].substring(0, x) + SYMB.arbusto + mapa[y].substring(x + 1);
      }
    }

    // Verificar fin del juego
    const vivasDespues = (await doc.collection('criaturas').where('estado', '==', 'viva').get()).size;
    if (vivasDespues === 0 && criaturasSnap.size > 0) {
      await doc.update({ finDelJuego: true, puntuacion: dias });
    }

    // Guardar colonia
    await doc.update({
      mapa, recursos, horaDelDia: hora, diasTranscurridos: dias
    });
  });
  console.log(`✅ Tick procesado`);
}

setInterval(tick, TICK_INTERVAL);
console.log('🧠 Servidor de colonia iniciado');

// Servidor HTTP para Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Colonia viva 🐜');
}).listen(PORT, () => console.log(`🌐 Health check puerto ${PORT}`));