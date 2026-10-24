# URBANO Score — Desbloqueo operativo previo al ensayo

Estado: **candidato local, sin commit**. Rama `codex/score-operational-unblock-001`, cortada de `b4ef165705c7a9bb0f707118586100953511d1ef` (`origin/main`, igual a Producción). Contiene el candidato de acceso administrativo de Gate H (idéntico, huella `41911aa3…01b8`) más este paquete. Nada publicado, sin migraciones, sin datos tocados ni creados.

## Qué cambia

| Plano | Cambio |
|---|---|
| **Retorno administrativo** — `public/urbanoAuth.js`, `public/predictions-admin.html` | Opción `returnTo: "score-admin"` en `attachSignInButton`, independiente de `accountEntry`. El destino es una **constante del componente**: `https://gaming.urbanohn.com/predictions-admin.html`, elegida por clave. Solo se envía como `emailRedirectTo` en un código por **correo** (primer envío y reenvío). No se lee nada de la barra de direcciones, de `?next=` ni de un valor del llamador; una clave desconocida, una URL, `constructor`, `__proto__` u otro tipo no cambian nada. Solo `predictions-admin.html` pasa la clave: las páginas públicas siguen sin `emailRedirectTo` y conservan su destino. No se toca el Site URL. |
| **Fixtures excluidos por IDs exactos** — `lib/gaming/predictions/fixtureExclusionManifest.ts`, `fixtureExclusion.ts` | Lista temporal de **172 IDs** (36 partidos, 82 equipos, 30 sedes, 24 activaciones) leída de Producción el 2026-10-24, con huella SHA-256 por lista. Se verifica sin duplicados, conteos y huellas antes del primer uso: una lista editada sin nuevo inventario falla en voz alta en lugar de ocultar filas equivocadas. No mira nombres, prefijos, fechas, edad, clasificación ni competición. No borra ni altera ninguna fila. |
| **Lista pública** — `app/api/gaming/predictions/matches/route.ts` | Excluye el conjunto **sobre las filas recién leídas y antes del reparto** por partido: un partido excluido no cuesta equipos, plantillas, activaciones, sedes, niveles ni resultados. Las rutas por partido (`mine`, `predict`, resultados) no se tocan: la consulta legítima de participación e historia sigue igual. |
| **Listas administrativas** — `admin/{teams,matches,venues,activations}/route.ts` | Vista por defecto sin los fixtures; `?includeFixtures=1` (exactamente ese valor) devuelve todo. `activations` excluye los partidos **antes** de leer sus activaciones, sedes y niveles. Las comprobaciones de autoridad no cambian y siguen siendo lo primero. |
| **Portal** — `public/predictions-admin.html` | Casilla «Mostrar datos de prueba históricos» (apagada por defecto, con nota). Pide las cuatro listas con o sin `?includeFixtures=1`, así que **las plantillas solo se piden para los equipos que se muestran** (no es un filtro del DOM). Cambiar de persona o cerrar sesión vuelve a la vista operativa. La casilla está protegida contra pulsaciones dobles. No existe nada de esto antes de que el servidor confirme el acceso (Gate H). |
| **Mensajes por estado** — `public/soccer-predictions.html`, `public/urbanoI18n.js` | Sin sesión: **abierto** invita a participar (texto de siempre); **cerrado** ofrece consultar la participación existente; **finalizado** ofrece consultar resultados. En cerrado y finalizado el panel se abre en «iniciar sesión» (sin elegir «crear cuenta») y la intención es *ver*: al volver solo se enfoca la tarjeta, sin nota de «hacé tu predicción». Cuenta sin terminar: abierto conserva su texto; cerrado y finalizado solo piden terminarla. Claves nuevas solo con prefijo `pred.` (ES y EN, y el bloque en español de la página): las demás páginas no cambian. Los textos no cambian nada de lo que decide el servidor. |

## Decisiones y límites

