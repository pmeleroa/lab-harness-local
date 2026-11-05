# Salidas de ejemplo

Ejecuciones reales de `npm run dev -- --workspace examples/demo "<pregunta>"` con `qwen2.5:7b` en Ollama 0.40.14. La ruta del repositorio se ha sustituido por `<repo>`.

- `ventana-por-defecto.txt`: servidor con la ventana por defecto (`ollama ps` mostró 32768).
- `ventana-4096.txt`: servidor aparte con `OLLAMA_CONTEXT_LENGTH=4096` (`ollama ps` mostró 4096).

Un modelo de 7B no responde igual en cada ejecución: el número de llamadas y el texto cambian, y a veces se rinde antes de leer ningún fichero. Estas son ejecuciones representativas, no garantías.
- `contexto-4096.txt`: el harness sobre su propio repositorio (`--workspace .`) con `--context-window 4096` contra el servidor de 4096, pidiéndole que lea ocho ficheros enteros. Se ven los tres escalones: varios resultados «recortado al tope», `limpiados 1 resultados antiguos` y `conversación compactada`. Tras compactar, el modelo no responde a la pregunta que quedaba (cuál es el más largo): el resumen no basta para que un modelo de 7B retome la tarea.

Esa salida es una de 14 ejecuciones con el mismo prompt (más otras 14 con otros dos prompts que no llegaron a activar nada o solo la compaction). Con el prompt de `contexto-4096.txt`: 10 de 14 mostraron el tope, 3 la limpieza, 5 la compaction y 3 los tres a la vez; 3 no leyeron ningún fichero y ninguna acabó en `context_overflow`. Con una ventana real de 4096 la compaction salta antes que la limpieza salvo que haya más de seis resultados que limpiar (`keepToolResults`). No son garantías: con otro modelo u otra ejecución cambia.
