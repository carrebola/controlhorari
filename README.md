# Control Horari

Aplicación móvil para programar fichajes de Timenet desde un servidor, registrar entradas y salidas manuales, consultar el calendario y recibir notificaciones del resultado.

## Arquitectura

- **Vercel / Next.js:** interfaz web instalable (PWA) y proxy de sesión.
- **Cloudflare Worker:** API, autenticación y programador cada minuto.
- **Cloudflare D1:** usuarios, horarios, trabajos, avisos y auditoría.
- **Cloudflare Browser Rendering:** acceso automatizado a Timenet solo cuando toca fichar o cuando el usuario sincroniza el historial.

Los PIN de Timenet se cifran con AES-GCM antes de guardarse. Las contraseñas se derivan con PBKDF2 y las sesiones llegan al navegador en una cookie `HttpOnly`.

## Desarrollo local

### Trabajar desde otro puesto

Usa Node.js 24 y clona este repositorio:

```powershell
git clone https://github.com/carrebola/controlhorari.git
cd controlhorari
npm ci
Copy-Item cloudflare/.dev.vars.example cloudflare/.dev.vars
```

Si ya lo tienes clonado, utiliza `git pull --ff-only` y `npm ci` para actualizarlo. Completa las claves locales del archivo `cloudflare/.dev.vars` siguiendo los pasos siguientes. Para recibir avisos en desarrollo, ejecuta también `npm run push:setup`.

El código y las migraciones viajan con Git, pero las cuentas, los PIN y los fichajes locales no. Las variables privadas y las sesiones de Cloudflare/Vercel se configuran por separado en cada puesto; no copies credenciales de producción al repositorio. La base de producción permanece en Cloudflare.

La interfaz local usa por defecto `http://127.0.0.1:8787`. Si tienes un `.env.local` con otra dirección, establece `WORKER_API_URL=http://127.0.0.1:8787` para trabajar contra la base local. Crea un administrador local con el procedimiento de abajo; las credenciales de producción no funcionan en una base local vacía.

### Preparar los servidores locales

1. Instala dependencias con `npm install`.
2. Copia `cloudflare/.dev.vars.example` como `cloudflare/.dev.vars` y sustituye todos los valores. `DATA_ENCRYPTION_KEY` debe ser una clave aleatoria de 32 bytes codificada en Base64.
3. Aplica las migraciones y ejecuta el Worker:

   ```powershell
   npm run cf:migrate:local
   npm run cf:dev
   ```

4. En otra terminal, ejecuta `npm run dev` y abre `http://localhost:3000`.

En Windows, `cf:dev` usa Chrome o Edge instalado para evitar los errores de arranque del navegador incluido en Miniflare. Puedes indicar otra instalación con `LOCAL_CHROME_PATH` (ruta completa al ejecutable). Este ajuste solo afecta al desarrollo local.

## Crear el primer administrador

Con el Worker local en ejecución, usa el mismo `ADMIN_SETUP_SECRET` de `cloudflare/.dev.vars`:

```powershell
$headers = @{ "x-admin-setup-secret" = "TU_SECRETO_DE_ALTA" }
$body = @{
  username = "carlos"
  displayName = "Carlos"
  password = "UNA_CONTRASEÑA_LARGA"
  timenetPin = "TU_PIN"
  role = "admin"
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/admin/users -Headers $headers -ContentType "application/json" -Body $body
```

Cada usuario tiene su propio PIN cifrado y su horario independiente.

## Despliegue

### Cloudflare

1. Inicia sesión con `npx wrangler login`.
2. Crea D1 con `npx wrangler d1 create controlhorari`.
3. Sustituye el `database_id` de `cloudflare/wrangler.jsonc` por el identificador devuelto.
4. Cambia `APP_ORIGIN` por el dominio final de Vercel.
5. Guarda `ADMIN_SETUP_SECRET`, `AUTH_PEPPER`, `DATA_ENCRYPTION_KEY` y `CRON_SECRET` mediante `npx wrangler secret put NOMBRE --config cloudflare/wrangler.jsonc`.
6. Ejecuta `npm run cf:migrate:remote` y `npm run cf:deploy`.

### Vercel

Importa el repositorio y añade `WORKER_API_URL` con la URL pública del Worker, sin barra final. Si la URL final de Vercel cambia, actualiza `APP_ORIGIN` en el Worker.

## Funcionamiento y seguridad

