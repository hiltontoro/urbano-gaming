import { createHash } from "node:crypto";

import type { LegalBlock, LegalDocumentContent, LegalDocumentEntry, LegalDocumentKey, LegalScope } from "./types";

/**
 * THE REGISTRY OF CURRENT LEGAL TEXTS — the texts the Founder approved, and only those.
 *
 * A text enters this list only when the Founder has approved it, as a new entry with its version and its pinned hash (and the entry that
 * was current before it stops being current in the same change). While the list is empty nothing is published: every participation that
 * needs conditions is refused ("not published yet"), no acceptance can be recorded, and the public viewer shows that there are no texts.
 * Drafts live outside this repository. Tests build their own registries; they never write here.
 */
// Approved by the Founder; version 2026-10-25.1; pinned SHA-256: ACCOUNT_TERMS a98420db978325fe097a1c2e75bf38f0e15b8df38852abe846587f7d5a41d5b2 | PRIVACY_NOTICE b2542e59a508456e3a37d9d28279c5cea5f2186b4cf1a99efd480b98ac30677d | EVENT_RULES 0291684f8e9340cbcb411485afdaddfb2098b8ab4f8ed604e2ead4f1e2060b87
export const LEGAL_DOCUMENTS: ReadonlyArray<LegalDocumentEntry> = [
  {
    "key": "ACCOUNT_TERMS",
    "version": "2026-10-25.1",
    "locale": "es",
    "scope": {
      "kind": "GLOBAL"
    },
    "current": true,
    "sha256": "a98420db978325fe097a1c2e75bf38f0e15b8df38852abe846587f7d5a41d5b2",
    "content": {
      "title": "Términos de cuenta de URBANO Gaming",
      "blocks": [
        {
          "kind": "heading",
          "text": "1. Quiénes somos"
        },
        {
          "kind": "paragraph",
          "text": "URBANO Gaming es una plataforma de juegos para locales, operada por Tecnomovi S.A. como parte de URBANO."
        },
        {
          "kind": "list",
          "items": [
            "Domicilio: Torre Nova 2, Piso 9, Centro Comercial Novacentro, Corporativo Los Próceres, 11101 Tegucigalpa, Francisco Morazán.",
            "Contacto para cualquier consulta, reclamo o solicitud sobre tus datos: info@urbanohn.com."
          ]
        },
        {
          "kind": "heading",
          "text": "2. Qué regulan estos términos"
        },
        {
          "kind": "paragraph",
          "text": "Estos términos regulan tu cuenta y el uso general del sitio. Los juegos con premios tienen además sus propias reglas (por ejemplo, las del evento de URBANO Score), y el tratamiento de tus datos se explica en el Aviso de privacidad. Los tres documentos se te muestran completos antes de participar en un juego con premios."
        },
        {
          "kind": "heading",
          "text": "3. Tu cuenta"
        },
        {
          "kind": "list",
          "items": [
            "Una persona, una cuenta.",
            "Necesitas un correo electrónico que controles. Hoy la cuenta se crea solo con correo electrónico.",
            "Algunos juegos o eventos fijan una edad mínima. El evento de URBANO Score del 25 de octubre de 2026 exige 18 años cumplidos o más (lo dicen sus reglas y se declara al aceptarlas). Estos términos no fijan una edad mínima para la plataforma en general."
          ]
        },
        {
          "kind": "heading",
          "text": "4. Cómo entras y cómo proteges tu cuenta"
        },
        {
          "kind": "paragraph",
          "text": "No usas contraseña. Cada vez que entras te enviamos un código de un solo uso a tu correo, y lo escribes en el sitio. Es tu responsabilidad:"
        },
        {
          "kind": "list",
          "items": [
            "no compartir los códigos ni dejar tu cuenta abierta en un teléfono ajeno;",
            "avisarnos si crees que alguien entró a tu cuenta."
          ]
        },
        {
          "kind": "paragraph",
          "text": "Lo que se haga con tu cuenta abierta se considera hecho por ti."
        },
        {
          "kind": "heading",
          "text": "5. Tu nombre visible"
        },
        {
          "kind": "paragraph",
          "text": "Al crear tu cuenta eliges un nombre visible (hasta 40 caracteres). Puede mostrarse a quien administre el evento y, al canjear un premio, a quien lo entrega; y, si algún día se abren las clasificaciones, en ellas. No uses el nombre de otra persona, nombres ofensivos ni datos que no quieras mostrar. Podemos pedirte que lo cambies o cambiarlo si incumple estas reglas."
        },
        {
          "kind": "heading",
          "text": "6. Cómo debes usar el servicio"
        },
        {
          "kind": "paragraph",
          "text": "No puedes:"
        },
        {
          "kind": "list",
          "items": [
            "crear varias cuentas para participar más de una vez;",
            "falsear tu ubicación ni usar programas que automaticen respuestas;",
            "intentar entrar a cuentas, datos o partes del servicio que no son tuyos;",
            "usar el servicio para fines ilegales o para molestar a otras personas."
          ]
        },
        {
          "kind": "paragraph",
          "text": "Si incumples esto podemos suspender o cerrar tu cuenta, excluirte de un evento y retirar los premios que correspondan a una participación hecha con fraude."
        },
        {
          "kind": "heading",
          "text": "7. Ubicación"
        },
        {
          "kind": "paragraph",
          "text": "Algunos juegos solo se pueden jugar cerca del local. En esos casos, el navegador te pide permiso para usar tu ubicación y el sistema comprueba si estás dentro del área de proximidad definida para el local. Es una comprobación de cercanía basada en GPS: no acredita que estés dentro del local y su precisión depende de tu teléfono. Si no das el permiso, no podrás participar en esos juegos; el resto del sitio sigue disponible. Cómo se usa esa información está en el Aviso de privacidad."
        },
        {
          "kind": "heading",
          "text": "8. Premios"
        },
        {
          "kind": "paragraph",
          "text": "Los premios, cómo se ganan y cómo se canjean los fijan las reglas de cada evento. Los premios los entrega el local que se indique en esas reglas."
        },
        {
          "kind": "heading",
          "text": "9. Disponibilidad del servicio"
        },
        {
          "kind": "paragraph",
          "text": "Hacemos lo posible por que el sitio funcione, pero no garantizamos que esté siempre disponible ni libre de fallas (el servicio depende de proveedores de internet y de alojamiento). Podemos cambiar, pausar o retirar juegos o funciones. Si una falla grave afecta un evento con premios, se aplican las reglas de cancelación y reclamos de ese evento."
        },
        {
          "kind": "heading",
          "text": "10. Responsabilidad"
        },
        {
          "kind": "paragraph",
          "text": "Respondemos por el funcionamiento del servicio en la medida que la ley lo exige. Esto no limita los derechos que la ley te reconoce como consumidor."
        },
        {
          "kind": "heading",
          "text": "11. Cambios a estos términos"
        },
        {
          "kind": "paragraph",
          "text": "Si cambiamos estos términos, publicamos la nueva versión con su fecha. Antes de que sigas participando en juegos con premios, se te pedirá que leas y aceptes la versión nueva. No se considera que aceptaste una versión que no se te mostró."
        },
        {
          "kind": "heading",
          "text": "12. Cerrar tu cuenta"
        },
        {
          "kind": "paragraph",
          "text": "Puedes dejar de usar el servicio cuando quieras. Para pedir el cierre de tu cuenta o de tus datos escribe a info@urbanohn.com; cómo se atiende está en el Aviso de privacidad."
        },
        {
          "kind": "heading",
          "text": "13. Ley aplicable"
        },
        {
          "kind": "paragraph",
          "text": "Estos términos se rigen por las leyes de la República de Honduras."
        },
        {
          "kind": "paragraph",
          "text": "Aceptación: antes de participar en un juego con premios se te mostrará este texto completo y una casilla que debes marcar. El sistema guarda qué versión aceptaste y cuándo. Puedes volver a leerlo en cualquier momento desde el sitio."
        }
      ]
    }
  },
  {
    "key": "PRIVACY_NOTICE",
    "version": "2026-10-25.1",
    "locale": "es",
    "scope": {
      "kind": "GLOBAL"
    },
    "current": true,
    "sha256": "b2542e59a508456e3a37d9d28279c5cea5f2186b4cf1a99efd480b98ac30677d",
    "content": {
      "title": "Aviso de privacidad de URBANO Gaming",
      "blocks": [
        {
          "kind": "heading",
          "text": "1. Quién es responsable de tus datos"
        },
        {
          "kind": "paragraph",
          "text": "Tecnomovi S.A., operadora de URBANO Gaming."
        },
        {
          "kind": "list",
          "items": [
            "Domicilio: Torre Nova 2, Piso 9, Centro Comercial Novacentro, Corporativo Los Próceres, 11101 Tegucigalpa, Francisco Morazán.",
            "Contacto para consultas y solicitudes sobre tus datos: info@urbanohn.com."
          ]
        },
        {
          "kind": "heading",
          "text": "2. Qué datos recogemos"
        },
        {
          "kind": "table",
          "header": [
            "Dato",
            "Cuándo",
            "Para qué"
          ],
          "rows": [
            [
              "Correo electrónico",
              "Al crear tu cuenta y al entrar",
              "Verificar que la cuenta es tuya (código de un solo uso) y comunicarte ese código"
            ],
            [
              "Nombre visible (el que eliges)",
              "Al crear tu cuenta",
              "Identificar tu cuenta en el juego y ante quien entrega un premio"
            ],
            [
              "Tus pronósticos (marcador, primer equipo, jugador, minuto) y la hora en que los enviaste",
              "Cuando participas",
              "Evaluar tu participación"
            ],
            [
              "Resultado de la evaluación y premio ganado",
              "Después del partido",
              "Determinar y entregar tu premio"
            ],
            [
              "Registro del canje (fecha, hora, premio entregado y qué cuenta de administración lo registró)",
              "Cuando canjeas",
              "Evitar canjes dobles y poder atender reclamos"
            ],
            [
              "Comprobación de proximidad: hora de la comprobación, distancia en metros al punto definido para el local, precisión que reportó tu teléfono y el resultado",
              "Cuando envías un pronóstico en un juego que exige estar cerca del local",
              "Verificar que participas desde el área de proximidad del local"
            ],
            [
              "Tus aceptaciones y confirmaciones de lectura: qué texto (versión y huella), cuándo, y en las reglas de un evento, tu declaración de tener 18 años o más",
              "Antes de participar",
              "Dejar constancia de lo que aceptaste o leíste"
            ]
          ]
        },
        {
          "kind": "paragraph",
          "text": "Sobre tu ubicación: tu navegador te pide permiso. Al enviar un pronóstico, tu teléfono manda sus coordenadas a nuestro servidor solo para calcular la distancia al punto del local en ese momento. No guardamos las coordenadas: guardamos únicamente la distancia, la precisión, la hora y el resultado. No seguimos tu ubicación ni guardamos un historial de dónde estuviste. La comprobación se basa en GPS y no acredita que estés dentro del local."
        },
        {
          "kind": "paragraph",
          "text": "Lo que no recogemos: no guardamos fotos de documentos, números de documentos de identidad, datos de pago, ni tu lista de contactos. Cuando un bono se usa en bebidas alcohólicas, el personal de The Pub revisa tu documento en persona para comprobar tu edad, y no lo fotografía ni anota su número."
        },
        {
          "kind": "paragraph",
          "text": "Datos técnicos: los proveedores que hacen funcionar el sitio pueden registrar datos técnicos de conexión (por ejemplo la dirección IP) para operar y proteger el servicio. No los usamos para perfilarte."
        },
        {
          "kind": "heading",
          "text": "3. Qué guarda tu teléfono (sin cookies publicitarias)"
        },
        {
          "kind": "list",
          "items": [
            "Tu sesión de URBANO Gaming y tu idioma preferido, en el almacenamiento local de tu navegador, para que no tengas que volver a entrar en cada visita.",
            "El sitio no usa cookies de publicidad ni herramientas de analítica.",
            "Algunas fuentes de texto y una librería técnica se cargan desde servidores de terceros (Google Fonts y jsDelivr), que reciben tu dirección IP como en cualquier página web."
          ]
        },
        {
          "kind": "heading",
          "text": "4. Para qué usamos tus datos"
        },
        {
          "kind": "list",
          "items": [
            "Crear y mantener tu cuenta.",
            "Dejarte participar, comprobar tu proximidad al local, evaluar tus pronósticos y determinar tus premios.",
            "Entregar premios y registrar que se entregaron.",
            "Dejar constancia de lo que aceptaste o leíste.",
            "Proteger el servicio contra fraude y abuso.",
            "Atender tus consultas, solicitudes y reclamos."
          ]
        },
        {
          "kind": "paragraph",
          "text": "No enviamos mensajes de mercadeo ni vendemos ni cedemos tus datos para publicidad. Si en el futuro se quiere enviar promociones, se pedirá un permiso aparte, opcional, y este aviso se actualizará antes."
        },
        {
          "kind": "heading",
          "text": "5. Con quién se comparten o quién los procesa"
        },
        {
          "kind": "table",
          "header": [
            "Quién",
            "Qué hace",
            "Qué datos ve"
          ],
          "rows": [
            [
              "Supabase",
              "Base de datos y sistema de acceso (código por correo)",
              "Los datos de la sección 2. Región del servidor: Estados Unidos (us-west-2)"
            ],
            [
              "Vercel",
              "Aloja y entrega el sitio; sus servidores atienden las solicitudes",
              "Datos técnicos de conexión y las solicitudes que pasan por el sitio. Región: Estados Unidos"
            ],
            [
              "Servicio de envío de correo electrónico",
              "Entrega el correo con tu código",
              "Tu correo y el contenido del mensaje"
            ],
            [
              "Administrador presencial de URBANO Gaming",
              "Opera el sistema el día del evento, confirma resultados y valida y registra los canjes",
              "Tu nombre visible, tu participación, tu nivel y tu premio"
            ],
            [
              "The Pub (el local)",
              "Presta el servicio y entrega físicamente el premio",
              "Ve tu nombre visible y el premio cuando te presentas a recibirlo. No tiene acceso al sistema ni recibe tu correo"
            ],
            [
              "Google Fonts, jsDelivr",
              "Entregan fuentes y una librería técnica",
              "Tu dirección IP"
            ]
          ]
        },
        {
          "kind": "paragraph",
          "text": "Algunos de estos servicios operan fuera de Honduras. Fuera de estos casos no compartimos tus datos, salvo que una autoridad competente lo exija conforme a la ley."
        },
        {
          "kind": "paragraph",
          "text": "Las clasificaciones públicas están cerradas. Si se abren, tu nombre visible podría mostrarse en ellas y se te avisará antes."
        },
        {
          "kind": "heading",
          "text": "6. Cuánto tiempo los conservamos"
        },
        {
          "kind": "paragraph",
          "text": "Separamos lo que hace la aplicación de lo que garantiza la base de datos, porque no es lo mismo."
        },
        {
          "kind": "list",
          "items": [
            "Datos de tu cuenta (correo y nombre visible): mientras tu cuenta esté activa.",
            "Tu pronóstico (lo que hace la aplicación): la aplicación te deja cambiarlo mientras la participación esté abierta; cada cambio reemplaza el anterior. Al inicio del partido la participación se cierra y la aplicación ya no admite cambios. La aplicación no ofrece ninguna función para borrarlo.",
            "Lo que la base de datos garantiza: la evaluación de tu pronóstico no se puede modificar ni borrar; el historial de tus premios ganados y canjeados no se puede borrar (solo avanza con estados nuevos, por ejemplo «canjeado»); y tus aceptaciones y confirmaciones de lectura no se pueden modificar. Mientras existan registros enlazados a tu cuenta, la base de datos tampoco permite eliminar la cuenta.",
            "Lo que la base de datos no impide, y que nosotros no hacemos: borrar tus pronósticos y tus aceptaciones. La aplicación no ofrece ninguna función para hacerlo y no existe un procedimiento de borrado.",
            "No hay plazo de borrado automático ni un proceso automático de eliminación o de anonimización. Estos registros se conservan mientras sean necesarios para atender reclamos y evitar canjes dobles."
          ]
        },
        {
          "kind": "heading",
          "text": "7. Tus derechos y cómo ejercerlos"
        },
        {
          "kind": "paragraph",
          "text": "Puedes pedirnos: ver qué datos tenemos tuyos, corregirlos, pedir su eliminación en lo que el sistema permite (ver más abajo), oponerte a algún uso y retirar un permiso que hayas dado (por ejemplo, desactivar el permiso de ubicación en tu navegador)."
        },
        {
          "kind": "paragraph",
          "text": "Escribe a info@urbanohn.com desde el correo de tu cuenta, indicando qué pides. Te responderemos en 15 días hábiles. Responde Tecnomovi S.A., por medio del administrador. Hoy estas solicitudes se atienden manualmente; no existe un botón automático."
        },
        {
          "kind": "paragraph",
          "text": "Si pides eliminar tu cuenta, esto es lo que se puede y lo que no:"
        },
        {
          "kind": "list",
          "items": [
            "No borramos tus pronósticos, evaluaciones, premios y canjes, ni tus aceptaciones: la aplicación no ofrece ninguna función para ello y no existe un procedimiento de borrado. Además, la base de datos impide modificar o borrar las evaluaciones, impide borrar el historial de premios y canjes e impide modificar las aceptaciones (no impide borrar tus pronósticos ni tus aceptaciones; simplemente no lo hacemos). Esos registros están enlazados a tu cuenta mediante un identificador interno, y mientras existan la base de datos no permite eliminar tu cuenta de acceso.",
            "El procedimiento manual que sí existe: (1) comprobamos que la solicitud viene del correo de tu cuenta; (2) cambiamos tu nombre visible por uno genérico; (3) desactivamos tu acceso, para que nadie pueda entrar con tu cuenta. Lo hace Tecnomovi S.A., por medio del administrador, en el plazo de arriba.",
            "Esto no es anonimizar. Cambiar el nombre visible y desactivar el acceso reduce lo que se ve y quién puede entrar, pero permanecen: el identificador interno de tu cuenta y su fecha de creación; tus pronósticos, evaluaciones, premios y canjes, con sus fechas y horas; tus aceptaciones (qué texto, versión, fecha y hora, y tu declaración de tener 18 años o más); y tu correo, que sigue guardado en el sistema de acceso, desactivado. Un registro así, junto con otra información, podría relacionarse contigo."
          ]
        },
        {
          "kind": "paragraph",
          "text": "Tampoco podemos borrar lo que una ley o autoridad nos obligue a conservar."
        },
        {
          "kind": "paragraph",
          "text": "Si crees que tus derechos no fueron atendidos puedes acudir a las instancias que la ley hondureña te reconozca, incluida la garantía constitucional de hábeas data."
        },
        {
          "kind": "heading",
          "text": "8. Seguridad"
        },
        {
          "kind": "paragraph",
          "text": "Las conexiones al sitio usan HTTPS. Los datos del juego se leen y escriben desde nuestro servidor, no directamente desde tu teléfono. El panel con el que se registran los canjes exige una cuenta autorizada, y el personal del local no tiene acceso a él. Ningún sistema es infalible; si ocurriera una incidencia que te afecte, te lo comunicaremos por correo a las cuentas afectadas y en el sitio, sin demora injustificada."
        },
        {
          "kind": "heading",
          "text": "9. Menores de edad"
        },
        {
          "kind": "paragraph",
          "text": "El evento de URBANO Score del 25 de octubre de 2026 exige 18 años cumplidos o más. Este aviso no fija una edad mínima para la plataforma en general."
        },
        {
          "kind": "heading",
          "text": "10. Cambios a este aviso"
        },
        {
          "kind": "paragraph",
          "text": "Si lo cambiamos, publicamos la nueva versión con su fecha y, antes de que sigas participando en juegos con premios, se te pedirá que confirmes que la leíste. No se considera que leíste una versión que no se te mostró."
        },
        {
          "kind": "paragraph",
          "text": "Confirmación de lectura: antes de participar se te mostrará este texto completo y una casilla «Leí el Aviso de privacidad». Esa casilla confirma que tuviste acceso al texto y lo leíste; no es un consentimiento general para cualquier uso de tus datos y no amplía los usos de la sección 4. El sistema guarda qué versión confirmaste y cuándo. Puedes volver a leerlo en cualquier momento desde el sitio. Cualquier permiso de mercadeo sería una casilla distinta, opcional y nunca necesaria para participar."
        }
      ]
    }
  },
  {
    "key": "EVENT_RULES",
    "version": "2026-10-25.1",
    "locale": "es",
    "scope": {
      "kind": "EVENT",
      "kickoffAt": "2026-10-25T20:00:00.000Z"
    },
    "current": true,
    "sha256": "0291684f8e9340cbcb411485afdaddfb2098b8ab4f8ed604e2ead4f1e2060b87",
    "content": {
      "title": "Reglas específicas del evento y canje",
      "blocks": [
        {
          "kind": "paragraph",
          "text": "URBANO Score — El Clásico: FC Barcelona vs. Real Madrid CF — The Pub — 25 de octubre de 2026"
        },
        {
          "kind": "heading",
          "text": "1. Qué es este evento"
        },
        {
          "kind": "paragraph",
          "text": "URBANO Score es un juego de pronóstico de URBANO Gaming que se juega desde el teléfono, en el área de proximidad habilitada de The Pub (ubicación: https://maps.app.goo.gl/Pwq4B5sDBczHk2oYA), durante el partido FC Barcelona vs. Real Madrid CF del domingo 25 de octubre de 2026."
        },
        {
          "kind": "paragraph",
          "text": "Lo organiza URBANO Gaming, operado por Tecnomovi S.A., Torre Nova 2, Piso 9, Centro Comercial Novacentro, Corporativo Los Próceres, 11101 Tegucigalpa, Francisco Morazán. Contacto: info@urbanohn.com."
        },
        {
          "kind": "paragraph",
          "text": "The Pub presta el servicio en su local y entrega los premios."
        },
        {
          "kind": "heading",
          "text": "2. Qué no exige este evento"
        },
        {
          "kind": "list",
          "items": [
            "Participar es gratis: no hay que comprar nada ni hacer un consumo mínimo.",
            "No se pide factura para participar ni para canjear.",
            "No se exige consumo mínimo ni factura, ni para participar ni para canjear. Los premios de consumo no generan crédito después del 31 de octubre de 2026."
          ]
        },
        {
          "kind": "heading",
          "text": "3. Quién puede participar"
        },
        {
          "kind": "paragraph",
          "text": "Para participar necesitas:"
        },
        {
          "kind": "list",
          "items": [
            "Tener 18 años cumplidos o más. Al aceptar estas reglas declaras que los tienes. Esta edad es una condición de este evento, no de la plataforma en general.",
            "Tener una cuenta de URBANO Gaming y haber aceptado la versión vigente de los Términos de cuenta y de estas reglas, y haber confirmado que leíste el Aviso de privacidad.",
            "Estar dentro del área de proximidad habilitada de The Pub cuando envías tu pronóstico. El área es un círculo de unos 30 metros de radio alrededor de un punto de The Pub: puede incluir zonas fuera del local y no necesariamente cubre todo el local. El navegador te pide permiso de ubicación y el sistema compara la posición que reporta tu teléfono con un punto y un radio definidos para The Pub. Es una comprobación de cercanía basada en GPS: no acredita que estés dentro del local y su precisión depende de tu teléfono. Si no das el permiso o estás fuera del área, no puedes participar.",
            "Una participación por persona y por partido. Puedes cambiar tu pronóstico mientras la participación siga abierta."
          ]
        },
        {
          "kind": "heading",
          "text": "4. Cuándo se participa"
        },
        {
          "kind": "list",
          "items": [
            "Apertura prevista: 12:30 p. m., hora de Honduras (90 minutos antes del inicio previsto del partido).",
            "Cierre: al inicio del partido (previsto 2:00 p. m., hora de Honduras). El cierre lo aplica el sistema: a partir de ese instante no se acepta ningún pronóstico nuevo ni ningún cambio.",
            "La participación no se abre sola: la habilita una persona del equipo de URBANO Gaming cuando todo está listo. Si a las 12:30 p. m. no está habilitada, se informará en el sitio y sigue cerrada.",
            "Las horas anunciadas son las previstas. El inicio oficial previsto (2:00 p. m., hora de Honduras) se comprobó el 25 de octubre de 2026 en la web oficial del FC Barcelona. Si el inicio oficial cambia, vale la hora de cierre registrada en el sistema para el partido, y se anunciará."
          ]
        },
        {
          "kind": "heading",
          "text": "5. Qué se pronostica y cómo se gana un nivel"
        },
        {
          "kind": "paragraph",
          "text": "Tu pronóstico tiene hasta cuatro niveles, en este orden fijo. Tú eliges hasta qué nivel respondes. Todo se evalúa sobre el tiempo reglamentario (90 minutos más el tiempo agregado por el árbitro; no cuentan la prórroga ni los penales)."
        },
        {
          "kind": "table",
          "header": [
            "Nivel",
            "Nombre",
            "Qué debes acertar"
          ],
          "rows": [
            [
              "1",
              "Fácil",
              "El marcador exacto"
            ],
            [
              "2",
              "Mediana",
              "El primer equipo en anotar"
            ],
            [
              "3",
              "Difícil",
              "Un jugador que anote"
            ],
            [
              "4",
              "Legendaria",
              "El minuto de un gol"
            ]
          ]
        },
        {
          "kind": "paragraph",
          "text": "Ganas el nivel más alto que alcanzas acertando en orden desde el nivel 1. Si fallas un nivel, los siguientes no cuentan, aunque los hayas acertado. Si eliges \"ninguno\" en un nivel, esa respuesta es correcta únicamente cuando no hubo goles en el tiempo reglamentario."
        },
        {
          "kind": "heading",
          "text": "6. Premios"
        },
        {
          "kind": "paragraph",
          "text": "Cada participante recibe un solo premio: el del nivel más alto que ganó. No hay sorteo ni cupo por nivel: todas las personas que alcanzan un nivel ganan el premio de ese nivel."
        },
        {
          "kind": "table",
          "header": [
            "Nivel",
            "Premio"
          ],
          "rows": [
            [
              "Fácil",
              "Una orden de tequeños por ganador"
            ],
            [
              "Mediana",
              "Un bono de consumo de L250 por ganador"
            ],
            [
              "Difícil",
              "Un bono de consumo de L500 por ganador"
            ],
            [
              "Legendaria",
              "Un paquete completo de cuatro entradas para Halloween de The Pub, valorado en L1,200, por ganador"
            ]
          ]
        },
        {
          "kind": "list",
          "items": [
            "Tecnomovi S.A. asume cubrir los premios a todas las personas ganadoras.",
            "Los premios de este evento no se cambian por otros después de abierta la participación.",
            "Premios de consumo (la orden de tequeños y los bonos de L250 y L500): se canjean y se usan en The Pub, durante su horario de atención, hasta el 31 de octubre de 2026 inclusive, para el consumo de la persona ganadora. Pasada esa fecha ya no se pueden usar y no generan crédito posterior. Los bonos no se entregan en efectivo ni dan cambio y no tienen consumo mínimo. Los bonos pueden usarse en bebidas alcohólicas solo por personas de 18 años cumplidos o más, con la verificación de edad que The Pub aplica a cualquier cliente.",
            "Paquete de entradas para Halloween de The Pub: cuatro entradas para la fiesta de Halloween del 31 de octubre de 2026 en The Pub, valoradas en L1,200 el paquete. Son entradas de acceso a la fiesta: no son una inscripción al concurso de disfraces. El premio son las cuatro entradas; cualquier consumo o beneficio adicional no forma parte del premio. Las entradas se entregan en The Pub, en el mismo canje y plazo de los premios de consumo. Si la fiesta se cancela, Tecnomovi S.A. acuerda con la persona ganadora entradas para la nueva fecha u otro premio de igual valor (L1,200).",
            "Si un premio no pudiera entregarse como se anunció, Tecnomovi S.A. cumple el premio anunciado; si no fuera posible, acuerda con la persona ganadora otro de valor igual o mayor. El premio no se cambia unilateralmente."
          ]
        },
        {
          "kind": "heading",
          "text": "7. Cuándo y cómo se evalúa"
        },
        {
          "kind": "list",
          "items": [
            "Cuando el partido termina, el administrador presencial de URBANO Gaming registra y confirma el resultado oficial del tiempo reglamentario (el resultado del tiempo reglamentario publicado por LaLiga para este partido).",
            "El sistema compara cada pronóstico con ese resultado y determina el nivel ganado por cada participante.",
            "Puedes ver el resultado de tu participación en la sección \"Mi participación\" del sitio.",
            "Si se descubre un error en el resultado cargado, se corrige y se reevalúan los pronósticos. Si ya habías recibido un premio, la corrección no te lo quita."
          ]
        },
        {
          "kind": "heading",
          "text": "8. Canje del premio"
        },
        {
          "kind": "paragraph",
          "text": "El canje es presencial, en The Pub, durante su horario de atención, hasta el 31 de octubre de 2026 inclusive. Pasada esa fecha el premio de consumo ya no se puede canjear y se pierde, sin compensación ni crédito posterior. Lo canjea únicamente la persona ganadora, con su propia cuenta en su propio teléfono. El premio no es transferible."
        },
        {
          "kind": "paragraph",
          "text": "Son dos cosas distintas:"
        },
        {
          "kind": "list",
          "items": [
            "Identificar a la persona ganadora. El administrador presencial de URBANO Gaming comprueba que quien se presenta es la titular de la cuenta ganadora: ve su cuenta en su propio teléfono y compara su nombre visible, el partido y el nivel con el sistema. Mostrar la cuenta o haber ganado no basta por sí solo para recibir un premio.",
            "Registrar el canje una sola vez. El administrador presencial valida el premio y lo registra como canjeado en el sistema, coordinado con la entrega. Cada premio se canjea una sola vez y el registro queda con fecha, hora y premio."
          ]
        },
        {
          "kind": "paragraph",
          "text": "Sobre el consumo de bebidas alcohólicas en The Pub:"
        },
        {
          "kind": "list",
          "items": [
            "URBANO Gaming no promueve el consumo excesivo. Si vas a manejar, no bebas alcohol.",
            "Las normas sobre venta de bebidas alcohólicas aplican a The Pub en su local."
          ]
        },
        {
          "kind": "heading",
          "text": "9. Qué datos se usan"
        },
        {
          "kind": "paragraph",
          "text": "Las respuestas, la comprobación de ubicación y el registro del canje se tratan como explica el Aviso de privacidad. Al canjear no se guardan fotos ni números de documentos."
        },
        {
          "kind": "heading",
          "text": "10. Cancelación, suspensión y fraude"
        },
        {
          "kind": "paragraph",
          "text": "URBANO Gaming puede suspender o cancelar el evento, o excluir participaciones, si:"
        },
        {
          "kind": "list",
          "items": [
            "el partido se suspende, se pospone o no se completa el tiempo reglamentario este 25 de octubre de 2026: el evento queda sin efecto y no se entregan premios, y se avisará en el sitio;",
            "hay una falla técnica grave que impida evaluar con justicia;",
            "se detecta fraude, por ejemplo cuentas múltiples, falsear la ubicación o usar programas automáticos."
          ]
        },
        {
          "kind": "paragraph",
          "text": "Se anunciará en el sitio. Esto no afecta los derechos que la ley te reconoce como consumidor."
        },
        {
          "kind": "heading",
          "text": "11. Reclamos"
        },
        {
          "kind": "paragraph",
          "text": "Si crees que tu participación o tu premio se evaluó mal, escribe a info@urbanohn.com indicando tu nombre visible y el partido, hasta las 11:59 p. m. del 26 de octubre de 2026. Revisamos tu participación registrada, el resultado y estas reglas y te respondemos por el mismo medio en 5 días hábiles."
        },
        {
          "kind": "heading",
          "text": "12. Cambios a estas reglas"
        },
        {
          "kind": "paragraph",
          "text": "Si estas reglas cambian antes de que abra la participación, se publica la nueva versión con su fecha y debes aceptarla antes de participar. Una vez abierta la participación, las reglas del evento no se cambian en perjuicio de quien ya participó."
        },
        {
          "kind": "paragraph",
          "text": "Aceptación: para participar se te mostrará este texto completo, una casilla para aceptarlo y otra para declarar que tienes 18 años o más. El sistema guarda qué versión aceptaste y cuándo. Puedes volver a leerlo en cualquier momento desde el sitio."
        }
      ]
    }
  }
];

