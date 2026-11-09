# lab-harness-local

Un harness para agentes de código en terminal, construido parte a parte para entender cómo funcionan estos agentes por dentro. Acompaña a la serie «Asistente de código local» de [pablomeleroalonso.me](https://pablomeleroalonso.me).

Esta versión (tag `parte-4`) ya **escribe**: un bucle con streaming, un contrato de inferencia con un adaptador a `/v1/chat/completions`, gestión del contexto (limpiar y compactar contra la ventana, y detectar cuando el servidor recorta la conversación sin avisar), cinco herramientas (`Read`, `Glob`, `Grep`, `Write` y `Edit`) y un sistema de permisos que decide dónde puede escribir el agente. No decide qué escribe: eso se revisa con `git diff`. No ejecuta comandos: `Bash` y su seguridad llegan en una parte posterior. Cada parte de la serie añade commits y un tag nuevo.

## Prerrequisitos

- Linux o macOS. En Windows, desde WSL2.
- Node.js 22 o superior y npm.
- [ripgrep](https://github.com/BurntSushi/ripgrep#installation) (`rg`) en el `PATH`: lo usan `Glob` y `Grep`.
- Un servidor compatible con `/v1/chat/completions` con un modelo que admita herramientas. Los ejemplos usan [Ollama](https://ollama.com) y `qwen2.5:7b`.

```bash
ollama pull qwen2.5:7b
```

## Instalación

```bash
git clone --branch parte-4 https://github.com/pmeleroa/lab-harness-local.git
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

| Opción | Efecto |
|---|---|
| `-w, --workspace <dir>` | Directorio sobre el que trabaja. Fuera de él, el motor de permisos pregunta. |
| `-m, --model <id>` | Modelo. Defecto: `$HARNESS_MODEL` o `qwen2.5:7b`. |
| `--base-url <url>` | Endpoint con `/v1`. Defecto: `$OPENAI_BASE_URL` o `http://localhost:11434/v1`. |
| `--context-window <n>` | Ventana de contexto del servidor, en tokens. Defecto: 4096, con un aviso. |
| `--max-turns <n>` | Turnos máximos del run. Defecto: 25. |
| `--permission-mode <modo>` | `default`, `acceptEdits` o `bypass`. Defecto: `default`. |
| `--allow <regla>`, `--deny <regla>` | Reglas extra, repetibles: `--deny "Edit(**/.env*)"`. |

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

Lo que no hace: el prompt de aprobación muestra herramienta y ruta, no el diff; la protección de `.harness/settings.json` no viene integrada (es una regla); y nada impide que el modelo escriba algo dañino dentro del workspace en `acceptEdits`. Los permisos limitan dónde, no qué: lo que se escribió se revisa con `git diff`. Tampoco hay modo `plan` ni reglas de Bash.

## Estructura

```
src/core/        loop y eventos
src/context/     tope, limpieza y compaction, detección de recortes, AGENTS.md
src/providers/   contrato canónico y adaptador a chat completions
src/tools/       contrato de herramientas, registro, Read, Glob, Grep, Write y Edit, estado de lectura
src/policy/      motor de permisos, reglas de ruta, approver de terminal y settings
src/cli.ts       salida por terminal
examples/demo/   repositorio pequeño para las preguntas de ejemplo
examples/desbordar.ts  conversación fija que desborda una ventana de 4096
examples/salidas/      salidas reales de ejecuciones, también de escritura y de seguridad
test/            proveedor simulado y tests
```

## Licencia

MIT.
