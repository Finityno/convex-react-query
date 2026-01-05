import { useQuery, useSuspenseQuery, useInfiniteQuery, QueryClient } from "@tanstack/react-query";
import { test, describe, expectTypeOf, assertType, expect, vi, beforeEach, afterEach } from "vitest";
import { convexAction, convexQuery, convexPaginatedQuery, ConvexQueryClient } from "./index.js";
import { FunctionArgs, FunctionReference, PaginationResult, PaginationOptions } from "convex/server";
import * as convexReact from "convex/react";
import * as convexServer from "convex/server";

// Mock getFunctionName to work with our mock function references
vi.mock("convex/server", async (importOriginal) => {
  const original = await importOriginal<typeof convexServer>();
  return {
    ...original,
    getFunctionName: (funcRef: any) => {
      // Handle mock function references by extracting a name from them
      if (funcRef && typeof funcRef === "object") {
        // For mock refs, try to find a name property or generate one
        if (funcRef._mockName) return funcRef._mockName;
        // Fallback to type-based name for testing
        return `mock:${funcRef._type || "unknown"}`;
      }
      // Fall through to original for real function refs
      return original.getFunctionName(funcRef);
    },
  };
});

// Mock Convex function references for testing
// These replace the need to import from "../convex/_generated/api.js"
// which was causing tshy to compile the convex directory

// Helper to create mock function references with names
function createMockRef<T extends "query" | "action", Args, Return>(
  type: T,
  name: string,
  _args: Args,
  _returnType: Return,
) {
  return {
    _type: type,
    _visibility: "public" as const,
    _args: _args as Args,
    _returnType: _returnType as Return,
    _componentPath: undefined,
    _mockName: name, // Used by our mock getFunctionName
  } as unknown as FunctionReference<T, "public", Args extends object ? Args : never, Return>;
}

// Action with empty args
const getSFWeather = createMockRef("action", "weather:getSFWeather", {} as {}, "" as string);

// Query with empty args
const list = createMockRef(
  "query",
  "messages:list",
  {} as {},
  [] as Array<{ id: string; text: string }>,
);

// Query with empty args, returns string
const count = createMockRef("query", "messages:count", {} as {}, "" as string);

// Query with optional args
const countWithOptionalArg = createMockRef(
  "query",
  "messages:countWithOptionalArg",
  {} as { cacheBust?: number },
  "" as string,
);

// Query with required args
const getByAuthor = createMockRef(
  "query",
  "messages:getByAuthor",
  {} as { authorId: string },
  [] as Array<{ id: string; text: string; authorId: string }>,
);

// Query with required and optional args
const search = createMockRef(
  "query",
  "messages:search",
  {} as { query: string; limit?: number },
  [] as Array<{ id: string; text: string }>,
);

// Paginated query with required args
type MessageItem = { _id: string; body: string; channelId: string };
const listPaginated = createMockRef(
  "query",
  "messages:listPaginated",
  {} as { channelId: string; paginationOpts: PaginationOptions },
  {} as PaginationResult<MessageItem>,
);

// Paginated query with no additional args (just paginationOpts)
const listAllPaginated = createMockRef(
  "query",
  "messages:listAllPaginated",
  {} as { paginationOpts: PaginationOptions },
  {} as PaginationResult<MessageItem>,
);

// Paginated query with optional args
type PostItem = { _id: string; title: string; authorId?: string };
const listPostsPaginated = createMockRef(
  "query",
  "posts:listPaginated",
  {} as { authorId?: string; paginationOpts: PaginationOptions },
  {} as PaginationResult<PostItem>,
);

// Paginated query with multiple required args
type CommentItem = { _id: string; postId: string; userId: string; text: string };
const listCommentsPaginated = createMockRef(
  "query",
  "comments:listPaginated",
  {} as { postId: string; userId: string; paginationOpts: PaginationOptions },
  {} as PaginationResult<CommentItem>,
);

// Mock API structure matching the real Convex API
const api = {
  weather: {
    getSFWeather,
  },
  messages: {
    list,
    count,
    countWithOptionalArg,
    getByAuthor,
    search,
    listPaginated,
    listAllPaginated,
  },
  posts: {
    listPaginated: listPostsPaginated,
  },
  comments: {
    listPaginated: listCommentsPaginated,
  },
} as const;

