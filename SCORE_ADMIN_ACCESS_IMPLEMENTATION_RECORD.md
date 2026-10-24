# URBANO Score — Administración: acceso solo-ingreso, comprobación de autoridad en servidor e interfaz fail-closed

Estado: **candidato local, sin commit**. Rama `codex/score-admin-access-001`, cortada de `b4ef165705c7a9bb0f707118586100953511d1ef` (`main`). Nada publicado, sin migraciones, sin datos tocados.

## Qué cambia

| Plano | Cambio |
|---|---|
| **Autenticación** — `public/urbanoAuth.js` | Opción `attachSignInButton(btn, status, { accountEntry: "login-only" })`. El panel solo puede **iniciar sesión**: sin «Create account», sin selector de modo, el código se pide siempre con `shouldCreateUser: false`, un correo desconocido recibe la misma pantalla que uno conocido, y una identidad sin Gaming Member **no** recibe el paso de nombre ni se le crea miembro. Sin la opción, todas las demás páginas quedan exactamente igual. |
| **Autorización de plataforma** — `lib/gaming/predictions/httpAuth.ts` y `app/api/gaming/predictions/admin/access/route.ts` (nuevo) | `GET /api/gaming/predictions/admin/access`: 401 sin token válido o sin miembro, 403 con miembro sin clase administrativa, 200 con las clases activas en orden estable (`OPERATIONAL`, `CONSEQUENTIAL_FINALIZER`, `PRODUCT_GOVERNANCE`), `Cache-Control: no-store`. **Es una pista para la interfaz, no una frontera**: ninguna otra ruta la consulta. Las 24 operaciones administrativas **no cambian** y cada una conserva su comprobación fresca por llamada. No se lee ningún correo, dominio ni nombre. |
| **Interfaz** — `public/predictions-admin.html` | Título y encabezado «URBANO Score — Administración». Estados `CHECKING / SIGNED_OUT / NO_ACCESS / CHECK_FAILED / ADMIN`: hasta que el servidor confirma, no existen secciones, datos, controles ni peticiones administrativas. Sin acceso: «Esta cuenta no tiene acceso administrativo» con «Cerrar sesión» y «Usar otra cuenta». Los controles siguen la clase efectiva (`data-requires` / `data-edit-requires`). Cualquier 401/403 vuelve a preguntar quién es el miembro y **nunca repite la petición**. Una respuesta tardía de la persona anterior se descarta. |

## Decisiones y límites

- **No hay frontera en el cliente.** Ocultar un control no protege nada: el servidor vuelve a comprobar la clase en cada petición, y las funciones de la base la comprueban una vez más.
- **Identidad = miembro verificado.** No hay comparación de correos ni de dominios en el portal, el componente ni las rutas (hay pruebas estáticas). No se concede nada por `tecnomovi.com`.
- **Exclusividad.** Hoy se cumple por los datos (un único titular activo). Un grant administrativo futuro a otra persona cambiaría ese estado, y como las clases son de plataforma, también pasaría las comprobaciones de otros productos. No se redefine el modelo compartido en este candidato.
- **Alcance de «solo-ingreso».** Evita que *este portal* cree cuentas o miembros; no impide que alguien llame directamente al proveedor de Auth, y el registro público de participantes no se toca.
- **Idioma.** El mensaje de sin-acceso y los estados de la compuerta están en español (decisión del Founder) con una línea en inglés; el resto del portal y el texto del panel solo-ingreso siguen en inglés. No se añadieron claves a `urbanoI18n.js` (el portal no carga ese módulo, y añadirlas obligaría a regenerar los bloques en español de Home, Predicciones y Perfil).
- **Fallo al volver a comprobar para el mismo miembro ya confirmado:** se conserva lo que hay en pantalla (puede contener la única marca de un canje de resultado desconocido) pero se desactivan todos los controles hasta poder repetir la comprobación.
- **Otros portales** (`competitions-admin.html`, `host-applications-admin.html`): no se tocan. Diferencias en el informe del gate.

