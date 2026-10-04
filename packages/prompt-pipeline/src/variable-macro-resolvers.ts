import type { PromptVariableContext } from "./prompt-variable-context.js";
import {
  getVariableStore,
  readVariableKey,
  type MacroVariableScope,
  writeVariableKey,
} from "./macro-variable-scope.js";

interface VariableMacroResolver {
  name: string;
  aliases?: readonly string[];
  description: string;
  category: "variables";
  resolve: (
    args: string[],
    context: PromptVariableContext,
    state: { didUseOriginal: boolean },
    variables: MacroVariableScope,
    resolveNested: (text: string) => string,
    sourceOffset: number,
  ) => string;
}

function numberValue(value: string): number {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function addValue(store: Map<string, string>, name: string, value: string): string {
  const existing = store.get(name) ?? "0";
  const existingNumber = Number(existing);
  const addedNumber = Number(value);
  const next = !Number.isNaN(existingNumber) && !Number.isNaN(addedNumber)
    ? String(existingNumber + addedNumber)
    : existing + value;
  store.set(name, next);
  return next;
}

function createVariableResolvers(global: boolean): VariableMacroResolver[] {
  const prefix = global ? "global" : "";
  const label = global ? "global" : "local";
  const storeFor = (scope: MacroVariableScope) => getVariableStore(scope, global);
  return [
    {
      name: `set${prefix}var`,
      description: `Set an assembly-scoped ${label} variable.`,
      category: "variables",
      resolve: (args, _context, _state, scope) => {
        const name = args[0] ?? "";
        if (name) storeFor(scope).set(name, args[1] ?? "");
        return "";
      },
    },
    {
      name: `get${prefix}var`,
      description: `Read an assembly-scoped ${label} variable, with an optional fallback.`,
      category: "variables",
      resolve: (args, _context, _state, scope) => {
        const name = args[0] ?? "";
        return name && storeFor(scope).has(name) ? storeFor(scope).get(name) ?? "" : args[1] ?? "";
      },
    },
    {
      name: `add${prefix}var`,
      description: `Append or numerically add to an assembly-scoped ${label} variable.`,
      category: "variables",
      resolve: (args, _context, _state, scope) => args[0] ? (addValue(storeFor(scope), args[0], args[1] ?? ""), "") : "",
    },
    {
      name: `inc${prefix}var`,
      description: `Increment an assembly-scoped ${label} variable and emit the new value.`,
      category: "variables",
      resolve: (args, _context, _state, scope) => {
        const name = args[0] ?? "";
        if (!name) return "0";
        const next = numberValue(storeFor(scope).get(name) ?? "0") + 1;
        storeFor(scope).set(name, String(next));
        return String(next);
      },
    },
    {
      name: `dec${prefix}var`,
      description: `Decrement an assembly-scoped ${label} variable and emit the new value.`,
      category: "variables",
      resolve: (args, _context, _state, scope) => {
        const name = args[0] ?? "";
        if (!name) return "0";
        const next = numberValue(storeFor(scope).get(name) ?? "0") - 1;
        storeFor(scope).set(name, String(next));
        return String(next);
      },
    },
    {
      name: `has${prefix}var`,
      aliases: global ? ["globalvarexists"] : ["varexists"],
      description: `Whether an assembly-scoped ${label} variable exists.`,
      category: "variables",
      resolve: (args, _context, _state, scope) => storeFor(scope).has(args[0] ?? "") ? "true" : "false",
    },
    {
      name: `delete${prefix}var`,
      aliases: global ? ["flushglobalvar"] : ["flushvar"],
      description: `Delete an assembly-scoped ${label} variable.`,
      category: "variables",
      resolve: (args, _context, _state, scope) => (storeFor(scope).delete(args[0] ?? ""), ""),
    },
    {
      name: `set${prefix}varkey`,
      aliases: [`set${prefix}varindex`],
      description: `Set an object key in an assembly-scoped ${label} variable.`,
      category: "variables",
      resolve: (args, _context, _state, scope) => {
        const [name = "", key = "", value = ""] = args;
        if (name && key) writeVariableKey(storeFor(scope), name, key, value);
        return "";
      },
    },
    {
      name: `get${prefix}varkey`,
      aliases: [`get${prefix}varindex`],
      description: `Read an object key from an assembly-scoped ${label} variable.`,
      category: "variables",
      resolve: (args, _context, _state, scope) => {
        const [name = "", key = ""] = args;
        return name && key ? readVariableKey(storeFor(scope), name, key) : "";
      },
    },
  ];
}

/** All ST local/global variable macro registrations. */
export function createVariableMacroResolvers(): VariableMacroResolver[] {
  return [...createVariableResolvers(false), ...createVariableResolvers(true)];
}

/** Resolve ST shorthand (.local / $global), including its assignment operators. */
export function resolveVariableShorthand(name: string, args: string[], scope: MacroVariableScope): string | null {
  const nameMatch = name.match(/^([.$][A-Za-z_][A-Za-z0-9_]*)(\+\+|--)?$/);
  if (!nameMatch) return null;
  const shorthandName = nameMatch[1];
  const suffixOperator = nameMatch[2];
  const global = shorthandName.startsWith("$");
  const variableName = shorthandName.slice(1);
  const store = getVariableStore(scope, global);
  const expression = args.join("::").trim();
  const match = expression.match(/^(\+\+|--|\?\?=|\|\|=|\+=|-=|\?\?|\|\||==|!=|>=|<=|=|>|<)?\s*([\s\S]*)$/);
  const operator = suffixOperator ?? match?.[1];
  const operand = match?.[2] ?? "";
  const current = store.get(variableName) ?? "";

  if (!operator) return current;
  if (operator === "++" || operator === "--") {
    const next = numberValue(current) + (operator === "++" ? 1 : -1);
    store.set(variableName, String(next));
    return String(next);
  }
  if (operator === "=") {
    store.set(variableName, operand);
    return "";
  }
  if (operator === "+=") {
    addValue(store, variableName, operand);
    return "";
  }
  if (operator === "-=") {
    const next = numberValue(current) - numberValue(operand);
    store.set(variableName, String(next));
    return "";
  }
  if (operator === "??=") {
    if (!store.has(variableName)) store.set(variableName, operand);
    return store.get(variableName) ?? "";
  }
  if (operator === "||=") {
    if (isFalsy(current)) store.set(variableName, operand);
    return store.get(variableName) ?? "";
  }
  if (operator === "??") return store.has(variableName) ? current : operand;
  if (operator === "||") return isFalsy(current) ? operand : current;
  if (operator === "==") return current === operand ? "true" : "false";
  if (operator === "!=") return current !== operand ? "true" : "false";
  const currentNumber = numberValue(current);
  const operandNumber = numberValue(operand);
  if (operator === ">") return currentNumber > operandNumber ? "true" : "false";
  if (operator === ">=") return currentNumber >= operandNumber ? "true" : "false";
  if (operator === "<") return currentNumber < operandNumber ? "true" : "false";
  return currentNumber <= operandNumber ? "true" : "false";
}

function isFalsy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "0" || normalized === "false";
}