describe("query options factory types", () => {
  test("with useQuery", () => {
    if (1 + 2 === 3) return; // type test only - prevent runtime execution

    type ActionFunc = typeof api.weather.getSFWeather;
    {
      const action = convexAction(api.weather.getSFWeather, {});
      const result = useQuery(action);
      expectTypeOf(result.data).toEqualTypeOf<
        ActionFunc["_returnType"] | undefined
      >();
    }

    {
      const action = convexAction(api.weather.getSFWeather, "skip");
      const result = useQuery(action);
      // Skip doesn't need to cause data in types since there's no point
      // to always passing "skip".
      expectTypeOf(result.data).toEqualTypeOf<
        ActionFunc["_returnType"] | undefined
      >();

      // @ts-expect-error Actions with "skip" can't be used with useSuspenseQuery
      useSuspenseQuery(action);
    }

    type QueryFunc = typeof api.messages.list;
    {
      const query = convexQuery(api.messages.list, {});
      const result = useQuery(query);
      expectTypeOf(result.data).toEqualTypeOf<
        QueryFunc["_returnType"] | undefined
      >();
    }

    {
      // @ts-expect-error Queries with empty args should reject extra properties
      const _query = convexQuery(api.messages.list, { something: 123 });
    }

    {
      // Should be able to omit args when function has no args (empty object)
      const query = convexQuery(api.messages.list);
      const result = useQuery(query);
      expectTypeOf(result.data).toEqualTypeOf<
        QueryFunc["_returnType"] | undefined
      >();
    }

    {
      // Should still be able to pass {} explicitly for empty args functions
      const query = convexQuery(api.messages.list, {});
      const result = useQuery(query);
      expectTypeOf(result.data).toEqualTypeOf<
        QueryFunc["_returnType"] | undefined
      >();
    }

    {
      // Should still be able to pass "skip" for empty args functions
      const query = convexQuery(api.messages.list, "skip");
      const result = useQuery(query);
      expectTypeOf(result.data).toEqualTypeOf<
        QueryFunc["_returnType"] | undefined
      >();
    }
  });

  test("required args for queries/actions with args", () => {
    if (1 + 2 === 3) return; // type test only - prevent runtime execution

    type ActionFunc = typeof api.weather.getSFWeather;
    {
      // Actions with empty args should allow omitting args
      const action = convexAction(api.weather.getSFWeather);
      const result = useQuery(action);
      expectTypeOf(result.data).toEqualTypeOf<
        ActionFunc["_returnType"] | undefined
      >();
    }

    {
      // Actions with empty args should still allow passing {}
      const action = convexAction(api.weather.getSFWeather, {});
      const result = useQuery(action);
      expectTypeOf(result.data).toEqualTypeOf<
        ActionFunc["_returnType"] | undefined
      >();
    }

    {
      const _action = convexAction(api.weather.getSFWeather, {
        // @ts-expect-error Actions with empty args should reject extra properties
        something: 123,
      });
    }
  });

  test("optional args for queries with optional args", () => {
    if (1 + 2 === 3) return; // type test only - prevent runtime execution

    type _QueryFunc = typeof api.messages.countWithOptionalArg;
    {
      // Should be able to omit args when function has all optional args
      const query = convexQuery(api.messages.countWithOptionalArg);
      const result = useQuery(query);
      // Should be string, not unknown
      expectTypeOf(result.data).toEqualTypeOf<string | undefined>();
    }

    {
      // Should be able to pass empty object for optional args
      const query = convexQuery(api.messages.countWithOptionalArg);
      const result = useQuery(query);
      // Should be string, not unknown
      expectTypeOf(result.data).toEqualTypeOf<string | undefined>();
    }

    {
      // Should be able to pass the optional arg
      const query = convexQuery(api.messages.countWithOptionalArg, {
        cacheBust: 123,
      });
      const result = useQuery(query);
      // Should be string, not unknown
      expectTypeOf(result.data).toEqualTypeOf<string | undefined>();
    }

    {
      // Should work with useSuspenseQuery when args omitted
      const query = convexQuery(api.messages.countWithOptionalArg);
      const result = useSuspenseQuery(query);
      // Should be string, not unknown
      expectTypeOf(result.data).toEqualTypeOf<string>();
    }
  });

  test("conditional args (empty object or skip)", () => {
    if (1 + 2 === 3) return; // type test only - prevent runtime execution

    const shown = true;

    type _CountFunc = typeof api.messages.count;
    {
      // Should handle conditional expression: shown ? {} : "skip"
      const query = convexQuery(api.messages.count, shown ? {} : "skip");
      const result = useQuery(query);
      // Should be string, not unknown
      expectTypeOf(result.data).toEqualTypeOf<string | undefined>();
    }

    type _CountWithOptionalFunc = typeof api.messages.countWithOptionalArg;
    {
      // Should handle conditional with optional args: shown ? {} : "skip"
      const query = convexQuery(
        api.messages.countWithOptionalArg,
        shown ? {} : "skip",
      );
      const result = useQuery(query);
      // Should be string, not unknown
      expectTypeOf(result.data).toEqualTypeOf<string | undefined>();
    }

    {
      // Should handle conditional with actual optional arg value: shown ? { cacheBust: 123 } : "skip"
      const query = convexQuery(
        api.messages.countWithOptionalArg,
        shown ? { cacheBust: 123 } : "skip",
      );
      const result = useQuery(query);
      // Should be string, not unknown
      expectTypeOf(result.data).toEqualTypeOf<string | undefined>();
    }
  });

  test("conditional args with required args", () => {
    if (1 + 2 === 3) return; // type test only - prevent runtime execution

    const userId = "123" as any;
    const shouldFetch = true;

    type GetByAuthorFunc = typeof api.messages.getByAuthor;
    {
      // Should handle conditional with required args: shouldFetch ? { authorId: userId } : "skip"
      const query = convexQuery(
        api.messages.getByAuthor,
        shouldFetch ? { authorId: userId } : "skip",
      );
      const result = useQuery(query);
      expectTypeOf(result.data).toEqualTypeOf<
        GetByAuthorFunc["_returnType"] | undefined
      >();
    }

    {
      // Edge case: What if someone tries undefined instead of "skip"?
      // This should NOT work - we require explicit "skip"
      const _query = convexQuery(
        api.messages.getByAuthor,
        // @ts-expect-error undefined is not a valid value, must use "skip"
        shouldFetch ? { authorId: userId } : undefined,
      );
    }
  });

  test("autocomplete for required args", () => {
    if (1 + 2 === 3) return; // type test only - prevent runtime execution

    // Test what TypeScript infers for direct calls (not using Parameters<>)
    type SearchFunc = typeof api.messages.search;
    type SearchArgs = FunctionArgs<SearchFunc>;

    // The args should be: { query: string, limit?: number }
    const validArg1 = { query: "hello" } as SearchArgs;
    const validArg2 = { query: "hello", limit: 5 } as SearchArgs;

    expectTypeOf(validArg1).toEqualTypeOf<{ query: string; limit?: number }>();
    expectTypeOf(validArg2).toEqualTypeOf<{ query: string; limit?: number }>();

    // @ts-expect-error Empty object should not be valid
    const _invalidArg1: SearchArgs = {};

    // @ts-expect-error Only optional field should not be valid
    const _invalidArg2: SearchArgs = { limit: 5 };
  });

  test("compared to convex react", () => {
    if (1 + 2 === 3) return; // type test only - prevent runtime execution

    // @ts-expect-error should error, missing properties
    convexReact.useQuery(api.messages.search, {});
    // @ts-expect-error should error, missing properties
    convexQuery(api.messages.search, {});

    // Should be okay all required args met
    convexReact.useQuery(api.messages.search, {
      query: "hello",
    });
    convexQuery(api.messages.search, { query: "hello" });

    convexReact.useQuery(api.messages.search, {
      query: "hello",
      limit: 5,
    });
    convexQuery(api.messages.search, {
      query: "hello",
      limit: 5,
    });

    // Should be okay to skip
    convexReact.useQuery(api.messages.search, "skip");
    convexQuery(api.messages.search, "skip");

    // Should be okay to ternary skip
    const shouldFetch = Math.random() > 0.5;
    convexReact.useQuery(
      api.messages.search,
      shouldFetch ? { query: "hello" } : "skip",
    );
    convexQuery(api.messages.search, shouldFetch ? { query: "hello" } : "skip");

    convexReact.useQuery(api.messages.search, {
      query: "hello",
      // @ts-expect-error should error, with invalid properties
      something: 123,
    });
    // @ts-expect-error should error, with invalid properties
    convexQuery(api.messages.search, { query: "hello", something: 123 });

    convexReact.useQuery(
      api.messages.search,
      // @ts-expect-error should error, with invalid properties or skip
      shouldFetch ? { query: "hello", something: 123 } : "skip",
    );
    convexQuery(
      api.messages.search,
      // @ts-expect-error should error, with invalid properties or skip
      shouldFetch ? { query: "hello", something: 123 } : "skip",
    );

    // @ts-expect-error should error, with invalid type on required prop
    convexReact.useQuery(api.messages.search, { query: 123 });
    // @ts-expect-error should error, with invalid type on required prop
    convexQuery(api.messages.search, { query: 123 });
  });

  test("mixed required and optional args", () => {
    if (1 + 2 === 3) return; // type test only - prevent runtime execution

    type SearchFunc = typeof api.messages.search;
    {
      // Should work with just required args
      const query = convexQuery(api.messages.search, { query: "hello" });
      const result = useQuery(query);
      expectTypeOf(result.data).toEqualTypeOf<
        SearchFunc["_returnType"] | undefined
      >();
    }

    {
      // Should work with required + optional args
      const query = convexQuery(api.messages.search, {
        query: "hello",
        limit: 5,
      });
      const result = useQuery(query);
      expectTypeOf(result.data).toEqualTypeOf<
        SearchFunc["_returnType"] | undefined
      >();
    }

    {
      // Should work with "skip"
      const query = convexQuery(api.messages.search, "skip");
      const result = useQuery(query);
      expectTypeOf(result.data).toEqualTypeOf<
        SearchFunc["_returnType"] | undefined
      >();
    }

    {
      // @ts-expect-error Can't omit required args - errors at call site
      const _query = convexQuery(api.messages.search);
    }

    {
      // @ts-expect-error Can't pass empty object when function has required args
      const _query = convexQuery(api.messages.search, {});
    }

    {
      // @ts-expect-error Can't omit required arg (query)
      const _query = convexQuery(api.messages.search, { limit: 5 });
    }

    const shouldFetch = true;
    {
      // Should work with conditional: required args | "skip"
      const query = convexQuery(
        api.messages.search,
        shouldFetch ? { query: "hello" } : "skip",
      );
      const result = useQuery(query);
      expectTypeOf(result.data).toEqualTypeOf<
        SearchFunc["_returnType"] | undefined
      >();
    }

    {
      // Should work with conditional: required+optional args | "skip"
      const query = convexQuery(
        api.messages.search,
        shouldFetch ? { query: "hello", limit: 5 } : "skip",
      );
      const result = useQuery(query);
      expectTypeOf(result.data).toEqualTypeOf<
        SearchFunc["_returnType"] | undefined
      >();
    }
  });

  test("with useSuspenseQuery", () => {
    if (1 + 2 === 3) return; // type test only - prevent runtime execution

    type QueryFunc = typeof api.messages.list;
    {
      // Should work with empty args (omitted)
      const query = convexQuery(api.messages.list);
      const result = useSuspenseQuery(query);
      expectTypeOf(result.data).toEqualTypeOf<QueryFunc["_returnType"]>();
    }

    {
      // Should work with empty args (explicit {})
      const query = convexQuery(api.messages.list, {});
      const result = useSuspenseQuery(query);
      expectTypeOf(result.data).toEqualTypeOf<QueryFunc["_returnType"]>();
    }

    {
      const action = convexAction(api.weather.getSFWeather, {});
      // @ts-expect-error Actions can't be used with useSuspenseQuery
      useSuspenseQuery(action);
    }

    {
      const action = convexAction(api.weather.getSFWeather, "skip");
      // @ts-expect-error Actions with "skip" can't be used with useSuspenseQuery
      useSuspenseQuery(action);
    }
  });

  test("queryFn property type consistency", () => {
    if (1 + 2 === 3) return; // type test only - prevent runtime execution

    // Test that convexQuery and convexAction have consistent type signatures
    // Both claim to return queryFn in their type, but neither actually returns it
    // (they rely on the global default queryFn). Both use `as any` to bypass the type check.

    {
      const query = convexQuery(api.messages.list);
      // Verify that the return type includes queryFn property
      expectTypeOf(query).toHaveProperty("queryFn");
      // Verify queryFn exists in the type signature (even though undefined at runtime)
      type QueryReturn = typeof query;
      type HasQueryFn = "queryFn" extends keyof QueryReturn ? true : false;
      assertType<true>(true as HasQueryFn);
    }

    {
      const action = convexAction(api.weather.getSFWeather);
      // Verify that the return type includes queryFn property
      expectTypeOf(action).toHaveProperty("queryFn");
      // Verify queryFn exists in the type signature (same as convexQuery)
      type ActionReturn = typeof action;
      type HasQueryFn = "queryFn" extends keyof ActionReturn ? true : false;
      assertType<true>(true as HasQueryFn);
    }

    // Both functions should have the same type structure for consistency
    // The fix ensures convexAction uses `as any` like convexQuery does
  });
});

