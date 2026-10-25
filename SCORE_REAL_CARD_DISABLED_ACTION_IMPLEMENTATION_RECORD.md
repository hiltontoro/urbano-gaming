# URBANO Score — Tarjeta real con acción deshabilitada antes de la apertura

Decisión del Fundador (2026-10-25): mostrar ya la tarjeta real del partido con una acción deshabilitada «Participar — apertura prevista 12:30 p. m.»; no habilitar por el reloj solamente; si la hora pasa y sigue cerrada, mostrar «Apertura pendiente». Cambio visual acotado; no toca el servidor, la ventana de participación ni el mecanismo de aceptación.

## Qué cambia

| Archivo | Cambio |
|---|---|
| `public/soccer-predictions.html` | Un partido con **ventana de participación aprobada** (`participationOpensAt`), sin finalizar, antes de su inicio y **sin ninguna sede habilitada y activa**, muestra su tarjeta real con un botón **deshabilitado**: «Participar — apertura prevista 12:30 p. m.» (en inglés «Take part — opening expected 12:30 p.m.»). Pasada la hora y sin habilitarse, el mismo botón dice «Apertura pendiente» (se cambia solo la frase, con un temporizador; el botón sigue deshabilitado). Debajo se listan los premios de la oferta válida, tal como los lista el formulario. |
| `public/urbanoI18n.js` y el bloque de respaldo de la página | Dos claves nuevas, `pred.notOpen.btn` y `pred.notOpen.pending`, en español e inglés. |

## Reglas

- **El reloj no abre nada.** Solo una sede habilitada por la administración cambia la tarjeta al flujo normal (aviso de inicio de sesión o formulario). La hora solo cambia la frase del botón deshabilitado. Si algún día una sede se habilita antes de la hora, la tarjeta es la normal y el servidor sigue rechazando los envíos antes de la apertura.
- **La hora** se escribe como reloj de Honduras (el instante menos seis horas, sin horario de verano), igual en cualquier dispositivo: «12:30 p. m.» / «12:30 p.m.».
- **Solo afecta a partidos con ventana aprobada.** Un partido sin `participationOpensAt` se comporta exactamente como antes; uno con sede habilitada, también.
- **Una participación ya guardada se sigue mostrando:** quien tiene algo guardado ve su resumen, no el botón deshabilitado.
- Sin sesión iniciada no se pide ninguna otra solicitud al servidor; con sesión se consulta, como siempre, la ruta propia del miembro.

## Pruebas

`__tests__/soccerPredictionsPage.test.ts` (+11, total 40): botón deshabilitado con el texto exacto en español e inglés, sin aviso de inicio de sesión ni formulario, premios listados, hora de Honduras (mediodía, medianoche, minutos), «Apertura pendiente» pasada la hora, el paso de la hora solo cambia la frase (temporizador real), con sesión y sin nada guardado, con algo guardado, sede habilitada (con la hora antes y después), partido sin ventana, partido ya iniciado, y sin oferta válida. **Controles negativos (4 de 4 detectados):** el reloj abre, se pierde la participación guardada, se aplica a partidos sin ventana, el botón queda habilitado.