- **No hay horizonte genérico.** Un partido legítimo antiguo se sigue listando (hay prueba con un partido de 2020) y uno nuevo nunca se toma por ensayo, tenga el nombre, la competición o el día que tenga (prueba con uno «Contract Test», RANKED, del mismo día que los fixtures, con ID nuevo).
- **Alcance de `includeFixtures`:** es un parámetro de filtro en los cuatro listados existentes. No hay API masiva nueva. La vista histórica cuesta lo mismo que hoy a propósito.
- **Una actividad creada después sobre un partido fixture** quedaría oculta en la vista operativa (se excluyen los partidos antes de leer sus activaciones). No es un caso previsto; la casilla la muestra.
- **Redirect URLs de Producción:** leídas por el acceso autorizado del CLI (`config pull --dry-run`, sin escribir). Site URL `https://gaming.urbanohn.com/`; lista `https://urbano-gaming-playtest.vercel.app` y `https://gaming.urbanohn.com/`. Con una sonda sin efectos (token inválido, sin correo) Producción **ya acepta** `https://gaming.urbanohn.com/predictions-admin.html` (regla de mismo host que el Site URL); rechaza `…vercel.app/predictions-admin.html`, un host ajeno y uno parecido. **No falta ninguna entrada.** Añadir la entrada exacta sería endurecimiento opcional, no necesario.
- **Idioma:** el portal sigue con el texto de la compuerta en español y la casilla en español (decisión del Founder); el resto del portal en inglés, como estaba.

## Pruebas

- `__tests__/fixtureExclusion.test.ts` (nuevo, 18): conteos y huellas reproducidas, las huellas fijadas de Producción, IDs canónicos sin duplicados ni cruces, rechazo de listas editadas (6 mutaciones), exclusión solo por ID (sin nombre, prefijo, fecha, edad, clasificación ni competición), `?includeFixtures=1` solo con el valor exacto, y la ruta pública: partidos legítimos presentes (antiguo, parecido a un fixture, nuevo), cancelado fuera, **0 consultas dependientes** de lo excluido, mismas solicitudes que un catálogo que nunca tuvo los fixtures, y el control sin exclusión (273 contra 25 llamadas).
- `__tests__/predictionsAdminFixtureRoutes.test.ts` (nuevo, 10): las cuatro listas con y sin el parámetro, `activations` sin consultas de lo excluido, 401/403 antes de cualquier lectura, y solo lecturas.
- `__tests__/fixtureCatalogWorld.ts` (soporte): catálogo equivalente al de Producción con los IDs del manifiesto, filas legítimas y un repositorio que registra cada llamada.
- `__tests__/predictionsAdminPage.test.ts` (+10, total 256): casilla, vista operativa con solo las plantillas de los equipos mostrados, activar y desactivar, conteo de solicitudes, protección contra doble pulsación, persona distinta, creación sin parámetro, nada antes de la confirmación, y la página sin IDs ni nombres.
- `__tests__/urbanoAuthAccountEntry.test.ts` (+7, total 53): destino fijo en envío y reenvío, independiente del modo, páginas públicas sin destino (iniciar sesión, crear cuenta y `requestOtp`), claves y direcciones hostiles ignoradas, barra de direcciones ignorada, teléfono sin destino, y el código fuente (una sola dirección, un solo `emailRedirectTo`).
- `__tests__/soccerPredictionsPage.test.ts` (+7, total 29): los tres estados, cuenta sin terminar, ninguna petición de predicción desde ningún aviso, intención de ver y de predecir.
- `__tests__/fixtureExclusionSupabase.contract.test.ts` (nuevo, 7, en `test:contract`): Auth y Postgres **reales locales**, contando solicitudes en la frontera de red; el correo real en el receptor local lleva la dirección fija, y una dirección hostil cae al Site URL.
- Ajustes: `requireLocalSupabase.test.ts` (30 archivos de contrato) y una aserción de la suite del portal y otra de la página pública que codificaban el comportamiento corregido.
- Controles negativos: **25 regresiones introducidas a propósito, 25 detectadas** (sin exclusión, exclusión por nombre, por edad y por RANKED, integridad sin comprobar, ID sensible a mayúsculas, bandera abierta, listas administrativas sin exclusión, portal sin parámetro o con el parámetro siempre, casilla sin recarga o sin protección, historial que sobrevive a otra persona, dirección del llamador, prototipo, `?next=`, destino en todos los correos, en teléfonos o ausente al reenviar, aviso de predicción en cerrado, selector de «crear cuenta», nota de predicción al volver a ver).