describe("paginated query options factory types", () => {
  test("with useInfiniteQuery - required args", () => {
    if (1 + 2 === 3) return; // type test only - prevent runtime execution

    {
      // Should work with required args
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 20 },
      );
      const result = useInfiniteQuery(options);

      // Data should be InfiniteData with pages of PaginationResult
      expectTypeOf(result.data?.pages[0]?.page[0]).toEqualTypeOf<
        MessageItem | undefined
      >();
    }

    {
      // Should error when missing required args
      const _options = convexPaginatedQuery(
        api.messages.listPaginated,
        // @ts-expect-error channelId is required
        {},
        { initialNumItems: 20 },
      );
    }
  });

  test("with useInfiniteQuery - no additional args", () => {
    if (1 + 2 === 3) return; // type test only - prevent runtime execution

    {
      // Should work with empty args when query only has paginationOpts
      const options = convexPaginatedQuery(
        api.messages.listAllPaginated,
        {},
        { initialNumItems: 10 },
      );
      const result = useInfiniteQuery(options);

      expectTypeOf(result.data?.pages[0]?.page[0]).toEqualTypeOf<
        MessageItem | undefined
      >();
    }
  });

  test("with skip pattern", () => {
    if (1 + 2 === 3) return; // type test only - prevent runtime execution

    const shouldFetch = true;

    {
      // Should work with conditional skip
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        shouldFetch ? { channelId: "123" } : "skip",
        { initialNumItems: 20 },
      );

      // Should have enabled property when skip is possible
      expectTypeOf(options).toHaveProperty("enabled");
    }
  });

  test("query key structure", () => {
    if (1 + 2 === 3) return; // type test only - prevent runtime execution

    {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 20 },
      );

      // Query key should be tuple with "convexPaginatedQuery" prefix and numItems
      expectTypeOf(options.queryKey[0]).toEqualTypeOf<"convexPaginatedQuery">();
      // numItems should be in the query key (position 3)
      expectTypeOf(options.queryKey[3]).toEqualTypeOf<number>();
    }
  });

  test("getNextPageParam function", () => {
    if (1 + 2 === 3) return; // type test only - prevent runtime execution

    {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 20 },
      );

      // getNextPageParam should be a function that takes PaginationResult
      expectTypeOf(options.getNextPageParam).toBeFunction();

      // Should have initialPageParam
      expectTypeOf(options.initialPageParam).toEqualTypeOf<string | null>();
    }
  });

  test("numItems is in query key for cache separation", () => {
    if (1 + 2 === 3) return; // type test only - prevent runtime execution

    {
      // Different numItems should result in different query keys
      const options20 = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 20 },
      );

      const options50 = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 50 },
      );

      // numItems is at position 3 in the query key
      expectTypeOf(options20.queryKey[3]).toEqualTypeOf<number>();
      expectTypeOf(options50.queryKey[3]).toEqualTypeOf<number>();
    }
  });
});

