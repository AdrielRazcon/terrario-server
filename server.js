const admin = require('firebase-admin');
const http = require('http');

// Configuración de Firebase
let serviceAccount;
if (process.env.SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
} else {
  try { serviceAccount = require('./serviceAccountKey.json'); }
  catch (e) { console.error('❌ No se encontró clave de servicio'); process.exit(1); }
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TICK_INTERVAL = 2000;            // 2 segundos reales
const TICKS_POR_HORA = 30;            // 30 ticks = 1 hora de juego → 720 ticks = 1 día
const HORA_AMANECER = 6;              // día de 6 a 24 (18 horas)
const HORA_ANOCHECER = 24;

const SYMB = {
  suelo: 'S', muro: 'M', comida: 'C', agua: 'A', cama: 'B', juguete: 'J',
  arbusto: 'Y', almacen: 'L', pozo: 'W', muerto: 'D', huevo: 'E'
};

const DECAY = { hambre: 0.08, sed: 0.08, aburrimiento: 0.05, sueño: 0.06 };
const UMBRAL = {
  hambreCritica: 70, sedCritica: 70, aburrimientoCritico: 60, sueñoCritico: 70,
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

// ─── Procesar criatura ───
async function procesarCriatura(docRef, criaturaId, mapa, recursos, hora, tickColonia) {
  const criaturaDoc = await docRef.collection('criaturas').doc(criaturaId).get();
  if (!criaturaDoc.exists) return { recursos };
  const data = criaturaDoc.data();
  if (data.estado !== 'viva') return { recursos };

  let est = data.estadisticas;
  let x = data.x, y = data.y;
  const inventario = data.inventario || { tipo: null, cantidad: 0 };
  let accion = 'vagar';
  let objetivoChar = null;

  // Decaimientos
  est.hambre = Math.min(100, est.hambre + DECAY.hambre);
  est.sed = Math.min(100, est.sed + DECAY.sed);
  est.aburrimiento = Math.min(100, est.aburrimiento + DECAY.aburrimiento);
  est.sueño = Math.min(100, est.sueño + DECAY.sueño);

  // Enfermedad
  if (!est.enfermedad && Math.random() < 0.001) est.enfermedad = true;
  if (est.enfermedad) est.salud = Math.max(0, est.salud - 0.3);

  // Muerte por salud o vejez
  if (est.salud <= 0 || data.edad >= data.edadMaxima) {
    const fila = mapa[y];
    mapa[y] = fila.substring(0, x) + SYMB.muerto + fila.substring(x + 1);
    await criaturaDoc.ref.update({ estado: 'muerta', accionActual: 'muerto' });
    return { recursos, mapaActualizado: true };
  }

  // Lógica de tareas según inventario y necesidades
  const esDeNoche = (hora >= 20 || hora < 6);
  if (inventario.cantidad > 0) {
    // Tiene recurso en manos, llevarlo al almacén (L)
    accion = 'entregar_al_macen';
    objetivoChar = SYMB.almacen;
  } else if (est.hambre > UMBRAL.hambreCritica) {
    if (recursos.comida > 0) {
      accion = 'ir_almacen_comer';
      objetivoChar = SYMB.almacen;
    } else {
      // Buscar fuente de comida: arbusto o cadáver
      accion = 'recolectar_comida';
      const arbusto = encontrarMasCercano(mapa, x, y, SYMB.arbusto);
      const muerto = encontrarMasCercano(mapa, x, y, SYMB.muerto);
      if (!arbusto && !muerto) {
        // No hay comida, vagar (más tarde peleas)
        accion = 'vagar';
      } else {
        const target = (!arbusto) ? muerto : (!muerto) ? arbusto : (Math.abs(arbusto.x-x)+Math.abs(arbusto.y-y) < Math.abs(muerto.x-x)+Math.abs(muerto.y-y) ? arbusto : muerto);
        objetivoChar = mapa[target.y][target.x];
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
  } else if (est.sueño > UMBRAL.sueñoCritico || (esDeNoche && est.sueño > 50)) {
    accion = 'buscar_cama';
    objetivoChar = SYMB.cama;
  } else if (recursos.comida < 10) {
    // Recolectar proactivamente si hay poco
    const arbusto = encontrarMasCercano(mapa, x, y, SYMB.arbusto);
    const muerto = encontrarMasCercano(mapa, x, y, SYMB.muerto);
    if (arbusto || muerto) {
      accion = 'recolectar_comida';
      objetivoChar = (arbusto && (!muerto || Math.random() < 0.5)) ? SYMB.arbusto : SYMB.muerto;
    } else {
      accion = 'vagar';
    }
  } else {
    accion = 'vagar';
  }

  // Movimiento e interacción
  if (objetivoChar) {
    const coords = encontrarMasCercano(mapa, x, y, objetivoChar);
    if (coords) {
      const paso = moverHaciaConAStar(x, y, mapa, coords.x, coords.y);
      x = paso.x; y = paso.y;
      if (x === coords.x && y === coords.y) {
        const tile = mapa[coords.y][coords.x];
        // Interacción según la acción
        if (accion === 'entregar_al_macen') {
          if (inventario.tipo === 'comida') {
            recursos.comida++;
            inventario.cantidad--;
          } else if (inventario.tipo === 'agua') {
            recursos.agua++;
            inventario.cantidad--;
          }
          inventario.tipo = null;
          accion = 'entregado';
        } else if (accion === 'ir_almacen_comer' && recursos.comida > 0) {
          est.hambre = Math.max(0, est.hambre - 30);
          recursos.comida--;
        } else if (accion === 'ir_almacen_beber' && recursos.agua > 0) {
          est.sed = Math.max(0, est.sed - 30);
          recursos.agua--;
        } else if (accion === 'recolectar_comida') {
          // Recoger del arbusto o cadáver
          if (tile === SYMB.arbusto) {
            inventario.tipo = 'comida';
            inventario.cantidad = 1;
            // El arbusto puede desaparecer
            if (Math.random() < 0.3) {
              const fila = mapa[coords.y];
              mapa[coords.y] = fila.substring(0, coords.x) + SYMB.suelo + fila.substring(coords.x + 1);
            }
            accion = 'recolecto_comida';
          } else if (tile === SYMB.muerto) {
            inventario.tipo = 'comida';
            inventario.cantidad = 1;
            // El cadáver desaparece
            const fila = mapa[coords.y];
            mapa[coords.y] = fila.substring(0, coords.x) + SYMB.suelo + fila.substring(coords.x + 1);
            accion = 'recolecto_cadaver';
          }
        } else if (accion === 'recolectar_agua' && tile === SYMB.pozo) {
          inventario.tipo = 'agua';
          inventario.cantidad = 1;
          accion = 'recolecto_agua';
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
  }

  // Actualizar criatura
  await criaturaDoc.ref.update({
    estadisticas: est,
    x, y,
    inventario,
    accionActual: accion,
    emocion: calcularEmocion(est)
  });

  return { recursos, mapaActualizado: true };
}

// ─── Hambre extrema: peleas ───
async function manejarHambreExtrema(docRef, criaturasVivas, mapa) {
  const hambrientos = criaturasVivas.filter(c => c.estadisticas.hambre >= UMBRAL.hambreExtrema);
  if (hambrientos.length === 0) return;

  // Ordenar prioridad: eliminar machos extra, luego hembras extra
  const machos = criaturasVivas.filter(c => c.sexo === 'macho' && c.edad >= 3);
  const hembras = criaturasVivas.filter(c => c.sexo === 'hembra' && c.edad >= 3);
  let objetivo = null;

  if (machos.length > 1) {
    // Matar al último macho (el más viejo o aleatorio)
    objetivo = machos[machos.length - 1];
  } else if (hembras.length > 1 && machos.length === 1) {
    // Si hay un macho y varias hembras, eliminar una hembra extra (pero dejar al menos una)
    objetivo = hembras[hembras.length - 1];
  } else if (hembras.length > 1 && machos.length === 0) {
    objetivo = hembras[hembras.length - 1]; // eliminar una hembra sobrante
  } else if (machos.length === 1 && hembras.length === 1) {
    // No se puede matar a nadie sin extinguir, mueren de hambre luego
    return;
  }

  if (objetivo) {
    // Matar a la criatura objetivo (convertir en muerto)
    await docRef.collection('criaturas').doc(objetivo.id).update({
      estado: 'muerta',
      accionActual: 'muerto'
    });
    const fila = mapa[objetivo.y];
    mapa[objetivo.y] = fila.substring(0, objetivo.x) + SYMB.muerto + fila.substring(objetivo.x + 1);
    // Reducir hambre al atacante? No, pero ya obtendrán comida del cadáver más tarde.
  }
}

// ─── Reproducción (huevos) ───
async function gestionarReproduccion(docRef, criaturasVivas, mapa, tickColonia) {
  const machos = criaturasVivas.filter(c => c.sexo === 'macho' && c.edad >= 3);
  const hembras = criaturasVivas.filter(c => c.sexo === 'hembra' && c.edad >= 3);

  // Apareamientos: hembra no embarazada, sin cooldown, macho disponible
  for (const hembra of hembras) {
    if (hembra.embarazada) continue;
    if (hembra.ultimoParto && (tickColonia - hembra.ultimoParto) < 720) continue; // 1 día de cooldown
    if (machos.length === 0) break;
    if (Math.random() < 0.02) { // probabilidad baja por tick
      await docRef.collection('criaturas').doc(hembra.id).update({
        embarazada: true,
        tiempoEmbarazo: 0  // contador de ticks desde embarazo
      });
      break; // solo un apareamiento por tick
    }
  }

  // Progreso de embarazo y puesta de huevos
  const embarazadas = criaturasVivas.filter(c => c.embarazada);
  for (const hembra of embarazadas) {
    let tiempo = (hembra.tiempoEmbarazo || 0) + 1;
    if (tiempo >= 50) { // 50 ticks → poner huevo
      // Buscar celda adyacente libre
      const { x, y } = hembra;
      const dirs = [[0,1],[0,-1],[1,0],[-1,0]];
      let colocado = false;
      for (const [dx, dy] of dirs) {
        const nx = x + dx, ny = y + dy;
        if (esTransitable(mapa, nx, ny) && mapa[ny][nx] === SYMB.suelo) {
          const fila = mapa[ny];
          mapa[ny] = fila.substring(0, nx) + SYMB.huevo + fila.substring(nx + 1);
          colocado = true;
          break;
        }
      }
      // Guardar huevo (no es criatura, es tile)
      // La eclosión se maneja más abajo
      await docRef.collection('criaturas').doc(hembra.id).update({
        embarazada: false,
        tiempoEmbarazo: 0,
        ultimoParto: tickColonia
      });
      // Eliminar el huevo del mapa? No, se queda como tile.
    } else {
      await docRef.collection('criaturas').doc(hembra.id).update({ tiempoEmbarazo: tiempo });
    }
  }

  // Eclosión de huevos: buscar tiles 'E', si llevan 720 ticks desde puesta, eclosionar.
  // Al no tener registro del tick de puesta por huevo, simplificamos: cada tick, probabilidad baja de eclosionar.
  // Mejor: guardar en el documento de la colonia un mapa de huevos con tick de puesta.
  // Para no complicar, haremos que los huevos eclosionen después de 1 día (720 ticks) usando un campo adicional.
  // Implementación rápida: al poner huevo, agregamos un documento en subcolección 'huevos' con posición y tickPuesta.
  // Pero para simplificar en esta versión, cada tick, por cada tile 'E', con probabilidad baja (1/720) de convertirse en cría.
  for (let y = 0; y < mapa.length; y++) {
    for (let x = 0; x < mapa[y].length; x++) {
      if (mapa[y][x] === SYMB.huevo && Math.random() < 1/720) {
        // Eclosionar: crear cría y poner suelo
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

// ─── Inicializar colonia ───
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

  console.log(`🌱 Inicializando colonia ${docRef.id} (sin modificar mapa)...`);
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

  await docRef.update({ inicializado: true });
  console.log(`✅ Colonia inicializada con Adam y Eva.`);
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

      // Incrementar tick
      ticks++;
      let hora = (Math.floor(ticks / TICKS_POR_HORA) % 24);
      if (ticks % (TICKS_POR_HORA * 24) === 0) dias++;

      // Recolectar criaturas vivas
      const vivasSnap = await doc.ref.collection('criaturas').where('estado', '==', 'viva').get();
      const criaturasVivas = [];
      vivasSnap.forEach(c => criaturasVivas.push({ id: c.id, ...c.data() }));

      // Procesar cada criatura
      for (const criatura of criaturasVivas) {
        const result = await procesarCriatura(doc.ref, criatura.id, mapa, recursos, hora, ticks);
        if (result && result.recursos) recursos = result.recursos;
      }

      // Hambre extrema
      await manejarHambreExtrema(doc.ref, criaturasVivas, mapa);

      // Reproducción y huevos
      await gestionarReproduccion(doc.ref, criaturasVivas, mapa, ticks);

      // Aumentar edad al amanecer
      if (hora === HORA_AMANECER && ticks % TICKS_POR_HORA === 0) {
        const todasVivas = await doc.ref.collection('criaturas').where('estado', '==', 'viva').get();
        for (const c of todasVivas.docs) {
          await c.ref.update({ edad: admin.firestore.FieldValue.increment(1) });
        }
      }

      // Reaparición de arbustos (1-7 al amanecer)
      if (hora === HORA_AMANECER && ticks % (TICKS_POR_HORA * 24) === 0) {
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

      // Fin del juego si no hay vivas y había criaturas antes
      if (vivasSnap.empty && criaturasVivas.length > 0) {
        await doc.ref.update({ finDelJuego: true, puntuacion: dias });
      }

      // Guardar
      await doc.ref.update({
        mapa, recursos, ticks, diasTranscurridos: dias, horaDelDia: hora
      });
    }
  } catch (error) {
    console.error('🔥 Error en tick:', error);
  }
}

setInterval(tick, TICK_INTERVAL);
console.log('🧠 Servidor iniciado');

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => console.log(`🌐 Puerto ${PORT}`));