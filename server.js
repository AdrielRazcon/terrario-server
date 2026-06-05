const admin = require('firebase-admin');
const http = require('http');

// ─── Configuración de Firebase ───
let serviceAccount;
if (process.env.SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
} else {
  try { serviceAccount = require('./serviceAccountKey.json'); }
  catch (e) { console.error('❌ No se encontró clave de servicio'); process.exit(1); }
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TICK_INTERVAL = 1750;            // 1.75 segundos
const TICKS_POR_HORA = 10;            // 10 ticks = 1 hora → 240 ticks = 1 día = 7 minutos reales
const HORA_AMANECER = 6;
const HORA_ANOCHECER = 20;

const SYMB = {
  suelo: 'S', muro: 'M', comida: 'C', agua: 'A', cama: 'B', juguete: 'J',
  arbusto: 'Y', almacen: 'L', pozo: 'W', muerto: 'D', huevo: 'E'
};

const DECAY = {
  hambre: 0.08,
  sed: 0.08,
  aburrimiento: 0.05,
  sueño: 0.06,
};

const UMBRAL = {
  hambreCritica: 70,
  sedCritica: 70,
  aburrimientoCritico: 60,
  sueñoCritico: 70,
  hambreExtrema: 100
};

// ─── Pathfinding A* ───
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

// ─── Procesar una criatura ───
async function procesarCriatura(docRef, criaturaId, mapa, recursos, hora) {
  const criaturaDoc = await docRef.collection('criaturas').doc(criaturaId).get();
  if (!criaturaDoc.exists) return { recursos };
  const data = criaturaDoc.data();
  if (data.estado !== 'viva') return { recursos };

  let est = data.estadisticas;
  let x = data.x, y = data.y;
  const inventario = data.inventario || { tipo: null, cantidad: 0 };
  let accion = 'vagar';
  let objetivoChar = null;

  const esDeNoche = (hora >= 20 || hora < 6);
  const durmiendo = (data.accionActual === 'durmiendo');

  if (durmiendo) {
    est.salud = Math.min(100, est.salud + 5);
    if (est.enfermedad && est.salud >= 100) est.enfermedad = false;
    est.hambre = Math.min(100, est.hambre + DECAY.hambre * 2);
    est.sed = Math.min(100, est.sed + DECAY.sed * 2);
    est.sueño = Math.max(0, est.sueño - 0.5);
    if (est.sueño <= 0) {
      accion = 'despertar';
    }
  } else {
    est.hambre = Math.min(100, est.hambre + DECAY.hambre);
    est.sed = Math.min(100, est.sed + DECAY.sed);
    est.aburrimiento = Math.min(100, est.aburrimiento + DECAY.aburrimiento);
    est.sueño = Math.min(100, est.sueño + DECAY.sueño);

    if (!est.enfermedad && Math.random() < 0.001) est.enfermedad = true;
    if (est.enfermedad) {
      est.salud = Math.max(30, est.salud - 0.2);
    }

    if (est.salud <= 0 || data.edad >= data.edadMaxima) {
      const fila = mapa[y];
      mapa[y] = fila.substring(0, x) + SYMB.muerto + fila.substring(x + 1);
      await criaturaDoc.ref.update({ estado: 'muerta', accionActual: 'muerto' });
      return { recursos, mapaActualizado: true };
    }
  }

  if (!durmiendo || accion === 'despertar') {
    if (esDeNoche || est.sueño > UMBRAL.sueñoCritico) {
      accion = 'buscar_cama';
      objetivoChar = SYMB.cama;
    } else if (inventario.cantidad > 0) {
      if (inventario.cantidad >= 2) {
        accion = 'entregar_al_macen';
        objetivoChar = SYMB.almacen;
      } else if (inventario.cantidad === 1) {
        if (inventario.tipo === 'comida' && est.hambre > 40) {
          est.hambre = Math.max(0, est.hambre - 25);
          inventario.cantidad = 0;
          inventario.tipo = null;
          accion = 'consumir';
        } else if (inventario.tipo === 'agua' && est.sed > 40) {
          est.sed = Math.max(0, est.sed - 25);
          inventario.cantidad = 0;
          inventario.tipo = null;
          accion = 'consumir';
        } else {
          accion = 'entregar_al_macen';
          objetivoChar = SYMB.almacen;
        }
      }
    } else if (est.hambre > UMBRAL.hambreCritica) {
      if (recursos.comida > 0) {
        accion = 'ir_almacen_comer';
        objetivoChar = SYMB.almacen;
      } else {
        accion = 'recolectar_comida';
        const arbusto = encontrarMasCercano(mapa, x, y, SYMB.arbusto);
        const muerto = encontrarMasCercano(mapa, x, y, SYMB.muerto);
        if (arbusto || muerto) {
          objetivoChar = arbusto ? SYMB.arbusto : SYMB.muerto;
        } else {
          accion = 'vagar';
        }
      }
    } else if (est.sed > UMBRAL.sedCritica) {
      if (recursos.agua > 0) {
        accion = 'ir_almacen_beber';
        objetivoChar = SYMB.almacen;
      } else {
        accion = 'recolectar_agua';
        objetivoChar = SYMB.pozo;
      }
    } else if (est.aburrimiento > UMBRAL.aburrimientoCritico) {
      accion = 'buscar_juguete';
      objetivoChar = SYMB.juguete;
    } else if (recursos.comida < 10) {
      const arbusto = encontrarMasCercano(mapa, x, y, SYMB.arbusto);
      const muerto = encontrarMasCercano(mapa, x, y, SYMB.muerto);
      if (arbusto || muerto) {
        accion = 'recolectar_comida';
        objetivoChar = arbusto ? SYMB.arbusto : SYMB.muerto;
      } else {
        accion = 'vagar';
      }
    } else {
      accion = 'vagar';
    }
  }

  if (objetivoChar && !durmiendo) {
    const coords = encontrarMasCercano(mapa, x, y, objetivoChar);
    if (coords) {
      const paso = moverHaciaConAStar(x, y, mapa, coords.x, coords.y);
      x = paso.x; y = paso.y;
      if (x === coords.x && y === coords.y) {
        const tile = mapa[coords.y][coords.x];
        if (accion === 'entregar_al_macen') {
          if (inventario.cantidad > 0) {
            if (inventario.tipo === 'comida') {
              recursos.comida++;
              inventario.cantidad--;
            } else if (inventario.tipo === 'agua') {
              recursos.agua++;
              inventario.cantidad--;
            }
            if (inventario.cantidad === 0) inventario.tipo = null;
            accion = 'entregado';
          }
        } else if (accion === 'ir_almacen_comer' && recursos.comida > 0) {
          est.hambre = Math.max(0, est.hambre - 30);
          recursos.comida--;
        } else if (accion === 'ir_almacen_beber' && recursos.agua > 0) {
          est.sed = Math.max(0, est.sed - 30);
          recursos.agua--;
        } else if (accion === 'recolectar_comida') {
          if (tile === SYMB.arbusto || tile === SYMB.muerto) {
            inventario.tipo = 'comida';
            inventario.cantidad = 2;
            if (tile === SYMB.arbusto) {
              if (Math.random() < 0.3) {
                const fila = mapa[coords.y];
                mapa[coords.y] = fila.substring(0, coords.x) + SYMB.suelo + fila.substring(coords.x + 1);
              }
            } else if (tile === SYMB.muerto) {
              const fila = mapa[coords.y];
              mapa[coords.y] = fila.substring(0, coords.x) + SYMB.suelo + fila.substring(coords.x + 1);
            }
            accion = 'recolecto';
          }
        } else if (accion === 'recolectar_agua' && tile === SYMB.pozo) {
          inventario.tipo = 'agua';
          inventario.cantidad = 2;
          accion = 'recolecto';
        } else if (accion === 'buscar_juguete' && tile === SYMB.juguete) {
          est.aburrimiento = Math.max(0, est.aburrimiento - 20);
          accion = 'jugo';
        } else if (accion === 'buscar_cama' && tile === SYMB.cama) {
          est.sueño = Math.max(0, est.sueño - 35);
          accion = 'durmiendo';
        }
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
  } else if (accion === 'despertar') {
    accion = 'vagar';
    est.sueño = 0;
  }

  await criaturaDoc.ref.update({
    estadisticas: est,
    x, y,
    inventario,
    accionActual: accion,
    emocion: calcularEmocion(est)
  });

  return { recursos, mapaActualizado: true };
}

// ─── Gestión de reproducción y peleas ───
async function manejarHambreExtrema(docRef, criaturasVivas, mapa) {
  const hambrientos = criaturasVivas.filter(c => c.estadisticas.hambre >= UMBRAL.hambreExtrema);
  if (hambrientos.length === 0) return;

  const machos = criaturasVivas.filter(c => c.sexo === 'macho' && c.edad >= 3);
  const hembras = criaturasVivas.filter(c => c.sexo === 'hembra' && c.edad >= 3);
  let objetivo = null;

  if (machos.length > 1) {
    objetivo = machos[machos.length - 1];
  } else if (hembras.length > 1 && machos.length === 1) {
    objetivo = hembras[hembras.length - 1];
  } else if (hembras.length > 1 && machos.length === 0) {
    objetivo = hembras[hembras.length - 1];
  } else if (machos.length === 1 && hembras.length === 1) {
    return;
  }

  if (objetivo) {
    await docRef.collection('criaturas').doc(objetivo.id).update({
      estado: 'muerta',
      accionActual: 'muerto'
    });
    const fila = mapa[objetivo.y];
    mapa[objetivo.y] = fila.substring(0, objetivo.x) + SYMB.muerto + fila.substring(objetivo.x + 1);
  }
}

async function gestionarReproduccion(docRef, criaturasVivas, mapa, ticks) {
  const machos = criaturasVivas.filter(c => c.sexo === 'macho' && c.edad >= 3);
  const hembras = criaturasVivas.filter(c => c.sexo === 'hembra' && c.edad >= 3);

  for (const hembra of hembras) {
    if (hembra.embarazada) continue;
    if (hembra.ultimoParto && (ticks - hembra.ultimoParto) < 240) continue; // 1 día de cooldown
    if (machos.length === 0) break;
    if (Math.random() < 0.02) {
      await docRef.collection('criaturas').doc(hembra.id).update({
        embarazada: true,
        tiempoEmbarazo: 0
      });
      break;
    }
  }

  const embarazadas = criaturasVivas.filter(c => c.embarazada);
  for (const hembra of embarazadas) {
    let tiempo = (hembra.tiempoEmbarazo || 0) + 1;
    if (tiempo >= 30) { // ~3 horas de juego
      const { x, y } = hembra;
      let colocado = false;
      for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nx = x + dx, ny = y + dy;
        if (esTransitable(mapa, nx, ny) && mapa[ny][nx] === SYMB.suelo) {
          mapa[ny] = mapa[ny].substring(0, nx) + SYMB.huevo + mapa[ny].substring(nx + 1);
          colocado = true;
          break;
        }
      }
      await docRef.collection('criaturas').doc(hembra.id).update({
        embarazada: false,
        tiempoEmbarazo: 0,
        ultimoParto: ticks
      });
    } else {
      await docRef.collection('criaturas').doc(hembra.id).update({ tiempoEmbarazo: tiempo });
    }
  }

  // Eclosión de huevos
  for (let y = 0; y < mapa.length; y++) {
    for (let x = 0; x < mapa[y].length; x++) {
      if (mapa[y][x] === SYMB.huevo && Math.random() < 1/120) { // ~120 ticks para eclosionar (~0.5 día)
        const sexo = Math.random() < 0.5 ? 'macho' : 'hembra';
        await docRef.collection('criaturas').add({
          nombre: `Cria ${Math.floor(Math.random()*1000)}`,
          sexo,
          edad: 0,
          edadMaxima: 20,
          embarazada: false,
          tiempoEmbarazo: 0,
          inventario: { tipo: null, cantidad: 0 },
          estadisticas: { hambre: 50, sed: 50, aburrimiento: 0, sueño: 0, salud: 100, enfermedad: false },
          estado: 'viva',
          x, y,
          accionActual: 'idle',
          emocion: 'neutro'
        });
        mapa[y] = mapa[y].substring(0, x) + SYMB.suelo + mapa[y].substring(x + 1);
      }
    }
  }
}

async function inicializarColonia(docRef) {
  const coloniaSnap = await docRef.get();
  const data = coloniaSnap.data();
  if (data.inicializado) return;
  const mapa = data.mapa;
  const criaturasSnap = await docRef.collection('criaturas').get();
  if (!criaturasSnap.empty) {
    await docRef.update({ inicializado: true });
    return;
  }

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
  if (!pos1) pos1 = { x: 2, y: 2 };
  if (!pos2) pos2 = { x: 3, y: 2 };

  await docRef.collection('criaturas').add({
    nombre: 'Adam', sexo: 'macho', edad: 5, edadMaxima: 20,
    embarazada: false, tiempoEmbarazo: 0,
    inventario: { tipo: null, cantidad: 0 },
    estadisticas: { hambre:50, sed:50, aburrimiento:0, sueño:0, salud:100, enfermedad:false },
    estado: 'viva', x: pos1.x, y: pos1.y, accionActual: 'idle', emocion: 'neutro'
  });
  await docRef.collection('criaturas').add({
    nombre: 'Eva', sexo: 'hembra', edad: 5, edadMaxima: 20,
    embarazada: false, tiempoEmbarazo: 0,
    inventario: { tipo: null, cantidad: 0 },
    estadisticas: { hambre:50, sed:50, aburrimiento:0, sueño:0, salud:100, enfermedad:false },
    estado: 'viva', x: pos2.x, y: pos2.y, accionActual: 'idle', emocion: 'neutro'
  });

  await docRef.update({ inicializado: true, recursos: { comida: 0, agua: 0 } });
}

// ─── Tick principal ───
async function tick() {
  try {
    const coloniasSnap = await db.collection('mascotas').get();
    for (const doc of coloniasSnap.docs) {
      const data = doc.data();
      if (data.finDelJuego) continue;
      await inicializarColonia(doc.ref);

      let colonia = (await doc.ref.get()).data();
      let mapa = colonia.mapa;
      let recursos = colonia.recursos || { comida: 0, agua: 0 };
      let ticks = colonia.ticks || 0;
      let dias = colonia.diasTranscurridos || 0;
      let horaAnterior = colonia.horaDelDia || 12;

      ticks++;
      let hora = Math.floor((ticks % (TICKS_POR_HORA * 24)) / TICKS_POR_HORA);
      if (ticks % (TICKS_POR_HORA * 24) === 0) dias++;

      // Amanecer → spawn arbustos 1-7
      if (hora === HORA_AMANECER && horaAnterior !== HORA_AMANECER) {
        const cantidad = Math.floor(Math.random() * 7) + 1;
        for (let i = 0; i < cantidad; i++) {
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
      }

      const vivasSnap = await doc.ref.collection('criaturas').where('estado', '==', 'viva').get();
      const criaturasVivas = [];
      vivasSnap.forEach(c => criaturasVivas.push({ id: c.id, ...c.data() }));

      for (const criatura of criaturasVivas) {
        const result = await procesarCriatura(doc.ref, criatura.id, mapa, recursos, hora);
        if (result && result.recursos) recursos = result.recursos;
      }

      await manejarHambreExtrema(doc.ref, criaturasVivas, mapa);
      await gestionarReproduccion(doc.ref, criaturasVivas, mapa, ticks);

      if (hora === HORA_AMANECER && horaAnterior !== HORA_AMANECER) {
        const todasVivas = await doc.ref.collection('criaturas').where('estado', '==', 'viva').get();
        for (const c of todasVivas.docs) {
          await c.ref.update({ edad: admin.firestore.FieldValue.increment(1) });
        }
      }

      if (vivasSnap.empty && criaturasVivas.length > 0) {
        await doc.ref.update({ finDelJuego: true, puntuacion: dias });
      }

      await doc.ref.update({
        mapa, recursos, ticks, diasTranscurridos: dias, horaDelDia: hora
      });
    }
  } catch (error) {
    console.error('🔥 Error en tick:', error);
  }
}

setInterval(tick, TICK_INTERVAL);
console.log('🧠 Servidor de colonia iniciado (7 min/día)');

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => console.log(`🌐 Puerto ${PORT}`));