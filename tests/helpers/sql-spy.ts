/**
 * SQL spy helper for counting and inspecting database queries in tests.
 *
 * Wraps a postgres.js client to intercept and count all SQL statements.
 * Used for N+1 detection: query counts should not grow with data size.
 */

import type postgres from "postgres";

export interface QueryLog {
  query: string;
  timestamp: number;
}

export interface SqlSpy {
  sql: ReturnType<typeof postgres>;
  getQueryCount: () => number;
  getQueries: () => QueryLog[];
  reset: () => void;
  assertQueryCount: (expected: number, tolerance?: number) => void;
  assertQueryCountUnchanged: (previous: number, label?: string) => void;
}

export function createSqlSpy(baseSql: ReturnType<typeof postgres>): SqlSpy {
  const queries: QueryLog[] = [];

  const handler: ProxyHandler<ReturnType<typeof postgres>> = {
    apply(target, thisArg, args) {
      if (Array.isArray(args[0]) && "raw" in args[0]) {
        const templateStrings = args[0] as TemplateStringsArray;
        const query = templateStrings.join("?");
        queries.push({ query, timestamp: Date.now() });
      }
      return Reflect.apply(target, thisArg, args);
    },
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (prop === "begin") {
        return async function beginWithSpy(
          ...beginArgs: Parameters<typeof baseSql.begin>
        ) {
          return (baseSql.begin as (...a: unknown[]) => Promise<unknown>)(
            ...beginArgs.map((arg) => {
              if (typeof arg === "function") {
                return (tx: ReturnType<typeof postgres>) => {
                  const txSpy = createSqlSpy(tx);
                  const originalQueries = queries;
                  const result = (arg as (tx: SqlSpy["sql"]) => unknown)(txSpy.sql);
                  if (result instanceof Promise) {
                    return result.then((res) => {
                      originalQueries.push(...txSpy.getQueries());
                      return res;
                    });
                  }
                  originalQueries.push(...txSpy.getQueries());
                  return result;
                };
              }
              return arg;
            })
          );
        };
      }

      if (typeof value === "function") {
        return function spiedMethod(...methodArgs: unknown[]) {
          if (Array.isArray(methodArgs[0]) && "raw" in (methodArgs[0] as object)) {
            const templateStrings = methodArgs[0] as TemplateStringsArray;
            const query = templateStrings.join("?");
            queries.push({ query, timestamp: Date.now() });
          }
          return (value as (...a: unknown[]) => unknown).apply(target, methodArgs);
        };
      }

      return value;
    },
  };

  const proxiedSql = new Proxy(baseSql, handler) as ReturnType<typeof postgres>;

  return {
    sql: proxiedSql,
    getQueryCount: () => queries.length,
    getQueries: () => [...queries],
    reset: () => {
      queries.length = 0;
    },
    assertQueryCount: (expected: number, tolerance = 0) => {
      const actual = queries.length;
      if (Math.abs(actual - expected) > tolerance) {
        const queryList = queries.map((q, i) => `  ${i + 1}. ${q.query.slice(0, 100)}...`).join("\n");
        throw new Error(
          `Query count assertion failed: expected ${expected} (±${tolerance}), got ${actual}\n\nQueries:\n${queryList}`
        );
      }
    },
    assertQueryCountUnchanged: (previous: number, label = "query count") => {
      const actual = queries.length;
      if (actual !== previous) {
        throw new Error(
          `N+1 detected: ${label} changed from ${previous} to ${actual} (delta: ${actual - previous})`
        );
      }
    },
  };
}

export function countQueriesMatching(spy: SqlSpy, pattern: RegExp): number {
  return spy.getQueries().filter((q) => pattern.test(q.query)).length;
}

export function getQueriesMatching(spy: SqlSpy, pattern: RegExp): QueryLog[] {
  return spy.getQueries().filter((q) => pattern.test(q.query));
}