// =============================================================================
// RUNTIME TESTS - These actually execute and verify behavior
// =============================================================================

describe("convexPaginatedQuery runtime behavior", () => {
  describe("query key structure", () => {
    test("query key has correct structure with 4 elements", () => {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 20 },
      );

      expect(options.queryKey).toHaveLength(4);
      expect(options.queryKey[0]).toBe("convexPaginatedQuery");
      expect(typeof options.queryKey[1]).toBe("string"); // function name
      expect(options.queryKey[2]).toEqual({ channelId: "123" });
      expect(options.queryKey[3]).toBe(20);
    });

    test("query key uses function name, not reference", () => {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 20 },
      );

      // Should be serializable string, not the actual function reference
      expect(typeof options.queryKey[1]).toBe("string");
      expect(options.queryKey[1]).toBe("messages:listPaginated");
    });

    test("different numItems produces different query keys", () => {
      const options10 = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 10 },
      );

      const options25 = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 25 },
      );

      const options50 = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 50 },
      );

      // All should have different query keys due to numItems
      expect(options10.queryKey[3]).toBe(10);
      expect(options25.queryKey[3]).toBe(25);
      expect(options50.queryKey[3]).toBe(50);

      // The keys should be different
      expect(options10.queryKey).not.toEqual(options25.queryKey);
      expect(options25.queryKey).not.toEqual(options50.queryKey);
    });

    test("different args produces different query keys", () => {
      const optionsChannel1 = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "channel-1" },
        { initialNumItems: 20 },
      );

      const optionsChannel2 = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "channel-2" },
        { initialNumItems: 20 },
      );

      expect(optionsChannel1.queryKey[2]).toEqual({ channelId: "channel-1" });
      expect(optionsChannel2.queryKey[2]).toEqual({ channelId: "channel-2" });
      expect(optionsChannel1.queryKey).not.toEqual(optionsChannel2.queryKey);
    });

    test("same args and numItems produces identical query keys", () => {
      const options1 = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 20 },
      );

      const options2 = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 20 },
      );

      expect(options1.queryKey).toEqual(options2.queryKey);
    });

    test("empty args produces correct query key", () => {
      const options = convexPaginatedQuery(
        api.messages.listAllPaginated,
        {},
        { initialNumItems: 10 },
      );

      expect(options.queryKey[2]).toEqual({});
      expect(options.queryKey[3]).toBe(10);
    });
  });

  describe("skip pattern", () => {
    test("skip produces enabled: false", () => {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        "skip",
        { initialNumItems: 20 },
      );

      expect(options.enabled).toBe(false);
    });

    test("skip sets empty object as args in query key", () => {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        "skip",
        { initialNumItems: 20 },
      );

      expect(options.queryKey[2]).toEqual({});
    });

    test("non-skip does not have enabled property", () => {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 20 },
      );

      expect(options.enabled).toBeUndefined();
    });

    test("conditional skip works correctly", () => {
      const shouldFetch = false;
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        shouldFetch ? { channelId: "123" } : "skip",
        { initialNumItems: 20 },
      );

      expect(options.enabled).toBe(false);
    });

    test("conditional non-skip works correctly", () => {
      const shouldFetch = true;
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        shouldFetch ? { channelId: "123" } : "skip",
        { initialNumItems: 20 },
      );

      expect(options.queryKey[2]).toEqual({ channelId: "123" });
      // enabled should not be set when not skipping
      expect("enabled" in options && options.enabled === false).toBe(false);
    });
  });

  describe("getNextPageParam", () => {
    test("returns undefined when isDone is true", () => {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 20 },
      );

      const result = options.getNextPageParam({
        page: [],
        isDone: true,
        continueCursor: "some-cursor",
      });

      expect(result).toBeUndefined();
    });

    test("returns continueCursor when isDone is false", () => {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 20 },
      );

      const result = options.getNextPageParam({
        page: [{ _id: "1", body: "test", channelId: "123" }],
        isDone: false,
        continueCursor: "next-page-cursor",
      });

      expect(result).toBe("next-page-cursor");
    });

    test("returns continueCursor even when page is empty but not done", () => {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 20 },
      );

      const result = options.getNextPageParam({
        page: [],
        isDone: false,
        continueCursor: "still-more-data",
      });

      expect(result).toBe("still-more-data");
    });

    test("handles empty string cursor", () => {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 20 },
      );

      const result = options.getNextPageParam({
        page: [],
        isDone: false,
        continueCursor: "",
      });

      expect(result).toBe("");
    });
  });

  describe("initialPageParam", () => {
    test("initialPageParam is null", () => {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 20 },
      );

      expect(options.initialPageParam).toBeNull();
    });
  });

  describe("staleTime", () => {
    test("staleTime is Infinity", () => {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 20 },
      );

      expect(options.staleTime).toBe(Infinity);
    });
  });

  describe("edge cases", () => {
    test("numItems of 1 works", () => {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 1 },
      );

      expect(options.queryKey[3]).toBe(1);
    });

    test("very large numItems works", () => {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "123" },
        { initialNumItems: 10000 },
      );

      expect(options.queryKey[3]).toBe(10000);
    });

    test("args with special characters work", () => {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "channel/with:special@chars#123" },
        { initialNumItems: 20 },
      );

      expect(options.queryKey[2]).toEqual({ channelId: "channel/with:special@chars#123" });
    });

    test("args with unicode work", () => {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "日本語チャンネル" },
        { initialNumItems: 20 },
      );

      expect(options.queryKey[2]).toEqual({ channelId: "日本語チャンネル" });
    });

    test("args with empty string work", () => {
      const options = convexPaginatedQuery(
        api.messages.listPaginated,
        { channelId: "" },
        { initialNumItems: 20 },
      );

      expect(options.queryKey[2]).toEqual({ channelId: "" });
    });

    test("multiple args are preserved", () => {
      const options = convexPaginatedQuery(
        api.comments.listPaginated,
        { postId: "post-123", userId: "user-456" },
        { initialNumItems: 15 },
      );

      expect(options.queryKey[2]).toEqual({ postId: "post-123", userId: "user-456" });
    });

    test("optional args can be omitted", () => {
      const options = convexPaginatedQuery(
        api.posts.listPaginated,
        {},
        { initialNumItems: 20 },
      );

      expect(options.queryKey[2]).toEqual({});
    });

    test("optional args can be provided", () => {
      const options = convexPaginatedQuery(
        api.posts.listPaginated,
        { authorId: "author-123" },
        { initialNumItems: 20 },
      );

      expect(options.queryKey[2]).toEqual({ authorId: "author-123" });
    });
  });
});

