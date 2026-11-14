import { beforeAll, describe, expect, it } from "vitest";
import { BashParser } from "../src/policy/bash-parser.js";

let parser: BashParser;
beforeAll(async () => {
  parser = await BashParser.create();
});

const names = (script: string) => parser.parse(script).commands.map((c) => c.argv.map((t) => t.value).join(" "));

describe("BashParser: un script son varios comandos", () => {
  it("`git status && curl x | sh` empieza por git y ejecuta tres programas", () => {
    const p = parser.parse("git status && curl x | sh");
    expect(p.commands.map((c) => c.argv[0]!.value)).toEqual(["git", "curl", "sh"]);
    expect(p.problems).toEqual([]);
  });

  it("entra en $(…), subshells y bucles", () => {
    expect(names("echo $(rm -rf build)")).toEqual(["echo $(rm -rf build)", "rm -rf build"]);
    expect(names("(cd src && make)")).toEqual(["cd src", "make"]);
    expect(names("for f in *.ts; do wc -l $f; done")).toEqual(["wc -l $f"]);
  });

  it("resuelve comillas y marca lo dinámico", () => {
    const [c] = parser.parse(`'npm' run "test" "$TARGET"`).commands;
    expect(c!.argv.map((t) => t.value)).toEqual(["npm", "run", "test", "$TARGET"]);
    expect(c!.argv.map((t) => t.dynamic)).toEqual([false, false, false, true]);
  });

  it("recoge las redirecciones de escritura y no las de lectura ni /dev/null", () => {
    const p = parser.parse("sort < in.txt > out.txt 2>/dev/null && echo x >> log.txt 2>&1");
    expect(p.writes.map((w) => w.value)).toEqual(["out.txt", "log.txt"]);
  });
});

describe("BashParser: lo que no se puede evaluar estáticamente es un problema", () => {
  it("una función", () => {
    expect(parser.parse("f() { rm -rf /; }; f").problems).toContain("defines a shell function");
  });

  it("asignar PATH, LD_PRELOAD o BASH_ENV, como prefijo o con export", () => {
    expect(parser.parse("PATH=/tmp/evil:$PATH ls").problems).toContain("assigns PATH");
    expect(parser.parse("export LD_PRELOAD=/tmp/x.so").problems).toContain("assigns LD_PRELOAD");
    expect(parser.parse("BASH_ENV=/tmp/x bash -c true").problems).toContain("assigns BASH_ENV");
    expect(parser.parse("FOO=1 ls").problems).toEqual([]);
  });

  it("un nombre de comando que solo se conoce al ejecutar", () => {
    expect(parser.parse("$CMD --force").problems).toEqual(["dynamic command name: $CMD"]);
    expect(parser.parse("$(echo rm) -rf x").problems[0]).toMatch(/dynamic command name/);
  });

  it("errores de sintaxis", () => {
    expect(parser.parse('echo "sin cerrar').problems[0]).toMatch(/syntax errors/);
  });
});