/** The one place the server asks for the registry, so a test can stand in a registry of its own without touching the real one. */
export function legalRegistry(): ReadonlyArray<LegalDocumentEntry> {
  return LEGAL_DOCUMENTS;
}

function blockForm(block: LegalBlock): unknown {
  switch (block.kind) {
    case "heading":
      return ["heading", block.text];
    case "paragraph":
      return ["paragraph", block.text];
    case "list":
      return ["list", block.items];
    case "table":
      return ["table", block.header, block.rows];
  }
}

/**
 * The canonical form of a document: its title and its blocks, in order, as nested arrays (so no object-key ordering is involved). The hash
 * is taken over this string encoded as UTF-8. Changing a single character of a text changes its hash.
 */
export function canonicalDocumentJson(content: LegalDocumentContent): string {
  return JSON.stringify([content.title, content.blocks.map(blockForm)]);
}

export function hashDocument(content: LegalDocumentContent): string {
  return createHash("sha256").update(canonicalDocumentJson(content), "utf8").digest("hex");
}

/** An entry is intact when the hash pinned beside its text is the hash of its text. */
export function isIntact(entry: LegalDocumentEntry): boolean {
  return /^[0-9a-f]{64}$/.test(entry.sha256) && entry.sha256 === hashDocument(entry.content);
}