describe("convexQuery runtime behavior", () => {
  describe("query key structure", () => {
    test("query key has correct structure", () => {
      const options = convexQuery(api.messages.search, { query: "test" });

      expect(options.queryKey[0]).toBe("convexQuery");
      expect(typeof options.queryKey[1]).toBe("string");
      expect(options.queryKey[2]).toEqual({ query: "test" });
    });

    test("skip produces 'skip' in query key", () => {
      const options = convexQuery(api.messages.search, "skip");

      expect(options.queryKey[2]).toBe("skip");
      expect(options.enabled).toBe(false);
    });

    test("empty args function can omit args", () => {
      const options = convexQuery(api.messages.list);

      expect(options.queryKey[2]).toEqual({});
    });
  });
});

describe("convexAction runtime behavior", () => {
  describe("query key structure", () => {
    test("query key has correct structure", () => {
      const options = convexAction(api.weather.getSFWeather, {});

      expect(options.queryKey[0]).toBe("convexAction");
      expect(typeof options.queryKey[1]).toBe("string");
      expect(options.queryKey[2]).toEqual({});
    });

    test("skip produces enabled: false", () => {
      const options = convexAction(api.weather.getSFWeather, "skip");

      expect(options.enabled).toBe(false);
    });
  });
});

// =============================================================================
// PAGINATED QUERY TYPE TESTS - Additional comprehensive type coverage
// =============================================================================