## Pruebas

- `__tests__/predictionsAdminAuthorityMatrix.test.ts` (nuevo, 21): las **24 operaciones** contra la cadena real (`httpAuth.ts` y rutas sin mocks de autoridad; solo las clases que hablan con Supabase son equivalentes en memoria). 401 sin credenciales / cabecera no bearer / token desconocido / identidad sin miembro; 403 con miembro sin grants o con grant revocado; clases no jerárquicas; las lecturas aceptan cualquier clase; la autoridad se lee fresca en cada llamada; una denegación no llega nunca al repositorio. Control de completitud: una ruta administrativa nueva no puede añadirse sin una fila.
- `__tests__/predictionsAdminAccessRoute.test.ts` (nuevo, 12): estados, clases exactas y orden, `no-store`, solo lectura (no crea miembros ni concede), no devuelve datos del miembro, y nada más importa el auxiliar.
- `__tests__/predictionsAdminPage.test.ts` (+21, total 246): título, fail-closed mientras se comprueba, cuenta sin acceso, sesión pública, sin sesión, sin miembro, 401, fallo de la comprobación y reintento, controles por clase (solo OPERATIONAL, solo FINALIZER, solo GOVERNANCE, las tres), un 403 mostrado una vez y nunca repetido, clase revocada, cambio de identidad en ambos sentidos con respuesta tardía descartada, mismo miembro con re-comprobación fallida, «Cerrar sesión» y «Usar otra cuenta».
- `__tests__/urbanoAuthAccountEntry.test.ts` (+13, total 46): solo-ingreso (sin «Create account», `shouldCreateUser:false` al enviar y reenviar, misma pantalla para direcciones desconocidas y sin crear usuario, sin paso de nombre ni miembro, sesión sin miembro sin «Finish creating your account»), y regresión: el panel por defecto y el **registro público** siguen igual.
- `__tests__/predictionsAdminAccessSupabase.contract.test.ts` (nuevo, 6, en `test:contract`): Auth y Postgres **reales** locales. Tokens verdaderos, las rutas reales, concesión y revocación por las funciones atómicas, el servidor de Auth real que respeta `shouldCreateUser:false`, los clientes que no pueden ejecutar las funciones de autoridad, y un recorrido de extremo a extremo con la página y el componente reales (código por Mailpit).
- Controles negativos: 18 regresiones introducidas a propósito (fail-open, 403 como acceso, no limpiar datos, controles sin clase, repetir tras 403, respuesta tardía, decisión por correo, panel con «Create account», `shouldCreateUser:true`, paso de nombre, clase equivocada, `requirePlatformAuthorityHttp` sin comprobar) — **18/18 detectadas**.
- Ajustes mecánicos de suites existentes: `requireLocalSupabase.test.ts` (registro de 29 archivos de contrato) y `soccerPredictionsStepper.test.ts` (su arnés del portal responde la comprobación de acceso).

## Verificación

`npm test`: 62 archivos / 2763 pruebas; `npx tsc --noEmit` limpio; `npm run build` correcto (la ruta nueva figura como dinámica). Contrato local (serie): `predictionsAdminAccessSupabase` 6, `adminAuthoritySupabaseRepository` 12, `predictionsClientBoundarySupabase` 13, `gamingMemberSupabaseRepository` 8. Navegador: estados sin sesión, sin acceso, solo-OPERATIONAL y las tres clases, y ancho de teléfono.

## Riesgos conocidos

- `public/urbanoAuth.js` también lo modifica otra línea de trabajo (`home-f3-recovery`): habrá que integrar los dos cambios.
- Las pruebas de contrato corren sobre una base **sin RLS**, mientras que en Production RLS (activado, sin políticas) es lo único que frena a los clientes sobre las tablas de autoridad (los privilegios de tabla están abiertos). No lo cambia este candidato; endurecimiento propuesto aparte.