/** The instant an event is keyed to, in one form; null if it is not a date. */
export function eventInstant(kickoffAt: string): string | null {
  const time = new Date(kickoffAt).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function sameScope(entryScope: LegalScope, wanted: LegalScope): boolean {
  if (entryScope.kind !== wanted.kind) return false;
  if (entryScope.kind === "GLOBAL") return true;
  const a = eventInstant(entryScope.kickoffAt);
  const b = eventInstant((wanted as { kind: "EVENT"; kickoffAt: string }).kickoffAt);
  return a !== null && a === b;
}

/**
 * The published current text of a document for a scope — or null. Null when there is none, when there is more than one (an ambiguous
 * registry publishes nothing), or when the one there is is not intact. Never a guess, never "the latest of what is there".
 */
export function publishedEntry(
  registry: ReadonlyArray<LegalDocumentEntry>,
  key: LegalDocumentKey,
  scope: LegalScope
): LegalDocumentEntry | null {
  const current = registry.filter((entry) => entry.key === key && entry.current && sameScope(entry.scope, scope));
  if (current.length !== 1) return null;
  return isIntact(current[0]) ? current[0] : null;
}

/** A specific version, current or not, if the registry has it exactly once and it is intact. */
export function entryByVersion(
  registry: ReadonlyArray<LegalDocumentEntry>,
  key: LegalDocumentKey,
  version: string,
  scope: LegalScope
): LegalDocumentEntry | null {
  const found = registry.filter((entry) => entry.key === key && entry.version === version && sameScope(entry.scope, scope));
  if (found.length !== 1) return null;
  return isIntact(found[0]) ? found[0] : null;
}