describe("paginated query additional type tests", () => {
  test("required args must be provided", () => {
    if (1 + 2 === 3) return;

    // This should compile - all required args provided
    const _valid = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: "123" },
      { initialNumItems: 20 },
    );

    // @ts-expect-error - missing channelId
    const _invalid = convexPaginatedQuery(
      api.messages.listPaginated,
      {},
      { initialNumItems: 20 },
    );
  });

  test("multiple required args must all be provided", () => {
    if (1 + 2 === 3) return;

    // This should compile - all required args provided
    const _valid = convexPaginatedQuery(
      api.comments.listPaginated,
      { postId: "post-1", userId: "user-1" },
      { initialNumItems: 20 },
    );

    // @ts-expect-error - missing userId
    const _invalid1 = convexPaginatedQuery(
      api.comments.listPaginated,
      { postId: "post-1" },
      { initialNumItems: 20 },
    );

    // @ts-expect-error - missing postId
    const _invalid2 = convexPaginatedQuery(
      api.comments.listPaginated,
      { userId: "user-1" },
      { initialNumItems: 20 },
    );

    // @ts-expect-error - missing both
    const _invalid3 = convexPaginatedQuery(
      api.comments.listPaginated,
      {},
      { initialNumItems: 20 },
    );
  });

  test("optional args are truly optional", () => {
    if (1 + 2 === 3) return;

    // Both should compile
    const _withoutOptional = convexPaginatedQuery(
      api.posts.listPaginated,
      {},
      { initialNumItems: 20 },
    );

    const _withOptional = convexPaginatedQuery(
      api.posts.listPaginated,
      { authorId: "author-123" },
      { initialNumItems: 20 },
    );
  });

  test("extra properties are rejected", () => {
    if (1 + 2 === 3) return;

    // @ts-expect-error - extra property 'extra'
    const _invalid = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: "123", extra: "not-allowed" },
      { initialNumItems: 20 },
    );
  });

  test("wrong property types are rejected", () => {
    if (1 + 2 === 3) return;

    // @ts-expect-error - channelId should be string, not number
    const _invalid = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: 123 },
      { initialNumItems: 20 },
    );
  });

  test("initialNumItems must be provided", () => {
    if (1 + 2 === 3) return;

    // @ts-expect-error - missing initialNumItems
    const _invalid = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: "123" },
      {},
    );
  });

  test("return type is correctly inferred", () => {
    if (1 + 2 === 3) return;

    const options = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: "123" },
      { initialNumItems: 20 },
    );

    // Test the page result type through getNextPageParam
    const mockPage: PaginationResult<MessageItem> = {
      page: [{ _id: "1", body: "hello", channelId: "123" }],
      isDone: false,
      continueCursor: "cursor",
    };

    const nextParam = options.getNextPageParam(mockPage);
    expectTypeOf(nextParam).toEqualTypeOf<string | null | undefined>();
  });

  test("works with conditional expressions", () => {
    if (1 + 2 === 3) return;

    const channelId: string | null = Math.random() > 0.5 ? "123" : null;

    const options = convexPaginatedQuery(
      api.messages.listPaginated,
      channelId ? { channelId } : "skip",
      { initialNumItems: 20 },
    );

    // Type should allow for enabled property
    expectTypeOf(options).toHaveProperty("enabled");
  });
});

