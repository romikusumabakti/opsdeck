import type { ServiceVariableTemplate, VariableKind } from "@/lib/db/schema";

// The variable templates of an environment: the templates of every service it
// deploys, merged per name. Pure: the callers read the rows
// (lib/variables/repository) and decide what to fill.
//
// Rules (Stage 8 spec, Builder-check answers):
// - identical definitions are one template;
// - the safety properties take the strictest value: required if any service
//   requires it, escrowed if any escrows it, the longest generated length;
// - a differing kind or default value is a conflict: the caller asks the user
//   to pick a service's definition (`choices`, by variable name); an
//   unresolved one is never filled, but still counts as required.
// Rows are taken in (name, service key) order, so the result is deterministic.

export type TemplateDefinition = Pick<
  ServiceVariableTemplate,
  | "componentKey"
  | "name"
  | "kind"
  | "required"
  | "defaultValue"
  | "generatedLength"
  | "escrow"
  | "description"
>;

/** One of the differing definitions of a name, and the services giving it. */
export type TemplateOption = {
  componentKeys: string[];
  kind: VariableKind;
  defaultValue: string | null;
};

export type MergedTemplate = {
  name: string;
  /**
   * The agreed or chosen kind. Unresolved: the first non-plain option's (a
   * value some service treats as secret is never proposed as plain).
   */
  kind: VariableKind;
  /** The agreed or chosen default; null while unresolved. */
  defaultValue: string | null;
  required: boolean;
  escrow: boolean;
  generatedLength: number | null;
  description: string | null;
  /** Every service defining the name, sorted. */
  componentKeys: string[];
  /** The differing definitions while no choice resolved them, else null. */
  conflict: TemplateOption[] | null;
};

const byNameThenService = (a: TemplateDefinition, b: TemplateDefinition) =>
  a.name < b.name
    ? -1
    : a.name > b.name
      ? 1
      : a.componentKey < b.componentKey
        ? -1
        : a.componentKey > b.componentKey
          ? 1
          : 0;

/**
 * Merges the templates of several services by name. `choices` maps a
 * conflicting name to the service whose definition the user picked; a choice
 * naming a service without that template is ignored.
 */
export function mergeTemplates(
  rows: readonly TemplateDefinition[],
  choices: Readonly<Record<string, string>> = {}
): MergedTemplate[] {
  const groups = new Map<string, TemplateDefinition[]>();
  for (const row of [...rows].sort(byNameThenService)) {
    const group = groups.get(row.name) ?? [];
    group.push(row);
    groups.set(row.name, group);
  }

  return [...groups.entries()].map(([name, group]) => {
    const options: TemplateOption[] = [];
    for (const row of group) {
      const same = options.find(
        (o) => o.kind === row.kind && o.defaultValue === row.defaultValue
      );
      if (same) same.componentKeys.push(row.componentKey);
      else {
        options.push({
          componentKeys: [row.componentKey],
          kind: row.kind,
          defaultValue: row.defaultValue,
        });
      }
    }
    const choice = choices[name];
    const chosen =
      options.length === 1
        ? options[0]
        : options.find((o) => choice && o.componentKeys.includes(choice));
    const lengths = group
      .map((row) => row.generatedLength)
      .filter((length): length is number => length !== null);
    return {
      name,
      kind:
        chosen?.kind ??
        options.find((o) => o.kind !== "plain")?.kind ??
        "plain",
      defaultValue: chosen?.defaultValue ?? null,
      required: group.some((row) => row.required),
      escrow: group.some((row) => row.escrow),
      generatedLength: lengths.length > 0 ? Math.max(...lengths) : null,
      description: group.find((row) => row.description)?.description ?? null,
      componentKeys: group.map((row) => row.componentKey),
      conflict: chosen ? null : options,
    };
  });
}

/**
 * Whether a copy keeps a variable of its source environment. Variables are
 * environment-wide, so one is kept unless only templates of source services
 * the new environment does not deploy define it (`sourceDefinedBy`: the
 * source's services whose templates name it; `targetTemplateNames`: the
 * names the new environment's services' templates define).
 */
export function keepsCopiedVariable(
  name: string,
  sourceDefinedBy: readonly string[],
  targetKeys: ReadonlySet<string>,
  targetTemplateNames: ReadonlySet<string>
): boolean {
  if (sourceDefinedBy.length === 0) return true;
  if (sourceDefinedBy.some((key) => targetKeys.has(key))) return true;
  return targetTemplateNames.has(name);
}