- Cada minuto se generan y reclaman de forma atómica los fichajes pendientes.
- Un margen aleatorio configurable modifica la hora objetivo.
- Se impide repetir una entrada o salida si Timenet ya está en ese estado.
- Si no puede confirmarse un clic, queda como **Revisar** y no se repite automáticamente.
- Un PIN inválido desactiva la automatización del usuario.
- Los trabajos fuera de la ventana segura quedan como **No ejecutado** y producen un aviso.
- El panel Monitor muestra latencia, ciclos del programador y fallos recientes.
- **Sincronizar Timenet** importa las marcas y distingue las que coinciden con trabajos automáticos; el resto se marca como manual.
- El resumen agrupa los datos por día: entrada/salida previstas en el calendario de Timenet, horas automáticas calculadas con margen aleatorio, registros manuales/externos y registros automáticos confirmados por esta aplicación. Se conservan todos los fichajes si hay varias entradas o salidas.
- La sincronización lee el horario y los registros reales por separado. Los horarios futuros no se importan como fichajes. Las horas aleatorias quedan guardadas y el programador reutiliza ese cálculo; no se inventan cálculos para días pasados sin planificación guardada.
- Cuando existe calendario sincronizado para un día, el programador utiliza ese horario y omite los días sin turno. Si no se ha sincronizado, utiliza el horario semanal configurado. Los turnos partidos quedan sin automatizar hasta contar con soporte para varias franjas.

## Instalación móvil y notificaciones

La app incluye manifiesto PWA, iconos PNG de 192/512 píxeles e icono de iPhone. En **Ajustes → Instalar en el móvil** aparecen las instrucciones o el botón de instalación cuando el navegador lo permite. Usa la URL pública HTTPS; `localhost` en el teléfono apunta al propio teléfono, no al ordenador. En iPhone/iPad, añade la app a la pantalla de inicio y ábrela desde su icono antes de activar los avisos.

Para desarrollo, ejecuta `npm run push:setup` y reinicia `npm run cf:dev`. Las claves se guardan solo en `cloudflare/.dev.vars`, excluido de Git. Para producción, genera una pareja VAPID una sola vez (`npx web-push generate-vapid-keys --json`), configura `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY` con `wrangler secret put NOMBRE --config cloudflare/wrangler.jsonc` y conserva ambas claves. `VAPID_SUBJECT` puede ser una URL HTTPS de contacto o una dirección `mailto:`; por defecto se utiliza `APP_ORIGIN`. Aplica las migraciones remotas y despliega el Worker y la interfaz. No publiques la clave privada en variables `NEXT_PUBLIC_*`.

En cada dispositivo, abre **Ajustes → Notificaciones del móvil → Activar avisos**, concede permiso y pulsa **Probar**. Una prueba aceptada por el proveedor no garantiza que el sistema operativo ya la haya mostrado: comprueba la recepción en el móvil. El envío real requiere una suscripción concedida por ese dispositivo; no se ha verificado en un teléfono físico desde este entorno.

Los fichajes manuales y automáticos guardan avisos de éxito, fallo o resultado incierto. También se notifican los trabajos no ejecutados a tiempo y los reintentos. El servidor envía Web Push cifrado aunque la app esté cerrada, conserva una cola con hasta tres intentos, evita reenviar a dispositivos ya atendidos y elimina suscripciones caducadas. Los avisos permanecen en la pestaña Avisos si la entrega móvil falla. Cerrar sesión elimina la suscripción de ese dispositivo; otros dispositivos del mismo usuario conservan la suya. Las entregas dependen de la conectividad, permisos y ajustes de concentración/ahorro de batería del teléfono.

El modo sin conexión muestra una pantalla informativa: no guarda páginas con datos personales ni encola fichajes manuales para ejecutarlos después.

## Comprobaciones

Antes de publicar, configura `WORKER_API_URL` con la URL HTTPS del Worker en Vercel y `APP_ORIGIN` con el dominio real de la interfaz en Cloudflare. La interfaz devuelve un error de configuración si falta `WORKER_API_URL` en producción. El proxy declara un máximo de 120 segundos; confirma que el plan de alojamiento lo permite.

Aplica todas las migraciones, incluidas `0003`–`0007`, antes de desplegar el nuevo Worker. Verifica los secretos de autenticación/cifrado y VAPID, y conserva la clave de cifrado existente para poder leer los PIN ya guardados. El secreto de alta inicial solo permite crear usuarios mientras la base está vacía; después hace falta una sesión administradora. El acceso está limitado a doce intentos por usuario cada quince minutos.

La prueba de aceptación pendiente tras el despliegue es instalarla en un móvil real, activar avisos y comprobar **Probar** con la app cerrada. El desarrollo local no demuestra entrega en iOS/Android ni confirma la configuración del cron remoto. No despliegues la cuenta local de prueba ni sus credenciales a producción.

```powershell
npm run build
npm run cf:typecheck
node --test --test-isolation=none scripts/timenet-history.test.mjs
node --test --test-isolation=none scripts/punch-guard.test.mjs scripts/push.test.mjs
npm run test:push:worker
```