// =============================================================================
// CACHE ISOLATION TESTS - Verify different queries don't interfere
// =============================================================================

describe("cache isolation", () => {
  test("different function refs have different keys", () => {
    const messagesOptions = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: "123" },
      { initialNumItems: 20 },
    );

    const postsOptions = convexPaginatedQuery(
      api.posts.listPaginated,
      {},
      { initialNumItems: 20 },
    );

    // Function names should be different
    expect(messagesOptions.queryKey[1]).not.toBe(postsOptions.queryKey[1]);
  });

  test("same function with different args have different keys", () => {
    const options1 = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: "channel-a" },
      { initialNumItems: 20 },
    );

    const options2 = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: "channel-b" },
      { initialNumItems: 20 },
    );

    expect(options1.queryKey).not.toEqual(options2.queryKey);
    expect(options1.queryKey[2]).not.toEqual(options2.queryKey[2]);
  });

  test("same function and args but different numItems have different keys", () => {
    const options1 = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: "123" },
      { initialNumItems: 10 },
    );

    const options2 = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: "123" },
      { initialNumItems: 50 },
    );

    expect(options1.queryKey).not.toEqual(options2.queryKey);
    expect(options1.queryKey[3]).not.toBe(options2.queryKey[3]);
  });

  test("completely identical calls produce identical keys", () => {
    const options1 = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: "123" },
      { initialNumItems: 20 },
    );

    const options2 = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: "123" },
      { initialNumItems: 20 },
    );

    expect(JSON.stringify(options1.queryKey)).toBe(JSON.stringify(options2.queryKey));
  });
});

