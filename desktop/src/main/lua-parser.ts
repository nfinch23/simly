import { parse, type Statement, type Expression, type TableConstructorExpression } from 'luaparse';
import type { SimlyDB } from '@simly/shared';

type LuaValue = string | number | boolean | null | LuaValue[] | { [key: string]: LuaValue };

/**
 * Parse a Simly SavedVariables Lua file and extract the
 * `SimlyDB` table. We only support a narrow subset of Lua: literal
 * tables, strings, numbers, booleans, nil. That's all the addon emits, and
 * any drift will throw — which is what we want.
 */
export function parseSavedVars(source: string): SimlyDB {
  const ast = parse(source, { comments: false, encodingMode: 'pseudo-latin1' });

  for (const stmt of ast.body) {
    const target = topLevelAssignmentTarget(stmt);
    if (target?.name !== 'SimlyDB') continue;
    const value = expressionToValue(target.init);
    if (!isPlainObject(value)) {
      throw new Error('SimlyDB is not a table');
    }
    return value as unknown as SimlyDB;
  }

  throw new Error('SimlyDB assignment not found in SavedVariables file');
}

function topLevelAssignmentTarget(
  stmt: Statement,
): { name: string; init: Expression } | undefined {
  if (stmt.type !== 'AssignmentStatement') return undefined;
  const variable = stmt.variables[0];
  const init = stmt.init[0];
  if (!variable || !init) return undefined;
  if (variable.type !== 'Identifier') return undefined;
  return { name: variable.name, init };
}

function expressionToValue(expr: Expression): LuaValue {
  switch (expr.type) {
    case 'StringLiteral':
      return expr.value;
    case 'NumericLiteral':
      return expr.value;
    case 'BooleanLiteral':
      return expr.value;
    case 'NilLiteral':
      return null;
    case 'UnaryExpression':
      if (expr.operator === '-') {
        const inner = expressionToValue(expr.argument);
        if (typeof inner !== 'number') {
          throw new Error('Unary minus on non-number');
        }
        return -inner;
      }
      throw new Error(`Unsupported unary operator: ${expr.operator}`);
    case 'TableConstructorExpression':
      return tableToValue(expr);
    default:
      throw new Error(`Unsupported Lua expression type: ${expr.type}`);
  }
}

function tableToValue(table: TableConstructorExpression): LuaValue {
  const fields = table.fields;
  // Lua doesn't distinguish empty array from empty map. Our schema's
  // empty-table case is `requests = {}` (an array), so default to [].
  if (fields.length === 0) return [];

  const allArrayLike = fields.every((f) => f.type === 'TableValue');
  if (allArrayLike) {
    return fields.map((f) => {
      if (f.type !== 'TableValue') throw new Error('unreachable');
      return expressionToValue(f.value);
    });
  }

  const obj: { [key: string]: LuaValue } = {};
  for (const field of fields) {
    if (field.type === 'TableKeyString') {
      obj[field.key.name] = expressionToValue(field.value);
    } else if (field.type === 'TableKey') {
      const key = expressionToValue(field.key);
      if (typeof key !== 'string' && typeof key !== 'number') {
        throw new Error(`Unsupported table key type: ${typeof key}`);
      }
      obj[String(key)] = expressionToValue(field.value);
    } else {
      throw new Error(
        `Mixed array-like and key-value fields in table — Simly schemas should not produce this`,
      );
    }
  }
  return obj;
}

function isPlainObject(value: LuaValue): value is { [key: string]: LuaValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
