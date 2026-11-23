---
name: convencion-commits
description: Convención de los mensajes de commit de este proyecto. Cárgala antes de hacer cualquier git commit.
---

# Convención de commits

El mensaje es una sola línea:

```
<tipo>(<ámbito>): <descripción> (#<issue>)
```

- `tipo`: `fix`, `feat`, `refactor`, `test`, `docs` o `chore`.
- `ámbito`: opcional, el módulo que cambia (`cart`, `pricing`).
- `descripción`: en minúsculas, sin punto final.
- `(#<issue>)`: el número de la issue que resuelve el cambio, si la hay.
- La línea entera tiene 72 caracteres como mucho.

Ejemplo: `fix(cart): redondea el total a céntimos (#12)`

Añade solo los ficheros que has cambiado y haz el commit con `-m`, sin editor:

```
git add <ficheros>
git commit -m "<mensaje>"
```