## Verificación (2026-10-24)

`npm test`: 64 archivos / 2819 pruebas; `npx tsc --noEmit` limpio; `npm run build` correcto. Contratos en serie contra la pila local aislada: acceso 6, autoridad 12, frontera de cliente 13, miembros 8, repositorio de Predicciones 23, exclusión 7. Escaneo de secretos y coordenadas del candidato (27 archivos) y de la carpeta de trabajo: 0.

**Medido localmente con el catálogo equivalente** (36 / 82 / 122 / 30 / 24 / 2 con los IDs del manifiesto, más 6 equipos, 12 jugadores, 2 sedes, 4 partidos y 3 activaciones legítimos). Los tiempos son **locales** (sin el cruce entre regiones): muestran la forma, no lo que verá una persona en Producción.

| Recorrido | Sin exclusión | Con exclusión |
|---|---|---|
| `GET /matches` (lista pública): solicitudes a PostgREST | 273 | **25** |
| `GET /matches`: tiempo local | 113–125 ms | 15–16 ms |
| Carga del portal: solicitudes administrativas (con 6 equipos legítimos; **2** serán los del ensayo) | 92 (88 plantillas + 4 listas) | **10** (6 plantillas + 4 listas) |
| Carga del portal: solicitudes a PostgREST | 371 | **41** |
| Carga del portal: tiempo local (prueba de contrato / navegador, con el dibujado) | 372 ms / 917 ms | 42–69 ms / 205 ms |
| Página pública con sesión: `/mine` | 1 por partido listado (34 en Producción hoy) | 1 por partido legítimo (3 aquí) |

Navegador local (rutas reales sobre la pila aislada, sesiones reales): escritorio y 375 px. Página pública sin sesión y con sesión (tres estados, sin tarjetas de fixtures, sin desborde horizontal); portal como Founder (vista operativa 11 solicitudes con el control de acceso; casilla encendida 92; apagada 10) y como participante sin autoridad (solo `access`, sin secciones ni casilla).

## Riesgos conocidos

- `public/urbanoAuth.js`: `home-f3-recovery` (cambios sin commit, partió de una base de 558 líneas frente a 1782 en Producción) ya choca con Producción en 4 regiones del cliente (cuenta atrás de reenvío, `renderDisplayName`, `renderSignedOut`, `justOpened`); el candidato de Gate H añade una quinta. Este paquete no añade regiones nuevas fuera de `requestCode` y la lectura de opciones. Habrá que rebasar esa rama sobre `b4ef165`.
- Las ramas del checkout principal con trabajo sin commit sobre `matches/route.ts`, `predictions-admin.html` y `soccer-predictions.html` parten de `be3911c`: si siguen vigentes, también habrá que rebasarlas.
- Tras publicar, **la página pública mostrará su estado vacío** hasta que exista un partido real o el de ensayo: hoy los 34 partidos listados son todos fixtures.
- La lista de IDs es temporal y específica de Producción. Si se retiran los fixtures por una operación autorizada, hay que retirar también este módulo.
- Las pruebas de contrato siguen corriendo contra una base **sin RLS**; en Producción RLS (sin políticas) es lo único que frena a los clientes sobre las tablas de autoridad. No lo cambia este candidato.
