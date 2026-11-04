# Salidas de ejemplo

Ejecuciones reales de `npm run dev -- --workspace examples/demo "<pregunta>"` con `qwen2.5:7b` en Ollama 0.40.14. La ruta del repositorio se ha sustituido por `<repo>`.

- `ventana-por-defecto.txt`: servidor con la ventana por defecto (`ollama ps` mostró 32768).
- `ventana-4096.txt`: servidor aparte con `OLLAMA_CONTEXT_LENGTH=4096` (`ollama ps` mostró 4096).

Un modelo de 7B no responde igual en cada ejecución: el número de llamadas y el texto cambian, y a veces se rinde antes de leer ningún fichero. Estas son ejecuciones representativas, no garantías.
