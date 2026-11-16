import { z } from "zod";
import { type Skill, renderSkill, renderSkillReference } from "../skills/loader.js";
import { defineTool } from "./types.js";

/**
 * Carga las instrucciones de una skill en la conversación. Lo que la skill haga después pasa por la policy normal.
 * isLoaded: si la skill ya está en la conversación, se devuelve una referencia en lugar del cuerpo.
 */
export function createSkillTool(skills: Skill[], isLoaded: (name: string) => boolean = () => false) {
  const byName = new Map(skills.filter((s) => s.modelInvocable).map((s) => [s.name, s]));
  return defineTool({
    name: "Skill",
    description: [
      "Loads a skill: packaged instructions (and possibly scripts or reference files) for a specific kind of task.",
      "- The available skills are listed in the system prompt under <available_skills>.",
      "- Invoke the matching skill before starting the task, then follow the instructions it returns.",
      "- Do not invoke a skill that is already loaded in this conversation.",
      "- Run the skill's scripts with Bash and read its reference files with Read, using its base directory.",
    ].join("\n"),
    schema: z.object({
      skill: z
        .string()
        .refine((n) => byName.has(n), {
          error: (iss) => `Unknown skill: ${String(iss.input)}. Available skills: ${[...byName.keys()].join(", ")}`,
        })
        .describe("Skill name, as listed in <available_skills>"),
      args: z.string().optional().describe("Optional arguments for the skill"),
    }),
    readOnly: true,
    // Leer el SKILL.md: la policy lo permite porque los directorios de skills son de lectura libre.
    permissionTarget: (input) => ({ kind: "path", path: byName.get(input.skill)!.file, access: "read" }),
    async run(input) {
      const s = byName.get(input.skill)!;
      try {
        return { content: isLoaded(s.name) ? renderSkillReference(s, input.args) : renderSkill(s, input.args) };
      } catch (e) {
        return { content: `Could not load skill ${s.name}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  });
}
