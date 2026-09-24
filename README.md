# Lista-de-precios

Buscador de precios de materiales eléctricos de ELYCON S.A.S. Los precios del listado son de venta, antes de IVA.

## Uso
- Busca el material como se dice en obra (breaker 2x30, tubo EMT 3/4, cable THHN 12 rojo).
- Si no está en el listado, **Buscar precio en la web** busca primero en Interelectricas y Homecenter y, si faltan, en otras tiendas de Colombia, hasta tener mínimo 3 referencias con tienda y enlace. Revisa cada enlace antes de agregar.

## Publicar en Render (Web Service)
1. New → Web Service → repositorio `Lista-de-precios`.
2. Runtime: Node · Build command: `true` · Start command: `node server.js`.
3. Environment: `ANTHROPIC_API_KEY` = clave de https://console.anthropic.com (obligatoria para la búsqueda web).
   Opcionales: `CODIGO_ACCESO` (la app lo pide antes de buscar), `TIENDAS` (dominios donde busca primero, por defecto interelectricas.com.co, homecenter.com.co, easy.com.co, mercadolibre.com.co), `CLAUDE_MODEL`, `LIMITE_POR_HORA` (por defecto 30).

Sin servidor (abriendo `index.html` directamente) la app funciona igual, pero la búsqueda web queda en modo manual con enlaces.
