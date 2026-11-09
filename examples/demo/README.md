# tienda-demo

Carrito de la compra de juguete para probar el harness: leerlo, buscar en él y cambiarlo.

- `src/pricing.ts`: precios e impuestos.
- `src/cart.ts`: el carrito y el total del pedido.
- `test/pricing.test.ts`: pruebas de `pricing.ts`.
- `.harness/settings.json`: reglas de permisos del demo. Deniegan leer y editar cualquier `.env*` y editar la propia configuración, para que el agente no pueda ampliarse los permisos en el siguiente run. No hay ningún `deny` implícito: lo que no esté aquí no se deniega.