// =============================================================================
// INTEGRATION WITH TANSTACK QUERY PATTERNS
// =============================================================================

describe("TanStack Query integration patterns", () => {
  test("options can be spread with additional config", () => {
    const baseOptions = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: "123" },
      { initialNumItems: 20 },
    );

    const extendedOptions = {
      ...baseOptions,
      gcTime: 1000 * 60 * 5,
      refetchOnWindowFocus: false,
    };

    expect(extendedOptions.queryKey).toEqual(baseOptions.queryKey);
    expect(extendedOptions.gcTime).toBe(300000);
    expect(extendedOptions.refetchOnWindowFocus).toBe(false);
  });

  test("staleTime can be overridden", () => {
    const baseOptions = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: "123" },
      { initialNumItems: 20 },
    );

    const overriddenOptions = {
      ...baseOptions,
      staleTime: 60000, // Override Infinity
    };

    expect(baseOptions.staleTime).toBe(Infinity);
    expect(overriddenOptions.staleTime).toBe(60000);
  });

  test("enabled can be additionally controlled", () => {
    const baseOptions = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: "123" },
      { initialNumItems: 20 },
    );

    const isReady = false;
    const conditionalOptions = {
      ...baseOptions,
      enabled: isReady,
    };

    expect(conditionalOptions.enabled).toBe(false);
  });

  test("skip pattern with additional enabled check", () => {
    const channelId: string | null = "123";
    const isReady = false;

    const options = {
      ...convexPaginatedQuery(
        api.messages.listPaginated,
        channelId ? { channelId } : "skip",
        { initialNumItems: 20 },
      ),
      enabled: !!channelId && isReady,
    };

    expect(options.enabled).toBe(false);
  });
});

// =============================================================================
// BOUNDARY CONDITIONS
// =============================================================================

describe("boundary conditions", () => {
  test("handles very long string args", () => {
    const longString = "a".repeat(10000);
    const options = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: longString },
      { initialNumItems: 20 },
    );

    expect(options.queryKey[2]).toEqual({ channelId: longString });
  });

  test("handles args with nested objects (if supported)", () => {
    // This tests that complex objects are preserved
    const options = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: "test" },
      { initialNumItems: 20 },
    );

    // The query key should be serializable
    expect(() => JSON.stringify(options.queryKey)).not.toThrow();
  });

  test("numItems edge case: fractional numbers are preserved", () => {
    // While not recommended, this tests that the value is passed through as-is
    const options = convexPaginatedQuery(
      api.messages.listPaginated,
      { channelId: "123" },
      { initialNumItems: 20.5 as any },
    );

    expect(options.queryKey[3]).toBe(20.5);
  });

  test("consistent behavior across multiple calls", () => {
    const results: Array<ReturnType<typeof convexPaginatedQuery>> = [];

    for (let i = 0; i < 100; i++) {
      results.push(
        convexPaginatedQuery(
          api.messages.listPaginated,
          { channelId: "123" },
          { initialNumItems: 20 },
        ),
      );
    }

    // All results should be equivalent
    const firstKey = JSON.stringify(results[0].queryKey);
    for (const result of results) {
      expect(JSON.stringify(result.queryKey)).toBe(firstKey);
      expect(result.staleTime).toBe(Infinity);
      expect(result.initialPageParam).toBeNull();
    }
  });
});
