# Control Horari

Aplicación móvil para programar fichajes de Timenet desde un servidor. El teléfono solo sirve para configurar horarios, activar o desactivar la automatización, consultar resultados y revisar el estado del sistema.

## Arquitectura

- **Vercel / Next.js:** interfaz web instalable (PWA) y proxy de sesión.
- **Cloudflare Worker:** API, autenticación y programador cada minuto.
- **Cloudflare D1:** usuarios, horarios, trabajos, avisos y auditoría.
- **Cloudflare Browser Rendering:** acceso automatizado a Timenet solo cuando toca fichar o cuando el usuario sincroniza el historial.

Los PIN de Timenet se cifran con AES-GCM antes de guardarse. Las contraseñas se derivan con PBKDF2 y las sesiones llegan al navegador en una cookie `HttpOnly`.

## Desarrollo local

1. Instala dependencias con `npm install`.
2. Copia `cloudflare/.dev.vars.example` como `cloudflare/.dev.vars` y sustituye todos los valores. `DATA_ENCRYPTION_KEY` debe ser una clave aleatoria de 32 bytes codificada en Base64.
3. Aplica las migraciones y ejecuta el Worker:

   ```powershell
   npm run cf:migrate:local
   npm run cf:dev
   ```

4. En otra terminal, ejecuta `npm run dev` y abre `http://localhost:3000`.

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

## Comprobaciones

```powershell
npm run build
npm run cf:typecheck
```
