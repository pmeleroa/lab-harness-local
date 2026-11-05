# lab-harness-local

Un harness para agentes de código en terminal, construido parte a parte para entender cómo funcionan estos agentes por dentro. Acompaña a la serie «Asistente de código local» de [pablomeleroalonso.me](https://pablomeleroalonso.me).

Esta versión (tag `parte-2`) es de **solo lectura**: un bucle con streaming, un contrato de inferencia con un adaptador a `/v1/chat/completions` y dos herramientas, `Read` y `Glob`. Cada parte de la serie añade commits y un tag nuevo.

## Prerrequisitos

- Linux o macOS. En Windows, desde WSL2.
- Node.js 22 o superior y npm.
- [ripgrep](https://github.com/BurntSushi/ripgrep#installation) (`rg`) en el `PATH`: lo usa `Glob`.
- Un servidor compatible con `/v1/chat/completions` con un modelo que admita herramientas. Los ejemplos usan [Ollama](https://ollama.com) y `qwen2.5:7b`.

```bash
ollama pull qwen2.5:7b
```

## Instalación

```bash
git clone --branch parte-2 https://github.com/pmeleroa/lab-harness-local.git
cd lab-harness-local
npm install
npm test
```

`npm test` no necesita modelo: usa un proveedor simulado.

## Uso

```bash
npm run dev -- --workspace examples/demo "¿A partir de qué importe se aplica descuento y en qué fichero está esa regla?"
```

El harness muestra cada llamada a herramienta por la salida de error y la respuesta por la salida estándar.

| Opción | Efecto |
|---|---|
| `-w, --workspace <dir>` | Directorio sobre el que trabaja. Las herramientas no salen de él. |
| `-m, --model <id>` | Modelo. Defecto: `$HARNESS_MODEL` o `qwen2.5:7b`. |
| `--base-url <url>` | Endpoint con `/v1`. Defecto: `$OPENAI_BASE_URL` o `http://localhost:11434/v1`. |
| `--max-turns <n>` | Turnos máximos del run. Defecto: 25. |

## Cómo termina un run

Cada ejecución acaba con un motivo explícito, que se imprime al final:

| Motivo | Significa |
|---|---|
| `end_turn` | El modelo respondió sin pedir más herramientas. |
| `max_turns` | Se agotaron los turnos. |
| `repeated_failure` | La misma llamada falló tres veces seguidas. |
| `empty_response` | El modelo no devolvió texto ni llamada, ni tras avisarle. |
| `max_tokens` | La respuesta se cortó por el tope de tokens de salida. |
| `error` | Falló el proveedor (por ejemplo, el servidor está parado). |
| `aborted`, `max_tool_calls`, `refusal` | Cancelación, tope de llamadas y rechazo del proveedor. |

Los fallos se provocan de forma determinista en `test/loop.test.ts`, con `test/fake-provider.ts`.

## Estructura

```
src/core/        loop y eventos
src/providers/   contrato canónico y adaptador a chat completions
src/tools/       contrato de herramientas, registro, Read y Glob
src/cli.ts       salida por terminal
examples/demo/   repositorio pequeño para las preguntas de ejemplo
test/            proveedor simulado y tests
```

## Límite de workspace

`Read` y `Glob` rechazan, con un error que ve el modelo, cualquier ruta que salga del workspace tras resolver enlaces simbólicos. No es un modelo de permisos: es el mínimo para que una herramienta de solo lectura no salga del repositorio. Los permisos llegan en una parte posterior.

## Licencia

MIT.
