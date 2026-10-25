# URBANO Score — Contención de los datos de nuestros ensayos (segundo lote)

Estado: **candidato local, sin commit ni push** (rama `fix/exclude-rehearsal-rows`, cortada de `origin/main` `2dd6b8d`). Decisión del Fundador (2026-10-25): ocultar en la vista operativa y en los selectores los equipos, jugadores y partidos de los ensayos propios, **por sus ID exactos**; mostrarlos solo con «Mostrar datos de prueba históricos»; conservar participaciones y evidencia; ningún borrado, renombrado ni filtro genérico por la palabra «ensayo».

## Qué cambia

| Plano | Cambio |
|---|---|
| **Manifiesto** — `lib/gaming/predictions/fixtureExclusionManifest.ts` | Segundo lote `REHEARSAL_FIXTURE_EXCLUSION` (3 partidos, 2 equipos, 0 sedes, 3 activaciones) con sus huellas SHA-256 fijadas, y `EFFECTIVE_FIXTURE_EXCLUSION` = primer lote + segundo lote (39 / 84 / 30 / 27 = 180 IDs) con las huellas de la unión fijadas como literales. El primer lote (172 IDs, 2026-08-25) **no se tocó**. |
| **Exclusión** — `lib/gaming/predictions/fixtureExclusion.ts` | El manifiesto por defecto pasa a ser el efectivo. Ninguna otra línea cambia: sigue sin mirar nombres, fechas, edades, clasificaciones ni competiciones. |
| **Rutas y portal** | Sin cambios. Las rutas públicas y administrativas ya usan el valor por defecto; la casilla ya envía `?includeFixtures=1`. |

## Las filas, por ID exacto

Leídas del respaldo completo de Producción del 2026-10-25 a las 10:10 (hora de Honduras), antes de cargar el Clásico real. Creadas entre `2026-10-25T00:01:49Z` y `01:24:29Z`.

- **Equipos (2):** `eab01687-bbaa-4eba-ac20-63c02bf22c31` «Equipo A (ensayo)», `9bd7171b-355b-43ed-a684-72316bb5200f` «Equipo B (ensayo)».
- **Partidos (3, los tres cancelados, TRAINING):** `0ef3b349-6636-4a41-97a8-676aa33bfd1b` (The Pub), `58765eb4-7bec-4c1f-8bca-c542bd93239a` (Finca Ocho), `c25f8a8f-99ea-4756-b5a6-8a84a3f173de` (Finca Ocho 15 m).
- **Activaciones (3, deshabilitadas):** `36670fbd-0af7-4516-9c90-8122cecf615b`, `754b4eea-91c7-429b-a726-2eefb1ed7c11`, `8e19e862-8278-4709-b0b5-73395af21e1b`.
- **Jugadores (4, solo registro):** `4404e556-1107-461f-8ea2-06dc5925918c`, `5c58d4c1-35de-4b06-b412-5826e4aac71f`, `bf747952-8312-41e9-baa5-17d82dd6139d`, `cfa5bd0c-ec61-4890-9e4f-87736861e7e2`. Se llega a ellos solo por su equipo, que se excluye primero (misma convención del primer lote); no hay una lista de jugadores que se filtre.
- **Se conservan, sin tocarlos:** 3 participaciones, 12 niveles de premio y 6 eventos de auditoría que referencian esas filas.

## Decisiones y límites

- **Las sedes no se ocultan.** «The Pub by Beer Box» (`703657cc-…`) y «Finca Ocho • Plaza San Rafael» (`2105dd59-…`) las usa el flujo real. La copia «Finca Ocho · 15 m» (`1ab69d0b-aa72-4e64-bdba-d0d29d9d359d`), creada por un ensayo, **sigue visible** hasta que el Fundador decida nombrarla.
- **Ninguna regla:** una fila creada mañana con los mismos nombres («Equipo A (ensayo)», «ENSAYO — sin premios reales · The Pub») **no** se oculta; hay prueba de ello. Una prueba comprueba además que el código de la exclusión no contiene la palabra «ensayo».
- **Inventario acotado:** las filas se identificaron en el respaldo de las 10:10. Una fila de ensayo creada después de esa hora no está cubierta; aparecería en la vista operativa y se añadiría con un nuevo inventario y huellas.
- **Efecto:** solo la vista por defecto del portal y la lista pública. Las rutas por partido (`mine`, `predict`, `result`) no se afectan; las participaciones siguen en la base y en las vistas del propio miembro.

## Pruebas

- `__tests__/fixtureExclusion.test.ts` (+13, total 31): lote exacto (IDs escritos a mano contra el respaldo, huellas reproducidas y fijadas), primer lote intacto, unión de 180 IDs sin cruces, las filas reales (Clásico, su activación, sus equipos y las tres sedes) **no** están en el manifiesto, rechazo de uniones editadas (5 mutaciones), exclusión solo por ID incluso con los mismos nombres, la palabra «ensayo» ausente del código, y la lista pública con el Clásico real y las filas de ensayo.
- `__tests__/predictionsAdminFixtureRoutes.test.ts` (+7, total 17): vistas por defecto sin las 2+3+3 filas, el Clásico real visible con su oferta calculada, filas con el mismo nombre y ID nuevo visibles, las tres sedes visibles, `?includeFixtures=1` trae todo, un partido oculto no cuesta ninguna consulta dependiente, y nada se borra ni se altera (4 jugadores y 12 niveles intactos).
- `__tests__/fixtureCatalogWorld.ts` (soporte): opción `withRehearsal`.
- **Controles negativos (4 de 4 detectados):** volver al primer lote solo, quitar un partido de la unión sin cambiar la huella, un filtro genérico por «ensayo», y meter la sede The Pub en la lista.
